/**
 * @file Defines transport-safe failures and command identity shared by core
 * temporal contracts.
 *
 * Native Error objects remain local. Public error values contain only fields a
 * caller explicitly admits, preventing stack traces, credentials, and raw
 * adapter messages from crossing a diagnostic or transport boundary by default.
 */

import * as z from 'zod';

import { ArcherError } from './errors.js';
import { JsonObjectSchema, UuidV4Schema, type JsonObject, type UuidV4 } from './values.js';

/** Prevents an arbitrary UUIDv4 from being reused as command idempotency evidence. */
declare const idempotencyKeyBrand: unique symbol;

/** A UUIDv4 scoped to deduplicating one command at its receiving boundary. */
export type IdempotencyKey = UuidV4 & {
  /** Carries compile-time evidence of idempotency-key admission. */
  readonly [idempotencyKeyBrand]: true;
};

/** Canonicalizes and validates command idempotency keys as UUIDv4 values. */
export const IdempotencyKeySchema = UuidV4Schema.transform((value) => value as IdempotencyKey);

/** A bounded, serializable failure safe for public contracts. */
export type PublicError = Readonly<{
  /** Stable machine category used for branching and aggregation. */
  code: string;

  /** Redacted human-readable context suitable for an untrusted boundary. */
  message: string;

  /** Tells orchestration whether a new admitted attempt may be meaningful. */
  retryable: boolean;

  /** Optional explicitly admitted JSON evidence with no native Error graph. */
  details?: JsonObject;
}>;

/** Runtime schema for failures that cross process or product boundaries. */
export const PublicErrorSchema = z
  .strictObject({
    code: z.string().min(1),
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
    details: JsonObjectSchema.optional(),
  })
  .transform((value) => value as PublicError)
  .readonly();

/** A failure proving a source or adapter violated an Archer protocol. */
export type ProtocolFailure = PublicError &
  Readonly<{
    /** Keeps protocol violations distinct from ordinary operation failures. */
    kind: 'protocol-failure';
  }>;

/** Runtime schema for failures carried by stream and attachment close evidence. */
export const ProtocolFailureSchema = z
  .strictObject({
    kind: z.literal('protocol-failure'),
    code: z.string().min(1),
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
    details: JsonObjectSchema.optional(),
  })
  .transform((value) => value as ProtocolFailure)
  .readonly();

/** Explicit fallback used when an unknown Error must cross a public boundary. */
export type PublicErrorFallback = Readonly<{
  /** Stable category used when the input is not already an ArcherError. */
  code: string;

  /** Redacted message that does not include the unknown Error text. */
  message: string;

  /** Retry disposition selected by the boundary that understands the operation. */
  retryable?: boolean;

  /** Optional evidence admitted by the boundary rather than copied from the Error. */
  details?: JsonObject;
}>;

/**
 * Converts local failure identity into bounded public data.
 *
 * ArcherError messages and details are already authored for Archer callers and
 * remain visible. Unknown Error messages, stacks, causes, and properties are
 * discarded in favor of the explicit fallback.
 * @param error - A local failure that must not cross the boundary by identity.
 * @param fallback - Redacted data for non-Archer failures.
 * @returns A validated immutable public failure.
 */
export function toPublicError(error: unknown, fallback: PublicErrorFallback): PublicError {
  if (error instanceof ArcherError) {
    return PublicErrorSchema.parse({
      code: error.code,
      message: error.message,
      retryable: false,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }

  return PublicErrorSchema.parse({
    code: fallback.code,
    message: fallback.message,
    retryable: fallback.retryable ?? false,
    ...(fallback.details === undefined ? {} : { details: fallback.details }),
  });
}

/**
 * Marks a normalized public failure as a protocol violation.
 * @param error - A local failure that explains the violated boundary.
 * @param fallback - Redacted data for non-Archer failures.
 * @returns An immutable protocol failure suitable for close evidence.
 */
export function toProtocolFailure(error: unknown, fallback: PublicErrorFallback): ProtocolFailure {
  return ProtocolFailureSchema.parse({ kind: 'protocol-failure', ...toPublicError(error, fallback) });
}

/**
 * Generates command identity through the platform UUID source and canonical
 * parser rather than exposing unchecked string construction.
 * @returns A canonical UUIDv4 idempotency key.
 */
export function createIdempotencyKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(globalThis.crypto.randomUUID());
}
