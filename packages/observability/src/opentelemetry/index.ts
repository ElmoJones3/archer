/**
 * @file Projects normalized Archer diagnostics into OpenTelemetry traces and
 * bounded metrics without treating Archer UUIDs as trace context.
 *
 * The retained sink owns only its pending-parent graph and projected-context
 * cache. Flush and close authority over the injected SDK stays explicit through
 * a borrowed or owned lifecycle reference. The optional OpenTelemetry API is
 * loaded only when the synchronous factory is selected.
 */

import { createRequire } from 'node:module';

import type {
  Attributes,
  Counter,
  Histogram,
  Meter,
  MetricAttributes,
  Span,
  SpanContext,
  Tracer,
} from '@opentelemetry/api';

import {
  ArcherError,
  toProtocolFailure,
  type ComponentRef,
  type DiagnosticEventRecord,
  type DiagnosticRecord,
  type DiagnosticSink,
  type DiagnosticSinkCloseEvidence,
  type DiagnosticSpanRecord,
  type OwnedHandle,
  type PublicError,
} from '@archer/core';

/** Supported optional OpenTelemetry API peer rendered in construction failures. */
const OPENTELEMETRY_API_RANGE = '^1.9.1';

/** Default pending-parent item limit keeps out-of-order completion finite. */
const DEFAULT_PENDING_ITEMS = 2_048;

/** Default pending-parent byte limit caps retained normalized record data. */
const DEFAULT_PENDING_BYTES = 4 * 1_024 * 1_024;

/** Default projected-context item limit supports ordinary late-child arrival. */
const DEFAULT_PROJECTED_CONTEXT_ITEMS = 4_096;

/** Default projected-context byte limit prevents trace identity retention from growing forever. */
const DEFAULT_PROJECTED_CONTEXT_BYTES = 1 * 1_024 * 1_024;

/** Stable metric name for terminal span duration in monotonic milliseconds. */
const SPAN_DURATION_METRIC = 'archer.diagnostic.span.duration';

/** Stable metric name for terminal diagnostic span cardinality. */
const SPAN_COUNT_METRIC = 'archer.diagnostic.span.count';

/** Stable metric name for standalone diagnostic event cardinality. */
const EVENT_COUNT_METRIC = 'archer.diagnostic.event.count';

/** Runtime API namespace loaded only at the selected adapter factory boundary. */
type OpenTelemetryApi = typeof import('@opentelemetry/api');

/** Stable public identities for every Archer-owned OpenTelemetry adapter failure. */
export type OpenTelemetrySinkErrorCode =
  | 'opentelemetry_api_unavailable'
  | 'opentelemetry_configuration_invalid'
  | 'opentelemetry_projection_failed'
  | 'opentelemetry_flush_failed'
  | 'opentelemetry_sink_closed'
  | 'opentelemetry_close_failed';

/**
 * Carries bounded OpenTelemetry adapter failure identity without retaining
 * dependency messages, causes, credentials, paths, or exporter details.
 */
export class OpenTelemetrySinkError extends ArcherError {
  /**
   * Creates one focused adapter failure from adapter-owned bounded text.
   * @param code - Stable category suitable for caller branching.
   * @param message - Bounded adapter-authored message safe for public identity.
   */
  constructor(code: OpenTelemetrySinkErrorCode, message: string) {
    super(message, { code });
  }
}

/** Maps every Archer correlation field to one retained trace attribute. */
const CORRELATION_ATTRIBUTE_KEYS = Object.freeze({
  taskId: 'archer.task_id',
  threadId: 'archer.thread_id',
  turnId: 'archer.turn_id',
  cellId: 'archer.cell_id',
  effectId: 'archer.effect_id',
  attemptId: 'archer.attempt_id',
  modelRequestId: 'archer.model_request_id',
  invocationId: 'archer.invocation_id',
  sandboxId: 'archer.sandbox_id',
  materializedViewId: 'archer.materialized_view_id',
  workspaceId: 'archer.workspace_id',
  resourceSetId: 'archer.resource_set_id',
  changeSetId: 'archer.change_set_id',
});

/** Configures one independently enforced in-memory retention limit. */
export type OpenTelemetryRetentionBounds = Readonly<{
  /** Maximum number of retained values before oldest unresolved work is projected. */
  capacityItems?: number;

  /** Maximum UTF-8 encoded bytes retained before unresolved work is projected or evicted. */
  capacityBytes?: number;
}>;

