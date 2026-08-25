/**
 * @file Implements pure Cell value admission, revision binding, and identity.
 *
 * These helpers are shared by every CellHost so storage products cannot invent
 * different durable encodings or compatibility rules.
 */

import { createHash } from 'node:crypto';

import type { Codec } from '../codec.js';
import { Result, type Result as ResultValue } from '../result.js';
import { JsonValueSchema, Sha256DigestSchema, type JsonValue } from '../values.js';
import {
  CellCodecRevisionSchema,
  CellEffectIdSchema,
  type CellCodec,
  type CellCodecRevision,
  type CellEffectId,
  type CellId,
  type CellProtocol,
  type CellProtocolRevision,
  type CellRestoreRefusal,
  type CellSequence,
  type ProgramRevision,
  type StateProjectionRevision,
} from './contracts.js';

/** Exact revisions retained beside canonical Cell state. */
export type CellProtocolBinding = Readonly<{
  /** Binds the complete Cell interpretation contract. */
  protocol: CellProtocolRevision;

  /** Binds pure Program behavior. */
  program: ProgramRevision;

  /** Binds the bounded current-state projection. */
  projection: StateProjectionRevision;

  /** Binds canonical state bytes. */
  stateCodec: CellCodecRevision;

  /** Binds bounded state-view bytes. */
  stateViewCodec: CellCodecRevision;

  /** Binds ordered Program-event bytes. */
  eventCodec: CellCodecRevision;

  /** Binds acknowledged effect-intent bytes. */
  effectCodec: CellCodecRevision;
}>;

/** Options that adapt one ordinary JSON codec to exact durable bytes. */
export type JsonCellCodecOptions<Value> = Readonly<{
  /** Identifies this exact canonical JSON byte contract. */
  revision: string;

  /** Admits and copies values independently of the chosen validator product. */
  value: Codec<Value>;
}>;

/** UTF-8 encoder shared by canonical JSON Cell codecs. */
const TEXT_ENCODER = new TextEncoder();

/** UTF-8 decoder rejects malformed durable bytes instead of replacing them. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Serializes admitted JSON with recursively sorted object keys.
 * @param value - Immutable JSON value owned by the caller.
 * @returns Canonical JSON text independent of insertion order.
 */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    /** Sorts property names through host-independent code-unit comparison. */
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Adapts a product-neutral JSON validator to Archer's canonical durable bytes.
 * @param options - Revision identity and application-value codec.
 * @returns Exact Cell codec that copies both values and byte arrays.
 */
export function jsonCellCodec<Value>(options: JsonCellCodecOptions<Value>): CellCodec<Value> {
  /** Admits the revision before a codec can cross a persistence boundary. */
  const revision = CellCodecRevisionSchema.parse(options.revision);
  return Object.freeze({
    revision,
    /**
     * Admits a fresh JSON value and encodes its canonical representation.
     * @param value - Application-owned value that may contain mutable descendants.
     * @returns Fresh canonical UTF-8 bytes or the exact validation Error.
     */
    encode(value: Readonly<Value>): ResultValue<Uint8Array, Error> {
      /** Validation both proves JSON compatibility and establishes codec-owned identity. */
      const admitted = options.value.safeParse(value);
      if (!admitted.ok) return admitted;
      /** Archer's JSON boundary remains exact even when Value has optional TypeScript properties. */
      const json = JsonValueSchema.safeParse(admitted.value);
      return json.success
        ? Result.ok(TEXT_ENCODER.encode(canonicalJson(json.data)))
        : Result.error(new Error('Cell codec value is not JSON-compatible', { cause: json.error }));
    },
    /**
     * Parses canonical UTF-8 JSON and applies the same value admission contract.
     * @param bytes - Durable bytes that remain caller-owned.
     * @returns Fresh admitted value or an Error with the native failure as cause.
     */
    decode(bytes: Uint8Array): ResultValue<Value, Error> {
      try {
        /** JSON parsing creates fresh data before the application codec copies and freezes it. */
        return options.value.safeParse(JSON.parse(TEXT_DECODER.decode(bytes)));
      } catch (cause) {
        return Result.error(new Error('Invalid canonical Cell JSON bytes', { cause }));
      }
    },
  });
}

/**
 * Projects exact persistence revisions from a complete Cell protocol.
 * @param protocol - Protocol selected for create or attach.
 * @returns Frozen storage-neutral revision binding.
 */
export function bindCellProtocol<State, StateView, Event, Effect>(
  protocol: CellProtocol<State, StateView, Event, Effect>,
): CellProtocolBinding {
  return Object.freeze({
    protocol: protocol.protocolRevision,
    program: protocol.programRevision,
    projection: protocol.projectionRevision,
    stateCodec: protocol.codecs.state.revision,
    stateViewCodec: protocol.codecs.stateView.revision,
    eventCodec: protocol.codecs.event.revision,
    effectCodec: protocol.codecs.effect.revision,
  });
}

/**
 * Finds the first stable compatibility boundary that prevents Cell restore.
 * @param stored - Revisions bound when the Cell was created.
 * @param requested - Revisions supplied by the attaching protocol.
 * @returns Exact refusal, or absence when all interpretation contracts match.
 */
export function compareCellProtocol(
  stored: CellProtocolBinding,
  requested: CellProtocolBinding,
): CellRestoreRefusal | undefined {
  if (stored.protocol !== requested.protocol) return Object.freeze({ reason: 'protocol-revision', field: 'protocol' });
  if (stored.program !== requested.program) return Object.freeze({ reason: 'program-revision', field: 'program' });
  if (stored.projection !== requested.projection)
    return Object.freeze({ reason: 'projection-revision', field: 'projection' });

  /** Checks codec families in the same order they appear in the public protocol. */
  const codecs = [
    ['stateCodec', stored.stateCodec, requested.stateCodec],
    ['stateViewCodec', stored.stateViewCodec, requested.stateViewCodec],
    ['eventCodec', stored.eventCodec, requested.eventCodec],
    ['effectCodec', stored.effectCodec, requested.effectCodec],
  ] as const;
  /** Reports the first codec family whose durable interpretation changed. */
  for (const [field, expected, actual] of codecs) {
    if (expected !== actual) return Object.freeze({ reason: 'codec-revision', field });
  }
  return undefined;
}

/**
 * Derives effect identity from durable cause rather than process randomness.
 * @param cellId - Cell owning the acknowledged decision.
 * @param sequence - Program-event position that caused the effect.
 * @param position - Zero-based effect position inside that decision.
 * @returns SHA-256 identity stable across recovery and redrive.
 */
export function cellEffectId(cellId: CellId, sequence: CellSequence, position: number): CellEffectId {
  /** Length-prefixing prevents separator ambiguity if a branded value changes representation later. */
  const identity = `${cellId.length}:${cellId}${sequence.length}:${sequence}${String(position).length}:${position}`;
  /** Prefix preserves the digest algorithm in every durable identity. */
  const digest = `sha256:${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
  return CellEffectIdSchema.parse(Sha256DigestSchema.parse(digest));
}
