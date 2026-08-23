/**
 * @file Implements explicit, bounded diagnostic span accumulation.
 *
 * One runtime object owns the mutable open-to-terminal lifecycle. Every value
 * admitted into it is copied and frozen, and only terminal settlement emits a
 * DiagnosticSpanRecord through the hub-owned callback.
 */

import { toPublicError, type PublicErrorFallback } from '../protocol.js';
import { Result, type Result as ResultValue } from '../result.js';
import {
  CanonicalDecimalSchema,
  JsonObjectSchema,
  TimestampSchema,
  UuidV4Schema,
  type JsonObject,
  type UuidV4,
} from '../values.js';
import {
  DiagnosticSpanAbandonmentSchema,
  DiagnosticSpanAttributesSchema,
  DiagnosticSpanCompletionSchema,
  DiagnosticSpanError,
  DiagnosticSpanFailureSchema,
  DiagnosticSpanInputSchema,
  DiagnosticSpanNamespaceSchema,
  DiagnosticSpanRecordSchema,
  type DiagnosticHub,
  type DiagnosticSeverity,
  type DiagnosticSpan,
  type DiagnosticSpanAbandonment,
  type DiagnosticSpanAttributes,
  type DiagnosticSpanCompletion,
  type DiagnosticSpanFailure,
  type DiagnosticSpanInput,
  type DiagnosticSpanLimits,
  type DiagnosticSpanRecord,
  type DiagnosticSpanSettlement,
  type DiagnosticSpanState,
} from './contracts.js';

/** Supplies deterministic wall time at span start and settlement. */
export type DiagnosticSpanClock = () => Date;

/** Supplies monotonic milliseconds for elapsed-time calculation. */
export type DiagnosticSpanMonotonicClock = () => number;

/** Supplies process-local UUIDv4 span identity without ambient randomness in tests. */
export type DiagnosticSpanIdFactory = () => UuidV4 | string;

/** Internal dependencies required to construct one legal open span. */
export type CreateDiagnosticSpanOptions = Readonly<{
  /** Carries component-owned identity, correlation, and initial context. */
  input: DiagnosticSpanInput;

  /** Bounds context retained before one terminal record is emitted. */
  limits: DiagnosticSpanLimits;

  /** Captures normalized start and finish wall instants. */
  now: DiagnosticSpanClock;

  /** Captures elapsed time without depending on wall-clock continuity. */
  monotonicNow: DiagnosticSpanMonotonicClock;

  /** Creates one source-owned span identity at admission. */
  createSpanId: DiagnosticSpanIdFactory;

  /** Admits the only terminal record into the owning hub. */
  onSettled(record: DiagnosticSpanRecord): void;
}>;

/** Work callback observed by the managed helper without changing its result. */
export type DiagnosticSpanWork<Value> = (span: DiagnosticSpan) => Value | Promise<Value>;

/** Names the bounded reasons an open enrichment may be refused. */
type EnrichmentRejectionReason = 'invalid' | 'namespace_limit' | 'byte_limit';

/** Measures the canonical JSON bytes charged to one span context budget. */
const jsonEncoder = new TextEncoder();

/**
 * Measures immutable JSON through the same representation emitted to sinks.
 * @param value - JSON admitted by the span or its public schemas.
 * @returns UTF-8 bytes occupied by the canonical JSON-compatible representation.
 */
function measureJson(value: JsonObject): number {
  return jsonEncoder.encode(JSON.stringify(value)).byteLength;
}

/**
 * Validates a host monotonic reading before it can shape public duration.
 * @param value - Injected elapsed-time reading in milliseconds.
 * @returns The finite non-negative reading unchanged.
 */
function admitMonotonic(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Diagnostic span monotonic clocks must return finite non-negative milliseconds');
  }
  return value;
}

/** Owns one process-local open-to-terminal diagnostic lifecycle. */
class DiagnosticSpanRuntime implements DiagnosticSpan {
  /** Stable source-owned identity published in the terminal record. */
  readonly spanId: UuidV4;

  /** Immutable admitted component input retained until settlement. */
  readonly #input: DiagnosticSpanInput;

  /** Source-owned limits applied to every proposed context replacement. */
  readonly #limits: DiagnosticSpanLimits;

  /** Injected wall clock read only at start and terminal settlement. */
  readonly #now: DiagnosticSpanClock;

