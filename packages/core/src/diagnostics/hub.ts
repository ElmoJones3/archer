/**
 * @file Implements the non-blocking diagnostics dispatcher with independent,
 * serialized, bounded sink queues and explicit ownership.
 */

import type { ComponentRef, OwnedHandle } from '../ownership.js';
import { toPublicError, type PublicError } from '../protocol.js';
import type { DeliveryBounds } from '../stream/contracts.js';
import { createUuidV4 } from '../values.js';
import {
  asTransientEventStream,
  createTransientEventSource,
  type ScheduleTask,
  type TransientEventSource,
} from '../stream/runtime.js';
import type {
  DiagnosticAttachOptions,
  DiagnosticAttachmentCloseEvidence,
  DiagnosticEventInput,
  DiagnosticEventRecord,
  DiagnosticFilter,
  DiagnosticHub,
  DiagnosticRecord,
  DiagnosticSeverity,
  DiagnosticSink,
  DiagnosticsCloseEvidence,
  DiagnosticSpan,
  DiagnosticSpanLimits,
} from './contracts.js';
import {
  DiagnosticEventInputSchema,
  DiagnosticEventRecordSchema,
  DiagnosticRecordSchema,
  DiagnosticSpanError,
} from './contracts.js';
import { createDiagnosticSpan, type DiagnosticSpanIdFactory, type DiagnosticSpanMonotonicClock } from './span.js';

/** Provides deterministic time for diagnostic construction. */
export type DiagnosticClock = () => Date;

/** Produces one deterministic shutdown-expiration signal after a duration. */
export type DiagnosticShutdownTimer = (milliseconds: number) => Promise<void>;

/** Configures dispatcher identity, scheduling, time, and default sink bounds. */
export type DiagnosticsOptions = Readonly<{
  /** Identifies the public transient diagnostic plane. */
  source?: string;

  /** Identifies the current non-replayable diagnostic generation. */
  epoch?: string;

  /** Supplies deterministic current time for created and synthesized records. */
  now?: DiagnosticClock;

  /** Supplies monotonic milliseconds for exact diagnostic span duration. */
  monotonicNow?: DiagnosticSpanMonotonicClock;

  /** Supplies UUIDv4 process-local span identity without ambient randomness in tests. */
  createSpanId?: DiagnosticSpanIdFactory;

  /** Overrides the safe finite context budget shared by spans from this hub. */
  spanLimits?: Partial<DiagnosticSpanLimits>;

  /** Schedules sink work outside the producer's call stack. */
  schedule?: ScheduleTask;

  /** Selects default independent bounds for extension sinks. */
  delivery?: DeliveryBounds;

  /** Caps sink attachment overrides independently of safe defaults. */
  maximumDelivery?: DeliveryBounds;

  /** Caps distinct component keys carried by one synthesized gap record. */
  gapComponentLimit?: number;

  /** Bounds total sink drain, flush, and owned teardown during shutdown. */
  shutdownTimeoutMs?: number;

  /** Replaces the production timer for deterministic temporal hosts and tests. */
  waitForShutdownTimeout?: DiagnosticShutdownTimer;
}>;

/** Orders severity filters without relying on string comparison. */
const severityOrder: Readonly<Record<DiagnosticSeverity, number>> = Object.freeze({
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
});

/**
 * Defers production sink work through the host microtask queue.
 * @param task - Destination work that must not run in the producer stack.
 * @returns Nothing; the host owns later execution.
 */
const defaultSchedule: ScheduleTask = (task) => queueMicrotask(task);

/** Owns one expiration signal and any host resource retaining it. */
type ShutdownDeadline = Readonly<{
  /** Settles when the shutdown budget expires. */
  expired: Promise<void>;

  /** Releases the host timer after orderly shutdown wins the race. */
  cancel(): void;
}>;

/**
 * Produces a referenced host timeout that can be cancelled after shutdown.
 * @param milliseconds - Positive shutdown duration selected by the hub.
 * @returns A deadline that keeps Node alive only while close evidence depends on it.
 */
function defaultShutdownDeadline(milliseconds: number): ShutdownDeadline {
  /** Retains the referenced timer until expiration or explicit cancellation. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves only when the production shutdown budget expires. */
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return Object.freeze({
    expired,
    /** Cancels the referenced timer after another shutdown branch settles. */
    cancel() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
  });
}

/**
 * Measures normalized diagnostic records through their canonical JSON representation.
 * @param record - Immutable normalized diagnostic value.
 * @returns Canonical JSON UTF-8 byte length.
 */
