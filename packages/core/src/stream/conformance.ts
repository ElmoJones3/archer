/**
 * @file Publishes the required, versioned conformance suite for Archer's shared
 * temporal protocol.
 *
 * The runner has no test-framework dependency. Implementers supply public
 * factories, receive configuration-bound diagnostic results, and obtain passing
 * evidence only when every required case succeeds.
 */

import * as z from 'zod';

import { ArcherError } from '../errors.js';
import {
  ConformanceExecutionSchema,
  conformanceDigestsMatch,
  conformanceExecution,
  conformanceTimestamp,
  digestConformanceValue,
  normalizeConformanceEnvironment,
  type ConformanceEnvironment,
  type ConformanceEvidence,
} from '../conformance.js';
import { IdempotencyKeySchema, PublicErrorSchema, toPublicError, type PublicError } from '../protocol.js';
import { Result, type Result as ResultValue } from '../result.js';
import { JsonObjectSchema, Sha256DigestSchema, TimestampSchema, type JsonObject } from '../values.js';
import { StateVersionSchema, createAtomicLiveAttachmentSource, createVersionedLiveState } from './attachment.js';
import type { AttemptAbortDisposition } from './contracts.js';
import { createLiveOperation } from './operation.js';
import {
  createLiveState,
  createReplayableEventSource,
  createTransientEventSource,
  type EventEncoding,
} from './runtime.js';
import { createDeferredTask, ManualTaskScheduler } from './testing.js';

/** Selects the exact required case set and report schema published by this module. */
export const STREAM_CONFORMANCE_VERSION = '1.0.0';

/** Stable identities of the required v1 temporal protocol cases. */
export type StreamConformanceCaseId =
  | 'live-state.identity-sharing-isolation'
  | 'live-state.late-final-close'
  | 'attachment.atomic-barrier-final-state'
  | 'attachment.planes-races-detach'
  | 'replay.bounds-resume-fanout'
  | 'replay.cursor-retention-lifecycle'
  | 'transient.gap-bounds-epochs'
  | 'transient.detach-lifecycle-capability'
  | 'operation.single-start-terminal-abort'
  | 'operation.races-fifo-late';

/** One required conformance claim published for implementer discovery. */
export type StreamConformanceCase = Readonly<{
  /** Stable case identity preserved across compatible suite patches. */
  id: StreamConformanceCaseId;

  /** Human-readable protocol claim proved by this case. */
  claim: string;
}>;

/** The complete required v1 case catalogue in deterministic execution order. */
export const STREAM_CONFORMANCE_CASES: readonly StreamConformanceCase[] = Object.freeze([
  Object.freeze({
    id: 'live-state.identity-sharing-isolation',
    claim: 'LiveState preserves snapshot identity, hot sharing, coalescing, listener isolation, and close.',
  }),
  Object.freeze({
    id: 'live-state.late-final-close',
    claim: 'Late observers read retained state without replay and receive no callback after source close.',
  }),
  Object.freeze({
    id: 'attachment.atomic-barrier-final-state',
    claim: 'Atomic attachment queues precede its seed and drain the final versioned snapshot before close.',
  }),
  Object.freeze({
    id: 'attachment.planes-races-detach',
    claim: 'Attachment planes are typed and optional, setup rolls back, state coalesces, and detach preserves sources.',
  }),
  Object.freeze({
    id: 'replay.bounds-resume-fanout',
    claim: 'Replay item and byte overflow are bounded, independently fanned out, and resumable without hidden loss.',
  }),
  Object.freeze({
    id: 'replay.cursor-retention-lifecycle',
    claim: 'Replay validates cursor identity and retention while iterator and source close remain explicit.',
  }),
  Object.freeze({
    id: 'transient.gap-bounds-epochs',
    claim: 'Transient item and byte overflow is subscriber-local and reports exact epoch-bound loss.',
  }),
  Object.freeze({
    id: 'transient.detach-lifecycle-capability',
    claim: 'Transient streams detach independently, close iterators explicitly, and expose no replay capability.',
  }),
  Object.freeze({
    id: 'operation.single-start-terminal-abort',
    claim: 'A finite operation starts once, seals progress, and resolves abort only with terminal evidence.',
  }),
  Object.freeze({
    id: 'operation.races-fifo-late',
    claim:
      'Operation races settle once, accepted progress drains FIFO, and slow or late subscribers cannot delay result.',
  }),
]);

/** Public factory port implemented by one temporal runtime under test. */
export type StreamConformanceTarget = Readonly<{
  /** Constructs shared current-state sources. */
  createLiveState: typeof createLiveState;

  /** Constructs bounded durable replay sources. */
  createReplayableEventSource: typeof createReplayableEventSource;

  /** Constructs bounded transient sources. */
  createTransientEventSource: typeof createTransientEventSource;

  /** Constructs monotonic versioned current-state sources. */
  createVersionedLiveState: typeof createVersionedLiveState;

  /** Constructs race-free state and event attachment factories. */
  createAtomicLiveAttachmentSource: typeof createAtomicLiveAttachmentSource;

  /** Constructs one finite hot attempt. */
  createLiveOperation: typeof createLiveOperation;
}>;

/** First-party RxJS-backed factory port exercised by Archer's own proof. */
export const CORE_STREAM_CONFORMANCE_TARGET: StreamConformanceTarget = Object.freeze({
  createLiveState,
  createReplayableEventSource,
  createTransientEventSource,
  createVersionedLiveState,
  createAtomicLiveAttachmentSource,
  createLiveOperation,
});

/** Identifies the exact implementation and configuration covered by one report. */
export type StreamConformanceImplementation = Readonly<{
  /** Stable implementation or package name. */
  name: string;

  /** Exact implementation version or source revision. */
  version: string;

  /** Immutable configuration whose guarantees the case results cover. */
  configuration: JsonObject;
}>;

/** One required case outcome with no skipped success state. */
export type StreamConformanceCaseResult =
  | Readonly<{
      /** Required case that ran successfully. */
      status: 'passed';

      /** Stable identity matching the published catalogue. */
      id: StreamConformanceCaseId;
    }>
  | Readonly<{
      /** Required case that ran and failed. */
      status: 'failed';

      /** Stable identity matching the published catalogue. */
      id: StreamConformanceCaseId;

      /** Redacted public failure suitable for stored evidence. */
      failure: PublicError;
    }>;

