/**
 * @file Proves public failures are bounded, redacted, serializable values and
 * command identities remain canonical UUIDv4 values.
 */

import { describe, expect, it } from 'vitest';

import {
  ArcherError,
  IdempotencyKeySchema,
  ProtocolFailureSchema,
  PublicErrorSchema,
  createIdempotencyKey,
  toProtocolFailure,
  toPublicError,
} from '../src/index.js';

describe('public protocol values', () => {
  it('preserves explicitly public ArcherError data without retaining Error identity', () => {
    /** Carries fields Archer deliberately authored for public inspection. */
    const error = new ArcherError('The adapter refused the request', {
      code: 'adapter_refused',
      details: { adapter: 'fixture' },
    });

    /** Converts the local Error graph into transport-safe data. */
    const result = toPublicError(error, {
      code: 'unexpected_adapter_failure',
      message: 'The adapter failed',
    });

    expect(result).toEqual({
      code: 'adapter_refused',
      message: 'The adapter refused the request',
      retryable: false,
      details: { adapter: 'fixture' },
    });
    expect(result).not.toBe(error);
    expect(PublicErrorSchema.parse(result)).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('redacts unknown Error messages, causes, stacks, and custom fields', () => {
    /** Contains material that must never cross the public boundary implicitly. */
    const error = Object.assign(new Error('credential=super-secret', { cause: new Error('raw provider body') }), {
      responseHeaders: { authorization: 'Bearer secret' },
    });

    /** Applies boundary-owned fallback text instead of inspecting unknown fields. */
    const result = toPublicError(error, {
      code: 'adapter_failed',
      message: 'The adapter failed',
      retryable: true,
      details: { adapter: 'fixture' },
    });

    expect(result).toEqual({
      code: 'adapter_failed',
      message: 'The adapter failed',
      retryable: true,
      details: { adapter: 'fixture' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('marks protocol violations explicitly after the same redaction boundary', () => {
    /** Represents an untrusted adapter exception with no public contract. */
    const error = new TypeError('provider internals');

    /** Carries only the boundary-authored protocol explanation. */
    const failure = toProtocolFailure(error, {
      code: 'invalid_event_order',
      message: 'The adapter emitted progress after its result',
    });

    expect(failure).toEqual({
      kind: 'protocol-failure',
      code: 'invalid_event_order',
      message: 'The adapter emitted progress after its result',
      retryable: false,
    });
    expect(ProtocolFailureSchema.parse(failure)).toEqual(failure);
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it('generates idempotency keys through the UUIDv4 codec', () => {
    /** Exercises the real platform UUID boundary while asserting only shape. */
    const key = createIdempotencyKey();

    expect(IdempotencyKeySchema.parse(key)).toBe(key);
  });

  it('rejects non-object details at the runtime transport boundary', () => {
    expect(
      PublicErrorSchema.safeParse({ code: 'invalid', message: 'Invalid details', retryable: false, details: [] })
        .success,
    ).toBe(false);
  });
});
