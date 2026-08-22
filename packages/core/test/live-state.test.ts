/**
 * @file Proves current-state observation remains hot, coalescing, isolated, and
 * independent of producer commit stacks.
 */

import { describe, expect, it, vi } from 'vitest';

import { createLiveState } from '../src/stream/index.js';
import { ManualScheduler } from './temporal-fixtures.js';

/** Immutable state used to make snapshot identity and replacement explicit. */
type FixtureState = Readonly<{
  /** Monotonic representative application value. */
  count: number;
}>;

describe('LiveState', () => {
  it('returns stable identity and notifies outside publication with latest-state coalescing', () => {
    /** Controls exactly when public callbacks may run. */
    const scheduler = new ManualScheduler();

    /** Captures listener observations without reading source internals. */
    const observed: FixtureState[] = [];

    /** Owns the hot state graph under test. */
    const source = createLiveState<FixtureState>({ count: 0 }, { schedule: scheduler.schedule });

    /** Proves repeated reads preserve identity before a change. */
    const initial = source.getSnapshot();
    expect(source.getSnapshot()).toBe(initial);

    source.subscribe((snapshot) => observed.push(snapshot));
    source.publish({ count: 1 });
    source.publish({ count: 2 });

    expect(observed).toEqual([]);
    expect(source.getSnapshot()).toEqual({ count: 2 });
    expect(source.getSnapshot()).not.toBe(initial);

    scheduler.flushAll();
    expect(observed).toEqual([{ count: 2 }]);
  });

  it('isolates listener failures and stops callbacks before close settles', async () => {
    /** Controls deferred listener delivery. */
    const scheduler = new ManualScheduler();

    /** Records isolated callback errors for diagnostics integration. */
    const onListenerError = vi.fn();

    /** Owns the state source being closed while a callback is queued. */
    const source = createLiveState({ count: 0 }, { schedule: scheduler.schedule, onListenerError });

    /** Would fail if invoked, proving close suppresses queued delivery. */
    const listener = vi.fn(() => {
      throw new Error('listener failure');
    });

    source.subscribe(listener);
    source.publish({ count: 1 });
    /** Captures the shared source completion record. */
    const evidence = await source.close();
    scheduler.flushAll();

    expect(evidence).toEqual({ kind: 'completed' });
    expect(await source.closed).toBe(evidence);
    expect(listener).not.toHaveBeenCalled();
    expect(onListenerError).not.toHaveBeenCalled();
    expect(source.getSnapshot()).toEqual({ count: 1 });

    /** A subscription created after close must remain inert. */
    const lateListener = vi.fn();
    /** Retains the idempotent no-op detacher returned after close. */
    const unsubscribe = source.subscribe(lateListener);
    unsubscribe();
    unsubscribe();
    expect(lateListener).not.toHaveBeenCalled();
  });

  it('reports one listener failure without suppressing healthy listeners', () => {
    /** Controls delivery of both listeners in one notification turn. */
    const scheduler = new ManualScheduler();

    /** Receives the isolated failure from the first listener. */
    const onListenerError = vi.fn();

    /** Owns the representative hot state graph. */
    const source = createLiveState({ count: 0 }, { schedule: scheduler.schedule, onListenerError });

    /** Records delivery to the unaffected subscriber. */
    const healthy = vi.fn();
    source.subscribe(() => {
      throw new Error('broken view');
    });
    source.subscribe(healthy);

    source.publish({ count: 1 });
    scheduler.flushAll();

    expect(onListenerError).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledWith({ count: 1 });
  });
});