/** Diagnostic report returned whether required cases pass or fail. */
export type StreamConformanceReport = Readonly<{
  /** Selects this report codec. */
  schema: 1;

  /** Names the protocol rather than one implementation. */
  protocol: '@archer/core/stream';

  /** Selects the exact suite and required case set. */
  suiteVersion: typeof STREAM_CONFORMANCE_VERSION;

  /** Binds results to one named implementation and immutable configuration. */
  implementation: StreamConformanceImplementation;

  /** Lists the exact required catalogue independently of individual outcomes. */
  requiredCases: readonly StreamConformanceCaseId[];

  /** Summarizes whether every required case passed. */
  status: 'passed' | 'failed';

  /** Contains every required result in catalogue order with no skipped branch. */
  cases: readonly StreamConformanceCaseResult[];
}> &
  ConformanceEvidence;

/** The report refinement required before conformance can serve as passing evidence. */
type PassingStreamStatus = Readonly<{
  /** Confirms every published temporal case passed. */
  status: 'passed';
}>;

/** Report narrowed to the only form that can support passing evidence. */
export type PassingStreamConformance = StreamConformanceReport & PassingStreamStatus;

/** Validates the stable identity of every required temporal proof. */
const StreamConformanceCaseIdSchema = z.enum([
  'live-state.identity-sharing-isolation',
  'live-state.late-final-close',
  'attachment.atomic-barrier-final-state',
  'attachment.planes-races-detach',
  'replay.bounds-resume-fanout',
  'replay.cursor-retention-lifecycle',
  'transient.gap-bounds-epochs',
  'transient.detach-lifecycle-capability',
  'operation.single-start-terminal-abort',
  'operation.races-fifo-late',
]);

/** Validates the named implementation and exact JSON configuration bound into evidence. */
const StreamConformanceImplementationSchema = z
  .strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    configuration: JsonObjectSchema,
  })
  .readonly();

/** Validates one executed case without admitting a skipped or unbounded failure branch. */
const StreamConformanceCaseResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ id: StreamConformanceCaseIdSchema, status: z.literal('passed') }),
    z.strictObject({ id: StreamConformanceCaseIdSchema, status: z.literal('failed'), failure: PublicErrorSchema }),
  ])
  .readonly();

/**
 * Admits serialized temporal conformance reports into an immutable runtime form.
 * Digest verification remains a separate asynchronous step because schemas
 * establish shape and invariants, not content integrity.
 */
export const StreamConformanceReportSchema = z
  .strictObject({
    schema: z.literal(1),
    protocol: z.literal('@archer/core/stream'),
    suiteVersion: z.literal(STREAM_CONFORMANCE_VERSION),
    implementation: StreamConformanceImplementationSchema,
    configurationDigest: Sha256DigestSchema,
    at: TimestampSchema,
    environment: JsonObjectSchema,
    execution: ConformanceExecutionSchema,
    evidenceDigest: Sha256DigestSchema,
    requiredCases: z.array(StreamConformanceCaseIdSchema).readonly(),
    status: z.enum(['passed', 'failed']),
    cases: z.array(StreamConformanceCaseResultSchema).readonly(),
  })
  .transform((value) => value as StreamConformanceReport)
  .readonly();

/** Explains why a diagnostic report cannot be promoted to passing evidence. */
export class StreamConformanceError extends ArcherError {
  /**
   * Constructs one bounded failure naming every failed required case.
   * @param failedCases - Stable failed case identities in execution order.
   */
  constructor(failedCases: readonly StreamConformanceCaseId[]) {
    super('Stream conformance failed', {
      code: 'stream_conformance_failed',
      details: { failedCases },
    });
  }
}

/** Input required to run one complete conformance pass. */
export type RunStreamConformanceOptions = Readonly<{
  /** Factory implementation exercised by every case. */
  target: StreamConformanceTarget;

  /** Identity and exact configuration bound into the report. */
  implementation: StreamConformanceImplementation;

  /** Runtime and dependency facts needed to interpret passing evidence. */
  environment: ConformanceEnvironment;

  /** Supplies the evidence timestamp after every case executes. */
  now?: () => Date;
}>;

/**
 * Fails one case with ordinary Error control flow internal to the runner.
 * @param condition - Protocol claim that must hold.
 * @param message - Stable local explanation normalized by the report boundary.
 */
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Pulls one required iterator value or fails the owning conformance case.
 * @param iterator - Iterator attached by the current case.
 * @returns The next non-terminal value.
 */
async function nextValue<Value>(iterator: AsyncIterator<Value>): Promise<Value> {
  /** Preserves the iterator discriminant until absence becomes a case failure. */
  const next = await iterator.next();
  invariant(!next.done, 'The stream completed before its required value');
  return next.value;
}

/** Fixture state shared by current-state and attachment cases. */
type FixtureState = Readonly<{
  /** Monotonic example payload independent of source version metadata. */
  count: number;
}>;

/** Fixture event shared by replay, transient, and operation cases. */
type FixtureEvent = Readonly<{
  /** Small encoded payload used for exact byte accounting. */
  value: string;
}>;

/** Terminal operation result used to prove abort settlement. */
type FixtureOperationResult = Readonly<{
  /** Distinguishes ordinary completion from acknowledged active termination. */
  kind: 'completed' | 'aborted';
}>;

/** Retained close result used after one fixture operation settles. */
type FixtureOperationClose = Readonly<{
  /** Identifies completed retained-handle release. */
  kind: 'closed';
}>;

/**
 * Measures the fixture's encoded payload without relying on object heuristics.
 * @param event - Fixture event admitted by a bounded source.
 * @returns Exact UTF-16-independent ASCII byte length for the fixture value.
 */
function measureFixtureEvent(event: FixtureEvent): number {
  return event.value.length;
}

/** Event encoding shared by every finite ASCII fixture in this suite. */
const fixtureEventEncoding: EventEncoding<FixtureEvent> = Object.freeze({
  revision: 'conformance-event/1',
  /**
   * Copies the flat fixture before it enters source-owned protocol state.
   * @param event - Caller-owned conformance event.
   * @returns A frozen source-owned fixture.
   */
  normalize: (event) => Object.freeze({ ...event }),
  measure: measureFixtureEvent,
});

/** Deterministic UUIDv4 command identity shared only within this suite run. */
const fixtureIdempotencyKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000001');

/**
 * Proves current-state identity, sharing, coalescing, isolation, and close.
 * @param target - Runtime factories under test.
 */
