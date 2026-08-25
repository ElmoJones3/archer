/**
 * @file Runs a local customer endpoint for trying the webhook service.
 *
 * It verifies signatures, prints the application event, and rejects the first
 * two attempts so retry and restart recovery are easy to see from two terminals.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/** Options for the local webhook receiver used by the README walkthrough. */
export type ExampleReceiverOptions = Readonly<{
  /** Shared secret also configured on the delivery service. */
  signingSecret: string;

  /** Listening interface, which defaults to loopback. */
  host?: string;

  /** Listening port, which defaults to 4318. */
  port?: number;

  /** Number of valid requests rejected before success, which defaults to two. */
  failFirst?: number;

  /** Receives one plain status line per request and defaults to process stdout. */
  report?: (message: string) => void;
}>;

/** Running local receiver and its cleanup owner. */
export type ExampleReceiver = Readonly<{
  /** URL to use as the submitted webhook destination. */
  url: string;

  /** Stops the local receiver once. */
  close(): Promise<void>;
}>;

/** Compares a received HMAC without leaking matching prefix timing. */
function signatureMatches(body: Buffer, secret: string, received: string | undefined): boolean {
  if (received === undefined) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const candidate = Buffer.from(received);
  return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
}

/** Converts Node's callback-based server close into one Promise. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/**
 * Starts a local receiver that behaves like a temporarily unhealthy customer endpoint.
 * @param options - Shared secret, address, and number of planned failures.
 * @returns The destination URL and one idempotent cleanup function.
 */
export async function startExampleReceiver(options: ExampleReceiverOptions): Promise<ExampleReceiver> {
  if (options.signingSecret.length === 0) throw new RangeError('signingSecret must not be empty');
  const host = options.host ?? '127.0.0.1';
  const failFirst = options.failFirst ?? 2;
  const report = options.report ?? ((message: string) => process.stdout.write(`${message}\n`));
  /** Each delivery gets the same temporary-failure story even after earlier examples succeed. */
  const attemptsByDelivery = new Map<string, number>();

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/customer-webhooks') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const signature = Array.isArray(request.headers['webhook-signature'])
      ? request.headers['webhook-signature'][0]
      : request.headers['webhook-signature'];
    if (!signatureMatches(body, options.signingSecret, signature)) {
      report('Rejected a webhook with an invalid signature.');
      response.writeHead(401).end();
      return;
    }

    const event = JSON.parse(body.toString('utf8')) as { readonly id?: unknown; readonly type?: unknown };
    const deliveryId = typeof event.id === 'string' ? event.id : 'unknown-delivery';
    const attempts = (attemptsByDelivery.get(deliveryId) ?? 0) + 1;
    attemptsByDelivery.set(deliveryId, attempts);
    const status = attempts <= failFirst ? 503 : 204;
    report(
      `Received ${String(event.type)} for delivery ${String(event.id)}. Returning ${status} on attempt ${attempts}.`,
    );
    response.writeHead(status).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4318, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Example receiver did not bind a TCP address');

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    url: `http://${host}:${address.port}/customer-webhooks`,
    close() {
      closePromise ??= closeServer(server);
      return closePromise;
    },
  });
}
