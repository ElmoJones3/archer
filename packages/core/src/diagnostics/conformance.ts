/**
 * @file Publishes the versioned, framework-neutral conformance suite for
 * Archer's product-neutral diagnostics protocol.
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
import { borrowed, owned, type OwnedHandle } from '../ownership.js';
import { PublicErrorSchema, toPublicError, type PublicError } from '../protocol.js';
import { Result, type Result as ResultValue } from '../result.js';
import { createDeferredTask } from '../stream/testing.js';
import { JsonObjectSchema, Sha256DigestSchema, TimestampSchema, type JsonObject } from '../values.js';
import type {
  DiagnosticAttachmentCloseEvidence,
  DiagnosticRecord,
  DiagnosticSink,
  DiagnosticSinkCloseEvidence,
} from './contracts.js';
import { createDiagnosticRecord, createDiagnostics } from './hub.js';

/** Selects the exact diagnostic report schema and required case set. */
export const DIAGNOSTICS_CONFORMANCE_VERSION = '1.0.0';

/** Stable identities of the required v1 diagnostic cases. */
export type DiagnosticsConformanceCaseId =
  | 'record.normalization-redaction'
  | 'sink.independent-order-no-retry'
  | 'sink.failure-policy-accounting'
  | 'overflow.exact-bounds-cardinality'
  | 'shutdown.flush-close-ownership'
  | 'shutdown.deadline-close-evidence'
  | 'runtime.lifecycle-non-interference';

/** One published diagnostic protocol claim. */
export type DiagnosticsConformanceCase = Readonly<{
  /** Stable identity preserved across compatible suite patches. */
  id: DiagnosticsConformanceCaseId;

  /** Human-readable protocol claim executed by the suite. */
  claim: string;
}>;

/** Complete required diagnostic case catalogue in execution order. */
export const DIAGNOSTICS_CONFORMANCE_CASES: readonly DiagnosticsConformanceCase[] = Object.freeze([
  Object.freeze({
    id: 'record.normalization-redaction',
    claim: 'Records normalize time, own schema fields, freeze JSON data, and keep native errors out.',
  }),
  Object.freeze({
    id: 'sink.independent-order-no-retry',
    claim: 'Each sink has independent ordered writes and one rejected write is never retried implicitly.',
  }),
  Object.freeze({
    id: 'sink.failure-policy-accounting',
    claim: 'Detach and continue policies report truthful outcomes plus exact accepted and dropped accounting.',
  }),
  Object.freeze({
    id: 'overflow.exact-bounds-cardinality',
    claim: 'Item and byte overflow report exact totals plus cardinality-bounded component and severity breakdown.',
  }),
  Object.freeze({
    id: 'shutdown.flush-close-ownership',
    claim: 'Accepted writes precede flush, owned sinks then close, and borrowed sinks remain caller-owned.',
  }),
  Object.freeze({
    id: 'shutdown.deadline-close-evidence',
    claim: 'Hung write, flush, or owned close cannot block shutdown and retain terminal evidence.',
  }),
  Object.freeze({
    id: 'runtime.lifecycle-non-interference',
    claim: 'Runtime lifecycle diagnostics stay publicly visible while remaining unable to change domain state.',
  }),
]);

/** Public factory port implemented by one diagnostic runtime under test. */
export type DiagnosticsConformanceTarget = Readonly<{
  /** Constructs normalized diagnostic records. */
  createDiagnosticRecord: typeof createDiagnosticRecord;

  /** Constructs retained diagnostic dispatchers. */
  createDiagnostics: typeof createDiagnostics;
}>;

/** First-party bounded dispatcher port exercised by Archer's own proof. */
export const CORE_DIAGNOSTICS_CONFORMANCE_TARGET: DiagnosticsConformanceTarget = Object.freeze({
  createDiagnosticRecord,
  createDiagnostics,
});

/** Binds one report to an exact implementation and configuration. */
export type DiagnosticsConformanceImplementation = Readonly<{
  /** Stable implementation or package name. */
  name: string;

  /** Exact implementation version or source revision. */
  version: string;

  /** Immutable configuration whose guarantees the report covers. */
  configuration: JsonObject;
}>;

