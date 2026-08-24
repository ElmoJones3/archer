/**
 * @file Defines Archer's versioned product-neutral diagnostics contract.
 *
 * Diagnostic data explains operation but never authorizes work, changes a
 * durable decision, or substitutes for task and transcript state.
 */

import * as z from 'zod';

import { ArcherError } from '../errors.js';
import type { ComponentRef, OwnedHandle } from '../ownership.js';
import { PublicErrorSchema, type ProtocolFailure, type PublicError } from '../protocol.js';
import type { Result as ResultValue } from '../result.js';
import {
  CanonicalDecimalSchema,
  JsonObjectSchema,
  TimestampSchema,
  UuidV4Schema,
  type CanonicalDecimal,
  type JsonObject,
  type Timestamp,
  type UuidV4,
} from '../values.js';
import type { DeliveryBounds, TransientEventStream } from '../stream/contracts.js';

/** Severity levels ordered from verbose diagnosis to operator-visible failure. */
export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error';

/** Runtime schema for the bounded diagnostic severity vocabulary. */
export const DiagnosticSeveritySchema = z.enum(['debug', 'info', 'warn', 'error']);

/** Optional UUIDv4 identities that correlate one record with Archer work. */
export type DiagnosticCorrelation = Readonly<{
  /** Correlates a record with one durable task. */
  taskId?: UuidV4;

  /** Correlates a record with one durable conversation thread. */
  threadId?: UuidV4;

  /** Correlates a record with one admitted chat turn. */
  turnId?: UuidV4;

  /** Correlates a record with one durable state machine. */
  cellId?: UuidV4;

  /** Correlates a record with one durable effect intent. */
  effectId?: UuidV4;

  /** Correlates a record with one finite effect attempt. */
  attemptId?: UuidV4;

  /** Correlates a record with one model provider request. */
  modelRequestId?: UuidV4;

  /** Correlates a record with one tool invocation. */
  invocationId?: UuidV4;

  /** Correlates a record with one retained sandbox. */
  sandboxId?: UuidV4;

  /** Correlates a record with one physical workspace view. */
  materializedViewId?: UuidV4;

  /** Correlates a record with one private workspace lineage. */
  workspaceId?: UuidV4;

  /** Correlates a record with one admitted resource configuration. */
  resourceSetId?: UuidV4;

  /** Correlates a record with one promoted workspace delta. */
  changeSetId?: UuidV4;

  /** Correlates a record with one Authority ledger attachment. */
  authorityLedgerId?: UuidV4;

  /** Correlates a record with one immutable authorization grant. */
  authorizationGrantId?: UuidV4;

  /** Correlates a record with one immutable grant-revocation fact. */
  grantRevocationId?: UuidV4;
}>;

/** Runtime schema for bounded low-cardinality work correlation. */
export const DiagnosticCorrelationSchema = z
  .strictObject({
    taskId: UuidV4Schema.optional(),
    threadId: UuidV4Schema.optional(),
    turnId: UuidV4Schema.optional(),
    cellId: UuidV4Schema.optional(),
    effectId: UuidV4Schema.optional(),
    attemptId: UuidV4Schema.optional(),
    modelRequestId: UuidV4Schema.optional(),
    invocationId: UuidV4Schema.optional(),
    sandboxId: UuidV4Schema.optional(),
    materializedViewId: UuidV4Schema.optional(),
    workspaceId: UuidV4Schema.optional(),
    resourceSetId: UuidV4Schema.optional(),
    changeSetId: UuidV4Schema.optional(),
    authorityLedgerId: UuidV4Schema.optional(),
    authorizationGrantId: UuidV4Schema.optional(),
    grantRevocationId: UuidV4Schema.optional(),
  })
  .transform((value) => value as DiagnosticCorrelation)
  .readonly();

