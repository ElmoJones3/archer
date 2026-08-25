/**
 * @file Describes a webhook delivery as state, events, and HTTP work.
 *
 * The rules contain no network or storage code. That lets the same delivery
 * resume after a restart without guessing what happened before the process died.
 */

import {
  JsonValueSchema,
  TimestampSchema,
  fromZod,
  programDecision,
  type JsonValue,
  type Timestamp,
} from '@archer/core';
import { CellIdSchema, defineJsonCellProtocol } from '@archer/core/cells';
import * as z from 'zod';

/** Fields kept for every status so recovery can send the same event again. */
const WebhookIdentitySchema = z.strictObject({
  id: CellIdSchema,
  url: z.url(),
  event: z.string().trim().min(1).max(128),
  data: JsonValueSchema,
});

/** New delivery waiting for its first saved start command. */
const IdleWebhookStateSchema = WebhookIdentitySchema.extend({
  status: z.literal('idle'),
  attempt: z.literal(0),
});

/** Delivery whose current customer request is running. */
const DeliveringWebhookStateSchema = WebhookIdentitySchema.extend({
  status: z.literal('delivering'),
  attempt: z.number().int().min(1).max(3),
});

/** Temporary failure waiting for its next saved retry time. */
const WaitingWebhookStateSchema = WebhookIdentitySchema.extend({
  status: z.literal('waiting'),
  attempt: z.number().int().min(1).max(2),
  nextAttemptAt: TimestampSchema,
  lastStatus: z.number().int().min(100).max(599).optional(),
  lastError: z.string().min(1).max(256).optional(),
});

/** Delivery accepted by the customer's endpoint. */
const DeliveredWebhookStateSchema = WebhookIdentitySchema.extend({
  status: z.literal('delivered'),
  attempt: z.number().int().min(1).max(3),
  lastStatus: z.number().int().min(100).max(599).optional(),
});

/** Permanent failure or retry policy exhaustion. */
const FailedWebhookStateSchema = WebhookIdentitySchema.extend({
  status: z.literal('failed'),
  attempt: z.number().int().min(1).max(3),
  lastStatus: z.number().int().min(100).max(599).optional(),
  lastError: z.string().min(1).max(256).optional(),
});

/** Complete saved status accepted from S3 or returned by the application. */
export const WebhookStateSchema = z
  .discriminatedUnion('status', [
    IdleWebhookStateSchema,
    DeliveringWebhookStateSchema,
    WaitingWebhookStateSchema,
    DeliveredWebhookStateSchema,
    FailedWebhookStateSchema,
  ])
  .transform((value) => Object.freeze(value))
  .readonly();

/** Commands and HTTP outcomes allowed to change a delivery. */
const WebhookEventSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('start') }),
    z.strictObject({ type: z.literal('retry-due'), at: TimestampSchema }),
    z.strictObject({
      type: z.literal('attempt-finished'),
      delivered: z.boolean(),
      status: z.number().int().min(100).max(599).optional(),
      error: z.string().min(1).max(256).optional(),
      retryAt: TimestampSchema.optional(),
    }),
  ])
  .transform((value) => Object.freeze(value))
  .readonly();

/** Customer request saved before a worker is allowed to send it. */
const WebhookEffectSchema = z
  .strictObject({
    type: z.literal('post-json'),
    id: CellIdSchema,
    url: z.url(),
    event: z.string().trim().min(1).max(128),
    data: JsonValueSchema,
  })
  .transform((value) => Object.freeze(value))
  .readonly();

/** Current delivery status returned by the HTTP API and its live update stream. */
export type WebhookState = z.output<typeof WebhookStateSchema>;

/** User commands, retry alarms, and HTTP results understood by the delivery rules. */
export type WebhookEvent = z.output<typeof WebhookEventSchema>;

/** One outbound request that Archer may resume after a process restart. */
export type WebhookEffect = z.output<typeof WebhookEffectSchema>;

/**
 * Creates the first status for a new customer webhook.
 * @param id - Public delivery ID returned to the caller.
 * @param url - Customer endpoint that receives the event.
 * @param event - Application event name, such as `invoice.paid`.
 * @param data - JSON data sent to the customer.
 * @returns A new delivery that has not started its first request.
 */