/** One required diagnostic case that satisfied its complete assertion set. */
export type PassedDiagnosticsConformanceCase = Readonly<{
  /** Identifies the required case that ran. */
  id: DiagnosticsConformanceCaseId;

  /** Confirms every assertion in the case passed. */
  status: 'passed';
}>;

/** One required diagnostic case that produced bounded failure evidence. */
export type FailedDiagnosticsConformanceCase = Readonly<{
  /** Identifies the required case that ran. */
  id: DiagnosticsConformanceCaseId;

  /** Confirms at least one required assertion failed. */
  status: 'failed';

  /** Carries public failure data without leaking native exception detail. */
  failure: PublicError;
}>;

/** One required diagnostic case outcome with no skipped success state. */
export type DiagnosticsConformanceCaseResult = PassedDiagnosticsConformanceCase | FailedDiagnosticsConformanceCase;

/** Complete diagnostic report returned for both successful and failed runs. */
export type DiagnosticsConformanceReport = Readonly<{
  /** Selects this report codec. */
  schema: 1;

  /** Names the product-neutral protocol under test. */
  protocol: '@archer/core/diagnostics';

  /** Selects the exact suite and required case set. */
  suiteVersion: typeof DIAGNOSTICS_CONFORMANCE_VERSION;

  /** Binds every result to one implementation and immutable configuration. */
  implementation: DiagnosticsConformanceImplementation;

  /** Lists the exact required catalogue independently of individual outcomes. */
  requiredCases: readonly DiagnosticsConformanceCaseId[];

  /** Summarizes whether every required case passed. */
  status: 'passed' | 'failed';

  /** Contains every required result in catalogue order. */
  cases: readonly DiagnosticsConformanceCaseResult[];
}> &
  ConformanceEvidence;

/** The status refinement required before a report can serve as passing evidence. */
type PassingDiagnosticsStatus = Readonly<{
  /** Confirms every published case passed. */
  status: 'passed';
}>;

/** Diagnostic report narrowed to reusable passing evidence. */
export type PassingDiagnosticsConformance = DiagnosticsConformanceReport & PassingDiagnosticsStatus;

/** Validates the stable identity of every required diagnostic proof. */
const DiagnosticsConformanceCaseIdSchema = z.enum([
  'record.normalization-redaction',
  'sink.independent-order-no-retry',
  'sink.failure-policy-accounting',
  'overflow.exact-bounds-cardinality',
  'shutdown.flush-close-ownership',
  'shutdown.deadline-close-evidence',
  'runtime.lifecycle-non-interference',
]);

/** Validates the named implementation and exact JSON configuration bound into evidence. */
const DiagnosticsConformanceImplementationSchema = z
  .strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    configuration: JsonObjectSchema,
  })
  .readonly();

/** Validates one executed case without admitting a skipped or unbounded failure branch. */
const DiagnosticsConformanceCaseResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ id: DiagnosticsConformanceCaseIdSchema, status: z.literal('passed') }),
    z.strictObject({ id: DiagnosticsConformanceCaseIdSchema, status: z.literal('failed'), failure: PublicErrorSchema }),
  ])
  .readonly();

/**
 * Admits serialized diagnostic conformance reports into an immutable runtime form.
 * Digest verification remains a separate asynchronous step because schemas
 * establish shape and invariants, not content integrity.
 */
export const DiagnosticsConformanceReportSchema = z
  .strictObject({
    schema: z.literal(1),
    protocol: z.literal('@archer/core/diagnostics'),
    suiteVersion: z.literal(DIAGNOSTICS_CONFORMANCE_VERSION),
    implementation: DiagnosticsConformanceImplementationSchema,
    configurationDigest: Sha256DigestSchema,
    at: TimestampSchema,
    environment: JsonObjectSchema,
    execution: ConformanceExecutionSchema,
    evidenceDigest: Sha256DigestSchema,
    requiredCases: z.array(DiagnosticsConformanceCaseIdSchema).readonly(),
    status: z.enum(['passed', 'failed']),
    cases: z.array(DiagnosticsConformanceCaseResultSchema).readonly(),
  })
  .transform((value) => value as DiagnosticsConformanceReport)
  .readonly();