/** Fields shared by terminal spans and standalone diagnostic events. */
export type DiagnosticRecordBase = Readonly<{
  /** Selects the record codec revision. */
  schema: 1;

  /** Names a stable operational observation suitable for filters and projections. */
  name: string;

  /** Selects operator significance without controlling domain behavior. */
  severity: DiagnosticSeverity;

  /** Records the normalized UTC instant at which the observation occurred. */
  at: Timestamp;

  /** Names the Archer component that produced the record. */
  component: string;

  /** Correlates the record through UUIDv4 work identity. */
  correlation: DiagnosticCorrelation;

  /** Carries explicitly admitted immutable JSON attributes. */
  attributes: JsonObject;
}>;

/** Terminal disposition earned by one open DiagnosticSpan. */
export type DiagnosticSpanSettlement =
  | Readonly<{
      /** Confirms the observed work returned normally. */
      kind: 'completed';

      /** Names the component-owned successful result category. */
      outcome: string;
    }>
  | Readonly<{
      /** Confirms the observed work produced a bounded failure. */
      kind: 'failed';

      /** Names the component-owned failed result category. */
      outcome: string;

      /** Carries redacted failure data without native Error identity. */
      error: PublicError;
    }>
  | Readonly<{
      /** Confirms observation ended without a work settlement. */
      kind: 'abandoned';

      /** Explains why observation stopped before work settlement. */
      reason: string;
    }>;

/** Runtime schema for mutually exclusive terminal span dispositions. */
export const DiagnosticSpanSettlementSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('completed'), outcome: z.string().min(1).max(128) }),
    z.strictObject({
      kind: z.literal('failed'),
      outcome: z.string().min(1).max(128),
      error: PublicErrorSchema,
    }),
    z.strictObject({ kind: z.literal('abandoned'), reason: z.string().min(1).max(256) }),
  ])
  .transform((value) => value as DiagnosticSpanSettlement)
  .readonly();

/** Quantifies accepted and refused context updates without retaining rejected data. */
export type DiagnosticSpanEnrichmentEvidence = Readonly<{
  /** Counts namespace updates admitted into terminal context. */
  acceptedUpdates: number;

  /** Counts invalid or over-budget updates refused while the span was open. */
  rejectedUpdates: number;

  /** Counts canonical encoded bytes known to have been refused. */
  rejectedBytes: CanonicalDecimal;
}>;

/** Runtime schema for exact span-enrichment accounting. */
export const DiagnosticSpanEnrichmentEvidenceSchema = z
  .strictObject({
    acceptedUpdates: z.number().int().nonnegative(),
    rejectedUpdates: z.number().int().nonnegative(),
    rejectedBytes: CanonicalDecimalSchema,
  })
  .transform((value) => value as DiagnosticSpanEnrichmentEvidence)
  .readonly();

/** One immutable wide record emitted only after a DiagnosticSpan settles. */
export type DiagnosticSpanRecord = DiagnosticRecordBase &
  Readonly<{
    /** Distinguishes accumulated span records from standalone events. */
    kind: 'span';

    /** Identifies this process-local diagnostic lifecycle. */
    spanId: UuidV4;

    /** Links this span to one explicit process-local parent when present. */
    parentSpanId?: UuidV4;

    /** Records the wall-clock instant captured when accumulation began. */
    startedAt: Timestamp;

    /** Records elapsed monotonic milliseconds independent of wall-clock adjustment. */
    durationMs: number;

    /** Carries the only terminal disposition earned by this span. */
    settlement: DiagnosticSpanSettlement;

    /** Makes context refusal visible without retaining rejected values. */
    enrichment: DiagnosticSpanEnrichmentEvidence;
  }>;

/** One immutable observation with no meaningful duration. */
export type DiagnosticEventRecord = DiagnosticRecordBase &
  Readonly<{
    /** Distinguishes standalone events from accumulated span records. */
    kind: 'event';

    /** Optionally names a bounded point-event result category. */
    outcome?: string;

    /** Optionally carries bounded public failure data without native Error identity. */
    error?: PublicError;
  }>;

/** One normalized, redacted, non-authoritative operational observation. */
export type DiagnosticRecord = DiagnosticSpanRecord | DiagnosticEventRecord;