function measureRecord(record: DiagnosticRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

/**
 * Tests one normalized record against a product-neutral sink filter.
 * @param record - Normalized record considered for sink admission.
 * @param filter - Optional severity, name, and component selection.
 * @returns True when the record belongs in this sink queue.
 */
function matchesFilter(record: DiagnosticRecord, filter: DiagnosticFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.severityAtLeast !== undefined && severityOrder[record.severity] < severityOrder[filter.severityAtLeast]) {
    return false;
  }
  if (filter.names !== undefined && !filter.names.includes(record.name)) return false;
  if (filter.components !== undefined && !filter.components.includes(record.component)) return false;
  return true;
}

/**
 * Copies one sink filter so later caller mutation cannot rewrite admission.
 * @param filter - Optional caller-owned filter and selection arrays.
 * @returns An immutable attachment-owned filter or undefined.
 */
function normalizeFilter(filter: DiagnosticFilter | undefined): DiagnosticFilter | undefined {
  if (filter === undefined) return undefined;
  return Object.freeze({
    ...(filter.severityAtLeast === undefined ? {} : { severityAtLeast: filter.severityAtLeast }),
    ...(filter.names === undefined ? {} : { names: Object.freeze([...filter.names]) }),
    ...(filter.components === undefined ? {} : { components: Object.freeze([...filter.components]) }),
  });
}

/**
 * Creates one immutable event through the same runtime codec used at boundaries.
 * @param input - Product-neutral fields other than source-owned kind, schema, and time.
 * @param now - Injected clock read exactly once for this event.
 * @returns A normalized deeply immutable diagnostic event.
 */
export function createDiagnosticEvent(
  input: DiagnosticEventInput,
  now: DiagnosticClock = () => new Date(),
): DiagnosticEventRecord {
  /** Rejects unexpected caller fields before attaching source-owned values. */
  const admitted = DiagnosticEventInputSchema.parse(input);
  return DiagnosticEventRecordSchema.parse({
    ...admitted,
    schema: 1,
    kind: 'event',
    at: now().toISOString(),
  });
}

/** Mutable queue entry retained by one sink attachment. */
type SinkQueueEntry = Readonly<{
  /** Normalized record accepted for this sink. */
  record: DiagnosticRecord;

  /** Encoded bytes charged to this sink's bound. */
  bytes: number;

  /** Distinguishes admitted source records from synthesized control records. */
  sourceRecord: boolean;
}>;

/** Coordinates a failed attachment report without recursively targeting itself. */
type AttachmentFailureReporter = (
  attachment: SinkAttachment,
  failure: PublicError,
  action: 'detached' | 'continued',
) => void;

/** Owns one sink's bounded queue, serialized writer, flush, and optional lifecycle. */
class SinkAttachment implements OwnedHandle<DiagnosticAttachmentCloseEvidence> {
  /** Settles once accepted records flush or a write failure detaches the sink. */
  readonly closed: Promise<DiagnosticAttachmentCloseEvidence>;

  /** Explicitly owned or borrowed destination. */
  readonly #sink: ComponentRef<DiagnosticSink>;

  /** Selected record filter applied before queue bounds. */
  readonly #filter: DiagnosticFilter | undefined;

  /** Maximum records retained in addition to the in-flight write. */
  readonly #capacityItems: number;

  /** Maximum encoded bytes retained in addition to the in-flight write. */
  readonly #capacityBytes: number;

  /** Selects failed-write detachment or continuation without retry. */
  readonly #onWriteFailure: 'detach' | 'continue';

  /** Defers pump activation outside diagnostic production. */
  readonly #schedule: ScheduleTask;

  /** Builds deterministic gap and failure records. */
  readonly #record: (input: DiagnosticEventInput) => DiagnosticEventRecord;

  /** Reports sink failure through public events and other healthy sinks. */
  readonly #reportFailure: AttachmentFailureReporter;

  /** Removes this attachment from future hub fan-out. */
  readonly #remove: () => void;

  /** Starts one attachment-scoped shutdown expiration signal. */
  readonly #shutdownDeadline: () => ShutdownDeadline;

  /** Caps diagnostic component cardinality inside one coalesced gap. */
  readonly #gapComponentLimit: number;

  /** Retains source records in exact accepted order. */
  readonly #queue: SinkQueueEntry[] = [];

  /** Settles the stable public lifecycle promise. */
  readonly #settle: (evidence: DiagnosticAttachmentCloseEvidence) => void;

  /** Tracks encoded bytes retained in the queue. */
  #queuedBytes = 0;

  /** Counts source records accepted before any synthetic gap marker. */
  #acceptedRecords = 0;

