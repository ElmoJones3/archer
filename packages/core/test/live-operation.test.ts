/**
 * @file Proves one finite attempt has hot progress, exact terminal order,
 * idempotent abort requests, and observation close distinct from abort.
 */

import { describe, expect, it, vi } from 'vitest';

import { createIdempotencyKey } from '../src/index.js';
import {
  createLiveOperation,
  type AttemptAbortDisposition,
  type LiveOperationContext,
  type OperationSettlement,
} from '../src/stream/index.js';
import { deferred, fixtureEventEncoding, nextValue } from './temporal-fixtures.js';

/** Progress emitted by the representative finite attempt. */
type Progress = Readonly<{
  /** Monotonic representative progress step. */
  step: number;
}>;

/** Tagged domain result produced by the representative attempt. */
type OperationResult = Readonly<{
  /** Distinguishes successful completion from terminal abort. */
  kind: 'completed' | 'aborted';
}>;

/** Immutable evidence returned when the attempt handle releases ownership. */
type OperationClose = Readonly<{
  /** Identifies normal retained-handle closure. */
  kind: 'closed';
}>;

/** Close evidence used to inspect redaction of an unexpected adapter rejection. */
type FailedOperationClose = Readonly<{
  /** Carries only the bounded failure selected by operation close mapping. */
  error?: unknown;
}>;

/**
 * Classifies the representative tagged result after an accepted abort signal.
 * @param settlement - Normalized attempt result or protocol rejection.
 * @returns Terminal abort or cleanup evidence.
 */
function classifyAbort(settlement: OperationSettlement<OperationResult>): AttemptAbortDisposition {
  if (settlement.kind === 'failed') return Object.freeze({ kind: 'cleanup-unproved', failure: settlement.error });
  return Object.freeze({
    kind: 'attempt-settled',
    outcome: settlement.value.kind === 'aborted' ? 'aborted' : 'completed',
  });
}

