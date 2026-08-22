/**
 * @file Proves the Zod adapter preserves transformations and hides Zod failures
 * behind Archer's validation contract.
 */

import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { Result, ValidationError, fromZod } from '../src/index.js';

/** Uses strict positive counts to exercise both transformation and issue paths. */
const CountSchema = z.strictObject({ count: z.int().positive() }).readonly();

/** Exercises the public Codec contract through a real Zod-backed adapter. */
const CountCodec = fromZod(CountSchema);

describe('fromZod', () => {
  it('returns transformed schema output through parse and safeParse', () => {
    expect(CountCodec.parse({ count: 2 })).toEqual({ count: 2 });
    expect(CountCodec.safeParse({ count: 2 })).toEqual(Result.ok({ count: 2 }));
  });

  it('normalizes Zod issues into a ValidationError Result', () => {
    /** Remains caller-owned so the test can prove failure handling does not mutate it. */
    const input = { count: -1 };

    /** Captures the non-throwing boundary for exact failure assertions. */
    const result = CountCodec.safeParse(input);

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.code).toBe('validation_failed');
      expect(result.error.issues).toEqual([expect.objectContaining({ path: ['count'], code: 'too_small' })]);
      expect(result.error.cause).toBeInstanceOf(z.ZodError);
    }
    expect(input).toEqual({ count: -1 });
  });

  it('throws the same public ValidationError contract from parse', () => {
    expect(() => CountCodec.parse({ count: -1 })).toThrowError(
      expect.objectContaining({
        name: 'ValidationError',
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: ['count'], code: 'too_small' })],
      }),
    );
  });
});
