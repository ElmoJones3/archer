/**
 * @file Implements one finite admitted attempt whose hot progress, result,
 * abort command, and retained-handle closure remain distinct contracts.
 */

import { toPublicError, type PublicError, type PublicErrorFallback } from '../protocol.js';
import type { AttemptAbortDisposition, AttemptAbortEvidence, LiveOperation } from './contracts.js';
import {
  asTransientEventStream,
  createTransientEventSource,
  type EventEncoding,
  type TransientDeliveryDefaults,
  type TransientEventSource,
} from './runtime.js';

/** Capabilities supplied to one finite adapter activation. */
export type LiveOperationContext<Event> = Readonly<{
  /** Publishes non-authoritative progress while the attempt remains active. */
  emit(event: Event): void;

  /** Signals an explicit abort command without conflating handle close. */
  signal: AbortSignal;
}>;

/** Normalizes either result settlement or an unexpected adapter rejection. */
export type OperationSettlement<Result> =
  | Readonly<{
      /** Identifies a tagged result returned by the finite adapter. */
      kind: 'result';

      /** Carries the adapter's one terminal domain value. */
      value: Result;
    }>
  | Readonly<{
      /** Identifies an unexpected adapter rejection. */
      kind: 'failed';

      /** Carries bounded public failure data rather than native Error identity. */
      error: PublicError;
    }>;

/** Configures activation and retained closure for one finite attempt. */
export type LiveOperationOptions<Event, Result, CloseEvidence> = Readonly<{
  /** Names the attempt progress plane. */
  source: string;

  /** Identifies this non-replayable attempt generation. */
  epoch: string;

  /** Binds progress byte limits to one canonical event protocol revision. */
  eventEncoding: EventEncoding<Event>;

  /** Selects default independent progress queue bounds. */
  delivery?: Partial<TransientDeliveryDefaults>;

  /** Activates the adapter exactly once with progress and abort capabilities. */
  start(context: LiveOperationContext<Event>): Promise<Result>;

  /** Converts terminal settlement into immutable retained-handle evidence. */
  closeEvidence(settlement: OperationSettlement<Result>): CloseEvidence;

  /** Classifies terminal settlement after an accepted abort signal. */
  classifyAbort(settlement: OperationSettlement<Result>): AttemptAbortDisposition;

  /** Redacts an unexpected adapter rejection before it enters close evidence. */
  failure?: PublicErrorFallback;
}>;

/**
 * Stages progress typing while inferring result and close evidence from options.
 * @returns A finite-operation factory requiring only the event type up front.
 */
export function liveOperation<Event>() {
  return <Result, CloseEvidence>(options: LiveOperationOptions<Event, Result, CloseEvidence>) =>
    createLiveOperation<Event, Result, CloseEvidence>(options);
}

/**
 * Creates and immediately activates one finite operation over a shared hot graph.
 * @param options - Attempt identity, activation, bounds, redaction, and close mapping.
 * @returns A retained finite operation that starts exactly once.
 */
export function createLiveOperation<Event, Result, CloseEvidence>(
  options: LiveOperationOptions<Event, Result, CloseEvidence>,
): LiveOperation<Event, Result, CloseEvidence> {
  /** Owns progress fan-out independently of operation result settlement. */
  const events: TransientEventSource<Event> = createTransientEventSource({
    source: options.source,
    epoch: options.epoch,
    eventEncoding: options.eventEncoding,
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
  });

  /** Carries the only active termination signal supplied to the adapter. */
  const abortController = new AbortController();

  /** Deduplicates terminal abort settlement by command identity. */
  const abortEvidence = new Map<string, Promise<AttemptAbortEvidence>>();

  /** Prevents progress acceptance and changes late abort acknowledgements. */
  let settled = false;

  /** Captures synchronous adapter throws in the same result promise as rejection. */
  let started: Promise<Result>;
  try {
    started = Promise.resolve(
      options.start({
        /**
         * Publishes progress only while result settlement remains open.
         * @param event - Non-authoritative attempt progress.
         */
        emit(event) {
          if (!settled) events.publish(event);
        },
        signal: abortController.signal,
      }),
    );
  } catch (error) {
    started = Promise.reject(error);
  }

  /** Seals progress synchronously before forwarding either terminal settlement. */
  const result = started.then(
    async (value) => {
      settled = true;
      await events.close();
      return value;
    },
    async (error: unknown) => {
      settled = true;
      await events.close();
      throw error;
    },
  );

  /** Normalizes terminal settlement once for close and abort evidence mapping. */
  const terminalSettlement: Promise<OperationSettlement<Result>> = result.then(
    (value) => Object.freeze({ kind: 'result', value }),
    (error: unknown) =>
      Object.freeze({
        kind: 'failed',
        error: toPublicError(
          error,
          options.failure ?? {
            code: 'operation_failed',
            message: 'The operation failed unexpectedly',
          },
        ),
      }),
  );

  /** Retains one idempotent close operation without starting it eagerly. */
  let closePromise: Promise<CloseEvidence> | undefined;

  /** Exposes `closed` before closure through a separately retained deferred promise. */
  let settleClosed: ((evidence: CloseEvidence) => void) | undefined;

  /** Rejects `closed` with the same protocol failure as the close method. */
  let rejectClosed: ((reason: unknown) => void) | undefined;

  /** Retains lifecycle observation independently of lazy close activation. */
  const closed = new Promise<CloseEvidence>((resolve, reject) => {
    settleClosed = resolve;
    rejectClosed = reject;
  });

  /** Constructs the public operation without exposing the progress publisher. */
  const operation: LiveOperation<Event, Result, CloseEvidence> = {
    events: asTransientEventStream(events),
    result,
    closed,
    /**
     * Requests active termination idempotently by command identity.
     * @param command - Bounded reason and UUIDv4 idempotency key.
     * @returns Immutable acknowledgement of request timing.
     */
    abort(command) {
      /** Reuses exact terminal settlement identity for command retries. */
      const prior = abortEvidence.get(command.idempotencyKey);
      if (prior !== undefined) return prior;
      if (settled) {
        /** A late command observes terminal state without rewriting the attempt. */
        const late = Promise.resolve<AttemptAbortEvidence>(
          Object.freeze({ kind: 'already-settled', idempotencyKey: command.idempotencyKey }),
        );
        abortEvidence.set(command.idempotencyKey, late);
        return late;
      }
      if (!abortController.signal.aborted) abortController.abort(command.reason);
      /** Waits for terminal result and adapter cleanup classification before resolving. */
      const evidence = terminalSettlement.then((settlement): AttemptAbortEvidence =>
        Object.freeze({ ...options.classifyAbort(settlement), idempotencyKey: command.idempotencyKey }),
      );
      abortEvidence.set(command.idempotencyKey, evidence);
      return evidence;
    },
    /**
     * Waits for terminal result without requesting abort, then releases the handle.
     * @returns Shared immutable operation close evidence.
     */
    close() {
      closePromise ??= terminalSettlement
        .then((settlement) => options.closeEvidence(settlement))
        .then((evidence) => Object.freeze(evidence));
      void closePromise.then(
        (evidence) => settleClosed?.(evidence),
        (error: unknown) => rejectClosed?.(error),
      );
      return closePromise;
    },
    /** Delegates language disposal to the non-aborting close path. */
    async [Symbol.asyncDispose]() {
      await operation.close();
    },
  };

  return Object.freeze(operation);
}
