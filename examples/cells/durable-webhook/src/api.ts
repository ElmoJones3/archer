/**
 * @file Generates the webhook service's OpenAPI contract from its Zod schemas.
 *
 * The same submission schema admits live HTTP requests, so the runnable API and
 * its documentation cannot quietly disagree about the accepted body.
 */

import { JsonObjectSchema } from '@archer/core';
import * as z from 'zod';
import { createDocument } from 'zod-openapi';

/** Maximum JSON request size enforced by the HTTP reader. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** Customer event accepted by the delivery API. */
export const SubmissionSchema = z
  .strictObject({
    url: z.url().meta({ description: 'Customer HTTPS or HTTP endpoint that receives the event.' }),
    event: z.string().trim().min(1).max(128).meta({ description: 'Application event name, such as invoice.paid.' }),
    data: JsonObjectSchema.meta({ description: 'JSON object sent under the webhook data field.' }),
  })
  .meta({ id: 'WebhookSubmission' });

/** Delivery identity admitted from status and event-stream paths. */
const DeliveryIdSchema = z.uuidv4().meta({
  description: 'Delivery ID returned by POST /deliveries.',
  example: '7a111111-1111-4111-8111-111111111111',
});

/** Small response returned after durable submission. */
const SubmittedWebhookSchema = z
  .strictObject({
    id: DeliveryIdSchema,
    status: z.enum(['idle', 'delivering', 'waiting', 'delivered', 'failed']),
  })
  .meta({ id: 'SubmittedWebhook' });

/** Fields returned for every saved delivery status. */
const WebhookStatusIdentitySchema = z.strictObject({
  id: DeliveryIdSchema,
  url: z.url(),
  event: z.string().min(1).max(128),
  data: z.json(),
});

/** Public response schema checked again when finite status leaves the service. */
export const WebhookStatusSchema = z
  .discriminatedUnion('status', [
    WebhookStatusIdentitySchema.extend({ status: z.literal('idle'), attempt: z.literal(0) }),
    WebhookStatusIdentitySchema.extend({
      status: z.literal('delivering'),
      attempt: z.number().int().min(1).max(3),
    }),
    WebhookStatusIdentitySchema.extend({
      status: z.literal('waiting'),
      attempt: z.number().int().min(1).max(2),
      nextAttemptAt: z.iso.datetime(),
      lastStatus: z.number().int().min(100).max(599).optional(),
      lastError: z.string().min(1).max(256).optional(),
    }),
    WebhookStatusIdentitySchema.extend({
      status: z.literal('delivered'),
      attempt: z.number().int().min(1).max(3),
      lastStatus: z.number().int().min(100).max(599).optional(),
    }),
    WebhookStatusIdentitySchema.extend({
      status: z.literal('failed'),
      attempt: z.number().int().min(1).max(3),
      lastStatus: z.number().int().min(100).max(599).optional(),
      lastError: z.string().min(1).max(256).optional(),
    }),
  ])
  .meta({ id: 'WebhookStatus' });

/** Stable JSON shape used for all documented HTTP failures. */
const ErrorResponseSchema = z
  .strictObject({ error: z.string().meta({ description: 'Safe explanation for the caller.' }) })
  .meta({ id: 'ErrorResponse' });

/** Plain health response used by local and deployment probes. */
const HealthResponseSchema = z.strictObject({ status: z.literal('ok') }).meta({ id: 'HealthResponse' });

/**
 * Generated OpenAPI description served by the running example.
 *
 * Route prose is intentionally about customer webhook work. Cell mechanics
 * remain an implementation choice and do not belong in the caller contract.
 */
