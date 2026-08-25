/**
 * @file Proves durable replay and transient loss retain distinct, bounded,
 * independently fanned-out semantics.
 */

import { describe, expect, it } from 'vitest';

import { createReplayableEventSource, createTransientEventSource, type StreamCursor } from '../src/stream/index.js';
import { fixtureEventEncoding, nextValue } from './temporal-fixtures.js';

/** Durable fixture event measured by its UTF-8 payload. */
type DurableEvent = Readonly<{
  /** Stable event label. */
  name: string;
}>;

/** Stable encoding used where a scenario does not need custom byte behavior. */
const durableEventEncoding = fixtureEventEncoding<DurableEvent>('task-event/1');

/**
 * Copies one flat durable fixture into source-owned immutable storage.
 * @param event - Caller-owned durable fixture candidate.
 * @returns A frozen source-owned event.
 */
function normalizeDurableEvent(event: DurableEvent): DurableEvent {
  return Object.freeze({ ...event });
}

describe('ReplayableEventStream', () => {
  it('restores durable history before observation and continues cursor order', async () => {
    /** Represents values restored from durable storage before activation is visible. */
    const initialEvents = [{ name: 'one' }, { name: 'two' }] as const;
    /** Creates a source whose first live cursor must continue after restored history. */
    const source = createReplayableEventSource({
      source: 'test',
      streamId: 'restored',
      epoch: 'stable-epoch',
      retentionItems: 8,
      initialEvents,
      eventEncoding: durableEventEncoding,
    });

    /** Replays restored values through the same bounded public contract as live values. */
    const subscription = source.subscribe({ after: source.cursorCodec.encode(0n) });
    /** Owns the pull cursor independently from the subscription lifecycle. */
    const iterator = subscription[Symbol.asyncIterator]();
    expect(await nextValue(iterator)).toEqual(expect.objectContaining({ value: { name: 'one' } }));
    expect(await nextValue(iterator)).toEqual(expect.objectContaining({ value: { name: 'two' } }));
    expect(source.cursorCodec.decode(source.currentCursor())).toEqual({
      ok: true,
      value: expect.objectContaining({ offset: '2' }),
    });

    await subscription.close();
    await source.close();
  });
  it('rejects an empty event protocol revision before constructing a source', () => {
    expect(() =>
      createReplayableEventSource<DurableEvent, 'task'>({
        source: 'task',
        streamId: 'task-1',
        epoch: 'epoch-1',
        retentionItems: 1,
        eventEncoding: {
          revision: '',
          normalize: normalizeDurableEvent,
          /**
           * Measures the fixture value through its stable ASCII representation.
           * @param event - Durable fixture event offered to the source.
           * @returns The fixture payload's exact byte count.
           */
          measure: (event) => event.name.length,
        },
      }),
    ).toThrow('revision');
  });

  it('rejects a missing event measurement at source construction', () => {
    expect(() =>
      createTransientEventSource<DurableEvent>({
        source: 'task-presentation',
        epoch: 'epoch-1',
        eventEncoding: { revision: 'task-presentation/1' } as unknown as typeof durableEventEncoding,
      }),
    ).toThrow('measurement');
  });

  it('fans out independently and replays strictly after a delivered cursor', async () => {
    /** Owns one durable source with enough retention for explicit replay. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 8,
      eventEncoding: durableEventEncoding,
    });

    expect(source.eventEncoding.revision).toBe('task-event/1');

    /** Attaches two independent consumers to the existing hot source. */
    const first = source.subscribe();
    /** Retains the second independent queue for fan-out comparison. */
    const second = source.subscribe();
    source.publish({ name: 'one' });
    source.publish({ name: 'two' });

    /** Pulls each queue independently to prove one does not consume the other. */
    const firstOne = await nextValue(first[Symbol.asyncIterator]());
    /** Pulls the second subscription without consuming the first queue. */
    const secondIterator = second[Symbol.asyncIterator]();
    expect(await nextValue(secondIterator)).toEqual(firstOne);
    expect((await nextValue(secondIterator)).value).toEqual({ name: 'two' });

    /** Reattaches after the first delivered envelope and receives only its successor. */
    const replay = source.subscribe({ after: firstOne.cursor });
    expect((await nextValue(replay[Symbol.asyncIterator]())).value).toEqual({ name: 'two' });

    await first.close();
    await second.close();
    await replay.close();
    await source.close();
  });

  it('retains a normalized event rather than a mutable caller alias', async () => {
    /** Owns one replay suffix whose admitted value must not follow later caller mutation. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 1,
      eventEncoding: durableEventEncoding,
    });

    /** Remains caller-owned after publication so the source boundary has to copy it. */
    const candidate = { name: 'before-admission' };
    /** Captures the cursor before the source admits the candidate. */
    const before = source.currentCursor();
    source.publish(candidate);
    candidate.name = 'rewritten-after-admission';

    /** Replays from retained source state rather than a live subscriber alias. */
    const replay = source.subscribe({ after: before });
    expect((await nextValue(replay[Symbol.asyncIterator]())).value).toEqual({ name: 'before-admission' });

    await replay.close();
    await source.close();
  });

  it('closes a lagging subscriber with its last delivered resume cursor', async () => {
    /** Uses a one-item queue so the second unconsumed event forces overflow. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 8,
      eventEncoding: durableEventEncoding,
      delivery: { capacityItems: 1, capacityBytes: 1024, overflow: 'resume-required' },
      maximumDelivery: { capacityItems: 2, capacityBytes: 1024 },
    });

    /** Establishes a safe starting cursor before any live value arrives. */
    const start = source.currentCursor();

    /** Lags deliberately by never pulling from the bounded queue. */
    const subscription = source.subscribe();
    source.publish({ name: 'one' });
    source.publish({ name: 'two' });

    expect(await subscription.closed).toEqual({ kind: 'resume-required', after: start });

    /** Replays both retained observations from the reported safe position. */
    const resumed = source.subscribe({ after: start, capacityItems: 2 });
    /** Pulls the replay queue in deterministic source order. */
    const iterator = resumed[Symbol.asyncIterator]();
    expect((await nextValue(iterator)).value).toEqual({ name: 'one' });
    expect((await nextValue(iterator)).value).toEqual({ name: 'two' });

    await resumed.close();
    await source.close();
  });

  it('rejects a structurally different source cursor without replaying data', async () => {
    /** Creates a cursor for another logical task source. */
    const other = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-2',
      epoch: 'epoch-1',
      retentionItems: 1,
      eventEncoding: durableEventEncoding,
    });

    /** Owns the source that must reject the foreign cursor. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 1,
      eventEncoding: durableEventEncoding,
    });

    /** Cast reflects that static branding cannot encode each runtime stream identity. */
    const foreign = other.currentCursor() as StreamCursor<'task'>;
    /** Carries the already-failed queue returned for the foreign cursor. */
    const subscription = source.subscribe({ after: foreign });

    expect(await subscription.closed).toMatchObject({
      kind: 'failed',
      failure: { kind: 'protocol-failure', code: 'cursor_stream_mismatch' },
    });

    await other.close();
    await source.close();
  });

  it('requires a fresh seed for an expired or replaced replay generation', async () => {
    /** Produces a cursor that falls outside a one-item retention suffix. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 1,
      eventEncoding: durableEventEncoding,
    });
    /** Captures the only safe position before retention advances twice. */
    const expired = source.currentCursor();
    source.publish({ name: 'one' });
    source.publish({ name: 'two' });

    expect(await source.subscribe({ after: expired }).closed).toEqual({
      kind: 'reseed-required',
      reason: 'cursor-expired',
    });

    /** Reuses logical identity with a new epoch to prove generation replacement. */
    const replacement = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-2',
      retentionItems: 1,
      eventEncoding: durableEventEncoding,
    });
    expect(await replacement.subscribe({ after: source.currentCursor() }).closed).toEqual({
      kind: 'reseed-required',
      reason: 'source-replaced',
    });

    await source.close();
    await replacement.close();
  });

  it('preserves cursor and history when event measurement rejects admission', async () => {
    /** Controls whether the source protocol can encode the next event. */
    let rejectMeasurement = true;

    /** Owns a one-record replay suffix so a phantom offset would expire the seed. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 1,
      eventEncoding: {
        revision: 'task-event/1',
        normalize: normalizeDurableEvent,
        /**
         * Rejects the first admission and measures the next one deterministically.
         * @param event - Candidate durable event.
         * @returns Encoded fixture bytes after rejection is disabled.
         */
        measure: (event) => {
          if (rejectMeasurement) throw new TypeError('cannot encode event');
          return event.name.length;
        },
      },
    });

    /** Captures the durable position that failed admission must preserve exactly. */
    const before = source.currentCursor();
    expect(() => source.publish({ name: 'rejected' })).toThrow('cannot encode event');
    expect(source.currentCursor()).toBe(before);

    rejectMeasurement = false;
    source.publish({ name: 'accepted' });
    /** Replays the only admitted successor without treating the safe cursor as expired. */
    const replay = source.subscribe({ after: before });
    expect((await nextValue(replay[Symbol.asyncIterator]())).value).toEqual({ name: 'accepted' });

    await replay.close();
    await source.close();
  });

  it('preserves cursor and history when event normalization rejects admission', async () => {
    /** Controls whether the source protocol admits the next caller-owned value. */
    let rejectNormalization = true;

    /** Owns a one-record suffix so phantom admission would expire its initial cursor. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 1,
      eventEncoding: {
        revision: 'task-event/1',
        /**
         * Rejects the first candidate before copying later valid values.
         * @param event - Caller-owned durable candidate.
         * @returns A source-owned immutable event after rejection is disabled.
         */
        normalize(event) {
          if (rejectNormalization) throw new TypeError('cannot normalize event');
          return normalizeDurableEvent(event);
        },
        /**
         * Measures the admitted flat fixture through its payload length.
         * @param event - Source-owned normalized event.
         * @returns The exact fixture payload length.
         */
        measure: (event) => event.name.length,
      },
    });

    /** Captures the exact state that failed normalization must preserve. */
    const before = source.currentCursor();
    expect(() => source.publish({ name: 'rejected' })).toThrow('cannot normalize event');
    expect(source.currentCursor()).toBe(before);

    rejectNormalization = false;
    source.publish({ name: 'accepted' });
    /** Proves the successful successor remains replayable from the original barrier. */
    const replay = source.subscribe({ after: before });
    expect((await nextValue(replay[Symbol.asyncIterator]())).value).toEqual({ name: 'accepted' });

    await replay.close();
    await source.close();
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid encoded byte measurement %s before durable mutation',
    (bytes) => {
      /** Owns a source whose protocol returns the invalid size under test. */
      const source = createReplayableEventSource<DurableEvent, 'task'>({
        source: 'task',
        streamId: 'task-1',
        epoch: 'epoch-1',
        retentionItems: 1,
        eventEncoding: {
          revision: 'task-event/1',
          normalize: normalizeDurableEvent,
          /**
           * Returns the deliberately invalid encoded size.
           * @returns The current table case's invalid measurement.
           */
          measure: () => bytes,
        },
      });

      /** Captures the exact state that invalid admission must not advance. */
      const before = source.currentCursor();
      expect(() => source.publish({ name: 'invalid' })).toThrow('non-negative safe integer');
      expect(source.currentCursor()).toBe(before);
    },
  );

  it('publishes source maxima and rejects subscriber expansion above them', async () => {
    /** Owns defaults smaller than the source's declared subscriber ceiling. */
    const source = createReplayableEventSource<DurableEvent, 'task'>({
      source: 'task',
      streamId: 'task-1',
      epoch: 'epoch-1',
      retentionItems: 1,
      eventEncoding: durableEventEncoding,
      delivery: { capacityItems: 1, capacityBytes: 8 },
      maximumDelivery: { capacityItems: 2, capacityBytes: 16 },
    });

    expect(source.deliveryLimits).toEqual({ capacityItems: 2, capacityBytes: 16 });
    expect(source.subscribe({ capacityItems: 2, capacityBytes: 16 }).delivery).toMatchObject({
      capacityItems: 2,
      capacityBytes: 16,
    });
    expect(() => source.subscribe({ capacityItems: 3 })).toThrow('source-declared maximum');

    await source.close();
  });
});