/** Explains why diagnostic results cannot be promoted to passing evidence. */
export class DiagnosticsConformanceError extends ArcherError {
  /**
   * Constructs a bounded failure naming every failed required case.
   * @param failedCases - Stable failed case identities in execution order.
   */
  constructor(failedCases: readonly DiagnosticsConformanceCaseId[]) {
    super('Diagnostics conformance failed', {
      code: 'diagnostics_conformance_failed',
      details: { failedCases },
    });
  }
}

/** Input required to run one complete diagnostic conformance pass. */
export type RunDiagnosticsConformanceOptions = Readonly<{
  /** Factory implementation exercised by every case. */
  target: DiagnosticsConformanceTarget;

  /** Identity and exact configuration bound into the report. */
  implementation: DiagnosticsConformanceImplementation;

  /** Runtime and dependency facts needed to interpret passing evidence. */
  environment: ConformanceEnvironment;

  /** Supplies the evidence timestamp after every case executes. */
  now?: () => Date;
}>;

/**
 * Fails one executable case when its protocol claim is false.
 * @param condition - Claim that must hold.
 * @param message - Stable local explanation normalized by the report boundary.
 */
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Supplies the one deterministic instant used by diagnostic record fixtures.
 * @returns A fresh Date whose value remains constant across suite executions.
 */
function fixtureNow(): Date {
  return new Date('2026-08-22T00:00:00.000Z');
}

/**
 * Supplies a settled destination flush when a case does not exercise flushing.
 * @returns A promise representing completed fixture flushing.
 */
async function flushFixtureSink(): Promise<void> {
  return undefined;
}

/**
 * Creates one deterministic valid point record through the target factory.
 * @param target - Diagnostic implementation under test.
 * @param name - Stable record name used by the case.
 * @param component - Low-cardinality component used by loss aggregation.
 * @returns A normalized immutable fixture record.
 */
function fixtureRecord(
  target: DiagnosticsConformanceTarget,
  name: string,
  component = 'conformance',
): DiagnosticRecord {
  return target.createDiagnosticRecord(
    {
      name,
      severity: 'info',
      component,
      phase: 'point',
      correlation: {},
      attributes: {},
    },
    fixtureNow,
  );
}

/**
 * Creates a retained borrowed sink for one executable case.
 * @param write - Serialized destination behavior.
 * @param flush - Optional destination flush behavior.
 * @returns A production-shaped retained diagnostic sink.
 */
function fixtureSink(
  write: (records: readonly DiagnosticRecord[]) => Promise<void>,
  flush: () => Promise<void> = flushFixtureSink,
): DiagnosticSink {
  /** Shares one normal close result through property and method access. */
  const evidence: DiagnosticSinkCloseEvidence = Object.freeze({ kind: 'closed' });
  /** Exposes the already-settled fixture lifecycle. */
  const closed = Promise.resolve(evidence);
  /** Owns the retained destination interface used by the dispatcher. */
  const sink: DiagnosticSink = {
    closed,
    /**
     * Returns the fixture's shared retained close evidence.
     * @returns The already-settled fixture close promise.
     */
    close() {
      return closed;
    },
    flush,
    write,
    /** Delegates disposal to the same close path. */
    async [Symbol.asyncDispose]() {
      await sink.close();
    },
  };
  return sink;
}

/**
 * Proves record normalization, immutable copying, and redaction-safe structure.
 * @param target - Diagnostic implementation under test.
 */