/**
 * Gives the sink an explicit SDK flush boundary and, only when owned, close
 * authority. One lifecycle can compose both trace and metric providers.
 */
export interface OpenTelemetryFlushLifecycle extends OwnedHandle<DiagnosticSinkCloseEvidence> {
  /** Forces trace and metric data already handed to the SDK toward their exporters. */
  forceFlush(): Promise<void>;
}

/** Constructs one retained OpenTelemetry projection with explicit dependency ownership. */
export type OpenTelemetrySinkOptions = Readonly<{
  /** Creates completed spans without exposing an SDK provider through Archer contracts. */
  tracer: Tracer;

  /** Creates the adapter's bounded synchronous metric instruments. */
  meter: Meter;

  /** Selects borrowed or transferred authority over the SDK flush lifecycle. */
  flushLifecycle: ComponentRef<OpenTelemetryFlushLifecycle>;

  /** Overrides pending-parent item or byte limits independently. */
  pending?: OpenTelemetryRetentionBounds;

  /** Overrides projected SDK SpanContext cache limits independently. */
  projectedContexts?: OpenTelemetryRetentionBounds;
}>;

/** Fully resolved positive limits used by one retained collection. */
type ResolvedRetentionBounds = Readonly<{
  /** Exact maximum retained item count. */
  capacityItems: number;

  /** Exact maximum retained UTF-8 byte count. */
  capacityBytes: number;
}>;

/** One unresolved terminal record plus its already-computed retention cost. */
type PendingSpan = Readonly<{
  /** Production-normalized span awaiting a real SDK parent context. */
  record: DiagnosticSpanRecord;

  /** UTF-8 encoded bytes charged against pending retention. */
  bytes: number;
}>;

/** One real SDK context retained for children that arrive after their parent. */
type ProjectedContext = Readonly<{
  /** Context returned by the injected tracer rather than fabricated from Archer identity. */
  context: SpanContext;

  /** Approximate encoded identity bytes charged against cache retention. */
  bytes: number;
}>;

/** Adapter-only evidence attached when hierarchy fidelity cannot be retained. */
type ProjectionEvidence = Readonly<{
  /** Marks an Archer parent that was unresolved when the record had to project. */
  parentMissing?: boolean;

  /** Marks a repeated Archer span identity that cannot safely own child resolution. */
  duplicateIdentity?: boolean;
}>;

/** One iterative projection step carrying a real parent context when available. */
type ProjectionQueueEntry = Readonly<{
  /** Terminal Archer record projected by this step. */
  record: DiagnosticSpanRecord;

  /** Real SDK parent context produced by the preceding projection step. */
  parent?: SpanContext;

  /** Hierarchy degradation evidence attached to this record. */
  evidence: ProjectionEvidence;
}>;

/** Lifecycle states prevent writes after close starts and make close idempotent. */
type SinkState = 'open' | 'closing' | 'closed';

/** Fixed retention collection names prevent caller data from entering failures. */
type RetentionLabel = 'pending' | 'projectedContexts';

/**
 * Loads the optional API synchronously only after the caller selects this adapter.
 * @returns The supported OpenTelemetry API runtime namespace.
 * @throws {OpenTelemetrySinkError} When the optional peer cannot be loaded.
 */
function loadOpenTelemetryApi(): OpenTelemetryApi {
  try {
    /** Resolves from the adapter package rather than the consumer's call-site module. */
    const loaded: unknown = createRequire(import.meta.url)('@opentelemetry/api');
    return loaded as OpenTelemetryApi;
  } catch {
    throw new OpenTelemetrySinkError(
      'opentelemetry_api_unavailable',
      `OpenTelemetry adapter requires @opentelemetry/api@${OPENTELEMETRY_API_RANGE}; install that peer before constructing a sink`,
    );
  }
}

/**
 * Resolves optional bounds while refusing values that cannot bound memory.
 * @param requested - Caller overrides for one retained collection.
 * @param defaults - Adapter defaults for omitted item and byte limits.
 * @param label - Stable collection name used in bounded configuration failures.
 * @returns Frozen positive safe-integer limits.
 * @throws {OpenTelemetrySinkError} When either requested bound cannot limit memory.
 */