export const WEBHOOK_OPENAPI = createDocument({
  openapi: '3.1.1',
  info: {
    title: 'Durable customer webhook API',
    version: '1.0.0',
    description:
      'Accepts customer events, delivers signed webhooks, and exposes saved status plus live updates. ' +
      'A 202 response means the event is saved and can resume after this process restarts.',
  },
  paths: {
    '/deliveries': {
      post: {
        operationId: 'submitWebhookDelivery',
        summary: 'Save and start a customer webhook',
        description:
          'Saves the event before starting its first outbound request. Retrying this HTTP call creates another ' +
          'delivery; callers should retain the returned delivery ID and monitor its status.',
        tags: ['Deliveries'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: SubmissionSchema } },
        },
        responses: {
          202: {
            description: 'The delivery was saved and its first request started.',
            headers: z.object({
              location: z.string().meta({ header: { description: 'Status resource for this delivery.' } }),
              link: z.string().meta({ header: { description: 'Live status stream with rel="monitor".' } }),
            }),
            content: { 'application/json': { schema: SubmittedWebhookSchema } },
          },
          400: {
            description: `The JSON body is invalid or exceeds ${MAX_REQUEST_BYTES / 1024} KiB.`,
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
          500: {
            description: 'The event could not be saved or its first request could not start.',
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
        },
      },
    },
    '/deliveries/{deliveryId}': {
      get: {
        operationId: 'getWebhookDelivery',
        summary: 'Read the latest saved delivery status',
        description: 'Returns finite saved state and does not start or resume delivery work.',
        tags: ['Deliveries'],
        requestParams: { path: z.object({ deliveryId: DeliveryIdSchema }) },
        responses: {
          200: {
            description: 'Latest saved status for the delivery.',
            content: { 'application/json': { schema: WebhookStatusSchema } },
          },
          400: {
            description: 'The delivery ID is not a UUIDv4.',
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
          404: {
            description: 'No delivery exists with this ID.',
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
          500: {
            description: 'Saved status is temporarily unavailable.',
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
        },
      },
    },
    '/deliveries/{deliveryId}/events': {
      get: {
        operationId: 'watchWebhookDelivery',
        summary: 'Watch a delivery until it finishes',
        description:
          'Streams the current saved status immediately and later saved changes as Server-Sent Events. ' +
          'The stream ends after delivered or failed. A process that does not own the delivery checks saved ' +
          'status once per second, so horizontally scaled deployments should route by delivery owner or replace ' +
          'that fallback with their shared notification transport at high volume.',
        tags: ['Deliveries'],
        requestParams: { path: z.object({ deliveryId: DeliveryIdSchema }) },
        responses: {
          200: {
            description: 'A text/event-stream whose status events each contain one JSON delivery state.',
            content: {
              'text/event-stream': {
                schema: z.string().meta({ example: 'event: status\ndata: {"status":"delivering"}\n\n' }),
              },
            },
          },
          400: {
            description: 'The delivery ID is not a UUIDv4.',
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
          404: {
            description: 'No delivery exists with this ID.',
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
          500: {
            description: 'The stream could not read or attach to saved status.',
            content: { 'application/json': { schema: ErrorResponseSchema } },
          },
        },
      },
    },
    '/health': {
      get: {
        operationId: 'getWebhookServiceHealth',
        summary: 'Check whether the HTTP process is accepting requests',
        description: 'Confirms only HTTP-process availability; it does not probe S3 or customer endpoints.',
        tags: ['Service'],
        responses: {
          200: {
            description: 'The HTTP process is running.',
            content: { 'application/json': { schema: HealthResponseSchema } },
          },
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getWebhookOpenApi',
        summary: 'Download the generated OpenAPI contract',
        tags: ['Documentation'],
        responses: {
          200: {
            description: 'OpenAPI 3.1 document generated from the service schemas.',
            content: { 'application/json': { schema: z.json() } },
          },
        },
      },
    },
    '/docs': {
      get: {
        operationId: 'getWebhookApiDocumentation',
        summary: 'Explore the webhook API in Swagger UI',
        tags: ['Documentation'],
        responses: {
          200: {
            description: 'Interactive HTML documentation backed by /openapi.json.',
            content: { 'text/html': { schema: z.string() } },
          },
        },
      },
    },
  },
});