describe('LiveOperation', () => {
  it('starts once, seals progress before result, and lets existing subscribers drain', async () => {
    /** Keeps attempt settlement under direct test control. */
    const settlement = deferred<OperationResult>();

    /** Captures the producer context retained by the running adapter. */
    let emit: ((event: Progress) => void) | undefined;

    /** Proves the finite adapter activates only once during construction. */
    const start = vi.fn((context: LiveOperationContext<Progress>) => {
      emit = context.emit;
      return settlement.promise;
    });

    /** Owns the one admitted attempt under test. */
    const operation = createLiveOperation<Progress, OperationResult, OperationClose>({
      source: 'fixture-operation',
      epoch: 'attempt-1',
      eventEncoding: fixtureEventEncoding<Progress>(),
      start,
      classifyAbort,
      /**
       * Maps normal result settlement into retained fixture close evidence.
       * @returns Immutable fixture evidence.
       */
      closeEvidence: () => Object.freeze({ kind: 'closed' }),
    });
    expect('publish' in operation.events).toBe(false);
    expect('close' in operation.events).toBe(false);

    /** Attaches to already-running work rather than starting another adapter call. */
    const subscription = operation.events.subscribe({ capacityItems: 4 });
    emit?.({ step: 1 });
    emit?.({ step: 2 });
    settlement.resolve(Object.freeze({ kind: 'completed' }));

    expect(await operation.result).toEqual({ kind: 'completed' });
    expect(start).toHaveBeenCalledOnce();

    /** Accepted progress remains FIFO-readable after result settlement. */
    const iterator = subscription[Symbol.asyncIterator]();
    expect(await nextValue(iterator)).toEqual({ kind: 'event', value: { step: 1 } });
    expect(await nextValue(iterator)).toEqual({ kind: 'event', value: { step: 2 } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });

    /** A subscriber attached after the seal is already complete. */
    const late = operation.events.subscribe();
    expect(await late.closed).toEqual({ kind: 'completed' });

    /** A retained producer callback cannot publish after result settlement. */
    emit?.({ step: 3 });
    expect(await late[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });

    /** Carries retained handle evidence after all accepted progress has drained. */
    const close = await operation.close();
    expect(await operation.closed).toBe(close);
  });

  it('waits rather than aborting on close and deduplicates explicit abort commands', async () => {
    /** Keeps the active attempt pending across close and abort assertions. */
    const settlement = deferred<OperationResult>();

    /** Captures the operation signal without coupling the test to AbortController. */
    let signal: AbortSignal | undefined;

    /** Owns the active operation whose close must not request termination. */
    const operation = createLiveOperation<Progress, OperationResult, OperationClose>({
      source: 'fixture-operation',
      epoch: 'attempt-1',
      eventEncoding: fixtureEventEncoding<Progress>(),
      /**
       * Retains the active signal while keeping result settlement under test control.
       * @param context - Attempt progress and abort capabilities.
       * @returns The manually settled tagged operation result.
       */
      start: (context) => {
        signal = context.signal;
        return settlement.promise;
      },
      classifyAbort,
      /**
       * Maps terminal settlement into immutable fixture evidence.
       * @returns Immutable fixture evidence.
       */
      closeEvidence: () => Object.freeze({ kind: 'closed' }),
    });

    /** Requests close while the attempt remains active. */
    const close = operation.close();
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);

    /** Retries the same abort command and receives the same terminal Promise. */
    const command = Object.freeze({ reason: 'operator request', idempotencyKey: createIdempotencyKey() });
    /** Captures the first terminal abort settlement for identity comparison. */
    const firstAbort = operation.abort(command);
    /** Captures the retried command's exact retained Promise. */
    const repeatedAbort = operation.abort(command);
    expect(repeatedAbort).toBe(firstAbort);
    expect(signal?.aborted).toBe(true);
    expect(await Promise.race([firstAbort, Promise.resolve('pending')])).toBe('pending');

    settlement.resolve(Object.freeze({ kind: 'aborted' }));
    expect(await firstAbort).toEqual({
      kind: 'attempt-settled',
      outcome: 'aborted',
      idempotencyKey: command.idempotencyKey,
    });
    expect(await close).toEqual({ kind: 'closed' });

    /** A new command after terminal settlement cannot rewrite attempt state. */
    const lateCommand = Object.freeze({ reason: 'too late', idempotencyKey: createIdempotencyKey() });
    expect(await operation.abort(lateCommand)).toEqual({
      kind: 'already-settled',
      idempotencyKey: lateCommand.idempotencyKey,
    });
  });

  it('reports ordinary completion when the result wins after an accepted abort signal', async () => {
    /** Keeps the result race under deterministic test control. */
    const settlement = deferred<OperationResult>();

    /** Owns an attempt whose adapter may complete despite receiving abort. */
    const operation = createLiveOperation<Progress, OperationResult, OperationClose>({
      source: 'fixture-operation',
      epoch: 'attempt-1',
      eventEncoding: fixtureEventEncoding<Progress>(),
      /**
       * Leaves terminal result settlement under direct fixture control.
       * @returns The manually controlled result race.
       */
      start: () => settlement.promise,
      classifyAbort,
      /**
       * Maps either terminal result into retained close evidence.
       * @returns Immutable fixture close evidence.
       */
      closeEvidence: () => Object.freeze({ kind: 'closed' }),
    });

    /** Requests abort before selecting the ordinary completion winner. */
    const command = Object.freeze({ reason: 'too late to stop', idempotencyKey: createIdempotencyKey() });
    /** Retains terminal command evidence rather than immediate signal delivery. */
    const abort = operation.abort(command);
    settlement.resolve(Object.freeze({ kind: 'completed' }));

    expect(await abort).toEqual({
      kind: 'attempt-settled',
      outcome: 'completed',
      idempotencyKey: command.idempotencyKey,
    });
    await operation.close();
  });

  it('returns cleanup-unproved evidence when an aborted adapter rejects', async () => {
    /** Keeps the adapter protocol rejection under deterministic test control. */
    const settlement = deferred<OperationResult>();

    /** Owns an attempt whose adapter fails before it can prove tagged abort. */
    const operation = createLiveOperation<Progress, OperationResult, OperationClose>({
      source: 'fixture-operation',
      epoch: 'attempt-1',
      eventEncoding: fixtureEventEncoding<Progress>(),
      /**
       * Leaves terminal rejection under direct fixture control.
       * @returns The manually controlled result promise.
       */
      start: () => settlement.promise,
      classifyAbort,
      /**
       * Maps failed settlement into ordinary retained close evidence.
       * @returns Immutable fixture close evidence.
       */
      closeEvidence: () => Object.freeze({ kind: 'closed' }),
      failure: { code: 'fixture_cleanup_unproved', message: 'The fixture could not prove cleanup' },
    });

    /** Requests termination before causing the adapter protocol rejection. */
    const command = Object.freeze({ reason: 'operator request', idempotencyKey: createIdempotencyKey() });
    /** Retains the terminal cleanup evidence associated with that command. */
    const abort = operation.abort(command);
    settlement.reject(new Error('private cleanup detail'));

    await expect(operation.result).rejects.toThrow('private cleanup detail');
    expect(await abort).toEqual({
      kind: 'cleanup-unproved',
      failure: {
        code: 'fixture_cleanup_unproved',
        message: 'The fixture could not prove cleanup',
        retryable: false,
      },
      idempotencyKey: command.idempotencyKey,
    });
    await operation.close();
  });

  it('redacts unexpected adapter rejection in close evidence while preserving result rejection', async () => {
    /** Owns an operation whose adapter violates the tagged-result expectation. */
    const operation = createLiveOperation<Progress, OperationResult, FailedOperationClose>({
      source: 'fixture-operation',
      epoch: 'attempt-1',
      eventEncoding: fixtureEventEncoding<Progress>(),
      /** Rejects with private adapter text to exercise result versus close boundaries. */
      start: async () => {
        throw new Error('credential=private');
      },
      classifyAbort,
      /**
       * Converts only normalized failure settlement into public close evidence.
       * @param settlement - Normalized result or redacted failure settlement.
       * @returns Immutable fixture close evidence.
       */
      closeEvidence: (settlement) => Object.freeze(settlement.kind === 'failed' ? { error: settlement.error } : {}),
      failure: { code: 'fixture_failed', message: 'The fixture operation failed' },
    });

    await expect(operation.result).rejects.toThrow('credential=private');
    /** Carries redacted failure data after the native result promise rejects. */
    const close = await operation.close();
    expect(close).toEqual({
      error: { code: 'fixture_failed', message: 'The fixture operation failed', retryable: false },
    });
    expect(JSON.stringify(close)).not.toContain('private');
  });

  it('settles close and closed with the same mapping failure', async () => {
    /** Makes retained close mapping failure identity directly observable. */
    const failure = new TypeError('invalid close evidence');

    /** Returns a normal result before the owning implementation violates close mapping. */
    const operation = createLiveOperation<Progress, OperationResult, OperationClose>({
      source: 'fixture-operation',
      epoch: 'attempt-1',
      eventEncoding: fixtureEventEncoding<Progress>(),
      /**
       * Returns one immediate normal tagged result.
       * @returns Completed fixture result.
       */
      start: async () => Object.freeze({ kind: 'completed' }),
      classifyAbort,
      /**
       * Throws the exact protocol mapping failure retained by the test.
       */
      closeEvidence: () => {
        throw failure;
      },
    });

    await operation.result;
    /** Starts the retained handle close path whose rejection is compared. */
    const close = operation.close();
    /** Captures both public close access paths without losing rejection identity. */
    const [methodSettlement, propertySettlement] = await Promise.allSettled([close, operation.closed]);

    expect(methodSettlement).toEqual({ status: 'rejected', reason: failure });
    expect(propertySettlement).toEqual({ status: 'rejected', reason: failure });
  });
});
