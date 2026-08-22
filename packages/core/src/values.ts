/**
 * @file Defines Archer's canonical scalar and JSON value boundaries.
 *
 * Every branded string enters through its schema. The brand is compile-time
 * evidence of that parse, not a substitute for validation at an external or
 * persisted boundary.
 */

import * as z from 'zod';

/** Prevents an arbitrary string from posing as a UUIDv4 after parsing. */
declare const uuidV4Brand: unique symbol;

/** Prevents an unnormalized date string from posing as an Archer instant. */
declare const timestampBrand: unique symbol;

/** Prevents numbers and padded strings from bypassing exact decimal encoding. */
declare const canonicalDecimalBrand: unique symbol;

/** Prevents an unqualified hash string from posing as a SHA-256 digest. */
declare const sha256DigestBrand: unique symbol;

/** A lowercase RFC 9562 version 4 UUID accepted by {@link UuidV4Schema}. */
export type UuidV4 = string & {
  /** Carries compile-time evidence that the UUIDv4 schema admitted the string. */
  readonly [uuidV4Brand]: true;
};

/** An RFC 3339 instant normalized to UTC with millisecond precision. */
export type Timestamp = string & {
  /** Carries compile-time evidence that the timestamp is in canonical UTC form. */
  readonly [timestampBrand]: true;
};

/** A non-negative base-10 integer with no sign or leading zeroes. */
export type CanonicalDecimal = string & {
  /** Carries compile-time evidence that the decimal text is canonical. */
  readonly [canonicalDecimalBrand]: true;
};

/** A lowercase SHA-256 digest that retains its algorithm prefix. */
export type Sha256Digest = string & {
  /** Carries compile-time evidence that the algorithm-qualified digest is valid. */
  readonly [sha256DigestBrand]: true;
};

/** The scalar values JSON can represent without application-specific coercion. */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A recursively immutable JSON value suitable for persisted facts and error
 * details. Undefined values, bigint values, non-finite numbers, and class
 * instances are outside this contract.
 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** A JSON object whose string-named values cannot be mutated through this type. */
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

/**
 * Validates only UUID version 4 and lowercases accepted input so textual
 * identity comparisons do not depend on producer casing.
 */
export const UuidV4Schema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.uuidv4())
  .transform((value) => value as UuidV4);

/**
 * Requires an explicit UTC offset and normalizes equivalent instants to a
 * single UTC millisecond representation. Precision beyond milliseconds is
 * intentionally truncated by the JavaScript Date boundary.
 */
export const TimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString() as Timestamp);

/**
 * Preserves arbitrarily large non-negative integer values as exact text.
 * Fractional and signed quantities need their own domain-specific schemas.
 */
export const CanonicalDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .transform((value) => value as CanonicalDecimal);

/**
 * Carries the digest algorithm in the value so future digest families cannot
 * be confused with a bare 64-character hash.
 */
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u)
  .transform((value) => value as Sha256Digest);

/**
 * Copies and freezes a value already admitted by Zod's JSON schema.
 *
 * The validation step guarantees a finite JSON tree, so this recursive walk
 * does not need cycle detection. It visits each array element and object field
 * once and never freezes or otherwise mutates the caller's input.
 * @param value - A value already proven to be JSON.
 * @returns A deeply frozen copy with the same JSON representation.
 */
function immutableJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableJson(item)));
  }

  if (value !== null && typeof value === 'object') {
    /** Accumulates a fresh object so freezing cannot affect caller-owned data. */
    const copy: Record<string, JsonValue> = {};

    /** Each binding names one validated field whose value is copied recursively. */
    for (const [key, item] of Object.entries(value)) copy[key] = immutableJson(item);
    return Object.freeze(copy);
  }

  return value;
}

/**
 * Rejects JavaScript values JSON cannot preserve, then returns a deeply frozen
 * copy so admitted facts cannot change after validation.
 */
export const JsonValueSchema = z.json().transform((value) => immutableJson(value));

/**
 * Narrows immutable JSON to string-keyed objects for attributes and error
 * details whose contract does not admit arrays, scalars, or null roots.
 */
export const JsonObjectSchema = JsonValueSchema.refine(
  (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  { message: 'Expected a JSON object' },
).transform((value) => value as JsonObject);

/**
 * Generates process-local identity with the platform cryptographic RNG and
 * immediately routes it through the same canonical schema used for input.
 * @returns A lowercase UUIDv4.
 */
export function createUuidV4(): UuidV4 {
  return UuidV4Schema.parse(globalThis.crypto.randomUUID());
}
