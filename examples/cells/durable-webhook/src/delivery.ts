/**
 * @file Sends signed customer webhooks after Archer has saved the request.
 *
 * The signing secret stays in process memory. Saved delivery state contains
 * only the destination, event name, and JSON data needed for another worker.
 */

import { createHmac } from 'node:crypto';

import { createLiveOperation } from '@archer/core/stream';
import type {
  AcknowledgedEffectAttempt,
  CellEffectAdapter,
  CellEffectAttemptCloseEvidence,
  CellEffectResult,
} from '@archer/core/cells';

import { retryAt, type WebhookEffect, type WebhookEvent } from './domain.js';

/** Live HTTP progress that a terminal or web client may show without saving it. */
export type WebhookProgress = Readonly<{
  /** Human-readable phase of the current request. */
  stage: 'sending' | 'response';

  /** Response status after the destination returns headers. */
  status?: number;
}>;

/** Configuration shared by new and recovered webhook attempts. */
export type WebhookEffectAdapterOptions = Readonly<{
  /** Secret used to sign the exact JSON bytes sent to customers. */
  signingSecret: string;

  /** Supplies completion time and defaults to wall time. */
  now?: () => Date;

  /** Stops waiting for response headers and defaults to fifteen seconds. */
  requestTimeoutMilliseconds?: number;

  /** Delays the first retry and defaults to ten seconds. */
  retryDelayMilliseconds?: number;

  /** Replaces platform fetch for a custom runtime or deterministic test. */
  fetch?: typeof fetch;

  /** Replaces the platform timeout signal for deterministic scheduling. */
  createTimeoutSignal?: (milliseconds: number) => AbortSignal;
}>;

/** Returns whether a customer response is likely to succeed when retried. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Returns whether the request ended because its configured deadline elapsed. */
function isTimeout(error: unknown, timeoutSignal: AbortSignal): boolean {
  return (
    timeoutSignal.aborted &&
    ((error instanceof DOMException && error.name === 'TimeoutError') ||
      (timeoutSignal.reason instanceof DOMException && timeoutSignal.reason.name === 'TimeoutError'))
  );
}

/**
 * Signs the exact request body so a receiver can reject forged deliveries.
 * @param body - JSON text that will be sent without further transformation.
 * @param secret - Application secret kept outside durable Cell state.
 * @returns Conventional SHA-256 signature header value.
 */
function signWebhook(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Creates the real fetch adapter used for both first attempts and restart recovery.
 * @param options - Signing secret and optional completion clock.
 * @returns An adapter that reports HTTP results back to the delivery rules.
 */
export function webhookEffectAdapter(
  options: WebhookEffectAdapterOptions,
): CellEffectAdapter<WebhookEffect, WebhookEvent, WebhookProgress> {
  const now = options.now ?? (() => new Date());
  const request = options.fetch ?? globalThis.fetch;
  const requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 15_000;
  const retryDelayMilliseconds = options.retryDelayMilliseconds ?? 10_000;
  const createTimeoutSignal =
    options.createTimeoutSignal ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));
  if (options.signingSecret.length === 0) throw new RangeError('signingSecret must not be empty');
  if (!Number.isSafeInteger(requestTimeoutMilliseconds) || requestTimeoutMilliseconds < 1) {
    throw new RangeError('requestTimeoutMilliseconds must be a positive safe integer');
  }
  if (!Number.isSafeInteger(retryDelayMilliseconds) || retryDelayMilliseconds < 1) {
    throw new RangeError('retryDelayMilliseconds must be a positive safe integer');
  }

  return Object.freeze({
    /**
     * Starts one request that Archer has already recorded.
     * @param attempt - Saved request plus stable delivery identity.
     * @returns A running request whose result becomes another delivery event.
     */
    async start(attempt: AcknowledgedEffectAttempt<WebhookEffect>) {
      return createLiveOperation<WebhookProgress, CellEffectResult<WebhookEvent>, CellEffectAttemptCloseEvidence>({
        source: 'webhook-delivery',
        epoch: `${attempt.effectId}:${attempt.attempt}`,
        eventEncoding: {
          revision: 'webhook-progress/1',
          normalize(event) {
            return Object.freeze({ ...event });
          },
          measure(event) {
            return new TextEncoder().encode(JSON.stringify(event)).byteLength;
          },
        },
        async start(context) {
          context.emit(Object.freeze({ stage: 'sending' }));
          const body = JSON.stringify({
            id: attempt.effect.id,
            type: attempt.effect.event,
            data: attempt.effect.data,
          });
          const timeoutSignal = createTimeoutSignal(requestTimeoutMilliseconds);
          const signal = AbortSignal.any([context.signal, timeoutSignal]);

          try {
            const response = await request(attempt.effect.url, {
              method: 'POST',
              redirect: 'error',
              signal,
              headers: {
                'content-type': 'application/json',
                'idempotency-key': attempt.effectId,
                'user-agent': 'archer-durable-webhook/1',
                'webhook-event': attempt.effect.event,
                'webhook-id': attempt.effect.id,
                'webhook-signature': signWebhook(body, options.signingSecret),
              },
              body,
            });
            context.emit(Object.freeze({ stage: 'response', status: response.status }));
            await response.body?.cancel();
            const completedAt = now();
            const retryable = !response.ok && isRetryableStatus(response.status);
            return Object.freeze({
              kind: 'event',
              event: Object.freeze({
                type: 'attempt-finished',
                delivered: response.ok,
                status: response.status,
                ...(!response.ok && !retryable ? { error: 'customer endpoint rejected request' } : {}),
                ...(retryable ? { retryAt: retryAt(completedAt, attempt.attempt * retryDelayMilliseconds) } : {}),
              }),
            });
          } catch (error) {
            const completedAt = now();
            const timedOut = isTimeout(error, timeoutSignal);
            return Object.freeze({
              kind: 'event',
              event: Object.freeze({
                type: 'attempt-finished',
                delivered: false,
                error: timedOut
                  ? 'request timed out'
                  : error instanceof Error && error.name === 'AbortError'
                    ? 'request stopped'
                    : 'network request failed',
                retryAt: retryAt(completedAt, attempt.attempt * retryDelayMilliseconds),
              }),
            });
          }
        },
        closeEvidence() {
          return Object.freeze({ kind: 'effect-attempt-closed', effectId: attempt.effectId, attempt: attempt.attempt });
        },
        classifyAbort(settlement) {
          return Object.freeze({
            kind: 'attempt-settled',
            outcome: settlement.kind === 'result' ? 'completed' : 'aborted',
          });
        },
      });
    },
  });
}