async function recordCase(target: DiagnosticsConformanceTarget): Promise<void> {
  /** Remains mutable after record construction to prove boundary ownership. */
  const attributes = { attempt: 1 };
  /** Constructs one record at a deterministic instant. */
  const diagnostic = target.createDiagnosticRecord(
    {
      name: 'conformance.record',
      severity: 'debug',
      component: 'conformance',
      phase: 'point',
      correlation: {},
      attributes,
    },
    () => new Date('2026-08-22T00:00:00.000Z'),
  );
  attributes.attempt = 2;
  invariant(diagnostic.schema === 1, 'Diagnostic schema was not normalized');
  invariant(diagnostic.at === '2026-08-22T00:00:00.000Z', 'Diagnostic clock was not honored');
  invariant(diagnostic.attributes.attempt === 1, 'Diagnostic attributes retained caller mutation');
  invariant(Object.isFrozen(diagnostic) && Object.isFrozen(diagnostic.attributes), 'Diagnostic graph was not frozen');
  /** Records whether a native Error was correctly refused at the public data boundary. */
  let nativeErrorRejected = false;
  try {
    target.createDiagnosticRecord(
      {
        name: 'conformance.native-error',
        severity: 'error',
        component: 'conformance',
        phase: 'point',
        correlation: {},
        attributes: {},
        error: new Error('private native detail'),
      } as unknown as Parameters<DiagnosticsConformanceTarget['createDiagnosticRecord']>[0],
      fixtureNow,
    );
  } catch {
    nativeErrorRejected = true;
  }
  invariant(nativeErrorRejected, 'Diagnostic record admitted a native Error graph');
}

/**
 * Proves sink isolation, ordered delivery, and zero implicit retry.
 * @param target - Diagnostic implementation under test.
 */
async function sinkCase(target: DiagnosticsConformanceTarget): Promise<void> {
  /** Counts calls to the destination that always rejects. */
  let failedWrites = 0;
  /** Rejects one write so detach behavior remains exact. */
  const failing = fixtureSink(async () => {
    failedWrites += 1;
    throw new Error('private destination detail');
  });
  /** Records healthy delivery independently of the failed sink. */
  const healthyNames: string[] = [];
  /** Accepts every healthy record in call order. */
  const healthy = fixtureSink(async (records) => {
    healthyNames.push(...records.map((record) => record.name));
  });
  /** Owns both independent queues for this case. */
  const diagnostics = target.createDiagnostics();
  /** Retains failed attachment evidence. */
  const failed = diagnostics.attach(borrowed(failing));
  /** Retains healthy attachment cleanup. */
  const healthyAttachment = diagnostics.attach(borrowed(healthy));
  diagnostics.emit(fixtureRecord(target, 'one'));
  diagnostics.emit(fixtureRecord(target, 'two'));
  /** Captures the failed destination's exact terminal accounting. */
  const failedEvidence = await failed.closed;
  await healthyAttachment.close();
  invariant(failedWrites === 1, 'A rejected diagnostic write was retried implicitly');
  invariant(failedEvidence.kind === 'sink-failed', 'Rejected write did not produce failed attachment evidence');
  invariant(
    failedEvidence.acceptedRecords === 2 && failedEvidence.droppedRecords === 2,
    'Detach policy did not account for failed and queued source records',
  );
  invariant(healthyNames[0] === 'one' && healthyNames[1] === 'two', 'Healthy sink lost accepted source order');
  invariant(healthyNames.includes('diagnostics.sink_write_failed'), 'Healthy sink missed redacted failure observation');
  await diagnostics.close();
}

/**
 * Proves continue policy, truthful failure outcome, and exact terminal accounting.
 * @param target - Diagnostic implementation under test.
 */