  /** Counts source records whose destination write fulfilled. */
  #writtenRecords = 0;

  /** Counts encoded source bytes whose destination write fulfilled. */
  #writtenBytes = 0;

  /** Counts source records discarded by this queue. */
  #droppedRecords = 0;

  /** Counts encoded source bytes discarded by this queue. */
  #droppedBytes = 0;

  /** Counts source records still in flight when shutdown expired. */
  #unconfirmedRecords = 0;

  /** Counts encoded source bytes still in flight when shutdown expired. */
  #unconfirmedBytes = 0;

  /** Coalesces records lost before a synthetic gap can enter the queue. */
  #pendingLostRecords = 0;

  /** Coalesces bytes lost before a synthetic gap can enter the queue. */
  #pendingLostBytes = 0;

  /** Retains bounded component and severity counts for pending source loss. */
  readonly #pendingLossByComponent = new Map<string, Partial<Record<DiagnosticSeverity, number>>>();

  /** Retains severity counts for components beyond the configured cardinality cap. */
  readonly #pendingLossFromOtherComponents: Partial<Record<DiagnosticSeverity, number>> = {};

  /** Prevents new source admission after close or failure. */
  #accepting = true;

  /** Prevents more than one scheduled or active writer loop. */
  #pumping = false;

  /** Prevents duplicate finalization and lifecycle settlement. */
  #ended = false;

  /** Retains the first redacted write or flush failure. */
  #failure: PublicError | undefined;

  /** Retains one idempotent close operation. */
  #closePromise: Promise<DiagnosticAttachmentCloseEvidence> | undefined;

  /** Retains the scheduled or active writer loop for deterministic drain. */
  #pumpPromise: Promise<void> | undefined;

  /** Retains the record currently owned by a destination write call. */
  #inFlight: SinkQueueEntry | undefined;