async function liveStateCase(target: StreamConformanceTarget): Promise<void> {
  /** Controls every deferred listener callback without sleeping. */
  const scheduler = new ManualTaskScheduler();
  /** Counts isolated listener failures reported by the source. */
  const failures: unknown[] = [];
  /**
   * Records isolated listener failures without changing source publication.
   * @param error - Listener failure reported by the runtime.
   */
  const onListenerError = (error: unknown): void => {
    failures.push(error);
  };
  /** Owns the current-state source under this case. */
  const state = target.createLiveState<FixtureState>(Object.freeze({ count: 0 }), {
    schedule: scheduler.schedule,
    onListenerError,
  });
  invariant(state.getSnapshot() === state.getSnapshot(), 'Snapshot identity changed without publication');
  /** Records one healthy observer without allowing it to control publication. */
  const observed: FixtureState[] = [];
  state.subscribe((snapshot) => observed.push(snapshot));
  state.subscribe(() => {
    throw new Error('fixture listener failed');
  });
  state.publish(Object.freeze({ count: 1 }));
  state.publish(Object.freeze({ count: 2 }));
  invariant(observed.length === 0, 'Listener ran inside the publication stack');
  scheduler.flushAll();
  invariant(
    [...observed].length === 1 && observed.at(-1)?.count === 2,
    'Latest-state coalescing or hot sharing failed',
  );
  invariant(failures.length === 1, 'Listener failure was not isolated and reported exactly once');
  await state.close();
  state.publish(Object.freeze({ count: 3 }));
  scheduler.flushAll();
  invariant([...observed].length === 1, 'State callback ran after source close');
}

/**
 * Proves late current-state observation, final retention, and post-close silence.
 * @param target - Runtime factories under test.
 */
async function lateLiveStateCase(target: StreamConformanceTarget): Promise<void> {
  /** Controls every observer callback without relying on host timing. */
  const scheduler = new ManualTaskScheduler();
  /** Owns current state before any observer attaches. */
  const state = target.createLiveState<FixtureState>(Object.freeze({ count: 0 }), { schedule: scheduler.schedule });
  /** Becomes the retained final snapshot before late subscription. */
  const final = Object.freeze({ count: 1 });
  state.publish(final);
  invariant(state.getSnapshot() === final, 'LiveState did not retain the exact final published snapshot');
  /** Counts callbacks without treating subscription as snapshot replay. */
  const observed: FixtureState[] = [];
  state.subscribe((snapshot) => observed.push(snapshot));
  scheduler.flushAll();
  invariant(observed.length === 0, 'Late LiveState subscription replayed current state as an event');
  await state.close();
  state.publish(Object.freeze({ count: 2 }));
  scheduler.flushAll();
  invariant(state.getSnapshot() === final, 'LiveState rewrote its final snapshot after close');
  invariant(observed.length === 0, 'Closed LiveState delivered a callback');
  /** A post-close observer has query access only and receives no future callback. */
  const unsubscribe = state.subscribe((snapshot) => observed.push(snapshot));
  unsubscribe();
  invariant(observed.length === 0, 'Post-close LiveState subscription produced work');
}

/**
 * Proves durable fan-out, exact cursor resume, and declared bounds.
 * @param target - Runtime factories under test.
 */
async function replayCase(target: StreamConformanceTarget): Promise<void> {
  /** Owns a small source whose queue limits and retained suffix are observable. */
  const source = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'replay',
    epoch: 'epoch-1',
    retentionItems: 4,
    eventEncoding: fixtureEventEncoding,
    delivery: { capacityItems: 1, capacityBytes: 16, overflow: 'resume-required' },
    maximumDelivery: { capacityItems: 2, capacityBytes: 32 },
  });
  /** Attaches independent queues before source admission. */
  const first = source.subscribe();
  /** Retains a second queue to prove fan-out does not consume the first. */
  const second = source.subscribe();
  source.publish(Object.freeze({ value: 'one' }));
  /** Captures the first delivered cursor as the exact replay position. */
  const firstValue = await nextValue(first[Symbol.asyncIterator]());
  /** Pulls the same admitted value from an independent queue. */
  const secondValue = await nextValue(second[Symbol.asyncIterator]());
  invariant(secondValue.cursor === firstValue.cursor, 'Independent subscribers observed different cursor identity');
  source.publish(Object.freeze({ value: 'two' }));
  /** Reattaches after the delivered cursor with source-approved larger capacity. */
  const replay = source.subscribe({ after: firstValue.cursor, capacityItems: 2 });
  invariant(
    (await nextValue(replay[Symbol.asyncIterator]())).value.value === 'two',
    'Replay did not resume strictly after cursor',
  );
  invariant(source.deliveryLimits.capacityItems === 2, 'Source maximum is not inspectable');
  /** Lags at the current barrier so the second new value forces item overflow. */
  const laggingStart = source.currentCursor();
  /** Retains a one-item queue without pulling from it. */
  const lagging = source.subscribe();
  /** Pulls independently so lagging overflow cannot pressure a healthy subscriber. */
  const healthy = source.subscribe();
  /** Retains the healthy iterator across both new source values. */
  const healthyIterator = healthy[Symbol.asyncIterator]();
  source.publish(Object.freeze({ value: 'three' }));
  invariant(
    (await nextValue(healthyIterator)).value.value === 'three',
    'Replay slow consumer pressured an independent subscriber',
  );
  source.publish(Object.freeze({ value: 'four' }));
  invariant(
    (await nextValue(healthyIterator)).value.value === 'four',
    'Replay healthy subscriber lost the second independently delivered value',
  );
  /** Captures exact resume-required evidence from the item bound. */
  const overflow = await lagging.closed;
  invariant(
    overflow.kind === 'resume-required' && overflow.after === laggingStart,
    'Replay item overflow did not retain its last safe cursor',
  );

  /** Owns a separate source whose first value exceeds its byte bound. */
  const byteBounded = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'replay-byte-bound',
    epoch: 'epoch-1',
    retentionItems: 1,
    eventEncoding: fixtureEventEncoding,
    delivery: { capacityItems: 1, capacityBytes: 3, overflow: 'resume-required' },
  });
  /** Establishes the safe barrier reported when the four-byte event cannot fit. */
  const byteStart = byteBounded.currentCursor();
  /** Retains one byte-constrained subscriber without a pending pull. */
  const byteSubscription = byteBounded.subscribe();
  byteBounded.publish(Object.freeze({ value: 'four' }));
  /** Captures exact resume evidence from byte rather than item exhaustion. */
  const byteOverflow = await byteSubscription.closed;
  invariant(
    byteOverflow.kind === 'resume-required' && byteOverflow.after === byteStart,
    'Replay byte overflow did not retain its last safe cursor',
  );
  await first.close();
  await second.close();
  await replay.close();
  await healthy.close();
  await byteBounded.close();
  await source.close();
}

/**
 * Proves cursor identity, retention admission, iterator return, and closed-source behavior.
 * @param target - Runtime factories under test.
 */