async function failurePolicyCase(target: DiagnosticsConformanceTarget): Promise<void> {
  /** Records serialized calls while rejecting only the first source record. */
  const writtenNames: string[] = [];
  /** Owns the explicitly continuing destination. */
  const continuing = fixtureSink(async (records) => {
    /** Reads the single-record dispatcher batch used by the protocol. */
    const name = records[0]?.name;
    if (name !== undefined) writtenNames.push(name);
    if (name === 'one') throw new Error('private continuing sink detail');
  });
  /** Retains operational records delivered to another healthy destination. */
  const observed: DiagnosticRecord[] = [];
  /** Owns an independent observer for truthful failure projection. */
  const observer = fixtureSink(async (records) => {
    observed.push(...records);
  });
  /** Owns both queues without coupling their write outcomes. */
  const diagnostics = target.createDiagnostics();
  /** Selects continuation after a rejected write without retry. */
  const continuingAttachment = diagnostics.attach(borrowed(continuing), { onWriteFailure: 'continue' });
  /** Retains the healthy observer through failure-report drain. */
  const observerAttachment = diagnostics.attach(borrowed(observer));
  diagnostics.emit(fixtureRecord(target, 'one'));
  diagnostics.emit(fixtureRecord(target, 'two'));
  /** Captures exact continuation settlement after both records are attempted. */
  const evidence = await continuingAttachment.close();
  await observerAttachment.close();
  invariant(writtenNames.join(',') === 'one,two', 'Continue policy retried or skipped the successor record');
  invariant(
    evidence.acceptedRecords === 2 &&
      evidence.writtenRecords === 1 &&
      evidence.droppedRecords === 1 &&
      evidence.kind === 'sink-failed',
    'Continue policy terminal accounting was not exact',
  );
  /** Finds the non-authoritative operational report emitted to healthy sinks. */
  const failure = observed.find((record) => record.name === 'diagnostics.sink_write_failed');
  invariant(failure?.outcome === 'continued', 'Continue policy falsely reported destination detachment');
  invariant(!JSON.stringify(failure).includes('private continuing'), 'Failure projection leaked native sink detail');
  await diagnostics.close();
}

/**
 * Proves exact overflow totals and bounded component/severity aggregation.
 * @param target - Diagnostic implementation under test.
 */
async function overflowCase(target: DiagnosticsConformanceTarget): Promise<void> {
  /** Holds the first active write while the one-item queue overflows. */
  const release = createDeferredTask<void>();
  /** Retains written source and synthesized records in order. */
  const written: DiagnosticRecord[] = [];
  /** Blocks only the first destination write. */
  const sink = fixtureSink(async (records) => {
    written.push(...records);
    if (written.length === 1) await release.promise;
  });
  /** Owns one bounded sink queue with one named component bucket. */
  const diagnostics = target.createDiagnostics({ gapComponentLimit: 1 });
  /** Retains close evidence after gap delivery. */
  const attachment = diagnostics.attach(borrowed(sink), {
    delivery: { capacityItems: 1, capacityBytes: 4096 },
  });
  diagnostics.emit(fixtureRecord(target, 'one', 'first'));
  await Promise.resolve();
  diagnostics.emit(fixtureRecord(target, 'two', 'first'));
  diagnostics.emit(fixtureRecord(target, 'three', 'second'));
  diagnostics.emit(fixtureRecord(target, 'four', 'third'));
  release.resolve();
  await attachment.close();
  /** Locates the synthesized gap without relying on destination batch size. */
  const gap = written.find((record) => record.name === 'diagnostics.gap');
  invariant(gap !== undefined, 'Diagnostic overflow did not produce a gap record');
  invariant(gap.attributes.lostItems === 2, 'Diagnostic item-bound gap total was not exact');
  invariant(
    JSON.stringify(gap.attributes.lostByComponent) ===
      JSON.stringify({ second: { info: 1 }, otherComponents: { info: 1 } }),
    'Diagnostic gap component and severity breakdown was not exact',
  );
  await diagnostics.close();

  /** Owns a separate destination proving byte bounds independent of item capacity. */
  const byteWrites: DiagnosticRecord[] = [];
  /** Records the synthesized gap produced by an oversized source record. */
  const byteSink = fixtureSink(async (records) => {
    byteWrites.push(...records);
  });
  /** Owns the byte-bound dispatcher independently of the earlier item case. */
  const byteDiagnostics = target.createDiagnostics();
  /** Selects a byte capacity too small for any valid normalized record. */
  const byteAttachment = byteDiagnostics.attach(borrowed(byteSink), {
    delivery: { capacityItems: 1, capacityBytes: 1 },
  });
  byteDiagnostics.emit(fixtureRecord(target, 'oversized'));
  await byteAttachment.close();
  /** Finds the control record that may use the documented reserved position. */
  const byteGap = byteWrites.find((record) => record.name === 'diagnostics.gap');
  invariant(byteGap?.attributes.lostItems === 1, 'Diagnostic byte overflow did not report one lost record');
  invariant(
    typeof byteGap.attributes.lostBytes === 'number' && byteGap.attributes.lostBytes > 1,
    'Diagnostic byte overflow did not report encoded loss',
  );
  await byteDiagnostics.close();
}