export function initialWebhookState(
  id: import('@archer/core/cells').CellId,
  url: string,
  event: string,
  data: JsonValue,
): WebhookState {
  return WebhookStateSchema.parse({ id, url, event, data, status: 'idle', attempt: 0 });
}

/** Delivery rules and JSON formats shared by new work and restart recovery. */
export const WEBHOOK_PROTOCOL = defineJsonCellProtocol({
  revision: 'durable-webhook/1',
  durability: 'node-independent',
  program: Object.freeze({
    /**
     * Moves a delivery to its next status and requests an HTTP call when needed.
     * @param state - Last saved delivery status.
     * @param event - New command, alarm, or HTTP result.
     * @returns The next status and any outbound request it requires.
     */
    reduce(state: Readonly<WebhookState>, event: Readonly<WebhookEvent>) {
      if (event.type === 'start') {
        if (state.status !== 'idle') throw new Error('Webhook delivery can start only from idle state');
        const next = WebhookStateSchema.parse({ ...state, status: 'delivering', attempt: 1 });
        return programDecision<WebhookState, WebhookEffect>(next, [
          WebhookEffectSchema.parse({
            type: 'post-json',
            id: state.id,
            url: state.url,
            event: state.event,
            data: state.data,
          }),
        ]);
      }

      if (event.type === 'retry-due') {
        if (state.status !== 'waiting' || state.nextAttemptAt !== event.at) {
          throw new Error('Webhook retry wake does not match saved delivery state');
        }
        const next = WebhookStateSchema.parse({
          id: state.id,
          url: state.url,
          event: state.event,
          data: state.data,
          status: 'delivering',
          attempt: state.attempt + 1,
        });
        return programDecision<WebhookState, WebhookEffect>(next, [
          WebhookEffectSchema.parse({
            type: 'post-json',
            id: state.id,
            url: state.url,
            event: state.event,
            data: state.data,
          }),
        ]);
      }

      if (state.status !== 'delivering') throw new Error('Webhook result requires an active delivery attempt');

      if (event.delivered) {
        return programDecision<WebhookState, WebhookEffect>(
          WebhookStateSchema.parse({
            id: state.id,
            url: state.url,
            event: state.event,
            data: state.data,
            status: 'delivered',
            attempt: state.attempt,
            ...(event.status === undefined ? {} : { lastStatus: event.status }),
          }),
        );
      }

      const exhausted = state.attempt >= 3;
      const willRetry = !exhausted && event.retryAt !== undefined;
      return programDecision<WebhookState, WebhookEffect>(
        WebhookStateSchema.parse({
          id: state.id,
          url: state.url,
          event: state.event,
          data: state.data,
          status: willRetry ? 'waiting' : 'failed',
          attempt: state.attempt,
          ...(event.status === undefined ? {} : { lastStatus: event.status }),
          ...(event.error === undefined ? {} : { lastError: event.error }),
          ...(willRetry ? { nextAttemptAt: event.retryAt } : {}),
        }),
      );
    },
  }),
  codecs: Object.freeze({
    state: fromZod(WebhookStateSchema),
    event: fromZod(WebhookEventSchema),
    effect: fromZod(WebhookEffectSchema),
  }),
  /**
   * Turns a saved retry deadline into work that another process can resume.
   * @param state - Last saved delivery status.
   * @returns The next retry alarm, or no alarm for all other statuses.
   */
  projectWake(state: Readonly<WebhookState>) {
    return state.status === 'waiting'
      ? Object.freeze({
          at: state.nextAttemptAt,
          event: WebhookEventSchema.parse({ type: 'retry-due', at: state.nextAttemptAt }),
        })
      : undefined;
  },
});

/**
 * Calculates the next short demo retry from a completed HTTP attempt.
 * @param at - Time the attempt finished.
 * @param milliseconds - Delay selected by the delivery policy.
 * @returns The next retry time in Archer's portable timestamp format.
 */
export function retryAt(at: Date, milliseconds: number): Timestamp {
  return TimestampSchema.parse(new Date(at.getTime() + milliseconds).toISOString());
}