async function replayLifecycleCase(target: StreamConformanceTarget): Promise<void> {
  /** Owns the replay source whose identities and retention are authoritative. */
  const source = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'replay-lifecycle',
    epoch: 'epoch-1',
    retentionItems: 1,
    eventEncoding: fixtureEventEncoding,
  });
  /** Round-trips the public branded cursor without a cast or private symbol. */
  const decodedCurrent = source.cursorCodec.decode(source.currentCursor());
  invariant(decodedCurrent.ok && decodedCurrent.value.offset === '0', 'Public cursor codec did not round-trip');
  /** Captures a cursor that will expire when a one-item suffix advances twice. */
  const expired = source.currentCursor();
  source.publish(Object.freeze({ value: 'one' }));
  source.publish(Object.freeze({ value: 'two' }));
  invariant(
    (await source.subscribe({ after: expired }).closed).kind === 'reseed-required',
    'Replay did not refuse an expired retention position',
  );

  /** Creates the same cursor family with a different logical stream identity. */
  const foreign = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'foreign-stream',
    epoch: 'epoch-1',
    retentionItems: 1,
    eventEncoding: fixtureEventEncoding,
  });
  /** Runtime identity must reject what the compile-time source family cannot distinguish. */
  const foreignClose = await source.subscribe({ after: foreign.currentCursor() }).closed;
  invariant(
    foreignClose.kind === 'failed' && foreignClose.failure.code === 'cursor_stream_mismatch',
    'Replay accepted a cursor from another logical stream',
  );

  /** Creates the same logical stream under a different authorization scope. */
  const foreignScope = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'other-suite',
    streamId: 'replay-lifecycle',
    epoch: 'epoch-1',
    retentionItems: 1,
    eventEncoding: fixtureEventEncoding,
  });
  /** Scope identity is validated before any retention claim is considered. */
  const scopeClose = await source.subscribe({ after: foreignScope.currentCursor() }).closed;
  invariant(
    scopeClose.kind === 'failed' && scopeClose.failure.code === 'cursor_scope_mismatch',
    'Replay accepted a cursor from another authorization scope',
  );

  /** Binds an otherwise identical stream to a different event protocol revision. */
  const revisedEncoding: EventEncoding<FixtureEvent> = Object.freeze({
    ...fixtureEventEncoding,
    revision: 'conformance-event/2',
  });
  /** Owns the source for the mismatched revision cursor. */
  const foreignRevision = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'replay-lifecycle',
    epoch: 'epoch-1',
    retentionItems: 1,
    eventEncoding: revisedEncoding,
  });
  /** Protocol revision is part of cursor identity, not an advisory label. */
  const revisionClose = await source.subscribe({ after: foreignRevision.currentCursor() }).closed;
  invariant(
    revisionClose.kind === 'failed' && revisionClose.failure.code === 'cursor_revision_mismatch',
    'Replay accepted a cursor from another protocol revision',
  );

  /** Replaces only the generation under otherwise identical cursor identity. */
  const replacement = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'replay-lifecycle',
    epoch: 'epoch-2',
    retentionItems: 1,
    eventEncoding: fixtureEventEncoding,
  });
  /** A replaced generation requires a fresh state seed rather than cursor replay. */
  const replacementClose = await replacement.subscribe({ after: source.currentCursor() }).closed;
  invariant(
    replacementClose.kind === 'reseed-required' && replacementClose.reason === 'source-replaced',
    'Replay treated a replaced source generation as retained history',
  );

  /** Owns a dedicated replay suffix for caller-alias normalization proof. */
  const normalized = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'replay-normalization',
    epoch: 'epoch-1',
    retentionItems: 1,
    eventEncoding: fixtureEventEncoding,
  });
  /** Captures the replay barrier before admitting mutable caller input. */
  const beforeMutable = normalized.currentCursor();
  /** Remains caller-owned and writable after publication. */
  const mutable = { value: 'before' };
  normalized.publish(mutable);
  mutable.value = 'after';
  /** Replays the source-owned normalized value rather than the caller alias. */
  const normalizedReplay = normalized.subscribe({ after: beforeMutable });
  invariant(
    (await nextValue(normalizedReplay[Symbol.asyncIterator]())).value.value === 'before',
    'Replay retained a caller-mutable event alias',
  );

  /** Proves AsyncIterator return delegates to subscriber-local detachment. */
  const detachable = source.subscribe();
  await detachable[Symbol.asyncIterator]().return?.();
  invariant((await detachable.closed).kind === 'detached', 'Replay iterator return did not detach its queue');

  await foreign.close();
  await foreignScope.close();
  await foreignRevision.close();
  await replacement.close();
  await normalizedReplay.close();
  await normalized.close();
  await source.close();
  /** A source closed before attachment must complete without reviving retained history. */
  const late = source.subscribe();
  invariant((await late.closed).kind === 'completed', 'Closed replay source did not complete a late subscription');
  invariant((await late[Symbol.asyncIterator]().next()).done === true, 'Closed replay source yielded a late value');
}

/**
 * Proves subscriber-local transient overflow and exact gap accounting.
 * @param target - Runtime factories under test.
 */
async function transientCase(target: StreamConformanceTarget): Promise<void> {
  /** Owns one presentation source with an intentionally tiny queue. */
  const source = target.createTransientEventSource<FixtureEvent>({
    source: 'conformance-transient',
    epoch: 'epoch-1',
    eventEncoding: fixtureEventEncoding,
    delivery: { capacityItems: 1, capacityBytes: 16, overflow: 'gap' },
  });
  /** Lags deliberately so two values become one exact gap. */
  const slow = source.subscribe();
  /** Pulls ahead independently to prove one subscriber cannot pressure another. */
  const healthy = source.subscribe();
  /** Retains the healthy iterator across each publication. */
  const healthyIterator = healthy[Symbol.asyncIterator]();
  source.publish(Object.freeze({ value: 'one' }));
  await nextValue(healthyIterator);
  source.publish(Object.freeze({ value: 'two' }));
  await nextValue(healthyIterator);
  source.publish(Object.freeze({ value: 'three' }));
  await nextValue(healthyIterator);
  /** Drains the accepted predecessor and then the exact coalesced loss marker. */
  const slowIterator = slow[Symbol.asyncIterator]();
  await nextValue(slowIterator);
  /** Captures the subscriber-local loss marker following its accepted predecessor. */
  const gap = await nextValue(slowIterator);
  invariant(gap.kind === 'gap', 'Transient loss did not produce a gap marker');
  invariant(
    gap.source === 'conformance-transient' && gap.epoch === 'epoch-1',
    'Transient gap did not retain source generation identity',
  );
  invariant(gap.lostItems === '2' && gap.lostBytes === '8', 'Transient gap counts were not exact');

  /** Owns a replacement epoch with one event larger than its byte bound. */
  const byteBounded = target.createTransientEventSource<FixtureEvent>({
    source: 'conformance-transient',
    epoch: 'epoch-2',
    eventEncoding: fixtureEventEncoding,
    delivery: { capacityItems: 1, capacityBytes: 3, overflow: 'gap' },
  });
  /** Retains the control reserve for an otherwise empty subscriber queue. */
  const byteSubscription = byteBounded.subscribe();
  byteBounded.publish(Object.freeze({ value: 'four' }));
  /** Captures exact byte-bound loss from the replacement generation. */
  const byteGap = await nextValue(byteSubscription[Symbol.asyncIterator]());
  invariant(
    byteGap.kind === 'gap' && byteGap.epoch === 'epoch-2' && byteGap.lostBytes === '4',
    'Transient byte overflow or replacement epoch evidence was incorrect',
  );
  await slow.close();
  await healthy.close();
  await byteSubscription.close();
  await byteBounded.close();
  await source.close();
}