/**
 * Proves write, flush, and close order while preserving explicit sink ownership.
 * @param target - Diagnostic implementation under test.
 */
async function ownershipCase(target: DiagnosticsConformanceTarget): Promise<void> {
  /** Records all destination lifecycle calls in exact execution order. */
  const operations: string[] = [];
  /** Shares normal fixture sink close evidence. */
  const sinkEvidence: DiagnosticSinkCloseEvidence = Object.freeze({ kind: 'closed' });
  /**
   * Builds one observable destination with caller-selected label.
   * @param label - Stable prefix recorded with each destination operation.
   * @returns A retained diagnostic sink with observable lifecycle calls.
   */
  const makeSink = (label: string): DiagnosticSink => {
    /** Exposes a stable already-settled lifecycle for the conformance fixture. */
    const closed = Promise.resolve(sinkEvidence);
    /** Owns the retained destination contract for this label. */
    const sink: DiagnosticSink = {
      closed,
      /**
       * Records destination close after flush when the dispatcher owns it.
       * @returns Normal fixture close evidence.
       */
      close() {
        operations.push(`${label}:close`);
        return closed;
      },
      /** Records flush after every accepted write drains. */
      async flush() {
        operations.push(`${label}:flush`);
      },
      /** Records each accepted source write before finalization. */
      async write() {
        operations.push(`${label}:write`);
      },
      /** Delegates language disposal to the retained close path. */
      async [Symbol.asyncDispose]() {
        await sink.close();
      },
    };
    return sink;
  };
  /** Leaves lifecycle authority with the conformance caller. */
  const borrowedSink = makeSink('borrowed');
  /** Transfers lifecycle authority to the diagnostic attachment. */
  const ownedSink = makeSink('owned');
  /** Owns independent destination queues for both ownership modes. */
  const diagnostics = target.createDiagnostics();
  /** Retains borrowed finalization without destination close authority. */
  const borrowedAttachment = diagnostics.attach(borrowed(borrowedSink));
  /** Retains owned finalization including destination close authority. */
  const ownedAttachment = diagnostics.attach(owned(ownedSink));
  diagnostics.emit(fixtureRecord(target, 'ordered'));
  await borrowedAttachment.close();
  await ownedAttachment.close();
  invariant(
    operations.indexOf('borrowed:write') < operations.indexOf('borrowed:flush'),
    'Borrowed sink flushed before its accepted write',
  );
  invariant(!operations.includes('borrowed:close'), 'Diagnostic attachment closed a borrowed sink');
  invariant(
    operations.indexOf('owned:write') < operations.indexOf('owned:flush') &&
      operations.indexOf('owned:flush') < operations.indexOf('owned:close'),
    'Owned sink did not preserve write, flush, close order',
  );
  await diagnostics.close();
}

/**
 * Proves a shared deadline releases shutdown from an uncooperative sink.
 * @param target - Diagnostic implementation under test.
 */
