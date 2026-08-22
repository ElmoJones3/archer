/**
 * @file Defines Archer's versioned product-neutral diagnostics contract.
 *
 * Diagnostic data explains operation but never authorizes work, changes a
 * durable decision, or substitutes for task and transcript state.
 */

import * as z from 'zod';

import type { ComponentRef, OwnedHandle } from '../ownership.js';
import { PublicErrorSchema, type ProtocolFailure, type PublicError } from '../protocol.js';
import {
  JsonObjectSchema,
  TimestampSchema,
  UuidV4Schema,
  type JsonObject,
  type Timestamp,
  type UuidV4,
} from '../values.js';
import type { DeliveryBounds, TransientEventStream } from '../stream/contracts.js';

/** Severity levels ordered from verbose diagnosis to operator-visible failure. */
export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error';

/** Runtime schema for the bounded diagnostic severity vocabulary. */
export const DiagnosticSeveritySchema = z.enum(['debug', 'info', 'warn', 'error']);

/** Position of a diagnostic within a named lifecycle. */
export type DiagnosticPhase = 'start' | 'finish' | 'point';

/** Runtime schema for lifecycle positions used by metrics and traces. */
export const DiagnosticPhaseSchema = z.enum(['start', 'finish', 'point']);

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
  })
  .transform((value) => value as DiagnosticCorrelation)
  .readonly();

/** One normalized, redacted, non-authoritative operational observation. */
export type DiagnosticRecord = Readonly<{
  /** Selects the record codec revision. */
  schema: 1;

  /** Names a stable operational event suitable for filters and projections. */
  name: string;

  /** Selects operator significance without controlling domain behavior. */
  severity: DiagnosticSeverity;

  /** Records the normalized UTC instant at which the observation occurred. */
  at: Timestamp;

  /** Names the Archer component that produced the record. */
  component: string;

  /** Places the record at a lifecycle start, finish, or standalone point. */
  phase: DiagnosticPhase;

  /** Optionally names a bounded lifecycle result category. */
  outcome?: string;

  /** Optionally records finite non-negative elapsed milliseconds. */
  durationMs?: number;

  /** Correlates the record through UUIDv4 work identity. */
  correlation: DiagnosticCorrelation;

  /** Carries explicitly admitted immutable JSON attributes. */
  attributes: JsonObject;

  /** Optionally carries bounded public failure data without native Error identity. */
  error?: PublicError;
}>;

/** Runtime codec for diagnostics crossing package and transport boundaries. */
export const DiagnosticRecordSchema = z
  .strictObject({
    schema: z.literal(1),
    name: z.string().min(1).max(256),
    severity: DiagnosticSeveritySchema,
    at: TimestampSchema,
    component: z.string().min(1).max(256),
    phase: DiagnosticPhaseSchema,
    outcome: z.string().min(1).max(128).optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    correlation: DiagnosticCorrelationSchema,
    attributes: JsonObjectSchema,
    error: PublicErrorSchema.optional(),
  })
  .transform((value) => value as DiagnosticRecord)
  .readonly();

/** Input for creating a diagnostic at an injected current instant. */
export type DiagnosticRecordInput = Readonly<Omit<DiagnosticRecord, 'schema' | 'at'>>;

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