/** Fields shared by both diagnostic record codecs. */
const diagnosticRecordBaseShape = {
  schema: z.literal(1),
  name: z.string().min(1).max(256),
  severity: DiagnosticSeveritySchema,
  at: TimestampSchema,
  component: z.string().min(1).max(256),
  correlation: DiagnosticCorrelationSchema,
  attributes: JsonObjectSchema,
} as const;

/** Runtime codec for terminal wide span records crossing process boundaries. */
export const DiagnosticSpanRecordSchema = z
  .strictObject({
    ...diagnosticRecordBaseShape,
    kind: z.literal('span'),
    spanId: UuidV4Schema,
    parentSpanId: UuidV4Schema.optional(),
    startedAt: TimestampSchema,
    durationMs: z.number().finite().nonnegative(),
    settlement: DiagnosticSpanSettlementSchema,
    enrichment: DiagnosticSpanEnrichmentEvidenceSchema,
  })
  .transform((value) => value as DiagnosticSpanRecord)
  .readonly();

/** Runtime codec for standalone diagnostic events crossing process boundaries. */
export const DiagnosticEventRecordSchema = z
  .strictObject({
    ...diagnosticRecordBaseShape,
    kind: z.literal('event'),
    outcome: z.string().min(1).max(128).optional(),
    error: PublicErrorSchema.optional(),
  })
  .transform((value) => value as DiagnosticEventRecord)
  .readonly();

/** Runtime codec for either product-neutral diagnostic record class. */
export const DiagnosticRecordSchema = z.union([DiagnosticSpanRecordSchema, DiagnosticEventRecordSchema]);

/** Input for one standalone event at the hub's injected current instant. */
export type DiagnosticEventInput = Readonly<Omit<DiagnosticEventRecord, 'schema' | 'kind' | 'at'>>;

/** Runtime codec for event input before hub-owned fields are attached. */
export const DiagnosticEventInputSchema = z
  .strictObject({
    name: z.string().min(1).max(256),
    severity: DiagnosticSeveritySchema,
    component: z.string().min(1).max(256),
    outcome: z.string().min(1).max(128).optional(),
    correlation: DiagnosticCorrelationSchema,
    attributes: JsonObjectSchema,
    error: PublicErrorSchema.optional(),
  })
  .transform((value) => value as DiagnosticEventInput)
  .readonly();

/** Stable package-owned namespace accepted by DiagnosticSpan enrichment. */
export const DiagnosticSpanNamespaceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u);

/** Namespace map used to prevent unrelated packages from colliding silently. */
export type DiagnosticSpanAttributes = Readonly<Record<string, JsonObject>>;

/** Runtime codec for initial or accumulated namespaced span context. */
export const DiagnosticSpanAttributesSchema = z
  .record(DiagnosticSpanNamespaceSchema, JsonObjectSchema)
  .transform((value) => value as DiagnosticSpanAttributes)
  .readonly();

/** Input known when one process-local diagnostic span begins. */
export type DiagnosticSpanInput = Readonly<{
  /** Names the stable operation represented by the span. */
  name: string;

  /** Names the Archer package or adapter that owns the observation. */
  component: string;

  /** Correlates the span with durable Archer work. */
  correlation: DiagnosticCorrelation;

  /** Links the span to one explicit process-local parent. */
  parentSpanId?: UuidV4;

  /** Supplies immutable package-owned context known at span admission. */
  attributes?: DiagnosticSpanAttributes;
}>;

/** Runtime codec for span admission before hub-owned identity and time. */
export const DiagnosticSpanInputSchema = z
  .strictObject({
    name: z.string().min(1).max(256),
    component: z.string().min(1).max(256),
    correlation: DiagnosticCorrelationSchema,
    parentSpanId: UuidV4Schema.optional(),
    attributes: DiagnosticSpanAttributesSchema.optional(),
  })
  .transform((value) => value as DiagnosticSpanInput)
  .readonly();

/** Input that earns ordinary successful span settlement. */
export type DiagnosticSpanCompletion = Readonly<{
  /** Names the component-owned successful result category. */
  outcome: string;

  /** Overrides the ordinary informational severity when justified. */
  severity?: DiagnosticSeverity;
}>;