  /**
   * Creates one independent destination dispatcher.
   * @param sink - Explicit sink lifecycle ownership.
   * @param options - Filter, bounds, and write-failure behavior.
   * @param defaults - Hub-selected default bounds.
   * @param maximum - Hub-selected maximum bounds.
   * @param gapComponentLimit - Maximum named component buckets per gap.
   * @param schedule - Host scheduling boundary for non-blocking writes.
   * @param record - Deterministic normalized record constructor.
   * @param reportFailure - Healthy-sink and public-stream failure reporter.
   * @param remove - Hub detachment callback.
   * @param shutdownDeadline - Creates one bounded shutdown expiration signal.
   */
  constructor(
    sink: ComponentRef<DiagnosticSink>,
    options: DiagnosticAttachOptions,
    defaults: Required<DeliveryBounds>,
    maximum: Required<DeliveryBounds>,
    gapComponentLimit: number,
    schedule: ScheduleTask,
    record: (input: DiagnosticEventInput) => DiagnosticEventRecord,
    reportFailure: AttachmentFailureReporter,
    remove: () => void,
    shutdownDeadline: () => ShutdownDeadline,
  ) {
    this.#sink = sink;
    this.#filter = normalizeFilter(options.filter);
    this.#capacityItems = options.delivery?.capacityItems ?? defaults.capacityItems;
    this.#capacityBytes = options.delivery?.capacityBytes ?? defaults.capacityBytes;
    this.#gapComponentLimit = gapComponentLimit;
    this.#onWriteFailure = options.onWriteFailure ?? 'detach';
    this.#schedule = schedule;
    this.#record = record;
    this.#reportFailure = reportFailure;
    this.#remove = remove;
    this.#shutdownDeadline = shutdownDeadline;
    if (!Number.isSafeInteger(this.#capacityItems) || this.#capacityItems < 1) {
      throw new RangeError('diagnostic capacityItems must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.#capacityBytes) || this.#capacityBytes < 1) {
      throw new RangeError('diagnostic capacityBytes must be a positive safe integer');
    }
    if (this.#capacityItems > maximum.capacityItems) {
      throw new RangeError('diagnostic capacityItems exceeds the hub-declared maximum');
    }
    if (this.#capacityBytes > maximum.capacityBytes) {
      throw new RangeError('diagnostic capacityBytes exceeds the hub-declared maximum');
    }

    /** Captures the native resolver for stable lifecycle evidence. */
    let settlePromise: ((evidence: DiagnosticAttachmentCloseEvidence) => void) | undefined;
    this.closed = new Promise((resolve) => {
      settlePromise = resolve;
    });
    /**
     * Settles attachment lifecycle once.
     * @param evidence - Immutable terminal delivery and loss evidence.
     * @returns Nothing; native Promise settlement is the side effect.
     */
    this.#settle = (evidence) => settlePromise?.(Object.freeze(evidence));
  }

  /**
   * Offers one record without awaiting this sink or another attachment.
   * @param record - Normalized source record.
   */
  offer(record: DiagnosticRecord): void {
    if (!this.#accepting || !matchesFilter(record, this.#filter)) return;
    /** Measures this record once before queue admission or loss accounting. */
    const bytes = measureRecord(record);
    if (
      this.#pendingLostRecords > 0 ||
      this.#queue.length >= this.#capacityItems ||
      bytes > this.#capacityBytes - this.#queuedBytes
    ) {
      this.#recordPendingLoss(record, bytes);
      this.#flushGap();
      this.#schedulePump();
      return;
    }
    this.#queue.push(Object.freeze({ record, bytes, sourceRecord: true }));
    this.#queuedBytes += bytes;
    this.#acceptedRecords += 1;
    this.#schedulePump();
  }

  /**
   * Records exact source loss while bounding component-cardinality evidence.
   * @param record - Source record discarded before sink admission.
   * @param bytes - Encoded bytes discarded with the source record.
   */
  #recordPendingLoss(record: DiagnosticRecord, bytes: number): void {
    this.#droppedRecords += 1;
    this.#droppedBytes += bytes;
    this.#pendingLostRecords += 1;
    this.#pendingLostBytes += bytes;
    /** Reuses an existing named bucket or admits one while capacity remains. */
    const named = this.#pendingLossByComponent.get(record.component);
    if (named !== undefined) {
      named[record.severity] = (named[record.severity] ?? 0) + 1;
      return;
    }
    if (this.#pendingLossByComponent.size < this.#gapComponentLimit) {
      this.#pendingLossByComponent.set(record.component, { [record.severity]: 1 });
      return;
    }
    this.#pendingLossFromOtherComponents[record.severity] =
      (this.#pendingLossFromOtherComponents[record.severity] ?? 0) + 1;
  }

  /**
   * Stops admission, drains accepted records, flushes, and closes an owned sink.
   * @returns Shared immutable attachment close evidence.
   */
  close(): Promise<DiagnosticAttachmentCloseEvidence> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    /** Owns one attachment-scoped host deadline and cancels it after settlement. */
    const deadline = this.#shutdownDeadline();
    return this.#beginClose(deadline.expired, deadline.cancel);
  }

  /**
   * Stops admission and races orderly drain against one shared deadline.
   * @param deadline - Settlement signal shared by one parent shutdown.
   * @returns Shared immutable attachment close evidence.
   */
  closeBefore(deadline: Promise<void>): Promise<DiagnosticAttachmentCloseEvidence> {
    return this.#beginClose(deadline, () => undefined);
  }

  /**
   * Starts the one close race and mirrors its lifetime into the selected deadline.
   * @param deadline - Settlement signal shared by this shutdown scope.
   * @param releaseDeadline - Releases an attachment-owned host deadline.
   * @returns Shared immutable attachment close evidence.
   */
  #beginClose(deadline: Promise<void>, releaseDeadline: () => void): Promise<DiagnosticAttachmentCloseEvidence> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#accepting = false;
    this.#remove();
    this.#flushGap();
    this.#closePromise = Promise.race([this.#drainAndFinalize(), deadline.then(() => this.#expireShutdown())]).finally(
      releaseDeadline,
    );
    return this.#closePromise;
  }