function resolveBounds(
  requested: OpenTelemetryRetentionBounds | undefined,
  defaults: ResolvedRetentionBounds,
  label: RetentionLabel,
): ResolvedRetentionBounds {
  /** Applies the item override independently from the byte override. */
  const capacityItems = requested?.capacityItems ?? defaults.capacityItems;
  /** Applies the byte override independently from the item override. */
  const capacityBytes = requested?.capacityBytes ?? defaults.capacityBytes;
  if (!Number.isSafeInteger(capacityItems) || capacityItems <= 0) {
    throw new OpenTelemetrySinkError(
      'opentelemetry_configuration_invalid',
      `OpenTelemetry ${label}.capacityItems must be a positive safe integer`,
    );
  }
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
    throw new OpenTelemetrySinkError(
      'opentelemetry_configuration_invalid',
      `OpenTelemetry ${label}.capacityBytes must be a positive safe integer`,
    );
  }
  return Object.freeze({ capacityItems, capacityBytes });
}

/**
 * Creates stable failed sink-close evidence from adapter-owned identity only.
 * @param code - Flush or close category owned by the adapter lifecycle.
 * @param message - Bounded adapter-authored failure text.
 * @returns Immutable redacted close evidence with no upstream fields.
 */
function failedCloseEvidence(
  code: 'opentelemetry_flush_failed' | 'opentelemetry_close_failed',
  message: 'OpenTelemetry flush failed' | 'OpenTelemetry close failed',
): DiagnosticSinkCloseEvidence {
  /** Converts an Archer-owned failure so protocol projection cannot inspect an SDK error. */
  const failure = new OpenTelemetrySinkError(code, message);
  return Object.freeze({
    kind: 'failed',
    failure: toProtocolFailure(failure, { code, message }),
  });
}

/**
 * Measures retained JSON with the same UTF-8 unit used by queue byte bounds.
 * @param value - JSON-compatible value whose encoded size is required.
 * @returns Exact UTF-8 byte length of its JSON representation.
 */
function encodedJsonBytes(value: unknown): number {
  /** Serializes normalized records without reading or mutating their fields. */
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('OpenTelemetry retention value must be JSON-encodable');
  return new TextEncoder().encode(encoded).byteLength;
}

/**
 * Copies bounded public error fields into trace-safe scalar or JSON attributes.
 * @param error - Already-redacted Archer failure value.
 * @returns Fresh attributes that retain no native Error identity.
 */
function publicErrorAttributes(error: PublicError): Attributes {
  /** Keeps adapter projection independent from the immutable source record. */
  const attributes: Attributes = {
    'archer.error.code': error.code,
    'archer.error.message': error.message,
    'archer.error.retryable': error.retryable,
  };
  if (error.details !== undefined) attributes['archer.error.details'] = JSON.stringify(error.details);
  return attributes;
}

/**
 * Projects common record fields and high-cardinality correlation only to traces.
 * @param record - Product-neutral source observation.
 * @returns Fresh OpenTelemetry span attributes.
 */
function baseTraceAttributes(record: DiagnosticRecord): Attributes {
  /** Retains the stable normalized record envelope as scalar trace attributes. */
  const attributes: Attributes = {
    'archer.schema': record.schema,
    'archer.kind': record.kind,
    'archer.name': record.name,
    'archer.component': record.component,
    'archer.severity': record.severity,
    'archer.at': record.at,
  };
  /** Iterates the fixed core correlation vocabulary rather than arbitrary record data. */
  const keys = Object.keys(CORRELATION_ATTRIBUTE_KEYS) as (keyof typeof CORRELATION_ATTRIBUTE_KEYS)[];
  /** Copies only present identities under their fixed trace attribute names. */
  for (const key of keys) {
    /** Reads one optional Archer identity without converting it into trace context. */
    const value = record.correlation[key];
    if (value !== undefined) attributes[CORRELATION_ATTRIBUTE_KEYS[key]] = value;
  }
  return attributes;
}

/**
 * Projects one terminal span record without flattening namespaced context.
 * @param record - Production-normalized terminal span.
 * @param evidence - Adapter hierarchy or identity degradation evidence.
 * @returns Fresh trace attributes for the completed OpenTelemetry span.
 */
