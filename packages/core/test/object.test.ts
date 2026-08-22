/**
 * @file Proves generic and aggregate-specific Archer identity envelopes enforce
 * canonical UUIDs, exact discriminators, trusted instants, and strict fields.
 */

import { describe, expect, it } from 'vitest';

import { ArcherObjectSchema, UuidV4Schema, archerObjectSchema, type UuidV4 } from '../src/index.js';

/** Distinguishes Thread identity from every other UUIDv4 at compile time. */
declare const threadIdBrand: unique symbol;

/** A UUIDv4 admitted specifically for Thread ownership. */
type ThreadId = UuidV4 & {
  /** Carries compile-time evidence of Thread identity specialization. */
  readonly [threadIdBrand]: true;
};

/** Narrows canonical UUID output to the Thread identity brand. */
const ThreadIdSchema = UuidV4Schema.transform((id) => id as ThreadId);

/** Reuses the production specialization factory under test. */
const ThreadSchema = archerObjectSchema('thread', ThreadIdSchema);

describe('archerObjectSchema', () => {
  it('defines the shared identity envelope', () => {
    expect(
      ArcherObjectSchema.parse({
        id: '550E8400-E29B-41D4-A716-446655440000',
        object: 'thread',
        createdAt: '2026-08-21T21:00:00-06:00',
      }),
    ).toEqual({
      id: '550e8400-e29b-41d4-a716-446655440000',
      object: 'thread',
      createdAt: '2026-08-22T03:00:00.000Z',
    });
    expect(
      ArcherObjectSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        object: '',
        createdAt: '2026-08-22T03:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('constructs a strict immutable object with specialized identity and discriminator', () => {
    /** Holds the normalized aggregate object returned by the specialized schema. */
    const thread = ThreadSchema.parse({
      id: '550E8400-E29B-41D4-A716-446655440000',
      object: 'thread',
      createdAt: '2026-08-21T21:00:00-06:00',
    });

    expect(thread).toEqual({
      id: '550e8400-e29b-41d4-a716-446655440000',
      object: 'thread',
      createdAt: '2026-08-22T03:00:00.000Z',
    });
    expect(Object.isFrozen(thread)).toBe(true);
  });

  it('rejects a different object discriminator and unknown fields', () => {
    expect(
      ThreadSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        object: 'workspace',
        createdAt: '2026-08-22T03:00:00.000Z',
      }).success,
    ).toBe(false);

    expect(
      ThreadSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        object: 'thread',
        createdAt: '2026-08-22T03:00:00.000Z',
        updatedAt: '2026-08-22T03:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