/** Runtime codec for successful span settlement. */
export const DiagnosticSpanCompletionSchema = z
  .strictObject({
    outcome: z.string().min(1).max(128),
    severity: DiagnosticSeveritySchema.optional(),
  })
  .transform((value) => value as DiagnosticSpanCompletion)
  .readonly();

/** Input that earns failed span settlement with already-redacted evidence. */
export type DiagnosticSpanFailure = Readonly<{
  /** Names the component-owned failed result category. */
  outcome: string;

  /** Carries bounded public failure data without native Error identity. */
  error: PublicError;

  /** Overrides the ordinary error severity when justified. */
  severity?: DiagnosticSeverity;
}>;

/** Runtime codec for failed span settlement. */
export const DiagnosticSpanFailureSchema = z
  .strictObject({
    outcome: z.string().min(1).max(128),
    error: PublicErrorSchema,
    severity: DiagnosticSeveritySchema.optional(),
  })
  .transform((value) => value as DiagnosticSpanFailure)
  .readonly();

/** Input that ends observation without claiming the work settled. */
export type DiagnosticSpanAbandonment = Readonly<{
  /** Explains why observation stopped before work settlement. */
  reason: string;

  /** Overrides the ordinary warning severity when justified. */
  severity?: DiagnosticSeverity;
}>;

/** Runtime codec for abandoned span settlement. */
export const DiagnosticSpanAbandonmentSchema = z
  .strictObject({
    reason: z.string().min(1).max(256),
    severity: DiagnosticSeveritySchema.optional(),
  })
  .transform((value) => value as DiagnosticSpanAbandonment)
  .readonly();

/** Public lifecycle states earned through DiagnosticSpan settlement methods. */
export type DiagnosticSpanState = 'open' | 'completed' | 'failed' | 'abandoned';

/** Stable refusal categories owned by DiagnosticSpan behavior. */
export type DiagnosticSpanErrorCode =
  | 'diagnostic_span_already_settled'
  | 'diagnostic_span_enrichment_rejected'
  | 'diagnostic_span_hub_closed'
  | 'diagnostic_span_settlement_rejected'
  | 'diagnostic_span_settlement_failed';

/** Focused Error returned when a span command cannot preserve its contract. */
export class DiagnosticSpanError extends ArcherError {
  /**
   * Constructs one public refusal without retaining rejected context.
   * @param code - Stable refusal category suitable for caller branching.
   * @param message - Bounded explanation safe for Archer callers.
   * @param details - Explicit immutable JSON evidence for the refusal.
   */
  constructor(code: DiagnosticSpanErrorCode, message: string, details: JsonObject = {}) {
    super(message, { code, details });
  }
}

/** Configured limits that keep one wide span finite in process and storage. */
export type DiagnosticSpanLimits = Readonly<{
  /** Maximum distinct top-level context namespaces retained by one span. */
  maxNamespaces: number;

  /** Maximum canonical JSON bytes retained across all span attributes. */
  maxAttributeBytes: number;
}>;

/** Stateful process-local accumulator returned only through DiagnosticHub. */
export interface DiagnosticSpan {
  /** Identifies this process-local observation independently of durable work. */
  readonly spanId: UuidV4;

  /** Exposes the one earned lifecycle state without permitting assignment. */
  readonly state: DiagnosticSpanState;

  /** Adds or atomically replaces one namespaced context object without emitting. */
  enrich(namespace: string, attributes: JsonObject): ResultValue<void, DiagnosticSpanError>;

  /** Earns successful settlement and emits the only terminal span record. */
  complete(input: DiagnosticSpanCompletion): ResultValue<DiagnosticSpanRecord, DiagnosticSpanError>;

  /** Earns failed settlement and emits the only terminal span record. */
  fail(input: DiagnosticSpanFailure): ResultValue<DiagnosticSpanRecord, DiagnosticSpanError>;

  /** Ends observation without manufacturing a domain work outcome. */
  abandon(input: DiagnosticSpanAbandonment): ResultValue<DiagnosticSpanRecord, DiagnosticSpanError>;
}