function spanTraceAttributes(record: DiagnosticSpanRecord, evidence: ProjectionEvidence): Attributes {
  /** Extends the copied common envelope with terminal span evidence. */
  const attributes: Attributes = {
    ...baseTraceAttributes(record),
    'archer.span_id': record.spanId,
    'archer.started_at': record.startedAt,
    'archer.duration_ms': record.durationMs,
    'archer.settlement': record.settlement.kind,
    'archer.enrichment.accepted_updates': record.enrichment.acceptedUpdates,
    'archer.enrichment.rejected_updates': record.enrichment.rejectedUpdates,
    'archer.enrichment.rejected_bytes': record.enrichment.rejectedBytes,
  };
  if (record.parentSpanId !== undefined) attributes['archer.parent_span_id'] = record.parentSpanId;
  if (evidence.parentMissing === true) attributes['archer.parent_resolution'] = 'missing';
  if (evidence.duplicateIdentity === true) attributes['archer.span_identity_resolution'] = 'duplicate';

  /** Preserves each admitted namespace as one JSON string attribute. */
  const namespaceEntries = Object.entries(record.attributes);
  /** Keeps arbitrary nested keys inside their namespace's single encoded value. */
  for (const [namespace, contextValue] of namespaceEntries) {
    attributes[`archer.context.${namespace}`] = JSON.stringify(contextValue);
  }

  switch (record.settlement.kind) {
    case 'completed':
      attributes['archer.outcome'] = record.settlement.outcome;
      break;
    case 'failed':
      attributes['archer.outcome'] = record.settlement.outcome;
      Object.assign(attributes, publicErrorAttributes(record.settlement.error));
      break;
    case 'abandoned':
      attributes['archer.abandonment.reason'] = record.settlement.reason;
      break;
  }
  return attributes;
}

/**
 * Projects one standalone event while keeping its arbitrary JSON as one value.
 * @param record - Production-normalized point observation.
 * @returns Fresh trace attributes for a zero-duration span.
 */
function eventTraceAttributes(record: DiagnosticEventRecord): Attributes {
  /** Keeps the event attribute object bounded as one core-owned JSON projection. */
  const attributes: Attributes = {
    ...baseTraceAttributes(record),
    'archer.attributes': JSON.stringify(record.attributes),
  };
  if (record.outcome !== undefined) attributes['archer.outcome'] = record.outcome;
  if (record.error !== undefined) Object.assign(attributes, publicErrorAttributes(record.error));
  return attributes;
}

/**
 * Derives only the metric labels allowlisted by the package contract.
 * @param record - Product-neutral observation whose identities stay trace-only.
 * @returns Fresh low-cardinality metric attributes.
 */
function metricAttributes(record: DiagnosticRecord): MetricAttributes {
  /** Starts with labels shared by terminal spans and point events. */
  const attributes: MetricAttributes = {
    'archer.name': record.name,
    'archer.component': record.component,
    'archer.severity': record.severity,
  };
  if (record.kind === 'span') {
    attributes['archer.settlement'] = record.settlement.kind;
    if (record.settlement.kind !== 'abandoned') attributes['archer.outcome'] = record.settlement.outcome;
    if (record.settlement.kind === 'failed') attributes['archer.error_code'] = record.settlement.error.code;
  } else {
    if (record.outcome !== undefined) attributes['archer.outcome'] = record.outcome;
    if (record.error !== undefined) attributes['archer.error_code'] = record.error.code;
  }
  return attributes;
}

/**
 * Applies the exact terminal status mapping without inferring from severity.
 * @param api - Runtime status vocabulary loaded at adapter construction.
 * @param span - Newly created OpenTelemetry span.
 * @param record - Archer observation that owns terminal meaning.
 */
function applyStatus(api: OpenTelemetryApi, span: Span, record: DiagnosticRecord): void {
  if (record.kind === 'span') {
    switch (record.settlement.kind) {
      case 'completed':
        span.setStatus({ code: api.SpanStatusCode.OK });
        return;
      case 'failed':
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: record.settlement.error.message });
        return;
      case 'abandoned':
        return;
    }
  }
  if (record.error !== undefined) {
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: record.error.message });
  }
}

/**
 * Owns bounded graph resolution and retained close semantics for one adapter.
 * The class never mutates source records and never uses ambient context.
 */
class OpenTelemetryDiagnosticSink implements DiagnosticSink {
  /** Supplies only runtime context and status operations from the selected optional peer. */
  readonly #api: OpenTelemetryApi;

  /** Creates destination spans through the application-selected API tracer. */
  readonly #tracer: Tracer;