  /** Delegates language-level disposal to the same idempotent close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Defers at most one pump activation outside the producer call stack. */
  #schedulePump(): void {
    if (this.#pumping || this.#ended) return;
    this.#pumping = true;
    /** Exposes completion of this exact scheduled writer loop to close. */
    let settlePump: (() => void) | undefined;
    this.#pumpPromise = new Promise((resolve) => {
      settlePump = resolve;
    });
    this.#schedule(() => {
      void this.#pump().finally(() => settlePump?.());
    });
  }

  /** Serializes one-record writes and never retries a rejected call. */
  async #pump(): Promise<void> {
    while (!this.#ended) {
      /** Removes exactly one accepted record for the next serialized write. */
      const entry = this.#queue.shift();
      if (entry === undefined) break;
      this.#queuedBytes -= entry.bytes;
      this.#flushGap();
      this.#inFlight = entry;
      try {
        await this.#sink.value.write(Object.freeze([entry.record]));
        if (this.#ended) break;
        if (entry.sourceRecord) {
          this.#writtenRecords += 1;
          this.#writtenBytes += entry.bytes;
        }
        this.#inFlight = undefined;
      } catch (error) {
        if (this.#ended) break;
        /** Redacts the native sink rejection before any diagnostic fan-out. */
        const failure = toPublicError(error, {
          code: 'diagnostic_sink_write_failed',
          message: 'A diagnostic sink rejected a write',
          retryable: true,
        });
        /** Reports only the first failure so continuing sinks cannot amplify each other. */
        if (this.#failure === undefined) {
          this.#failure = failure;
          this.#reportFailure(this, failure, this.#onWriteFailure === 'detach' ? 'detached' : 'continued');
        }
        this.#countDropped(entry);
        this.#inFlight = undefined;
        if (this.#onWriteFailure === 'detach') {
          this.#accepting = false;
          this.#remove();
          /** Every accepted source record still queued is now provably discarded. */
          for (const queued of this.#queue) this.#countDropped(queued);
          this.#queue.length = 0;
          this.#queuedBytes = 0;
          break;
        }
      }
    }
    this.#pumping = false;
    if (!this.#accepting && !this.#ended) {
      if (this.#closePromise === undefined) {
        /** Bounds automatic detach finalization even without a later caller close. */
        const deadline = this.#shutdownDeadline();
        this.#closePromise = Promise.race([
          this.#finalize(),
          deadline.expired.then(() => this.#expireShutdown()),
        ]).finally(deadline.cancel);
        await this.#closePromise;
      } else {
        /** Parent close already owns the deadline and is waiting for this pump. */
        await this.#finalize();
      }
    } else if (this.#queue.length > 0) {
      this.#schedulePump();
    }
  }

  /** Enqueues one exact loss record as soon as queue capacity exists. */
  #flushGap(): void {
    if (this.#pendingLostRecords === 0 || this.#queue.length >= this.#capacityItems) return;
    /** Copies bounded component buckets before pending accounting resets. */
    const lostByComponent = Object.fromEntries(
      [...this.#pendingLossByComponent].map(([component, counts]) => [component, Object.freeze({ ...counts })]),
    );
    if (Object.keys(this.#pendingLossFromOtherComponents).length > 0) {
      lostByComponent.otherComponents = Object.freeze({ ...this.#pendingLossFromOtherComponents });
    }
    /** Captures pending loss before resetting counters for future overflow. */
    const gap = this.#record({
      name: 'diagnostics.gap',
      severity: 'warn',
      component: 'core.diagnostics',
      correlation: {},
      attributes: {
        lostItems: this.#pendingLostRecords,
        lostBytes: this.#pendingLostBytes,
        lostByComponent,
      },
    });
    /** Charges the synthesized gap against queue bytes without source acceptance. */
    const bytes = measureRecord(gap);
    this.#pendingLostRecords = 0;
    this.#pendingLostBytes = 0;
    this.#pendingLossByComponent.clear();
    /** Clears each bounded severity counter without replacing retained identity. */
    for (const severity of Object.keys(this.#pendingLossFromOtherComponents) as DiagnosticSeverity[]) {
      delete this.#pendingLossFromOtherComponents[severity];
    }
    this.#queue.push(Object.freeze({ record: gap, bytes, sourceRecord: false }));
    this.#queuedBytes += bytes;
  }

  /**
   * Adds one provably unwritten source entry to terminal discard evidence.
   * @param entry - Accepted source or synthesized control queue entry.
   */
  #countDropped(entry: SinkQueueEntry): void {
    if (!entry.sourceRecord) return;
    this.#droppedRecords += 1;
    this.#droppedBytes += entry.bytes;
  }

  /**
   * Ends best-effort shutdown without waiting on an uncooperative destination.
   * @returns Immutable timeout evidence shared by attachment close paths.
   */
  #expireShutdown(): DiagnosticAttachmentCloseEvidence {
    if (this.#ended) {
      /** The settled lifecycle already carries the exact earlier evidence. */
      return Object.freeze({
        kind: this.#failure === undefined ? 'detached' : 'sink-failed',
        acceptedRecords: this.#acceptedRecords,
        writtenRecords: this.#writtenRecords,
        writtenBytes: this.#writtenBytes,
        droppedRecords: this.#droppedRecords,
        droppedBytes: this.#droppedBytes,
        unconfirmedRecords: this.#unconfirmedRecords,
        unconfirmedBytes: this.#unconfirmedBytes,
        ...(this.#failure === undefined ? {} : { failure: this.#failure }),
      });
    }
    this.#accepting = false;
    this.#remove();
    if (this.#inFlight?.sourceRecord === true) {
      this.#unconfirmedRecords += 1;
      this.#unconfirmedBytes += this.#inFlight.bytes;
    }
    /** Every entry not yet submitted to the destination is provably discarded. */
    for (const queued of this.#queue) this.#countDropped(queued);
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#failure ??= toPublicError(new Error('diagnostic shutdown expired'), {
      code: 'diagnostic_sink_shutdown_timeout',
      message: 'A diagnostic sink exceeded its shutdown deadline',
      retryable: false,
    });
    return this.#settleEvidence();
  }

  /**
   * Waits for an active pump or starts one before destination finalization.
   * @returns Immutable attachment close evidence after accepted records drain.
   */
  async #drainAndFinalize(): Promise<DiagnosticAttachmentCloseEvidence> {
    if (this.#queue.length > 0 && !this.#pumping) this.#schedulePump();
    await this.#pumpPromise;
    return this.#finalize();
  }

  /**
   * Flushes and optionally closes the sink before immutable evidence settles.
   * @returns The one immutable attachment close record.
   */
  async #finalize(): Promise<DiagnosticAttachmentCloseEvidence> {
    if (this.#ended) return this.closed;
    try {
      await this.#sink.value.flush();
    } catch (error) {
      this.#failure ??= toPublicError(error, {
        code: 'diagnostic_sink_flush_failed',
        message: 'A diagnostic sink failed to flush',
        retryable: true,
      });
    }
    if (this.#ended) return this.closed;
    if (this.#sink.ownership === 'owned') {
      try {
        /** Preserves fulfilled tagged failure evidence as well as rejection. */
        const closeEvidence = await this.#sink.value.close();
        if (closeEvidence.kind === 'failed') this.#failure ??= closeEvidence.failure;
      } catch (error) {
        this.#failure ??= toPublicError(error, {
          code: 'diagnostic_sink_close_failed',
          message: 'A diagnostic sink failed to close',
          retryable: false,
        });
      }
    }
    if (this.#ended) return this.closed;
    return this.#settleEvidence();
  }

  /**
   * Freezes current counters and first failure into the one lifecycle record.
   * @returns Immutable evidence shared by close and closed.
   */
  #settleEvidence(): DiagnosticAttachmentCloseEvidence {
    if (this.#ended) {
      /** This branch is reached only by an already-settled concurrent finalizer. */
      throw new Error('Diagnostic attachment evidence already settled');
    }
    this.#ended = true;
    /** Freezes the first failure and exact loss counters into one terminal record. */
    const evidence: DiagnosticAttachmentCloseEvidence = Object.freeze({
      kind: this.#failure === undefined ? 'detached' : 'sink-failed',
      acceptedRecords: this.#acceptedRecords,
      writtenRecords: this.#writtenRecords,
      writtenBytes: this.#writtenBytes,
      droppedRecords: this.#droppedRecords,
      droppedBytes: this.#droppedBytes,
      unconfirmedRecords: this.#unconfirmedRecords,
      unconfirmedBytes: this.#unconfirmedBytes,
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    });
    this.#settle(evidence);
    return evidence;
  }
}