/** Explains normal or failed closure of an externally supplied sink. */
export type DiagnosticSinkCloseEvidence =
  | Readonly<{
      /** Reports normal destination closure. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Reports destination teardown failure. */
      kind: 'failed';

      /** Carries bounded public evidence of teardown failure. */
      failure: ProtocolFailure;
    }>;

/** Best-effort destination for normalized diagnostic batches. */
export interface DiagnosticSink extends OwnedHandle<DiagnosticSinkCloseEvidence> {
  /** Writes one ordered batch without implicit retry. */
  write(records: readonly DiagnosticRecord[]): Promise<void>;

  /** Flushes only records the destination has already accepted. */
  flush(): Promise<void>;
}

/** Product-neutral filter evaluated before a record enters one sink queue. */
export type DiagnosticFilter = Readonly<{
  /** Rejects records below this ordered severity. */
  severityAtLeast?: DiagnosticSeverity;

  /** Admits only exact stable record names in this list. */
  names?: readonly string[];

  /** Admits only exact producer component names in this list. */
  components?: readonly string[];
}>;

/** Configures one independent bounded sink attachment. */
export type DiagnosticAttachOptions = Readonly<{
  /** Applies product-neutral selection before queue admission. */
  filter?: DiagnosticFilter;

  /** Selects item and encoded-byte bounds for this sink alone. */
  delivery?: DeliveryBounds;

  /** Selects whether a rejected write detaches or skips that batch. */
  onWriteFailure?: 'detach' | 'continue';
}>;

/** Explains terminal delivery and loss for one diagnostic sink attachment. */
export type DiagnosticAttachmentCloseEvidence = Readonly<{
  /** Distinguishes ordinary detachment from a sink write failure. */
  kind: 'detached' | 'sink-failed';

  /** Counts source records accepted by this sink queue. */
  acceptedRecords: number;

  /** Counts accepted source records whose sink write fulfilled. */
  writtenRecords: number;

  /** Counts encoded bytes whose source-record write fulfilled. */
  writtenBytes: number;

  /** Counts source records discarded by this sink queue. */
  droppedRecords: number;

  /** Counts encoded bytes discarded by this sink queue. */
  droppedBytes: number;

  /** Counts in-flight source records whose outcome was unknown at timeout. */
  unconfirmedRecords: number;

  /** Counts in-flight encoded source bytes whose outcome was unknown at timeout. */
  unconfirmedBytes: number;

  /** Carries redacted evidence when write or flush failed. */
  failure?: PublicError;
}>;

/** Summarizes best-effort shutdown of the diagnostics dispatcher. */
export type DiagnosticsCloseEvidence = Readonly<{
  /** Identifies normal dispatcher shutdown. */
  kind: 'closed';

  /** Counts sink attachments present when shutdown began. */
  attachments: number;

  /** Counts open spans settled as abandoned during orderly shutdown. */
  abandonedSpans: number;
}>;

/** Exposes public diagnostic observation and extension sink attachment. */
export interface Diagnostics extends OwnedHandle<DiagnosticsCloseEvidence> {
  /** Fans out normalized records as a bounded transient stream. */
  readonly events: TransientEventStream<DiagnosticRecord>;

  /** Attaches one explicitly owned or borrowed best-effort destination. */
  attach(
    sink: ComponentRef<DiagnosticSink>,
    options?: DiagnosticAttachOptions,
  ): OwnedHandle<DiagnosticAttachmentCloseEvidence>;
}

/** Adds product-neutral production commands to the public diagnostics owner. */
export interface DiagnosticHub extends Diagnostics {
  /** Begins one explicit, bounded process-local span without emitting a record. */
  beginSpan(input: DiagnosticSpanInput): DiagnosticSpan;

  /** Creates and emits one standalone observation with no meaningful duration. */
  event(input: DiagnosticEventInput): DiagnosticEventRecord;

  /** Admits one already-normalized record from an explicit adapter boundary. */
  emit(record: DiagnosticRecord): void;
}