  /** Flushes and conditionally closes the application-selected SDK lifecycle. */
  readonly #flushLifecycle: ComponentRef<OpenTelemetryFlushLifecycle>;

  /** Enforces both pending-parent limits before another record is retained. */
  readonly #pendingBounds: ResolvedRetentionBounds;

  /** Enforces both late-child context-cache limits on every insertion. */
  readonly #projectedContextBounds: ResolvedRetentionBounds;

  /** Records monotonic duration distributions for terminal spans only. */
  readonly #spanDuration: Histogram<MetricAttributes>;

  /** Counts every terminal span record exactly once when projected. */
  readonly #spanCount: Counter<MetricAttributes>;

  /** Counts every standalone event record exactly once when projected. */
  readonly #eventCount: Counter<MetricAttributes>;

  /** Retains first-seen unresolved identities in source arrival order. */
  readonly #pending = new Map<string, PendingSpan>();

  /** Tracks exact pending record bytes for pressure decisions. */
  #pendingBytes = 0;

  /** Retains first-seen real SDK contexts in projection order. */
  readonly #projectedContexts = new Map<string, ProjectedContext>();

  /** Tracks encoded projected identity bytes for cache eviction. */
  #projectedContextBytes = 0;

  /** Rejects new writes once retained closure begins. */
  #state: SinkState = 'open';

  /** Settles the public retained lifecycle exactly once. */
  readonly #resolveClosed: (evidence: DiagnosticSinkCloseEvidence) => void;

  /** Shares one immutable close result through property and method access. */
  readonly closed: Promise<DiagnosticSinkCloseEvidence>;