/**
 * Proves transient detachment, iterator lifecycle, closed behavior, and capability honesty.
 * @param target - Runtime factories under test.
 */
async function transientLifecycleCase(target: StreamConformanceTarget): Promise<void> {
  /** Owns one source whose slow queue detaches while a pending healthy pull survives. */
  const source = target.createTransientEventSource<FixtureEvent>({
    source: 'conformance-transient-lifecycle',
    epoch: 'epoch-1',
    eventEncoding: fixtureEventEncoding,
    delivery: { capacityItems: 1, capacityBytes: 16, overflow: 'detach' },
  });
  invariant(!('currentCursor' in source), 'Transient source accidentally claimed cursor replay capability');
  /** Lags deliberately until the second value exceeds its one-item queue. */
  const slow = source.subscribe();
  /** Holds a pending pull so independent delivery cannot be blocked by the slow queue. */
  const healthy = source.subscribe();
  /** Retains one healthy iterator across source publication. */
  const healthyIterator = healthy[Symbol.asyncIterator]();
  /** Starts the healthy pull before fan-out. */
  const healthyNext = healthyIterator.next();
  source.publish(Object.freeze({ value: 'one' }));
  source.publish(Object.freeze({ value: 'two' }));
  invariant((await slow.closed).kind === 'detached', 'Transient overflow did not detach only the slow queue');
  /** Proves the independent healthy queue received source data. */
  const healthyValue = await healthyNext;
  invariant(
    !healthyValue.done && healthyValue.value.kind === 'event' && healthyValue.value.value.value === 'one',
    'Healthy transient subscriber was controlled by a slow subscriber',
  );
  await healthyIterator.return?.();
  invariant((await healthy.closed).kind === 'detached', 'Transient iterator return did not detach its queue');
  await source.close();
  /** A post-close transient subscriber must complete without replay. */
  const late = source.subscribe();
  invariant((await late.closed).kind === 'completed', 'Closed transient source did not complete a late subscription');
  invariant((await late[Symbol.asyncIterator]().next()).done === true, 'Closed transient source replayed a value');

  /** Deliberately gives application data the same fields as a delivery gap. */
  type GapShapedEvent = Readonly<{
    /** Matches the reserved discriminator only inside application data. */
    kind: 'gap';

    /** Matches ordinary gap source evidence. */
    source: string;

    /** Matches ordinary gap generation evidence. */
    epoch: string;

    /** Matches ordinary gap item evidence. */
    lostItems: string;

    /** Matches ordinary gap byte evidence. */
    lostBytes: string;
  }>;
  /** Owns a source proving the outer delivery frame reserves control identity. */
  const framed = target.createTransientEventSource<GapShapedEvent>({
    source: 'conformance-framed',
    epoch: 'epoch-1',
    eventEncoding: {
      revision: 'conformance-gap-shaped/1',
      /**
       * Copies the flat hostile application value before fan-out.
       * @param event - Caller-owned gap-shaped data.
       * @returns A source-owned immutable application event.
       */
      normalize: (event) => Object.freeze({ ...event }),
      /**
       * Charges one fixture byte independently of its hostile shape.
       * @returns One encoded fixture byte.
       */
      measure: () => 1,
    },
  });
  /** Attaches before publishing the gap-shaped application value. */
  const framedSubscription = framed.subscribe();
  framed.publish({
    kind: 'gap',
    source: 'application',
    epoch: 'application',
    lostItems: '7',
    lostBytes: '11',
  });
  /** Captures the outer frame whose identity the application cannot forge. */
  const framedDelivery = await nextValue(framedSubscription[Symbol.asyncIterator]());
  invariant(
    framedDelivery.kind === 'event' && framedDelivery.value.kind === 'gap',
    'Transient application data impersonated source-owned gap evidence',
  );
  await framedSubscription.close();
  await framed.close();
}

/**
 * Proves queue-before-seed attachment and final state drain across source close.
 * @param target - Runtime factories under test.
 */
async function attachmentCase(target: StreamConformanceTarget): Promise<void> {
  /** Prevents the ordinary state callback from racing the close assertion. */
  const scheduler = new ManualTaskScheduler();
  /** Owns versioned state seeded at zero. */
  const state = target.createVersionedLiveState<FixtureState>(Object.freeze({ count: 0 }), {
    source: 'conformance-state',
    epoch: 'epoch-1',
    schedule: scheduler.schedule,
  });
  /** Owns one selectable transient plane. */
  const activity = target.createTransientEventSource<FixtureEvent>({
    source: 'conformance-activity',
    epoch: 'epoch-1',
    eventEncoding: fixtureEventEncoding,
  });
  /** Builds an attachment without inventing durable history. */
  const bridge = target.createAtomicLiveAttachmentSource({ state, transient: { activity } });
  /** Installs queues and captures a version-zero seed. */
  const attachment = await bridge.attachLive({ transient: { activity: {} } });
  invariant(attachment.seed.state.version === '0', 'Atomic seed was not captured at the attachment barrier');
  StateVersionSchema.parse(attachment.seed.state.version);
  /** Waits before the terminal publication to cover a pending pull. */
  const iterator = attachment.stateUpdates[Symbol.asyncIterator]();
  /** Retains a pending pull while the source publishes and immediately closes. */
  const pending = iterator.next();
  state.publish(Object.freeze({ count: 1 }));
  await state.close();
  /** Captures the source's final queued version after natural close. */
  const final = await pending;
  invariant(!final.done && final.value.version === '1', 'Final versioned snapshot was lost during source close');
  invariant((await iterator.next()).done === true, 'State lane did not complete after final snapshot drain');
  await attachment.close();
  await activity.close();
}

/**
 * Proves optional planes, setup rollback, latest-slot state, and borrowed-source survival.
 * @param target - Runtime factories under test.
 */