/**
 * Creates a diagnostics owner whose public stream and extension sinks share one
 * admission point but retain independent delivery queues.
 * @param options - Source identity, deterministic host services, and sink defaults.
 * @returns The retained diagnostics publication and attachment capability.
 */
export function createDiagnostics(options: DiagnosticsOptions = {}): DiagnosticHub {
  /**
   * Supplies normalized timestamps to original and synthesized records.
   * @returns The host's current instant.
   */
  const now = options.now ?? (() => new Date());

  /**
   * Supplies process-monotonic elapsed readings without exposing them in records.
   * @returns The current host monotonic millisecond reading.
   */
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  /** Supplies UUIDv4 process-local diagnostic identity. */
  const createSpanId = options.createSpanId ?? createUuidV4;

  /** Defers destination work outside record admission. */
  const schedule = options.schedule ?? defaultSchedule;

  /** Bounds total best-effort destination shutdown without wall-clock assumptions in tests. */
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw new RangeError('shutdownTimeoutMs must be a positive safe integer');
  }

  /**
   * Starts one bounded expiration signal for an attachment or shared hub close.
   * @returns An expiration promise plus release for any retained host timer.
   */
  const shutdownDeadline = (): ShutdownDeadline => {
    if (options.waitForShutdownTimeout === undefined) return defaultShutdownDeadline(shutdownTimeoutMs);
    /** Treats an injected timer rejection as expiration without owning its host resources. */
    const expired = Promise.resolve()
      .then(() => options.waitForShutdownTimeout?.(shutdownTimeoutMs))
      .then(
        () => undefined,
        () => undefined,
      );
    return Object.freeze({
      expired,
      /**
       * Leaves host-resource release with the injected timer implementation.
       * @returns Nothing because the dispatcher owns no injected timer handle.
       */
      cancel() {
        return undefined;
      },
    });
  };

  /** Publishes the public transient observation plane. */
  const events: TransientEventSource<DiagnosticRecord> = createTransientEventSource({
    source: options.source ?? 'diagnostics',
    epoch: options.epoch ?? globalThis.crypto.randomUUID(),
    eventEncoding: Object.freeze({
      revision: 'diagnostic-record/2',
      /**
       * Revalidates and owns each diagnostic before transient fan-out.
       * @param diagnostic - Normalized record offered to the public event plane.
       * @returns A deeply immutable source-owned diagnostic record.
       */
      normalize: (diagnostic) => DiagnosticRecordSchema.parse(diagnostic),
      measure: measureRecord,
    }),
  });

  /** Applies safe per-sink defaults before individual attachment overrides. */
  const delivery: Required<DeliveryBounds> = Object.freeze({
    capacityItems: options.delivery?.capacityItems ?? 1024,
    capacityBytes: options.delivery?.capacityBytes ?? 4 * 1024 * 1024,
  });

  /** Caps sink-specific expansion at a source-owned maximum. */
  const maximumDelivery: Required<DeliveryBounds> = Object.freeze({
    capacityItems: options.maximumDelivery?.capacityItems ?? delivery.capacityItems,
    capacityBytes: options.maximumDelivery?.capacityBytes ?? delivery.capacityBytes,
  });
  if (
    !Number.isSafeInteger(maximumDelivery.capacityItems) ||
    maximumDelivery.capacityItems < delivery.capacityItems ||
    !Number.isSafeInteger(maximumDelivery.capacityBytes) ||
    maximumDelivery.capacityBytes < delivery.capacityBytes
  ) {
    throw new RangeError(
      'maximum diagnostic delivery must contain positive safe integers at least as large as defaults',
    );
  }

  /** Bounds synthesized gap cardinality independently of hostile component names. */
  const gapComponentLimit = options.gapComponentLimit ?? 32;
  if (!Number.isSafeInteger(gapComponentLimit) || gapComponentLimit < 1) {
    throw new RangeError('gapComponentLimit must be a positive safe integer');
  }

  /** Applies finite defaults before any span begins accumulating context. */
  const spanLimits: DiagnosticSpanLimits = Object.freeze({
    maxNamespaces: options.spanLimits?.maxNamespaces ?? 64,
    maxAttributeBytes: options.spanLimits?.maxAttributeBytes ?? 64 * 1024,
  });
  if (
    !Number.isSafeInteger(spanLimits.maxNamespaces) ||
    spanLimits.maxNamespaces < 1 ||
    !Number.isSafeInteger(spanLimits.maxAttributeBytes) ||
    spanLimits.maxAttributeBytes < 1
  ) {
    throw new RangeError('Diagnostic span limits must be positive safe integers');
  }

  /** Retains currently accepting sink attachments. */
  const attachments = new Set<SinkAttachment>();

  /** Retains open process-local spans so orderly shutdown can abandon them honestly. */
  const openSpans = new Set<DiagnosticSpan>();

  /** Prevents admission and new attachments after hub shutdown begins. */
  let closing = false;

  /** Retains one idempotent hub close operation. */
  let closePromise: Promise<DiagnosticsCloseEvidence> | undefined;

  /** Exposes one stable hub lifecycle promise before closure begins. */
  let settleClosed: ((evidence: DiagnosticsCloseEvidence) => void) | undefined;
  /** Retains lifecycle observation independently of lazy shutdown activation. */
  const closed = new Promise<DiagnosticsCloseEvidence>((resolve) => {
    settleClosed = resolve;
  });

  /**
   * Creates a normalized record through this hub's injected clock.
   * @param input - Product-neutral record fields supplied by a component.
   * @returns A normalized record at the injected current instant.
   */
  const event = (input: DiagnosticEventInput): DiagnosticEventRecord => createDiagnosticEvent(input, now);

  /**
   * Admits a record to public observation and all healthy sink queues.
   * @param input - Normalized record entering the dispatcher.
   * @param excluded - Failed sink that must not receive its own failure report.
   */
  const emit = (input: DiagnosticRecord, excluded?: SinkAttachment): void => {
    if (closing) return;
    /** Revalidates data at the dispatcher boundary before fan-out. */
    const diagnostic = DiagnosticRecordSchema.parse(input);
    events.publish(diagnostic);
    /** Offers the admitted record to each independent healthy sink queue. */
    for (const attachment of attachments) {
      if (attachment !== excluded) attachment.offer(diagnostic);
    }
  };

  /**
   * Reports a rejected write without including native sink error material.
   * @param attachment - Failed destination excluded from recursive reporting.
   * @param failure - Already-redacted public write failure.
   * @param action - Truthful continuation or detachment selected by the attachment.
   */
  const reportFailure: AttachmentFailureReporter = (attachment, failure, action) => {
    emit(
      event({
        name: 'diagnostics.sink_write_failed',
        severity: 'error',
        component: 'core.diagnostics',
        outcome: action,
        correlation: {},
        attributes: {},
        error: failure,
      }),
      attachment,
    );
  };

  /** Constructs the public hub facade around private destination queues. */
  const hub: DiagnosticHub = {
    events: asTransientEventStream(events),
    closed,
    /**
     * Admits one preconstructed normalized diagnostic.
     * @param diagnostic - Product-neutral record to fan out.
     */
    emit(diagnostic) {
      emit(diagnostic);
    },
    /**
     * Creates and admits one standalone event using the hub clock.
     * @param input - Event fields other than source-owned schema, kind, and time.
     * @returns The exact admitted normalized event.
     */
    event(input) {
      /** Creates one event so caller and sinks observe equivalent immutable data. */
      const diagnostic = event(input);
      emit(diagnostic);
      return diagnostic;
    },
    /**
     * Begins one bounded span and retains it for orderly hub abandonment.
     * @param input - Stable identity, correlation, and initial namespaced context.
     * @returns An open process-local span that emits only at settlement.
     */
    beginSpan(input) {
      if (closing) {
        throw new DiagnosticSpanError('diagnostic_span_hub_closed', 'Diagnostics cannot begin a span after close');
      }
      /** Captures the instance for removal when its terminal callback runs. */
      const span: DiagnosticSpan = createDiagnosticSpan({
        input,
        limits: spanLimits,
        now,
        monotonicNow,
        createSpanId,
        /**
         * Publishes one terminal record and releases the hub's open-span retention.
         * @param diagnostic - Complete immutable record produced by span settlement.
         */
        onSettled(diagnostic) {
          openSpans.delete(span);
          emit(diagnostic);
        },
      });
      openSpans.add(span);
      return span;
    },
    /**
     * Attaches one independently bounded extension destination.
     * @param sink - Explicitly owned or borrowed diagnostic destination.
     * @param attachOptions - Filter, bounds, and failed-write behavior.
     * @returns The retained attachment owner.
     */
    attach(sink, attachOptions = {}) {
      /** Removes the attachment without giving its sink authority over the hub. */
      const attachment = new SinkAttachment(
        sink,
        attachOptions,
        delivery,
        maximumDelivery,
        gapComponentLimit,
        schedule,
        event,
        reportFailure,
        () => attachments.delete(attachment),
        shutdownDeadline,
      );
      if (closing) void attachment.close();
      else attachments.add(attachment);
      return attachment;
    },
    /**
     * Stops admission and closes every current attachment independently.
     * @returns Shared immutable diagnostics shutdown evidence.
     */
    close() {
      if (closePromise !== undefined) return closePromise;
      /** Snapshots every open span before synchronous abandonment mutates the set. */
      const spans = [...openSpans];
      /** Counts only spans whose abandonment produced terminal evidence. */
      let abandonedSpans = 0;
      /** Settles each retained open span before diagnostic admission closes. */
      for (const span of spans) {
        if (span.abandon({ reason: 'diagnostics_shutdown' }).ok) abandonedSpans += 1;
      }
      openSpans.clear();
      closing = true;
      /** Snapshots current attachments before shutdown mutates membership. */
      const current = [...attachments];
      attachments.clear();
      /** Gives every destination the same absolute parent shutdown deadline. */
      const deadline = shutdownDeadline();
      closePromise = Promise.all([
        events.close(),
        ...current.map((attachment) => attachment.closeBefore(deadline.expired)),
      ])
        .then(() => {
          /** Shares one immutable close record through method and property access. */
          const evidence: DiagnosticsCloseEvidence = Object.freeze({
            kind: 'closed',
            attachments: current.length,
            abandonedSpans,
          });
          settleClosed?.(evidence);
          return evidence;
        })
        .finally(deadline.cancel);
      return closePromise;
    },
    /** Delegates language disposal to hub shutdown. */
    async [Symbol.asyncDispose]() {
      await hub.close();
    },
  };

  return Object.freeze(hub);
}