  /**
   * Creates instruments once and validates all memory limits before accepting work.
   * @param api - Runtime API loaded by the selected construction boundary.
   * @param options - API dependencies, lifecycle ownership, and retention bounds.
   */
  constructor(api: OpenTelemetryApi, options: OpenTelemetrySinkOptions) {
    this.#api = api;
    this.#tracer = options.tracer;
    this.#flushLifecycle = options.flushLifecycle;
    this.#pendingBounds = resolveBounds(
      options.pending,
      { capacityItems: DEFAULT_PENDING_ITEMS, capacityBytes: DEFAULT_PENDING_BYTES },
      'pending',
    );
    this.#projectedContextBounds = resolveBounds(
      options.projectedContexts,
      {
        capacityItems: DEFAULT_PROJECTED_CONTEXT_ITEMS,
        capacityBytes: DEFAULT_PROJECTED_CONTEXT_BYTES,
      },
      'projectedContexts',
    );
    this.#spanDuration = options.meter.createHistogram(SPAN_DURATION_METRIC, {
      description: 'Monotonic duration of terminal Archer diagnostic spans',
      unit: 'ms',
    });
    this.#spanCount = options.meter.createCounter(SPAN_COUNT_METRIC, {
      description: 'Count of projected Archer terminal diagnostic spans',
      unit: '{span}',
    });
    this.#eventCount = options.meter.createCounter(EVENT_COUNT_METRIC, {
      description: 'Count of projected Archer standalone diagnostic events',
      unit: '{event}',
    });
    /** Captures the resolver while exposing a promise before close begins. */
    let resolveClosed!: (evidence: DiagnosticSinkCloseEvidence) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  /**
   * Projects an ordered batch without awaiting exporters or retaining events.
   * @param records - Normalized records accepted by one diagnostic attachment.
   * @returns A settled promise after every record has entered this projection.
   */
  async write(records: readonly DiagnosticRecord[]): Promise<void> {
    if (this.#state !== 'open') {
      throw new OpenTelemetrySinkError(
        'opentelemetry_sink_closed',
        'OpenTelemetry diagnostic sink is closing or closed',
      );
    }
    try {
      /** Preserves source order except where parent-before-child projection requires retention. */
      for (const record of records) {
        if (record.kind === 'span') this.#acceptSpan(record);
        else this.#projectEvent(record);
      }
    } catch {
      throw new OpenTelemetrySinkError('opentelemetry_projection_failed', 'OpenTelemetry diagnostic projection failed');
    }
  }

  /**
   * Projects every unresolved record as a marked root before flushing the SDK.
   * @returns A promise that settles after the explicit SDK flush boundary.
   */
  async flush(): Promise<void> {
    if (this.#state !== 'open') {
      throw new OpenTelemetrySinkError(
        'opentelemetry_sink_closed',
        'OpenTelemetry diagnostic sink is closing or closed',
      );
    }
    try {
      await this.#flushProjection();
    } catch {
      throw new OpenTelemetrySinkError('opentelemetry_flush_failed', 'OpenTelemetry flush failed');
    }
  }

  /**
   * Starts idempotent projection flush and closes only an owned SDK lifecycle.
   * @returns The same retained close evidence exposed by `closed`.
   */
  close(): Promise<DiagnosticSinkCloseEvidence> {
    if (this.#state !== 'open') return this.closed;
    this.#state = 'closing';
    void this.#finishClose();
    return this.closed;
  }

  /** Delegates language-level disposal to the same idempotent close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Resolves, retains, or pressure-projects one terminal span exactly once.
   * @param record - Production-normalized terminal span in source order.
   */
  #acceptSpan(record: DiagnosticSpanRecord): void {
    /** Detects identities still inside either bounded retention window. */
    const duplicate = this.#pending.has(record.spanId) || this.#projectedContexts.has(record.spanId);
    if (duplicate) {
      this.#projectDuplicate(record);
      return;
    }
    if (record.parentSpanId === undefined) {
      this.#projectTree(record, undefined, {});
      return;
    }
    /** Reuses only a context returned by a previously created SDK span. */
    const knownParent = this.#projectedContexts.get(record.parentSpanId)?.context;
    if (knownParent !== undefined) {
      this.#projectTree(record, knownParent, {});
      return;
    }

    /** Charges the complete normalized record before retaining it. */
    const bytes = encodedJsonBytes(record);
    if (bytes > this.#pendingBounds.capacityBytes) {
      this.#projectTree(record, undefined, { parentMissing: true });
      return;
    }
    if (
      this.#pending.size + 1 > this.#pendingBounds.capacityItems ||
      this.#pendingBytes + bytes > this.#pendingBounds.capacityBytes
    ) {
      this.#projectAllPendingAsMissing();
    }

    /** Pressure projection may have made this record's parent available. */
    const pressureResolvedParent = this.#projectedContexts.get(record.parentSpanId)?.context;
    if (pressureResolvedParent !== undefined) {
      this.#projectTree(record, pressureResolvedParent, {});
      return;
    }

    this.#pending.set(record.spanId, Object.freeze({ record, bytes }));
    this.#pendingBytes += bytes;
    this.#breakCycleFrom(record.spanId);
  }

  /**
   * Projects a repeated identity without replacing the first identity's child context.
   * @param record - Repeated terminal record that still requires one destination span.
   */
  #projectDuplicate(record: DiagnosticSpanRecord): void {
    /** Preserves parentage only when it cannot make the duplicate its own parent. */
    const parentContext =
      record.parentSpanId === undefined || record.parentSpanId === record.spanId
        ? undefined
        : this.#projectedContexts.get(record.parentSpanId)?.context;
    /** Marks only an explicitly declared parent that remained unresolved. */
    const parentMissing = record.parentSpanId !== undefined && parentContext === undefined;
    this.#projectRecord(record, parentContext, {
      duplicateIdentity: true,
      ...(parentMissing ? { parentMissing } : {}),
    });
  }

  /**
   * Breaks one newly closed pending cycle at its earliest retained member.
   * @param startId - Identity whose parent edge may have completed a cycle.
   */
  #breakCycleFrom(startId: string): void {
    /** Records each path position so a repeated identity isolates the cycle. */
    const positions = new Map<string, number>();
    /** Preserves traversal order from the new record toward its ancestors. */
    const path: string[] = [];
    /** Advances only through retained first-seen identities. */
    let current: string | undefined = startId;
    while (current !== undefined) {
      /** Locates the repeated path segment without following it again. */
      const cycleStart = positions.get(current);
      if (cycleStart !== undefined) {
        /** Contains only identities participating in this detected cycle. */
        const cycleIds = new Set(path.slice(cycleStart));
        /** Selects the earliest retained member to preserve deterministic projection order. */
        const oldest = [...this.#pending.entries()].find(([identity]) => cycleIds.has(identity));
        if (oldest !== undefined) {
          this.#removePending(oldest[0]);
          this.#projectTree(oldest[1].record, undefined, { parentMissing: true });
        }
        return;
      }
      positions.set(current, path.length);
      path.push(current);
      /** Stops when the path reaches a parent outside the pending graph. */
      const node: PendingSpan | undefined = this.#pending.get(current);
      current = node?.record.parentSpanId;
    }
  }

  /**
   * Projects one parent before every retained descendant reachable from it.
   * @param root - Root or newly resolved parent record.
   * @param parentContext - Real SDK parent context when hierarchy was resolved.
   * @param evidence - Degradation evidence for the first projected record.
   */
  #projectTree(root: DiagnosticSpanRecord, parentContext: SpanContext | undefined, evidence: ProjectionEvidence): void {
    /** Carries real projected contexts down the retained tree without relying on cache residency. */
    const queue: ProjectionQueueEntry[] = [
      Object.freeze({ record: root, ...(parentContext === undefined ? {} : { parent: parentContext }), evidence }),
    ];
    /** Advances iteratively so a bounded but deep graph cannot exhaust the call stack. */
    let index = 0;
    while (index < queue.length) {
      /** Reads the next parent only after every earlier queued ancestor projected. */
      const current = queue[index];
      index += 1;
      if (current === undefined) continue;
      /** Creates the destination span and returns its real context when recording is active. */
      const projected = this.#projectRecord(current.record, current.parent, current.evidence);
      if (projected !== undefined) this.#rememberProjectedContext(current.record.spanId, projected);

      /** Selects retained direct children in original arrival order. */
      const children = [...this.#pending.entries()].filter(
        ([, child]) => child.record.parentSpanId === current.record.spanId,
      );
      /** Removes children before queueing them so cycles cannot project one record twice. */
      for (const [childId, child] of children) {
        this.#removePending(childId);
        queue.push(
          Object.freeze({
            record: child.record,
            ...(projected === undefined ? {} : { parent: projected }),
            evidence: projected === undefined ? { parentMissing: true } : {},
          }),
        );
      }
    }
  }

  /**
   * Creates and ends one OpenTelemetry span at Archer's explicit timestamps.
   * @param record - Terminal record projected exactly once by this call.
   * @param parentContext - Real SDK context or undefined for an explicit root.
   * @param evidence - Adapter degradation evidence attached to the span.
   * @returns The SDK-generated context when it is valid for child propagation.
   */
  #projectRecord(
    record: DiagnosticSpanRecord,
    parentContext: SpanContext | undefined,
    evidence: ProjectionEvidence,
  ): SpanContext | undefined {
    /** Uses wall start plus monotonic duration instead of settlement wall time. */
    const startMillis = Date.parse(record.startedAt);
    /** Keeps fractional monotonic milliseconds in the explicit end time. */
    const endMillis = startMillis + record.durationMs;
    /** Supplies no ambient parent when Archer hierarchy is absent or unresolved. */
    const parent =
      parentContext === undefined
        ? this.#api.ROOT_CONTEXT
        : this.#api.trace.setSpanContext(this.#api.ROOT_CONTEXT, parentContext);
    /** Creates the complete span after its Archer record has already settled. */
    const span = this.#tracer.startSpan(
      record.name,
      {
        ...(parentContext === undefined ? { root: true } : {}),
        attributes: spanTraceAttributes(record, evidence),
        startTime: startMillis,
      },
      parent,
    );
    applyStatus(this.#api, span, record);
    span.end(endMillis);
    /** Uses only allowlisted labels for both count and duration. */
    const labels = metricAttributes(record);
    this.#spanDuration.record(record.durationMs, labels);
    this.#spanCount.add(1, labels);
    /** Reads identity generated by the SDK after the span has ended. */
    const context = span.spanContext();
    return this.#api.isSpanContextValid(context) ? context : undefined;
  }

  /**
   * Creates one explicit root span whose start and end are both the event instant.
   * @param record - Production-normalized point event.
   */
  #projectEvent(record: DiagnosticEventRecord): void {
    /** Converts the normalized event wall instant once for both boundaries. */
    const atMillis = Date.parse(record.at);
    /** Ignores ambient context because Archer supplied no process-local parent. */
    const span = this.#tracer.startSpan(
      record.name,
      { root: true, attributes: eventTraceAttributes(record), startTime: atMillis },
      this.#api.ROOT_CONTEXT,
    );
    applyStatus(this.#api, span, record);
    span.end(atMillis);
    this.#eventCount.add(1, metricAttributes(record));
  }

  /**
   * Retains one first-seen real context and evicts oldest entries under pressure.
   * @param archerSpanId - Archer identity used only as the cache lookup key.
   * @param context - Real context returned by the injected SDK tracer.
   */
  #rememberProjectedContext(archerSpanId: string, context: SpanContext): void {
    if (this.#projectedContexts.has(archerSpanId)) return;
    /** Charges stable identity material without serializing SDK implementation objects. */
    const bytes =
      new TextEncoder().encode(archerSpanId).byteLength +
      context.traceId.length +
      context.spanId.length +
      (context.traceState?.serialize().length ?? 0) +
      8;
    if (bytes > this.#projectedContextBounds.capacityBytes) return;
    while (
      this.#projectedContexts.size + 1 > this.#projectedContextBounds.capacityItems ||
      this.#projectedContextBytes + bytes > this.#projectedContextBounds.capacityBytes
    ) {
      /** Map insertion order makes the first entry the deterministic eviction target. */
      const oldest = this.#projectedContexts.entries().next().value;
      if (oldest === undefined) break;
      this.#projectedContexts.delete(oldest[0]);
      this.#projectedContextBytes -= oldest[1].bytes;
    }
    this.#projectedContexts.set(archerSpanId, Object.freeze({ context, bytes }));
    this.#projectedContextBytes += bytes;
  }

  /**
   * Removes one pending record and its exact byte charge if still retained.
   * @param spanId - First-seen Archer identity to remove.
   */
  #removePending(spanId: string): void {
    /** Reads the charged bytes before deleting the only owning entry. */
    const pending = this.#pending.get(spanId);
    if (pending === undefined) return;
    this.#pending.delete(spanId);
    this.#pendingBytes -= pending.bytes;
  }

  /** Projects all currently unresolved records without dropping cycles or descendants. */
  #projectAllPendingAsMissing(): void {
    while (this.#pending.size > 0) {
      /** Map insertion order selects the oldest unresolved record as the next root. */
      const oldest = this.#pending.entries().next().value;
      if (oldest === undefined) return;
      this.#removePending(oldest[0]);
      this.#projectTree(oldest[1].record, undefined, { parentMissing: true });
    }
  }

  /** Projects pending roots first, then invokes the application-supplied SDK flush. */
  async #flushProjection(): Promise<void> {
    this.#projectAllPendingAsMissing();
    await this.#flushLifecycle.value.forceFlush();
  }

  /** Resolves retained close evidence after flush and any authorized lifecycle close. */
  async #finishClose(): Promise<void> {
    /** Retains the first teardown failure without exposing dependency exception text. */
    let failure: DiagnosticSinkCloseEvidence | undefined;
    try {
      await this.#flushProjection();
    } catch {
      failure = failedCloseEvidence('opentelemetry_flush_failed', 'OpenTelemetry flush failed');
    }

    if (this.#flushLifecycle.ownership === 'owned') {
      try {
        /** Observes dependency evidence only to select adapter-owned close identity. */
        const lifecycleEvidence = await this.#flushLifecycle.value.close();
        if (failure === undefined && lifecycleEvidence.kind === 'failed') {
          failure = failedCloseEvidence('opentelemetry_close_failed', 'OpenTelemetry close failed');
        }
      } catch {
        if (failure === undefined) {
          failure = failedCloseEvidence('opentelemetry_close_failed', 'OpenTelemetry close failed');
        }
      }
    }

    this.#state = 'closed';
    this.#resolveClosed(failure ?? Object.freeze({ kind: 'closed' }));
  }
}

/**
 * Creates a retained DiagnosticSink for OpenTelemetry traces and bounded metrics.
 * @param options - API dependencies, explicit lifecycle ownership, and finite retention bounds.
 * @returns A retained sink whose idempotent close flushes pending records and only owned dependencies.
 * @throws {OpenTelemetrySinkError} When the optional peer or configuration cannot construct the adapter.
 */
export function openTelemetrySink(options: OpenTelemetrySinkOptions): DiagnosticSink {
  /** Loads the optional dependency only after this explicit adapter factory is called. */
  const api = loadOpenTelemetryApi();
  try {
    return new OpenTelemetryDiagnosticSink(api, options);
  } catch (error) {
    if (error instanceof OpenTelemetrySinkError) throw error;
    throw new OpenTelemetrySinkError('opentelemetry_configuration_invalid', 'OpenTelemetry sink configuration failed');
  }
}