async function shutdownCase(target: DiagnosticsConformanceTarget): Promise<void> {
  /** Never settles the active destination write. */
  const write = createDeferredTask<void>();
  /** Advances the injected deadline without wall-clock time. */
  const timeout = createDeferredTask<void>();
  /**
   * Gives the dispatcher deterministic ownership of timeout settlement.
   * @returns The manually controlled timeout promise.
   */
  const waitForShutdownTimeout = (): Promise<void> => timeout.promise;
  /** Owns the hung borrowed destination. */
  const sink = fixtureSink(async () => write.promise);
  /** Injects one deterministic shutdown deadline. */
  const diagnostics = target.createDiagnostics({
    shutdownTimeoutMs: 10,
    waitForShutdownTimeout,
  });
  /** Retains attachment evidence after parent shutdown. */
  const attachment: OwnedHandle<DiagnosticAttachmentCloseEvidence> = diagnostics.attach(borrowed(sink));
  diagnostics.emit(fixtureRecord(target, 'hung'));
  await Promise.resolve();
  /** Starts parent shutdown before expiring its one shared deadline. */
  const close = diagnostics.close();
  timeout.resolve();
  await close;
  /** Reads the attachment's exact timeout and unconfirmed-write evidence. */
  const evidence = await attachment.closed;
  invariant(evidence.kind === 'sink-failed', 'Hung sink did not fail its attachment');
  invariant(evidence.failure?.code === 'diagnostic_sink_shutdown_timeout', 'Shutdown timeout code was not stable');
  invariant(evidence.unconfirmedRecords === 1, 'Hung in-flight record was not reported as unconfirmed');

  /** Never settles destination flush. */
  const flush = createDeferredTask<void>();
  /** Advances the independent flush deadline deterministically. */
  const flushTimeout = createDeferredTask<void>();
  /** Owns a destination that writes but cannot finish flush. */
  const flushSink = fixtureSink(
    async () => undefined,
    () => flush.promise,
  );
  /** Injects the flush-specific timeout signal. */
  const flushDiagnostics = target.createDiagnostics({
    shutdownTimeoutMs: 10,
    /**
     * Returns the manually controlled flush-expiration signal.
     * @returns The pending deterministic timeout promise.
     */
    waitForShutdownTimeout: () => flushTimeout.promise,
  });
  /** Retains finalization evidence while flush remains pending. */
  const flushAttachment = flushDiagnostics.attach(borrowed(flushSink));
  /** Begins destination finalization before expiring its deadline. */
  const flushClose = flushAttachment.close();
  await Promise.resolve();
  flushTimeout.resolve();
  invariant(
    (await flushClose).failure?.code === 'diagnostic_sink_shutdown_timeout',
    'Hung diagnostic flush escaped the shutdown deadline',
  );
  await flushDiagnostics.close();

  /** Never settles an owned destination's close operation. */
  const ownedClose = createDeferredTask<DiagnosticSinkCloseEvidence>();
  /** Advances the independent owned-close deadline deterministically. */
  const ownedTimeout = createDeferredTask<void>();
  /** Owns one destination whose teardown cannot finish. */
  const ownedSink: DiagnosticSink = {
    closed: ownedClose.promise,
    /**
     * Returns the manually controlled retained close operation.
     * @returns The never-settling owned sink close promise.
     */
    close: () => ownedClose.promise,
    /**
     * Flushes immediately so this branch isolates owned teardown.
     * @returns Settled destination flush.
     */
    flush: async () => undefined,
    /**
     * Writes immediately so this branch isolates owned teardown.
     * @returns Settled destination write.
     */
    write: async () => undefined,
    /** Delegates disposal to the retained close path. */
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
  /** Injects the owned-close-specific timeout signal. */
  const ownedDiagnostics = target.createDiagnostics({
    shutdownTimeoutMs: 10,
    /**
     * Returns the manually controlled owned-close expiration signal.
     * @returns The pending deterministic timeout promise.
     */
    waitForShutdownTimeout: () => ownedTimeout.promise,
  });
  /** Transfers sink close authority to the attachment. */
  const ownedAttachment = ownedDiagnostics.attach(owned(ownedSink));
  /** Begins owned teardown before expiring its deadline. */
  const attachmentClose = ownedAttachment.close();
  await Promise.resolve();
  ownedTimeout.resolve();
  invariant(
    (await attachmentClose).failure?.code === 'diagnostic_sink_shutdown_timeout',
    'Hung owned diagnostic close escaped the shutdown deadline',
  );
  await ownedDiagnostics.close();
}

/**
 * Proves lifecycle visibility without allowing diagnostics to control domain state.
 * @param target - Diagnostic implementation under test.
 */
async function nonInterferenceCase(target: DiagnosticsConformanceTarget): Promise<void> {
  /** Represents authoritative domain state intentionally outside diagnostics. */
  let domainState = 'running';
  /** Owns the public lifecycle observation source. */
  const diagnostics = target.createDiagnostics();
  /** Attaches one bounded public observer before lifecycle production. */
  const events = diagnostics.events.subscribe();
  /** Starts the pull before emission so delivery does not depend on queue scheduling. */
  const next = events[Symbol.asyncIterator]().next();
  diagnostics.record({
    name: 'runtime.attempt.started',
    severity: 'info',
    component: 'conformance.runtime',
    phase: 'start',
    correlation: {},
    attributes: {},
  });
  /** Reads the public event frame carrying runtime lifecycle visibility. */
  const delivery = await next;
  invariant(
    !delivery.done && delivery.value.kind === 'event' && delivery.value.value.name === 'runtime.attempt.started',
    'Runtime lifecycle diagnostic was not publicly observable',
  );
  invariant(domainState === 'running', 'Diagnostic production changed authoritative domain state');
  await events.close();
  await diagnostics.close();
  invariant(domainState === 'running', 'Diagnostic shutdown changed authoritative domain state');
  /** Makes the separation explicit so this variable cannot be optimized into a constant claim. */
  domainState = 'completed';
  invariant(domainState === 'completed', 'Domain state could not advance independently of diagnostics');
}

/** Pairs each published case with its framework-neutral executable proof. */
const executableCases: Readonly<
  Record<DiagnosticsConformanceCaseId, (target: DiagnosticsConformanceTarget) => Promise<void>>
> = Object.freeze({
  'record.normalization-redaction': recordCase,
  'sink.independent-order-no-retry': sinkCase,
  'sink.failure-policy-accounting': failurePolicyCase,
  'overflow.exact-bounds-cardinality': overflowCase,
  'shutdown.flush-close-ownership': ownershipCase,
  'shutdown.deadline-close-evidence': shutdownCase,
  'runtime.lifecycle-non-interference': nonInterferenceCase,
});

/**
 * Runs every required diagnostic case and preserves failures as data.
 * @param options - Factory target plus implementation and configuration identity.
 * @returns A frozen report containing every required result.
 */
export async function runDiagnosticsConformance(
  options: RunDiagnosticsConformanceOptions,
): Promise<DiagnosticsConformanceReport> {
  if (options.implementation.name.length === 0 || options.implementation.version.length === 0) {
    throw new RangeError('Conformance implementation name and version must not be empty');
  }
  /** Copies implementation identity and configuration at the report boundary. */
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
  const requiredCases = Object.freeze(DIAGNOSTICS_CONFORMANCE_CASES.map((testCase) => testCase.id));
  /** Retains every required outcome without short-circuiting on failure. */
  const results: DiagnosticsConformanceCaseResult[] = [];
  /** Executes each published case exactly once in catalogue order. */
  for (const testCase of DIAGNOSTICS_CONFORMANCE_CASES) {
    try {
      await executableCases[testCase.id](options.target);
      results.push(Object.freeze({ id: testCase.id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id: testCase.id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'diagnostics_conformance_case_failed',
            message: `Required diagnostics conformance case failed: ${testCase.id}`,
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
    protocol: '@archer/core/diagnostics',
    suiteVersion: DIAGNOSTICS_CONFORMANCE_VERSION,
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
 * @param report - Report returned by the matching suite version.
 * @returns A promise of passing evidence or a focused Archer Error naming failed cases.
 */
export async function requirePassingDiagnosticsConformance(
  report: DiagnosticsConformanceReport,
): Promise<ResultValue<PassingDiagnosticsConformance, DiagnosticsConformanceError>> {
  /** Retains the exact required identities for metadata and result comparison. */
  const required = DIAGNOSTICS_CONFORMANCE_CASES.map((testCase) => testCase.id);
  /** Copies and freezes untrusted report data before an asynchronous integrity check. */
  const admitted = DiagnosticsConformanceReportSchema.safeParse(report);
  if (!admitted.success) return Result.error(new DiagnosticsConformanceError(required));
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
    candidate.protocol === '@archer/core/diagnostics' &&
    candidate.suiteVersion === DIAGNOSTICS_CONFORMANCE_VERSION &&
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
    return Result.ok(candidate as PassingDiagnosticsConformance);
  }
  /** Treats invalid or incomplete metadata as failure of the full required set. */
  const failed =
    catalogueMatches && metadataValid && digestsValid
      ? required.filter((id, index) => candidate.cases[index]?.id !== id || candidate.cases[index]?.status !== 'passed')
      : required;
  return Result.error(new DiagnosticsConformanceError(failed));
}