async function attachmentPlanesCase(target: StreamConformanceTarget): Promise<void> {
  /** Controls state notification and attachment-local coalescing deterministically. */
  const scheduler = new ManualTaskScheduler();
  /** Owns versioned state with an explicit generation. */
  const state = target.createVersionedLiveState<FixtureState>(Object.freeze({ count: 0 }), {
    source: 'conformance-state',
    epoch: 'state-epoch-1',
    schedule: scheduler.schedule,
  });
  /** Owns the optional durable observation plane. */
  const durable = target.createReplayableEventSource<FixtureEvent, 'conformance'>({
    source: 'conformance',
    scope: 'suite',
    streamId: 'attachment-durable',
    epoch: 'durable-epoch-1',
    retentionItems: 4,
    eventEncoding: fixtureEventEncoding,
  });
  /** Owns the selected transient plane. */
  const activity = target.createTransientEventSource<FixtureEvent>({
    source: 'conformance-activity',
    epoch: 'activity-epoch-1',
    eventEncoding: fixtureEventEncoding,
  });
  /** Owns a second plane used first to prove setup rollback. */
  const failingBase = target.createTransientEventSource<FixtureEvent>({
    source: 'conformance-failing',
    epoch: 'failing-epoch-1',
    eventEncoding: fixtureEventEncoding,
  });
  /** Captures the earlier successful queue that setup failure must release. */
  let rolledBack: ReturnType<typeof activity.subscribe> | undefined;
  /** Observes the first plane's real subscription without changing its protocol. */
  const trackedActivity: typeof activity = {
    ...activity,
    /**
     * Records the queue created before the next plane fails.
     * @param options - Selected transient delivery contract.
     * @returns The real source subscription.
     */
    subscribe(options) {
      rolledBack = activity.subscribe(options);
      return rolledBack;
    },
  };
  /** Rejects construction after earlier state, durable, and transient queues exist. */
  const failing: typeof failingBase = {
    ...failingBase,
    /** Throws the setup fault that the attachment transaction must roll back. */
    subscribe() {
      throw new Error('conformance attachment setup failed');
    },
  };
  /** Owns the deliberately failing composition transaction. */
  const failingBridge = target.createAtomicLiveAttachmentSource({
    state,
    durable,
    transient: { activity: trackedActivity, failing },
  });
  /** Captures the expected asynchronous setup rejection. */
  let setupRejected = false;
  try {
    await failingBridge.attachLive({ transient: { activity: {}, failing: {} } });
  } catch {
    setupRejected = true;
  }
  invariant(setupRejected, 'Atomic attachment did not reject a child setup failure');
  invariant((await rolledBack?.closed)?.kind === 'detached', 'Atomic attachment did not roll back an earlier queue');

  /** Builds the valid bridge with one selected and one omitted transient plane. */
  const bridge = target.createAtomicLiveAttachmentSource({
    state,
    durable,
    transient: { activity, omitted: failingBase },
  });
  /** Attaches exactly the activity plane while retaining optional durable facts. */
  const attachment = await bridge.attachLive({ transient: { activity: {} } });
  invariant(attachment.seed.durable !== undefined, 'Atomic seed omitted its configured durable barrier');
  invariant(
    Object.keys(attachment.transient).length === 1 && 'activity' in attachment.transient,
    'Atomic attachment ignored typed transient-plane selection',
  );
  /** Publishes two states before notification so only the latest slot survives. */
  const one = Object.freeze({ count: 1 });
  /** Becomes the exact application snapshot retained by the latest version. */
  const two = Object.freeze({ count: 2 });
  state.publish(one);
  state.publish(two);
  scheduler.flushAll();
  /** Pulls the attachment-local latest state without any client-side reducer. */
  const update = await nextValue(attachment.stateUpdates[Symbol.asyncIterator]());
  invariant(update.version === '2' && update.snapshot === two, 'Atomic state lane failed latest-slot coalescing');
  /** Coordinates detachment through one immutable owner result. */
  const detached = await attachment.close();
  invariant((await attachment.closed) === detached, 'Attachment close paths did not share one evidence value');

  /** Proves coordinated detach did not close the borrowed durable source. */
  const durableAfter = durable.subscribe({ after: attachment.seed.durable?.at });
  durable.publish(Object.freeze({ value: 'still-owned' }));
  invariant(
    (await nextValue(durableAfter[Symbol.asyncIterator]())).value.value === 'still-owned',
    'Attachment close acquired authority over a borrowed durable source',
  );
  /** Proves coordinated detach did not close the borrowed transient source. */
  const activityAfter = activity.subscribe();
  /** Starts the pull before source publication to avoid queue timing assumptions. */
  const activityNext = activityAfter[Symbol.asyncIterator]().next();
  activity.publish(Object.freeze({ value: 'still-owned' }));
  /** Reads the ordinary event frame returned by the surviving source. */
  const activityValue = await activityNext;
  invariant(
    !activityValue.done && activityValue.value.kind === 'event',
    'Attachment close acquired authority over a borrowed transient source',
  );
  await durableAfter.close();
  await activityAfter.close();
  await state.close();
  await durable.close();
  await activity.close();
  await failingBase.close();
}

/**
 * Proves single operation activation, progress seal, and terminal abort evidence.
 * @param target - Runtime factories under test.
 */
async function operationCase(target: StreamConformanceTarget): Promise<void> {
  /** Keeps terminal result under deterministic suite control. */
  const terminal = createDeferredTask<FixtureOperationResult>();
  /** Counts adapter activation independently of public subscribers. */
  let starts = 0;
  /** Captures the admitted progress publisher. */
  let emit: ((event: FixtureEvent) => void) | undefined;
  /** Owns the finite attempt under test. */
  const operation = target.createLiveOperation<FixtureEvent, FixtureOperationResult, FixtureOperationClose>({
    source: 'conformance-operation',
    epoch: 'attempt-1',
    eventEncoding: fixtureEventEncoding,
    delivery: { capacityItems: 2, capacityBytes: 32, overflow: 'gap' },
    /**
     * Activates the fixture adapter once and leaves settlement under case control.
     * @param context - Progress and abort capabilities for the admitted attempt.
     * @returns The manually controlled terminal result promise.
     */
    start: (context) => {
      starts += 1;
      emit = context.emit;
      return terminal.promise;
    },
    /**
     * Maps operation settlement into one retained close value.
     * @returns Immutable retained-handle close evidence.
     */
    closeEvidence: () => Object.freeze({ kind: 'closed' }),
    /**
     * Classifies tagged aborted result or bounded cleanup failure.
     * @param settlement - Terminal adapter result or normalized failure.
     * @returns Terminal abort disposition suitable for command evidence.
     */
    classifyAbort: (settlement): AttemptAbortDisposition =>
      settlement.kind === 'failed'
        ? Object.freeze({ kind: 'cleanup-unproved', failure: settlement.error })
        : Object.freeze({
            kind: 'attempt-settled',
            outcome: settlement.value.kind === 'aborted' ? 'aborted' : 'completed',
          }),
  });
  /** Observes the already-running attempt without triggering another start. */
  const subscription = operation.events.subscribe();
  emit?.(Object.freeze({ value: 'one' }));
  /** Requests active termination and retains its terminal evidence promise. */
  const abort = operation.abort({ reason: 'suite', idempotencyKey: fixtureIdempotencyKey });
  terminal.resolve(Object.freeze({ kind: 'aborted' }));
  invariant((await operation.result).kind === 'aborted', 'Operation did not expose its one tagged result');
  invariant(starts === 1, 'Operation activated more than once');
  invariant((await abort).kind === 'attempt-settled', 'Abort resolved without terminal attempt evidence');
  /** Pulls the accepted source event while keeping gap evidence distinguishable. */
  const progress = await nextValue(subscription[Symbol.asyncIterator]());
  invariant(progress.kind === 'event', 'Accepted operation progress was replaced by a gap');
  invariant(progress.value.value === 'one', 'Accepted progress did not drain');
  invariant((await subscription[Symbol.asyncIterator]().next()).done === true, 'Progress did not seal after result');
  await operation.close();
}

