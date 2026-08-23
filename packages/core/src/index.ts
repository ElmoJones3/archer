/**
 * @file Publishes the dependency-light contracts shared by every Archer layer.
 *
 * This entry point exposes values, validation, pure decisions, ownership, and
 * product-neutral diagnostic contracts. Reactive runtimes and framework
 * bindings live behind explicit subpaths so consumers acquire them deliberately.
 */

export {
  ArcherError,
  ValidationError,
  type ArcherErrorOptions,
  type ValidationIssue,
  type ValidationPathSegment,
} from './errors.js';
export { fromZod, type Codec } from './codec.js';
export { DiagnosticSpanError } from './diagnostics/contracts.js';
export type {
  DiagnosticAttachOptions,
  DiagnosticAttachmentCloseEvidence,
  DiagnosticCorrelation,
  DiagnosticEventInput,
  DiagnosticEventRecord,
  DiagnosticFilter,
  DiagnosticHub,
  DiagnosticRecord,
  DiagnosticRecordBase,
  DiagnosticSeverity,
  DiagnosticSink,
  DiagnosticSinkCloseEvidence,
  Diagnostics,
  DiagnosticsCloseEvidence,
  DiagnosticSpan,
  DiagnosticSpanAbandonment,
  DiagnosticSpanAttributes,
  DiagnosticSpanCompletion,
  DiagnosticSpanEnrichmentEvidence,
  DiagnosticSpanErrorCode,
  DiagnosticSpanFailure,
  DiagnosticSpanInput,
  DiagnosticSpanLimits,
  DiagnosticSpanRecord,
  DiagnosticSpanSettlement,
  DiagnosticSpanState,
} from './diagnostics/contracts.js';
export { ArcherObjectSchema, archerObjectSchema, type ArcherObject } from './object.js';
export { borrowed, owned, type BorrowedRef, type ComponentRef, type OwnedHandle, type OwnedRef } from './ownership.js';
export { programDecision, type EffectIntent, type Program, type ProgramDecision } from './program.js';
export {
  IdempotencyKeySchema,
  ProtocolFailureSchema,
  PublicErrorSchema,
  createIdempotencyKey,
  toProtocolFailure,
  toPublicError,
  type IdempotencyKey,
  type ProtocolFailure,
  type PublicError,
  type PublicErrorFallback,
} from './protocol.js';
export { Result, type ResultMatch } from './result.js';
export {
  CanonicalDecimalSchema,
  JsonObjectSchema,
  JsonValueSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  createUuidV4,
  type CanonicalDecimal,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from './values.js';
