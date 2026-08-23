/**
 * @file Proves Result's exact variants, branch isolation, monad laws, identity
 * preservation, and ordered collection policy.
 */

import { describe, expect, it, vi } from 'vitest';

import { Result } from '../src/index.js';

describe('Result', () => {
  it('constructs the exact success and error variants', () => {
    /** Makes Error identity observable in the failure constructor assertion. */
    const failure = new Error('nope');

    expect(Result.ok(42)).toEqual({ ok: true, value: 42 });
    expect(Result.error(failure)).toEqual({ ok: false, error: failure });
    expect(Object.isFrozen(Result)).toBe(true);
  });

  it('narrows each variant', () => {
    /** Uses the broad Error type to prove the success predicate narrows by discriminant. */
    const success: Result<number, Error> = Result.ok(42);

    /** Uses the broad Error type to prove the failure predicate exposes the Error. */
    const failure: Result<number, Error> = Result.error(new Error('nope'));

    expect(Result.isOk(success)).toBe(true);
    expect(Result.isError(success)).toBe(false);
    expect(Result.isOk(failure)).toBe(false);
    expect(Result.isError(failure)).toBe(true);
  });

  it('maps only success and preserves the exact error instance', () => {
    /** Records calls so the failure branch can prove it never evaluates the transform. */
    const transform = vi.fn((value: number) => value * 2);

    /** Makes short-circuit identity observable rather than comparing messages. */
    const failure = new Error('nope');

    expect(Result.map(Result.ok(21), transform)).toEqual(Result.ok(42));
    expect(Result.map(Result.error(failure), transform)).toEqual(Result.error(failure));
    expect(transform).toHaveBeenCalledOnce();
  });

  it('obeys flatMap left identity, right identity, and associativity', () => {
    /**
     * Provides the first Result-producing computation used by all three law proofs.
     * @param value - The value supplied by the preceding successful Result.
     * @returns A successful Result containing the incremented value.
     */
    const increment = (value: number) => Result.ok(value + 1);

    /**
     * Provides a differently typed computation so associativity covers type changes.
     * @param value - The numeric value supplied by the preceding computation.
     * @returns A successful Result containing its string representation.
     */
    const stringify = (value: number) => Result.ok(String(value));

    /** Anchors the left-identity comparison to one concrete input. */
    const value = 41;

    /** Anchors right identity and associativity to one immutable Result. */
    const result = Result.ok(value);

    expect(Result.flatMap(Result.ok(value), increment)).toEqual(increment(value));
    expect(Result.flatMap(result, Result.ok)).toEqual(result);
    expect(Result.flatMap(Result.flatMap(result, increment), stringify)).toEqual(
      Result.flatMap(result, (current) => Result.flatMap(increment(current), stringify)),
    );
  });

  it('short-circuits flatMap on the first error', () => {
    /** Records whether flatMap incorrectly evaluates work after failure. */
    const transform = vi.fn((value: number) => Result.ok(value + 1));

    /** Makes preservation of the original failure instance observable. */
    const failure = new Error('nope');

    /** Captures the short-circuited branch for value and call-count assertions. */
    const result = Result.flatMap(Result.error(failure), transform);

    expect(result).toEqual(Result.error(failure));
    expect(transform).not.toHaveBeenCalled();
  });

  it('maps only errors', () => {
    /** Changes the Error class so failure-only mapping is observable. */
    const wrap = vi.fn((error: Error) => new TypeError(error.message));

    /** Makes success identity preservation observable. */
    const success = Result.ok(42);

    expect(Result.mapError(success, wrap)).toBe(success);
    expect(wrap).not.toHaveBeenCalled();

    /** Captures the mapped failure for class and message assertions. */
    const mapped = Result.mapError(Result.error(new Error('nope')), wrap);
    expect(Result.isError(mapped) && mapped.error).toBeInstanceOf(TypeError);
    expect(Result.isError(mapped) && mapped.error.message).toBe('nope');
  });

  it('matches exactly one branch', () => {
    /** Records success branch selection and preserves its input in output text. */
    const success = vi.fn((value: number) => `value:${value}`);

    /** Records failure branch selection if match violates its discriminant. */
    const failure = vi.fn((error: Error) => `error:${error.message}`);

    expect(Result.match(Result.ok(42), { ok: success, error: failure })).toBe('value:42');
    expect(success).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });

  it('infers and returns different output types from each match branch', () => {
    /** Keeps the failure type broad while exercising the successful branch. */
    const result: Result<number, TypeError> = Result.ok(42);

    /** Preserves the natural union of independent branch outputs. */
    const matched: number | string = Result.match(result, {
      /**
       * Returns a number without widening it to the error branch's type.
       * @param value - Successful fixture payload.
       * @returns The fixture payload doubled.
       */
      ok: (value) => value * 2,
      /**
       * Returns text without forcing the success branch to return text.
       * @param error - Typed failure from the alternate branch.
       * @returns The failure's ordinary Error message.
       */
      error: (error) => error.message,
    });

    expect(matched).toBe(84);
  });

  it('collects successes in order and returns the first error', () => {
    /** Identifies the first failure expected from ordered collection. */
    const first = new Error('first');

    /** Proves later failures cannot replace the first failure. */
    const second = new Error('second');

    expect(Result.all([Result.ok(1), Result.ok(2), Result.ok(3)])).toEqual(Result.ok([1, 2, 3]));
    expect(Result.all([Result.ok(1), Result.error(first), Result.error(second)])).toEqual(Result.error(first));

    /** Preserves heterogeneous literal values at their original tuple positions. */
    const tuple = Result.all([Result.ok(1 as const), Result.ok('two' as const)] as const);
    if (tuple.ok) {
      /** Proves the public type retains its readonly positional result. */
      const exact: readonly [1, 'two'] = tuple.value;
      expect(exact).toEqual([1, 'two']);
    }
  });
});
