/**
 * @file Proves canonical value schemas normalize equivalent inputs, reject
 * ambiguous representations, and protect caller-owned JSON from mutation.
 */

import { describe, expect, it } from 'vitest';

import {
  CanonicalDecimalSchema,
  JsonObjectSchema,
  JsonValueSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  createUuidV4,
} from '../src/index.js';

/** The canonical UUID text expected after boundary normalization. */
const LOWERCASE_UUID = '550e8400-e29b-41d4-a716-446655440000';

/** An equivalent producer spelling used to prove casing does not affect identity. */
const UPPERCASE_UUID = '550E8400-E29B-41D4-A716-446655440000';

describe('UuidV4Schema', () => {
  it('normalizes UUIDv4 values to canonical lowercase form', () => {
    expect(UuidV4Schema.parse(UPPERCASE_UUID)).toBe(LOWERCASE_UUID);
  });

  it('rejects other UUID versions and malformed strings', () => {
    expect(UuidV4Schema.safeParse('018f4f30-a8d2-7c9a-b1e7-8f5d92f665ce').success).toBe(false);
    expect(UuidV4Schema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('generates values accepted by the UUIDv4 codec', () => {
    /**
     * Uses the real platform boundary because UUID version and shape are the
     * claim. Collision resistance belongs to the platform and is not sampled.
     */
    const generated = createUuidV4();

    expect(UuidV4Schema.safeParse(generated).success).toBe(true);
  });
});

describe('TimestampSchema', () => {
  it('normalizes an RFC 3339 instant to UTC millisecond precision', () => {
    expect(TimestampSchema.parse('2026-08-21T21:00:00-06:00')).toBe('2026-08-22T03:00:00.000Z');
    expect(TimestampSchema.parse('2026-08-22T03:00:00.123456Z')).toBe('2026-08-22T03:00:00.123Z');
  });

  it('rejects dates without an instant and invalid calendar values', () => {
    expect(TimestampSchema.safeParse('2026-08-22').success).toBe(false);
    expect(TimestampSchema.safeParse('2026-02-30T03:00:00Z').success).toBe(false);
  });
});

describe('CanonicalDecimalSchema', () => {
  it.each(['0', '1', '42', '90071992547409931234567890'])('accepts canonical non-negative decimal %s', (value) => {
    expect(CanonicalDecimalSchema.parse(value)).toBe(value);
  });

  it.each(['', '-1', '+1', '01', '1.0', 1])('rejects non-canonical decimal %j', (value) => {
    expect(CanonicalDecimalSchema.safeParse(value).success).toBe(false);
  });
});

describe('Sha256DigestSchema', () => {
  it('accepts only an algorithm-prefixed lowercase SHA-256 digest', () => {
    /** Uses an exact 256-bit lowercase payload with the required algorithm prefix. */
    const digest = `sha256:${'ab'.repeat(32)}`;

    expect(Sha256DigestSchema.parse(digest)).toBe(digest);
    expect(Sha256DigestSchema.safeParse(digest.toUpperCase()).success).toBe(false);
    expect(Sha256DigestSchema.safeParse('ab'.repeat(32)).success).toBe(false);
  });
});

describe('JsonValueSchema', () => {
  it('returns a deeply immutable copy without mutating the input', () => {
    /** Remains mutable and caller-owned so the test can detect accidental freezing. */
    const input = { name: 'Archer', nested: { values: [1, true, null] } };

    /** Holds the independent immutable graph returned by the schema. */
    const parsed = JsonValueSchema.parse(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    if (typeof parsed === 'object' && parsed !== null && 'nested' in parsed) {
      expect(Object.isFrozen(parsed.nested)).toBe(true);
    }
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date('2026-08-22T03:00:00Z')])(
    'rejects non-JSON value %s',
    (value) => {
      expect(JsonValueSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('JsonObjectSchema', () => {
  it('admits only immutable JSON objects rather than every JSON value', () => {
    expect(JsonObjectSchema.parse({ name: 'Archer' })).toEqual({ name: 'Archer' });
    expect(JsonObjectSchema.safeParse([]).success).toBe(false);
    expect(JsonObjectSchema.safeParse('object-like').success).toBe(false);
    expect(JsonObjectSchema.safeParse(null).success).toBe(false);
  });
});