  /** Injected monotonic clock used only for elapsed duration. */
  readonly #monotonicNow: DiagnosticSpanMonotonicClock;

  /** Hub callback that publishes the one terminal record. */
  readonly #onSettled: (record: DiagnosticSpanRecord) => void;

  /** Normalized wall-clock instant captured before observed work begins. */
  readonly #startedAt: ReturnType<typeof TimestampSchema.parse>;

  /** Monotonic start reading kept private because it is process-specific. */
  readonly #startedMonotonic: number;

  /** Fresh immutable namespace map replaced atomically on accepted enrichment. */
  #attributes: DiagnosticSpanAttributes;

  /** Public lifecycle state earned only by one settlement method. */
  #state: DiagnosticSpanState = 'open';

  /** Counts successful enrichments, including explicit namespace replacements. */
  #acceptedUpdates = 0;

  /** Counts invalid or over-budget enrichments while the span remains open. */
  #rejectedUpdates = 0;

  /** Accumulates known rejected bytes without Number precision loss. */
  #rejectedBytes = 0n;

  /**
   * Creates one legal open span without emitting a start breadcrumb.
   * @param options - Validated input, deterministic host services, and terminal publisher.
   */
  constructor(options: CreateDiagnosticSpanOptions) {
    /** Owns a normalized copy before any asynchronous observed work can mutate input. */
    const input = DiagnosticSpanInputSchema.parse(options.input);
    /** Owns an empty namespace map when no initial context was supplied. */
    const attributes = DiagnosticSpanAttributesSchema.parse(input.attributes ?? {});
    /** Charges initial context against the same limits as later enrichment. */
    const attributeBytes = measureJson(attributes);
    /** Refuses optional context atomically so best-effort diagnosis cannot prevent work. */
    const initialContextRejected =
      input.attributes !== undefined &&
      (Object.keys(attributes).length > options.limits.maxNamespaces ||
        attributeBytes > options.limits.maxAttributeBytes);

    /** Retains only identity fields so refused context does not remain hidden in memory. */
    this.#input = Object.freeze({
      name: input.name,
      component: input.component,
      correlation: input.correlation,
      ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    });
    this.#attributes = initialContextRejected ? DiagnosticSpanAttributesSchema.parse({}) : attributes;
    this.#limits = options.limits;
    this.#now = options.now;
    this.#monotonicNow = options.monotonicNow;
    this.#onSettled = options.onSettled;
    this.spanId = UuidV4Schema.parse(options.createSpanId());
    this.#startedAt = TimestampSchema.parse(options.now().toISOString());
    this.#startedMonotonic = admitMonotonic(options.monotonicNow());
    if (initialContextRejected) {
      this.#rejectedUpdates = 1;
      this.#rejectedBytes = BigInt(attributeBytes);
    }
  }

  /**
   * Returns the earned lifecycle state without exposing mutable storage.
   * @returns The current open or terminal state.
   */
  get state(): DiagnosticSpanState {
    return this.#state;
  }

  /**
   * Adds or replaces one namespace while preserving prior context on refusal.
   * @param namespace - Stable package-owned namespace for this context object.
   * @param attributes - Caller-owned JSON object copied before retention.
   * @returns Success with no emitted record, or a focused immutable refusal.
   */
  enrich(namespace: string, attributes: JsonObject): ResultValue<void, DiagnosticSpanError> {
    if (this.#state !== 'open') return this.#alreadySettled();

    /** Validates namespace identity independently of context shape. */
    const admittedNamespace = DiagnosticSpanNamespaceSchema.safeParse(namespace);
    /** Copies and freezes caller context before measurement or retention. */
    const admittedAttributes = JsonObjectSchema.safeParse(attributes);
    if (!admittedNamespace.success || !admittedAttributes.success) {
      return this.#rejectEnrichment(typeof namespace === 'string' ? namespace : '<invalid>', 'invalid', 0);
    }

    /** Charges the attempted namespace payload for truthful rejection evidence. */
    const attemptedBytes = measureJson({ [admittedNamespace.data]: admittedAttributes.data });
    /** Builds a fresh candidate so refusal cannot partially mutate retained context. */
    const candidate = DiagnosticSpanAttributesSchema.parse({
      ...this.#attributes,
      [admittedNamespace.data]: admittedAttributes.data,
    });
    if (Object.keys(candidate).length > this.#limits.maxNamespaces) {
      return this.#rejectEnrichment(admittedNamespace.data, 'namespace_limit', attemptedBytes);
    }
    if (measureJson(candidate) > this.#limits.maxAttributeBytes) {
      return this.#rejectEnrichment(admittedNamespace.data, 'byte_limit', attemptedBytes);
    }

    this.#attributes = candidate;
    this.#acceptedUpdates += 1;
    return Result.ok(undefined);
  }

  /**
   * Settles ordinary success with informational severity by default.
   * @param input - Component-owned outcome and optional severity override.
   * @returns The emitted terminal record or an exact transition refusal.
   */
  complete(input: DiagnosticSpanCompletion): ResultValue<DiagnosticSpanRecord, DiagnosticSpanError> {
    if (this.#state !== 'open') return this.#alreadySettled();
    /** Normalizes settlement before it can earn a terminal state. */
    const admitted = DiagnosticSpanCompletionSchema.safeParse(input);
    if (!admitted.success) return this.#settlementRejected('complete');
    return this.#settle('completed', admitted.data.severity ?? 'info', {
      kind: 'completed',
      outcome: admitted.data.outcome,
    });
  }

  /**
   * Settles observed failure with error severity by default.
   * @param input - Component-owned outcome, redacted failure, and optional severity.
   * @returns The emitted terminal record or an exact transition refusal.
   */
  fail(input: DiagnosticSpanFailure): ResultValue<DiagnosticSpanRecord, DiagnosticSpanError> {
    if (this.#state !== 'open') return this.#alreadySettled();
    /** Normalizes bounded failure data before it can enter the diagnostic plane. */
    const admitted = DiagnosticSpanFailureSchema.safeParse(input);
    if (!admitted.success) return this.#settlementRejected('fail');
    return this.#settle('failed', admitted.data.severity ?? 'error', {
      kind: 'failed',
      outcome: admitted.data.outcome,
      error: admitted.data.error,
    });
  }

  /**
   * Ends observation without claiming that the underlying work settled.
   * @param input - Bounded abandonment reason and optional severity override.
   * @returns The emitted terminal record or an exact transition refusal.
   */
  abandon(input: DiagnosticSpanAbandonment): ResultValue<DiagnosticSpanRecord, DiagnosticSpanError> {
    if (this.#state !== 'open') return this.#alreadySettled();
    /** Normalizes the reason before it can explain an absent work settlement. */
    const admitted = DiagnosticSpanAbandonmentSchema.safeParse(input);
    if (!admitted.success) return this.#settlementRejected('abandon');
    return this.#settle('abandoned', admitted.data.severity ?? 'warn', {
      kind: 'abandoned',
      reason: admitted.data.reason,
    });
  }

  /**
   * Records one open-span enrichment refusal without retaining rejected data.
   * @param namespace - Caller namespace or an explicit invalid placeholder.
   * @param reason - Stable policy gate that refused the update.
   * @param bytes - Known UTF-8 bytes carried by the refused namespace payload.
   * @returns A focused Result error with prior context preserved.
   */
  #rejectEnrichment(
    namespace: string,
    reason: EnrichmentRejectionReason,
    bytes: number,
  ): ResultValue<void, DiagnosticSpanError> {
    this.#rejectedUpdates += 1;
    this.#rejectedBytes += BigInt(bytes);
    return Result.error(
      new DiagnosticSpanError('diagnostic_span_enrichment_rejected', 'Diagnostic span enrichment was refused', {
        namespace,
        reason,
        maxNamespaces: this.#limits.maxNamespaces,
        maxAttributeBytes: this.#limits.maxAttributeBytes,
      }),
    );
  }

  /**
   * Refuses every command after the one terminal transition has been earned.
   * @returns A focused Result error naming the retained terminal state.
   */
  #alreadySettled<Value>(): ResultValue<Value, DiagnosticSpanError> {
    return Result.error(
      new DiagnosticSpanError('diagnostic_span_already_settled', 'Diagnostic span already settled', {
        state: this.#state,
        spanId: this.spanId,
      }),
    );
  }

  /**
   * Refuses malformed runtime settlement without exposing schema implementation detail.
   * @param command - Public transition method whose input was not admitted.
   * @returns A focused Result error while the span remains open.
   */
  #settlementRejected<Value>(command: 'complete' | 'fail' | 'abandon'): ResultValue<Value, DiagnosticSpanError> {
    return Result.error(
      new DiagnosticSpanError('diagnostic_span_settlement_rejected', 'Diagnostic span settlement was refused', {
        command,
      }),
    );
  }

  /**
   * Earns one terminal state, creates its immutable wide record, and emits once.
   * @param nextState - Terminal lifecycle state corresponding to settlement kind.
   * @param severity - Final operator significance selected by the settlement command.
   * @param settlement - Normalized completed, failed, or abandoned disposition.
   * @returns The emitted terminal record or a focused settlement refusal.
   */
  #settle(
    nextState: Exclude<DiagnosticSpanState, 'open'>,
    severity: DiagnosticSeverity,
    settlement: DiagnosticSpanSettlement,
  ): ResultValue<DiagnosticSpanRecord, DiagnosticSpanError> {
    if (this.#state !== 'open') return this.#alreadySettled();

    /** Retains the terminal record only after every source-owned field validates. */
    let record: DiagnosticSpanRecord;
    try {
      /** Captures the terminal monotonic reading independently of wall time. */
      const endedMonotonic = admitMonotonic(this.#monotonicNow());
      if (endedMonotonic < this.#startedMonotonic) {
        throw new RangeError('Diagnostic span monotonic clock moved backwards');
      }
      /** Builds the complete terminal record before making settlement externally visible. */
      record = DiagnosticSpanRecordSchema.parse({
        schema: 1,
        kind: 'span',
        name: this.#input.name,
        severity,
        at: this.#now().toISOString(),
        component: this.#input.component,
        spanId: this.spanId,
        ...(this.#input.parentSpanId === undefined ? {} : { parentSpanId: this.#input.parentSpanId }),
        startedAt: this.#startedAt,
        durationMs: endedMonotonic - this.#startedMonotonic,
        settlement,
        enrichment: {
          acceptedUpdates: this.#acceptedUpdates,
          rejectedUpdates: this.#rejectedUpdates,
          rejectedBytes: CanonicalDecimalSchema.parse(this.#rejectedBytes.toString()),
        },
        correlation: this.#input.correlation,
        attributes: this.#attributes,
      });
    } catch {
      return Result.error(
        new DiagnosticSpanError(
          'diagnostic_span_settlement_failed',
          'Diagnostic span could not produce terminal evidence',
          { spanId: this.spanId },
        ),
      );
    }

    this.#state = nextState;
    try {
      this.#onSettled(record);
    } catch {
      // Dispatch is deliberately best effort after the span has earned terminal evidence.
    }
    return Result.ok(record);
  }
}

/**
 * Creates one bounded open span for a DiagnosticHub.
 * @param options - Validated input, injected host services, and terminal publisher.
 * @returns A public lifecycle interface with no implementation-class exposure.
 */
export function createDiagnosticSpan(options: CreateDiagnosticSpanOptions): DiagnosticSpan {
  return new DiagnosticSpanRuntime(options);
}

/**
 * Observes asynchronous work without changing its exact value or thrown Error.
 *
 * The callback may settle the span explicitly for domain-specific outcomes. If
 * it does not, the helper supplies `completed` or a bounded `failed` fallback.
 * @param diagnostics - Hub capability that owns span construction and emission.
 * @param input - Span identity, correlation, and initial admitted context.
 * @param work - Exact work whose return or throw behavior must be preserved.
 * @param failureFallback - Redacted fallback for unknown non-Archer failures.
 * @returns The exact callback value, or rejection with the exact callback Error.
 */
export async function withDiagnosticSpan<Value>(
  diagnostics: Pick<DiagnosticHub, 'beginSpan'>,
  input: DiagnosticSpanInput,
  work: DiagnosticSpanWork<Value>,
  failureFallback: PublicErrorFallback = {
    code: 'diagnostic_span_work_failed',
    message: 'Observed work failed',
  },
): Promise<Value> {
  /** Retains explicit span identity through the callback rather than ambient state. */
  const span = diagnostics.beginSpan(input);
  try {
    /** Preserves the exact callback value before best-effort diagnostic settlement. */
    const value = await work(span);
    if (span.state === 'open') span.complete({ outcome: 'completed' });
    return value;
  } catch (error) {
    if (span.state === 'open') {
      span.fail({ outcome: 'failed', error: toPublicError(error, failureFallback) });
    }
    throw error;
  }
}