/**
 * Proves completion/abort/close races, FIFO drain, cleanup failure, and late observation.
 * @param target - Runtime factories under test.
 */
async function operationRacesCase(target: StreamConformanceTarget): Promise<void> {
  /** Keeps the completion-winning attempt under deterministic control. */
  const terminal = createDeferredTask<FixtureOperationResult>();
  /** Captures progress publication before and after result settlement. */
  let emit: ((event: FixtureEvent) => void) | undefined;
  /** Owns one attempt whose slow subscriber cannot control result or close. */
  const operation = target.createLiveOperation<FixtureEvent, FixtureOperationResult, FixtureOperationClose>({
    source: 'conformance-operation-race',
    epoch: 'attempt-1',
    eventEncoding: fixtureEventEncoding,
    delivery: { capacityItems: 4, capacityBytes: 64, overflow: 'gap' },
    /**
     * Retains progress capability while terminal settlement remains controlled.
     * @param context - Attempt progress and cancellation capabilities.
     * @returns The manually settled completion result.
     */
    start(context) {
      emit = context.emit;
      return terminal.promise;
    },
    /**
     * Maps any terminal settlement into one retained handle result.
     * @returns Immutable retained operation close evidence.
     */
    closeEvidence: () => Object.freeze({ kind: 'closed' }),
    /**
     * Classifies whether completion or cleanup failure won the abort race.
     * @param settlement - Normalized terminal adapter settlement.
     * @returns Terminal abort evidence.
     */
    classifyAbort: (settlement): AttemptAbortDisposition =>
      settlement.kind === 'failed'
        ? Object.freeze({ kind: 'cleanup-unproved', failure: settlement.error })
        : Object.freeze({ kind: 'attempt-settled', outcome: settlement.value.kind }),
  });
  /** Retains accepted progress without pulling until result and close settle. */
  const slow = operation.events.subscribe();
  emit?.(Object.freeze({ value: 'one' }));
  emit?.(Object.freeze({ value: 'two' }));
  /** Issues one command twice to prove idempotent promise identity. */
  const abort = operation.abort({ reason: 'suite-race', idempotencyKey: fixtureIdempotencyKey });
  /** Retries the exact same command without signaling twice. */
  const repeatedAbort = operation.abort({ reason: 'suite-race', idempotencyKey: fixtureIdempotencyKey });
  invariant(abort === repeatedAbort, 'Repeated operation abort did not reuse command settlement');
  /** Begins retained-handle close while completion and a slow subscriber remain outstanding. */
  const closing = operation.close();
  terminal.resolve(Object.freeze({ kind: 'completed' }));
  invariant((await operation.result).kind === 'completed', 'Completion did not win the abort race');
  invariant((await abort).kind === 'attempt-settled', 'Completion-winning abort lacked terminal evidence');
  /** Close must settle independently of subscriber drain. */
  const closeEvidence = await closing;
  invariant((await operation.closed) === closeEvidence, 'Operation close paths did not share evidence');
  /** Must be refused because result settlement already sealed progress acceptance. */
  emit?.(Object.freeze({ value: 'too-late' }));
  /** Drains the two values accepted before settlement in FIFO order. */
  const slowIterator = slow[Symbol.asyncIterator]();
  /** Captures the first accepted event frame. */
  const first = await nextValue(slowIterator);
  /** Captures the second accepted event frame. */
  const second = await nextValue(slowIterator);
  invariant(
    first.kind === 'event' && second.kind === 'event' && first.value.value === 'one' && second.value.value === 'two',
    'Operation progress did not drain in accepted FIFO order',
  );
  invariant((await slowIterator.next()).done === true, 'Operation accepted progress after result settlement');
  /** A late subscriber observes completion without starting or replaying work. */
  const late = operation.events.subscribe();
  invariant((await late.closed).kind === 'completed', 'Late operation subscriber did not complete');
  invariant((await late[Symbol.asyncIterator]().next()).done === true, 'Late operation subscriber replayed progress');

  /** Keeps the cleanup-unproved branch independent of completion-winning evidence. */
  const rejected = createDeferredTask<FixtureOperationResult>();
  /** Owns one attempt whose adapter rejects after accepting abort. */
  const failing = target.createLiveOperation<FixtureEvent, FixtureOperationResult, FixtureOperationClose>({
    source: 'conformance-operation-cleanup',
    epoch: 'attempt-2',
    eventEncoding: fixtureEventEncoding,
    /**
     * Returns the manually rejected adapter promise.
     * @returns The test-controlled terminal adapter promise.
     */
    start: () => rejected.promise,
    /**
     * Maps cleanup failure into a releasable retained handle.
     * @returns Immutable retained operation close evidence.
     */
    closeEvidence: () => Object.freeze({ kind: 'closed' }),
    /**
     * Preserves cleanup failure as bounded abort evidence.
     * @param settlement - Normalized rejected adapter settlement.
     * @returns Cleanup-unproved evidence for failure, otherwise completion.
     */
    classifyAbort: (settlement): AttemptAbortDisposition =>
      settlement.kind === 'failed'
        ? Object.freeze({ kind: 'cleanup-unproved', failure: settlement.error })
        : Object.freeze({ kind: 'attempt-settled', outcome: settlement.value.kind }),
  });
  /** Uses a second deterministic command identity for the failing attempt. */
  const cleanupKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000002');
  /** Retains terminal cleanup evidence before rejecting the adapter. */
  const cleanupAbort = failing.abort({ reason: 'suite-cleanup', idempotencyKey: cleanupKey });
  rejected.reject(new Error('private cleanup detail'));
  await failing.result.catch(() => undefined);
  invariant((await cleanupAbort).kind === 'cleanup-unproved', 'Rejected cleanup was reported as settled');
  await failing.close();
}

