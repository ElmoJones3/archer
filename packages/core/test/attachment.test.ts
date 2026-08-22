/**
 * @file Proves asynchronous consumers receive one race-free state, durable,
 * and transient attachment rather than reconstructing a live handle by polling.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createAtomicLiveAttachmentSource,
  createReplayableEventSource,
  createTransientEventSource,
  createVersionedLiveState,
  type StreamCursor,
  type TransientEventSource,
} from '../src/stream/index.js';
import { fixtureEventEncoding, ManualScheduler, nextValue } from './temporal-fixtures.js';

/** Current state exposed by the representative retained owner. */
type FixtureState = Readonly<{
  /** Monotonic representative value. */
  count: number;
}>;

/** Durable observation associated with state acknowledgement. */
type DurableEvent = Readonly<{
  /** Stable durable event label. */
  name: string;
}>;

/** Presentation event that may be dropped with explicit gap evidence. */
type ActivityEvent = Readonly<{
  /** Stable activity label. */
  name: string;
}>;

describe('AtomicLiveAttachmentSource', () => {
  it('attaches every queue before returning a consistent seed and later updates', async () => {
    /** Controls current-state callbacks without relying on the host event loop. */
    const scheduler = new ManualScheduler();

    /** Owns state versions for the logical task source. */
    const state = createVersionedLiveState<FixtureState>(
      { count: 0 },
      { source: 'task-state', epoch: 'state-1', schedule: scheduler.schedule },
    );

    /** Owns durable facts consistent with task state. */
    const durable = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'durable-1',
      retentionItems: 8,
      eventEncoding: fixtureEventEncoding<DurableEvent>(),
    });

    /** Owns non-authoritative task activity. */
    const activity = createTransientEventSource<ActivityEvent>({
      source: 'task-activity',
      epoch: 'activity-1',
      eventEncoding: fixtureEventEncoding<ActivityEvent>(),
    });

    /** Composes attachment only; it owns none of the three sources. */
    const bridge = createAtomicLiveAttachmentSource({ state, durable, transient: { activity } });

    /** Starts attachment synchronously even though the public boundary is asynchronous. */
    const pending = bridge.attachLive();
    state.publish({ count: 1 });
    durable.publish({ name: 'acknowledged' });
    activity.publish({ name: 'working' });

    /** Receives the barrier captured before publications made after attachLive returned. */
    const attachment = await pending;
    expect(attachment.seed).toEqual({
      state: { source: 'task-state', epoch: 'state-1', version: '0', snapshot: { count: 0 } },
      durable: { source: 'task', at: expect.any(String) },
      transient: { activity: { source: 'task-activity', epoch: 'activity-1' } },
    });

    scheduler.flushAll();
    expect(await nextValue(attachment.stateUpdates[Symbol.asyncIterator]())).toEqual({
      source: 'task-state',
      epoch: 'state-1',
      version: '1',
      snapshot: { count: 1 },
    });
    expect((await nextValue(attachment.durable[Symbol.asyncIterator]())).value).toEqual({ name: 'acknowledged' });
    expect(await nextValue(attachment.transient.activity[Symbol.asyncIterator]())).toEqual({
      kind: 'event',
      value: { name: 'working' },
    });

    await attachment.close();
    await state.close();
    await durable.close();
    await activity.close();
  });

  it('detaches as one owner without closing any borrowed source', async () => {
    /** Owns state independently of the attachment being tested. */
    const state = createVersionedLiveState({ count: 0 }, { source: 'task-state', epoch: 'state-1' });

    /** Owns durable observations independently of the attachment. */
    const durable = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'durable-1',
      retentionItems: 8,
      eventEncoding: fixtureEventEncoding<DurableEvent>(),
    });

    /** Provides an empty transient plane while retaining exact mapped typing. */
    const bridge = createAtomicLiveAttachmentSource({ state, durable, transient: {} });
    /** Retains the coordinated queues so their close behavior is observable. */
    const attachment = await bridge.attachLive();

    /** Both close paths must settle with one immutable attachment record. */
    const evidence = await attachment.close();
    expect(await attachment.closed).toBe(evidence);
    expect(evidence).toEqual({ kind: 'detached' });

    /** A new source subscriber still receives work after attachment teardown. */
    const direct = durable.subscribe({ after: attachment.seed.durable?.at as StreamCursor<'task'> });
    durable.publish({ name: 'still-owned' });
    expect((await nextValue(direct[Symbol.asyncIterator]())).value).toEqual({ name: 'still-owned' });

    await direct.close();
    await state.close();
    await durable.close();
  });

  it('represents a handle with no durable plane as durable undefined', async () => {
    /** Owns versioned current state for a transient-only retained handle. */
    const state = createVersionedLiveState({ count: 0 }, { source: 'sandbox-state', epoch: 'state-1' });

    /** Owns the one presentation plane exposed by the representative sandbox. */
    const lifecycle = createTransientEventSource<ActivityEvent>({
      source: 'sandbox-lifecycle',
      epoch: 'lifecycle-1',
      eventEncoding: fixtureEventEncoding<ActivityEvent>(),
    });

    /** Builds the same atomic bridge without inventing durable history. */
    const bridge = createAtomicLiveAttachmentSource({ state, transient: { lifecycle } });
    /** Retains the transient-only attachment for type and seed assertions. */
    const attachment = await bridge.attachLive();

    expect(attachment.durable).toBeUndefined();
    expect(attachment.seed).toEqual({
      state: { source: 'sandbox-state', epoch: 'state-1', version: '0', snapshot: { count: 0 } },
      transient: { lifecycle: { source: 'sandbox-lifecycle', epoch: 'lifecycle-1' } },
    });

    await attachment.close();
    await state.close();
    await lifecycle.close();
  });

  it('drains the final source snapshot before natural state-lane completion', async () => {
    /** Prevents the ordinary deferred callback from hiding the close race under test. */
    const scheduler = new ManualScheduler();

    /** Owns state whose final publication and closure occur in one host turn. */
    const state = createVersionedLiveState(
      { count: 0 },
      { source: 'task-state', epoch: 'state-1', schedule: scheduler.schedule },
    );

    /** Exposes only current state so final-state delivery cannot rely on a durable lane. */
    const bridge = createAtomicLiveAttachmentSource({ state, transient: {} });
    /** Seeds the remote view at version zero before the terminal publication. */
    const attachment = await bridge.attachLive();
    /** Waits for the next state before publication to cover a pending consumer pull. */
    const iterator = attachment.stateUpdates[Symbol.asyncIterator]();
    /** Retains the pending consumer pull across terminal source publication. */
    const next = iterator.next();

    state.publish({ count: 1 });
    await state.close();

    expect(await next).toEqual({
      done: false,
      value: {
        source: 'task-state',
        epoch: 'state-1',
        version: '1',
        snapshot: { count: 1 },
      },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await attachment.stateUpdates.closed).toEqual({ kind: 'completed', epoch: 'state-1', version: '1' });

    scheduler.flushAll();
    await attachment.close();
  });

  it('rejects post-close versioned publication without advancing state', async () => {
    /** Owns the versioned source whose admission boundary is already closed. */
    const state = createVersionedLiveState({ count: 0 }, { source: 'task-state', epoch: 'state-1' });
    await state.close();

    expect(() => state.publish({ count: 1 })).toThrow('completed versioned state source');
    expect(state.getVersionedSnapshot()).toEqual({
      source: 'task-state',
      epoch: 'state-1',
      version: '0',
      snapshot: { count: 0 },
    });
  });

  it('attaches only explicitly selected transient planes', async () => {
    /** Owns current state independently of presentation-plane selection. */
    const state = createVersionedLiveState({ count: 0 }, { source: 'task-state', epoch: 'state-1' });

    /** Owns the first selectable presentation source. */
    const one = createTransientEventSource<ActivityEvent>({
      source: 'one',
      epoch: 'one-1',
      eventEncoding: fixtureEventEncoding<ActivityEvent>(),
    });

    /** Owns the second presentation source that the caller does not select. */
    const two = createTransientEventSource<ActivityEvent>({
      source: 'two',
      epoch: 'two-1',
      eventEncoding: fixtureEventEncoding<ActivityEvent>(),
    });

    /** Observes source attachment while delegating to the first real source. */
    const subscribeOne = vi.fn(one.subscribe.bind(one));

    /** Observes that the omitted plane acquires no subscriber queue. */
    const subscribeTwo = vi.fn(two.subscribe.bind(two));

    /** Adds observation to the first source without mutating its frozen facade. */
    const trackedOne: TransientEventSource<ActivityEvent> = { ...one, subscribe: subscribeOne };

    /** Adds observation to the second source without mutating its frozen facade. */
    const trackedTwo: TransientEventSource<ActivityEvent> = { ...two, subscribe: subscribeTwo };

    /** Exposes both capabilities while the transport requests only one. */
    const bridge = createAtomicLiveAttachmentSource({ state, transient: { one: trackedOne, two: trackedTwo } });
    /** Retains the narrowed attachment returned for the selected plane. */
    const attachment = await bridge.attachLive({ transient: { one: {} } });

    expect(Object.keys(attachment.transient)).toEqual(['one']);
    expect(Object.keys(attachment.seed.transient)).toEqual(['one']);
    expect(subscribeOne).toHaveBeenCalledOnce();
    expect(subscribeTwo).not.toHaveBeenCalled();

    await attachment.close();
    await state.close();
    await one.close();
    await two.close();
  });

  it('rejects setup asynchronously and rolls back queues attached before failure', async () => {
    /** Owns current state for a construction path that fails before its lane attaches. */
    const state = createVersionedLiveState({ count: 0 }, { source: 'task-state', epoch: 'state-1' });

    /** Owns the first source whose successful subscription must be rolled back. */
    const first = createTransientEventSource<ActivityEvent>({
      source: 'first',
      epoch: 'first-1',
      eventEncoding: fixtureEventEncoding<ActivityEvent>(),
    });

    /** Captures the real first subscription so rollback evidence remains observable. */
    let firstSubscription: ReturnType<TransientEventSource<ActivityEvent>['subscribe']> | undefined;

    /** Wraps the first source with a tracked public source capability. */
    const trackedFirst: TransientEventSource<ActivityEvent> = {
      ...first,
      /**
       * Records the queue created before the later source rejects construction.
       * @param options - Selected transient delivery bounds.
       * @returns The real first-source subscription.
       */
      subscribe(options) {
        firstSubscription = first.subscribe(options);
        return firstSubscription;
      },
    };

    /** Supplies a source-shaped capability whose attachment violates the port. */
    const failing: TransientEventSource<ActivityEvent> = {
      ...first,
      source: 'failing',
      /** Throws synchronously to prove the Promise boundary and rollback transaction. */
      subscribe() {
        throw new Error('fixture attachment failed');
      },
    };

    /** Composes the successful lane before the deliberately failing lane. */
    const bridge = createAtomicLiveAttachmentSource({ state, transient: { first: trackedFirst, failing } });

    await expect(bridge.attachLive({ transient: { first: {}, failing: {} } })).rejects.toThrow(
      'fixture attachment failed',
    );
    expect(await firstSubscription?.closed).toEqual({ kind: 'detached' });

    await state.close();
    await first.close();
  });

  it('settles closed with the same rejection as a failing child close', async () => {
    /** Owns current state independently of the deliberately failing child queue. */
    const state = createVersionedLiveState({ count: 0 }, { source: 'task-state', epoch: 'state-1' });

    /** Supplies a real transient source behind the child lifecycle fault. */
    const child = createTransientEventSource<ActivityEvent>({
      source: 'task-activity',
      epoch: 'activity-1',
      eventEncoding: fixtureEventEncoding<ActivityEvent>(),
    });

    /** Identifies the exact rejection both attachment lifecycle paths must preserve. */
    const failure = new Error('fixture child close failed');

    /** Wraps the real source while changing only its subscription close settlement. */
    const failingChild: TransientEventSource<ActivityEvent> = {
      ...child,
      /**
       * Delegates iteration while exposing one contract-valid rejected child lifecycle.
       * @param options - Selected delivery behavior passed to the real child queue.
       * @returns A subscription whose close and closed reject together.
       */
      subscribe(options) {
        /** Retains real queue behavior for every operation except terminal settlement. */
        const subscription = child.subscribe(options);
        /** Captures rejection capability without rejecting before a close caller observes it. */
        let rejectClosed: ((reason: unknown) => void) | undefined;
        /** Shares one rejected child lifecycle across method and property access. */
        const closed = new Promise<never>((_resolve, reject) => {
          rejectClosed = reject;
        });
        /** Narrows the wrapper to the exact public subscription contract. */
        return {
          delivery: subscription.delivery,
          closed,
          /**
           * Detaches the real queue before rejecting this child lifecycle.
           * @returns The shared rejected close promise.
           */
          close() {
            void subscription.close();
            rejectClosed?.(failure);
            return closed;
          },
          /** Delegates language disposal to the same rejected lifecycle. */
          async [Symbol.asyncDispose]() {
            await this.close();
          },
          /**
           * Preserves the real queue's asynchronous iteration behavior.
           * @returns The real subscription iterator.
           */
          [Symbol.asyncIterator]() {
            return subscription[Symbol.asyncIterator]();
          },
        };
      },
    };

    /** Composes the failing child under one coordinated attachment owner. */
    const bridge = createAtomicLiveAttachmentSource({ state, transient: { activity: failingChild } });
    /** Retains the attachment before the lifecycle fault begins. */
    const attachment = await bridge.attachLive();
    /** Observes property settlement without risking a test hang on the current defect. */
    let closedFailure: unknown;
    void attachment.closed.catch((error: unknown) => {
      closedFailure = error;
    });

    await expect(attachment.close()).rejects.toBe(failure);
    await Promise.resolve();
    expect(closedFailure).toBe(failure);

    await state.close();
    await child.close();
  });
});
