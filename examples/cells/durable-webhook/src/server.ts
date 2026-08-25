/**
 * @file Exposes webhook submission, status, and live status updates over HTTP.
 *
 * The routes contain ordinary Node HTTP code. They depend on the delivery
 * service rather than Cell handles, grants, or RxJS.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { JsonObjectSchema, type JsonObject } from '@archer/core';
import * as z from 'zod';

import { MAX_REQUEST_BYTES, SubmissionSchema, WEBHOOK_OPENAPI, WebhookStatusSchema } from './api.js';
import type { WebhookDeliveryService, WebhookStatusWatch } from './application.js';
import { serveApiDocumentation } from './documentation.js';
import type { WebhookState } from './domain.js';

/** Frozen JSON-safe form of the generated OpenAPI document served to clients. */
const OPENAPI_RESPONSE = JsonObjectSchema.parse(WEBHOOK_OPENAPI);

/** Configuration for the example's customer-facing HTTP server. */
export type WebhookServerOptions = Readonly<{
  /** Delivery service borrowed until HTTP shutdown. */
  service: WebhookDeliveryService;

  /** Listening interface, which defaults to loopback for local safety. */
  host?: string;

  /** Listening port, which defaults to 4317 and may be zero in tests. */
  port?: number;
}>;

/** Running HTTP server and the cleanup function that owns it. */
export type WebhookServer = Readonly<{
  /** Actual origin after the server chooses its port. */
  origin: string;

  /** Stops HTTP admission and closes the delivery service. */
  close(): Promise<void>;
}>;

/**
 * Writes one JSON response.
 * @param response - Current Node response.
 * @param status - HTTP response status.
 * @param body - JSON object sent to the caller.
 * @param headers - Optional response headers such as `Location`.
 */
function json(response: ServerResponse, status: number, body: JsonObject, headers: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.byteLength),
    ...headers,
  });
  response.end(bytes);
}

/**
 * Reads one request without allowing an unbounded body into memory.
 * @param request - Incoming Node request stream.
 * @returns Parsed JSON input for schema admission.
 */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new RangeError('request body exceeds 64 KiB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Sends one delivery status using the Server-Sent Events wire format.
 * @param response - Open status-stream response.
 * @param state - Latest saved delivery status.
 */
function sendStatus(response: ServerResponse, state: WebhookState): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: status\ndata: ${JSON.stringify(state)}\n\n`);
}

/** Returns whether a delivery will never publish another status. */
function isFinished(state: WebhookState): boolean {
  return state.status === 'delivered' || state.status === 'failed';
}

/**
 * Opens a callback-based live status stream without exposing a framework-specific stream type.
 * @param service - Delivery application that owns current handles.
 * @param id - Public delivery ID from the route.
 * @param response - HTTP response retained until completion or caller disconnect.
 */
async function streamStatus(service: WebhookDeliveryService, id: string, response: ServerResponse): Promise<void> {
  const first = await service.status(id);
  if (first === undefined) {
    json(response, 404, { error: 'delivery not found' });
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  response.flushHeaders();

  let watching = false;
  let finished = false;
  let closeWatch: () => Promise<void> = async () => undefined;
  const finish = () => {
    void closeWatch().finally(() => {
      if (!response.writableEnded) response.end();
    });
  };
  const watch: WebhookStatusWatch | undefined = await service.watch(id, (state) => {
    sendStatus(response, state);
    if (isFinished(state)) {
      finished = true;
      if (watching) queueMicrotask(finish);
    }
  });

  if (watch === undefined) {
    // The delivery disappeared between the finite read and watch setup.
    sendStatus(response, (await service.status(id)) ?? first);
    response.end();
    return;
  }
  closeWatch = async () => {
    await watch.close();
  };
  watching = true;
  if (finished) {
    await watch.close();
    response.end();
    return;
  }
  response.once('close', () => void closeWatch());
}

/** Converts Node's callback-based server close into one Promise. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/**
 * Starts the webhook API after the application has had a chance to recover work.
 * @param options - Delivery service and optional listening address.
 * @returns The reachable origin and one idempotent cleanup owner.
 */
export async function startWebhookServer(options: WebhookServerOptions): Promise<WebhookServer> {
  const host = options.host ?? '127.0.0.1';
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/openapi.json') {
        json(response, 200, OPENAPI_RESPONSE);
        return;
      }
      if (request.method === 'GET' && (await serveApiDocumentation(url.pathname, response))) return;

      if (request.method === 'POST' && url.pathname === '/deliveries') {
        // A 202 means the event and first delivery attempt are saved before the caller receives its ID.
        const input = SubmissionSchema.parse(await readBody(request));
        const submitted = await options.service.submit(input);
        json(
          response,
          202,
          { id: submitted.id, status: submitted.status },
          {
            location: `/deliveries/${submitted.id}`,
            link: `</deliveries/${submitted.id}/events>; rel="monitor"`,
          },
        );
        return;
      }

      const eventsMatch = /^\/deliveries\/([^/]+)\/events$/u.exec(url.pathname);
      if (request.method === 'GET' && eventsMatch !== null) {
        // Each client receives current saved status first, then later saved changes until completion.
        await streamStatus(options.service, eventsMatch[1]!, response);
        return;
      }

      const statusMatch = /^\/deliveries\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && statusMatch !== null) {
        // Finite status reads never start delivery work or keep a connection open.
        const state = await options.service.status(statusMatch[1]!);
        if (state === undefined) json(response, 404, { error: 'delivery not found' });
        else json(response, 200, JsonObjectSchema.parse(WebhookStatusSchema.parse(state)));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        // Health proves only that this HTTP process can answer; it does not probe S3 or customers.
        json(response, 200, { status: 'ok' });
        return;
      }
      json(response, 404, { error: 'route not found' });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      json(
        response,
        error instanceof RangeError || error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 500,
        { error: error instanceof RangeError ? error.message : 'request failed' },
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Webhook server did not bind a TCP address');

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    origin: `http://${host}:${address.port}`,
    close() {
      closePromise ??= (async () => {
        const httpClosed = closeServer(server);
        server.closeAllConnections();
        await Promise.all([httpClosed, options.service.close()]);
      })();
      return closePromise;
    },
  });
}