describe('TransientEventStream', () => {
  it('frames an application event that has the same fields as loss evidence', async () => {
    /** Deliberately uses the public control-record shape as valid application data. */
    type GapShapedEvent = Readonly<{
      /** Matches the transport control discriminator without owning its meaning. */
      kind: 'gap';

      /** Matches the transport source field as ordinary application data. */
      source: string;

      /** Matches the transport epoch field as ordinary application data. */
      epoch: string;

      /** Matches the transport loss count as ordinary application data. */
      lostItems: number;

      /** Matches the transport byte count as ordinary application data. */
      lostBytes: number;
    }>;

    /** Owns a source whose domain value must remain distinguishable from control evidence. */
    const source = createTransientEventSource<GapShapedEvent>({
      source: 'task-presentation',
      epoch: 'epoch-1',
      eventEncoding: fixtureEventEncoding<GapShapedEvent>(),
    });
    /** Attaches before publication so the value is delivered live. */
    const subscription = source.subscribe();
    /** Carries a hostile but contract-valid application event. */
    const event: GapShapedEvent = {
      kind: 'gap',
      source: 'application-data',
      epoch: 'application-data',
      lostItems: 7,
      lostBytes: 11,
    };
    source.publish(event);

    expect(await nextValue(subscription[Symbol.asyncIterator]())).toEqual({ kind: 'event', value: event });

    await subscription.close();
    await source.close();
  });

  it('quantifies exact subscriber-local loss and preserves event order around the gap', async () => {
    /** Uses encoded name length as an auditable byte measurement. */
    const source = createTransientEventSource<DurableEvent>({
      source: 'task-presentation',
      epoch: 'epoch-1',
      eventEncoding: {
        revision: 'task-presentation/1',
        normalize: normalizeDurableEvent,
        /**
         * Measures only fixture payload text so expected loss bytes remain explicit.
         * @param event - Fixture event admitted to the transient source.
         * @returns Payload character count used as encoded bytes in this test.
         */
        measure: (event) => event.name.length,
      },
      delivery: { capacityItems: 1, capacityBytes: 32, overflow: 'gap' },
    });

    /** Falls behind after the first accepted value. */
    const subscription = source.subscribe();
    source.publish({ name: 'one' });
    source.publish({ name: 'two' });
    source.publish({ name: 'three' });

    /** Drains the accepted predecessor before receiving the coalesced loss marker. */
    const iterator = subscription[Symbol.asyncIterator]();
    expect(await nextValue(iterator)).toEqual({ kind: 'event', value: { name: 'one' } });
    expect(await nextValue(iterator)).toEqual({
      kind: 'gap',
      source: 'task-presentation',
      epoch: 'epoch-1',
      lostItems: '2',
      lostBytes: '8',
    });

    source.publish({ name: 'four' });
    expect(await nextValue(iterator)).toEqual({ kind: 'event', value: { name: 'four' } });

    await subscription.close();
    await source.close();
  });

  it('detaches only the overflowing subscriber while a healthy subscriber continues', async () => {
    /** Owns the shared hot presentation source. */
    const source = createTransientEventSource<DurableEvent>({
      source: 'task-presentation',
      epoch: 'epoch-1',
      eventEncoding: durableEventEncoding,
      delivery: { capacityItems: 1, capacityBytes: 1024, overflow: 'detach' },
    });

    /** Never pulls and therefore exhausts only its own queue. */
    const slow = source.subscribe();

    /** Pulls before each publish so its independent queue never overflows. */
    const healthy = source.subscribe();
    /** Pulls the healthy subscriber before each later source publication. */
    const healthyIterator = healthy[Symbol.asyncIterator]();
    source.publish({ name: 'one' });
    expect(await nextValue(healthyIterator)).toEqual({ kind: 'event', value: { name: 'one' } });
    source.publish({ name: 'two' });
    expect(await nextValue(healthyIterator)).toEqual({ kind: 'event', value: { name: 'two' } });

    expect(await slow.closed).toEqual({ kind: 'detached' });

    await healthy.close();
    await source.close();
  });

  it('reserves a gap marker when one event alone exceeds the byte bound', async () => {
    /** Makes the one source value too large for an otherwise empty queue. */
    const source = createTransientEventSource<DurableEvent>({
      source: 'task-presentation',
      epoch: 'epoch-1',
      eventEncoding: {
        revision: 'task-presentation/1',
        normalize: normalizeDurableEvent,
        /**
         * Supplies a fixed oversized byte measurement.
         * @returns Ten encoded bytes.
         */
        measure: () => 10,
      },
      delivery: { capacityItems: 1, capacityBytes: 4, overflow: 'gap' },
    });
    /** Retains the empty queue that must reserve a loss marker. */
    const subscription = source.subscribe();
    source.publish({ name: 'oversized' });

    /** Resolves immediately only when the reserved gap enters the empty queue. */
    const next = subscription[Symbol.asyncIterator]().next();
    expect(await Promise.race([next, Promise.resolve('still-pending')])).toEqual({
      done: false,
      value: {
        kind: 'gap',
        source: 'task-presentation',
        epoch: 'epoch-1',
        lostItems: '1',
        lostBytes: '10',
      },
    });

    await subscription.close();
    await source.close();
  });

  it('reports aggregate loss beyond Number safe precision as exact canonical decimals', async () => {
    /** Carries the source-owned encoded size without allocating a matching payload. */
    type SizedEvent = Readonly<{
      /** Selects the exact byte measurement returned by the fixture encoding. */
      bytes: number;
    }>;

    /** Owns a one-byte queue that can accumulate several maximum-sized losses. */
    const source = createTransientEventSource<SizedEvent>({
      source: 'task-presentation',
      epoch: 'epoch-1',
      eventEncoding: {
        revision: 'sized-event/1',
        /**
         * Copies the flat sizing fixture before its byte charge becomes evidence.
         * @param event - Caller-owned sizing candidate.
         * @returns A frozen source-owned sizing event.
         */
        normalize: (event) => Object.freeze({ ...event }),
        /**
         * Returns the fixture-selected protocol size.
         * @param event - Sized event admitted by the source.
         * @returns The event's exact safe-integer byte measurement.
         */
        measure: (event) => event.bytes,
      },
      delivery: { capacityItems: 1, capacityBytes: 1, overflow: 'gap' },
    });
    /** Retains the first value so later losses coalesce before capacity returns. */
    const subscription = source.subscribe();
    source.publish({ bytes: 1 });
    source.publish({ bytes: Number.MAX_SAFE_INTEGER });
    source.publish({ bytes: Number.MAX_SAFE_INTEGER });
    source.publish({ bytes: Number.MAX_SAFE_INTEGER });

    /** Releases the source-value slot, allowing its one reserved gap to enter. */
    const iterator = subscription[Symbol.asyncIterator]();
    expect(await nextValue(iterator)).toEqual({ kind: 'event', value: { bytes: 1 } });
    expect(await nextValue(iterator)).toMatchObject({
      kind: 'gap',
      lostItems: '3',
      lostBytes: (3n * BigInt(Number.MAX_SAFE_INTEGER)).toString(),
    });

    await subscription.close();
    await source.close();
  });
});