/** Pairs each public case description with its framework-neutral executable proof. */
const executableCases: Readonly<Record<StreamConformanceCaseId, (target: StreamConformanceTarget) => Promise<void>>> =
  Object.freeze({
    'live-state.identity-sharing-isolation': liveStateCase,
    'live-state.late-final-close': lateLiveStateCase,
    'attachment.atomic-barrier-final-state': attachmentCase,
    'attachment.planes-races-detach': attachmentPlanesCase,
    'replay.bounds-resume-fanout': replayCase,
    'replay.cursor-retention-lifecycle': replayLifecycleCase,
    'transient.gap-bounds-epochs': transientCase,
    'transient.detach-lifecycle-capability': transientLifecycleCase,
    'operation.single-start-terminal-abort': operationCase,
    'operation.races-fifo-late': operationRacesCase,
  });

/**
 * Runs every required stream case without skipping after an earlier failure.
 * @param options - Factory target plus implementation and configuration identity.
 * @returns A frozen diagnostic report bound to the complete required case set.
 */
export async function runStreamConformance(options: RunStreamConformanceOptions): Promise<StreamConformanceReport> {
  if (options.implementation.name.length === 0 || options.implementation.version.length === 0) {
    throw new RangeError('Conformance implementation name and version must not be empty');
  }
  /** Copies and freezes implementation configuration at the conformance boundary. */
  const implementation = Object.freeze({
    name: options.implementation.name,
    version: options.implementation.version,
    configuration: JsonObjectSchema.parse(options.implementation.configuration),
  });
  /** Copies environment evidence independently of caller mutation. */
  const environment = normalizeConformanceEnvironment(options.environment);
  /** Binds the report to the exact immutable implementation configuration. */
  const configurationDigest = await digestConformanceValue(implementation.configuration);
  /** Retains the catalogue independently of the result array. */
  const requiredCases = Object.freeze(STREAM_CONFORMANCE_CASES.map((testCase) => testCase.id));
  /** Retains every required result even when an earlier case fails. */
  const results: StreamConformanceCaseResult[] = [];
  /** Executes each published case exactly once in catalogue order. */
  for (const testCase of STREAM_CONFORMANCE_CASES) {
    try {
      await executableCases[testCase.id](options.target);
      results.push(Object.freeze({ id: testCase.id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id: testCase.id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'stream_conformance_case_failed',
            message: `Required stream conformance case failed: ${testCase.id}`,
          }),
        }),
      );
    }
  }
  /** Accounts explicitly for every published case rather than inferring skips. */
  const execution = conformanceExecution(requiredCases.length, results.length);
  /** Passing requires every required case to execute successfully. */
  const status = execution.skipped === 0 && results.every((result) => result.status === 'passed') ? 'passed' : 'failed';
  /**
   * Supplies wall time only when the conformance harness did not inject a clock.
   * @returns The host's current instant.
   */
  const defaultNow = (): Date => new Date();
  /** Reads the evidence clock once after the complete result set exists. */
  const at = conformanceTimestamp(options.now ?? defaultNow);
  /** Constructs the complete digest body without its self-referential hash. */
  const evidenceBody = Object.freeze({
    schema: 1,
    protocol: '@archer/core/stream',
    suiteVersion: STREAM_CONFORMANCE_VERSION,
    implementation,
    configurationDigest,
    at,
    environment,
    execution,
    requiredCases,
    status,
    cases: Object.freeze(results),
  });
  /** Makes any later report-body rewrite detectable by evidence consumers. */
  const evidenceDigest = await digestConformanceValue(evidenceBody);
  return Object.freeze({ ...evidenceBody, evidenceDigest });
}

/**
 * Promotes only a complete passing report into reusable conformance evidence.
 * @param report - Diagnostic report returned by the matching suite version.
 * @returns A promise of passing evidence or a focused Archer Error naming failed cases.
 */
export async function requirePassingStreamConformance(
  report: StreamConformanceReport,
): Promise<ResultValue<PassingStreamConformance, StreamConformanceError>> {
  /** Retains the exact required identities for metadata and result comparison. */
  const required = STREAM_CONFORMANCE_CASES.map((testCase) => testCase.id);
  /** Copies and freezes untrusted report data before an asynchronous integrity check. */
  const admitted = StreamConformanceReportSchema.safeParse(report);
  if (!admitted.success) return Result.error(new StreamConformanceError(required));
  /** Uses the deeply immutable report admitted by the public runtime schema. */
  const candidate = admitted.data;
  /** Proves required catalogue identity rather than trusting the summary status. */
  const catalogueMatches =
    candidate.requiredCases.length === required.length &&
    candidate.requiredCases.every((id, index) => id === required[index]);
  /** Proves every required case produced one ordered successful result with no skip. */
  const resultsComplete =
    candidate.cases.length === required.length &&
    candidate.cases.every((testCase, index) => testCase.id === required[index] && testCase.status === 'passed');
  /** Proves evidence metadata belongs to the selected protocol and report codecs. */
  const metadataValid =
    candidate.protocol === '@archer/core/stream' &&
    candidate.suiteVersion === STREAM_CONFORMANCE_VERSION &&
    candidate.execution.required === required.length &&
    candidate.execution.executed === required.length &&
    candidate.execution.skipped === 0 &&
    TimestampSchema.safeParse(candidate.at).success &&
    Sha256DigestSchema.safeParse(candidate.configurationDigest).success &&
    Sha256DigestSchema.safeParse(candidate.evidenceDigest).success &&
    JsonObjectSchema.safeParse(candidate.environment).success;
  /** Removes the self-referential claim before recomputing the complete report-body digest. */
  const { evidenceDigest: claimedEvidenceDigest, ...evidenceBody } = candidate;
  /** Verifies content rather than accepting digest-shaped strings as proof. */
  const digestsValid =
    metadataValid &&
    (await conformanceDigestsMatch({
      configuration: candidate.implementation.configuration,
      configurationDigest: candidate.configurationDigest,
      evidence: evidenceBody,
      evidenceDigest: claimedEvidenceDigest,
    }));
  if (candidate.status === 'passed' && catalogueMatches && resultsComplete && metadataValid && digestsValid) {
    return Result.ok(candidate as PassingStreamConformance);
  }
  /** Treats invalid or incomplete metadata as failure of the full required set. */
  const failed =
    catalogueMatches && metadataValid && digestsValid
      ? required.filter((id, index) => candidate.cases[index]?.id !== id || candidate.cases[index]?.status !== 'passed')
      : required;
  return Result.error(new StreamConformanceError(failed));
}
