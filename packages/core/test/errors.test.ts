/**
 * @file Proves Archer errors retain native causality while exposing immutable,
 * serializable evidence.
 */

import { describe, expect, it } from 'vitest';

import { ArcherError, ValidationError } from '../src/index.js';

describe('ArcherError', () => {
  it('retains stable identity, serializable details, and the local cause', () => {
    /** Represents adapter-local diagnostic state that transport must not flatten. */
    const cause = new TypeError('upstream');

    /** Represents caller-owned evidence that the Error must copy and freeze. */
    const details = { adapter: 'example', attempt: 2 } as const;

    /** Exercises the public base class rather than a test-only subclass. */
    const error = new ArcherError('Adapter failed', {
      cause,
      code: 'adapter_failed',
      details,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ArcherError);
    expect(error).toMatchObject({
      name: 'ArcherError',
      message: 'Adapter failed',
      code: 'adapter_failed',
      details,
      cause,
    });
    expect(error.details).not.toBe(details);
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(Object.isFrozen(details)).toBe(false);
  });
});

describe('ValidationError', () => {
  it('is a focused ArcherError with immutable normalized issues', () => {
    /** Uses a non-empty path so path copying and stable issue order are observable. */
    const issues = [{ path: ['count'], code: 'too_small', message: 'Must be positive' }] as const;

    /** Exercises normalization performed by the focused validation subclass. */
    const error = new ValidationError(issues);

    expect(error).toBeInstanceOf(ArcherError);
    expect(error).toMatchObject({
      name: 'ValidationError',
      message: 'Validation failed',
      code: 'validation_failed',
      issues,
    });
    expect(error.issues).not.toBe(issues);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(error.issues.every((issue) => Object.isFrozen(issue) && Object.isFrozen(issue.path))).toBe(true);
    expect(Object.isFrozen(issues)).toBe(false);
  });
});
