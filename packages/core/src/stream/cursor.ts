/**
 * @file Owns the versioned public codec for durable stream cursor identity.
 *
 * Implementations use this module instead of casting strings to StreamCursor.
 * Decoding proves wire structure while the source still decides retention and
 * whether a prior epoch requires reseeding.
 */

import { ArcherError } from '../errors.js';
import { Result, type Result as ResultValue } from '../result.js';
import { CanonicalDecimalSchema, type CanonicalDecimal, type JsonObject } from '../values.js';
import type { StreamCursor } from './contracts.js';

/** Identity shared by every position emitted from one logical durable source. */
export type StreamCursorIdentity<Source extends string> = Readonly<{
  /** Selects the event protocol whose codec measures and interprets values. */
  revision: string;

  /** Brands the durable source family at compile time and on the wire. */
  source: Source;

  /** Binds cursors to one tenant, project, or other authorization scope. */
  scope: string;

  /** Distinguishes logical streams inside one source family and scope. */
  streamId: string;

  /** Identifies the replaceable generation of the logical stream. */
  epoch: string;
}>;

/** Fully decoded cursor identity and monotonic position. */
export type StreamCursorClaims<Source extends string> = StreamCursorIdentity<Source> &
  Readonly<{
    /** Resumes strictly after this canonical non-negative position. */
    offset: CanonicalDecimal;
  }>;

/** Stable cursor failure categories suitable for protocol branching. */
export type StreamCursorErrorCode =
  | 'invalid_cursor'
  | 'cursor_revision_mismatch'
  | 'cursor_source_mismatch'
  | 'cursor_scope_mismatch'
  | 'cursor_stream_mismatch';

/** Explains why cursor bytes cannot be admitted by one logical source. */
export class StreamCursorError extends ArcherError {
  /** Narrows the inherited code to the cursor protocol's stable categories. */
  declare readonly code: StreamCursorErrorCode;

  /**
   * Constructs one redaction-safe cursor validation failure.
   * @param code - Stable category identifying the rejected identity component.
   * @param message - Bounded public explanation of the mismatch.
   * @param details - Optional admitted wire evidence without authority meaning.
   */
  constructor(code: StreamCursorErrorCode, message: string, details?: JsonObject) {
    super(message, { code, ...(details === undefined ? {} : { details }) });
  }
}

/** Creates and validates positions for one exact logical durable source. */
export interface StreamCursorCodec<Source extends string> {
  /** Publishes the immutable identity bound into every encoded position. */
  readonly identity: StreamCursorIdentity<Source>;

  /**
   * Encodes one non-negative monotonic position without unchecked public casts.
   * @param offset - Canonical text or non-negative bigint position.
   * @returns A source-branded cursor for this exact identity.
   */
  encode(offset: CanonicalDecimal | bigint): StreamCursor<Source>;

  /**
   * Decodes and validates structure, revision, family, scope, and stream identity.
   * Epoch differences remain valid claims so callers can return reseed evidence.
   * @param input - Untrusted wire cursor.
   * @returns Decoded claims or one focused cursor Error.
   */
  decode(input: unknown): ResultValue<StreamCursorClaims<Source>, StreamCursorError>;
}

/** Wire prefix selecting the first Archer stream cursor codec. */
const cursorPrefix = Object.freeze(['archer', 'stream', 'cursor', 'v1'] as const);

/**
 * Encodes one cursor component without allowing delimiter ambiguity.
 * @param value - Validated identity component.
 * @returns Delimiter-safe wire text.
 */
function encodePart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Requires one non-empty identity component before a codec can exist.
 * @param name - Component name used in the construction failure.
 * @param value - Candidate component value.
 * @returns The admitted unchanged component.
 */
function identityPart(name: string, value: string): string {
  if (value.length === 0) throw new RangeError(`${name} must not be empty`);
  return value;
}

/**
 * Constructs a public cursor codec for one logical durable source.
 * @param identity - Revision, source, scope, stream, and current epoch identity.
 * @returns A frozen encoder and decoder with no private cast requirement.
 */
export function createStreamCursorCodec<Source extends string>(
  identity: StreamCursorIdentity<Source>,
): StreamCursorCodec<Source> {
  /** Copies source identity so later caller mutation cannot rewrite validation. */
  const expected = Object.freeze({
    revision: identityPart('revision', identity.revision),
    source: identityPart('source', identity.source) as Source,
    scope: identityPart('scope', identity.scope),
    streamId: identityPart('streamId', identity.streamId),
    epoch: identityPart('epoch', identity.epoch),
  });

  /**
   * Returns one focused cursor failure without exposing decode exceptions.
   * @param code - Stable mismatch category.
   * @param message - Public protocol explanation.
   * @returns A Result failure carrying the focused Error.
   */
  const failure = (code: StreamCursorErrorCode, message: string) => Result.error(new StreamCursorError(code, message));

  /** Owns the public codec facade and its official StreamCursor brand cast. */
  const codec: StreamCursorCodec<Source> = {
    identity: expected,
    /**
     * Encodes one validated arbitrary-precision offset.
     * @param offset - Canonical decimal text or its exact bigint representation.
     * @returns An opaque cursor bound to this codec's complete identity.
     */
    encode(offset) {
      /** Normalizes bigint and branded text through the same decimal schema. */
      const normalized = CanonicalDecimalSchema.parse(typeof offset === 'bigint' ? offset.toString(10) : offset);
      return [
        ...cursorPrefix,
        encodePart(expected.revision),
        encodePart(expected.source),
        encodePart(expected.scope),
        encodePart(expected.streamId),
        encodePart(expected.epoch),
        normalized,
      ].join(':') as StreamCursor<Source>;
    },
    /**
     * Decodes one untrusted cursor and verifies its stable logical identity.
     * @param input - Unknown transport input at the cursor trust boundary.
     * @returns Validated claims or a focused public cursor error.
     */
    decode(input) {
      if (typeof input !== 'string') return failure('invalid_cursor', 'The replay cursor must be a string');
      /** Retains exact wire components for structural and identity checks. */
      const parts = input.split(':');
      if (parts.length !== 10 || cursorPrefix.some((part, index) => parts[index] !== part)) {
        return failure('invalid_cursor', 'The replay cursor is malformed');
      }
      try {
        /** Decodes every escaped identity component before comparison. */
        const claims = Object.freeze({
          revision: decodeURIComponent(parts[4] ?? ''),
          source: decodeURIComponent(parts[5] ?? '') as Source,
          scope: decodeURIComponent(parts[6] ?? ''),
          streamId: decodeURIComponent(parts[7] ?? ''),
          epoch: decodeURIComponent(parts[8] ?? ''),
          offset: CanonicalDecimalSchema.parse(parts[9]),
        });
        if (claims.revision !== expected.revision) {
          return failure('cursor_revision_mismatch', 'The replay cursor uses another protocol revision');
        }
        if (claims.source !== expected.source) {
          return failure('cursor_source_mismatch', 'The replay cursor belongs to another source family');
        }
        if (claims.scope !== expected.scope) {
          return failure('cursor_scope_mismatch', 'The replay cursor belongs to another scope');
        }
        if (claims.streamId !== expected.streamId) {
          return failure('cursor_stream_mismatch', 'The replay cursor belongs to another logical stream');
        }
        return Result.ok(claims);
      } catch {
        return failure('invalid_cursor', 'The replay cursor is malformed');
      }
    },
  };

  return Object.freeze(codec);
}
