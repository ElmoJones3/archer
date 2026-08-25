/** @file Proves the runnable service exchanges signed HTTP requests and streams saved status changes. */

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

import type { S3Client } from '@aws-sdk/client-s3';
import { TimestampSchema } from '@archer/core';
import { CellHostIdSchema, CellIdSchema } from '@archer/core/cells';
import { s3Cells, type S3CellService } from '@archer/core/cells/s3';
import { afterEach, describe, expect, it } from 'vitest';

import { WebhookDeliveryService } from '../src/application.js';
import type { WebhookState } from '../src/domain.js';
import { startExampleReceiver } from '../src/receiver.js';
import { startWebhookServer } from '../src/server.js';

type StoredObject = Readonly<{
  bytes: Uint8Array;

  etag: string;
}>;

type TestS3Command = Readonly<{
  constructor: Readonly<{
    name: string;
  }>;

  input: Record<string, unknown>;
}>;

type TestS3ServiceError = Error & {
  name: string;

  $metadata: {
    httpStatusCode: number;
  };
};

type ReceivedDelivery = Readonly<{
  body: unknown;

  key: string | undefined;

  event: string | undefined;

  signature: string | undefined;
}>;

type AcceptedSubmission = Readonly<{
  id: string;

  status: string;
}>;

class TestS3Client {
  readonly #objects = new Map<string, StoredObject>();

  #revision = 0;

  async send(command: TestS3Command): Promise<unknown> {
    const bucket = String(command.input.Bucket);
    const key = `${bucket}/${String(command.input.Key ?? '')}`;
    if (command.constructor.name === 'PutObjectCommand') {
      const current = this.#objects.get(key);
      if (command.input.IfNoneMatch === '*' && current !== undefined) throw this.#conflict();
      if (command.input.IfMatch !== undefined && command.input.IfMatch !== current?.etag) throw this.#conflict();
      const etag = `"${++this.#revision}"`;
      this.#objects.set(key, Object.freeze({ bytes: Uint8Array.from(command.input.Body as Uint8Array), etag }));
      return Object.freeze({ ETag: etag });
    }
    if (command.constructor.name === 'GetObjectCommand') {
      const current = this.#objects.get(key);
      if (current === undefined) {
        const error = new Error('missing') as TestS3ServiceError;
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return Object.freeze({
        ETag: current.etag,
        Body: Object.freeze({
          async transformToByteArray() {
            return Uint8Array.from(current.bytes);
          },
        }),
      });
    }
    if (command.constructor.name === 'ListObjectsV2Command') {
      const prefix = `${bucket}/${String(command.input.Prefix ?? '')}`;
      return Object.freeze({
        Contents: Object.freeze(
          [...this.#objects.keys()]
            .filter((candidate) => candidate.startsWith(prefix))
            .map((candidate) => Object.freeze({ Key: candidate.slice(bucket.length + 1) })),
        ),
      });
    }
    throw new Error(`Unexpected SDK command ${command.constructor.name}`);
  }

  destroy(): void {
    // The application transfers borrowed ownership, so this method must remain unused.
  }

  #conflict(): Error {
    const error = new Error('conflict') as TestS3ServiceError;
    error.name = 'PreconditionFailed';
    error.$metadata = { httpStatusCode: 412 };
    return error;
  }
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('durable webhook service', () => {
  it('runs a real customer endpoint that verifies the configured signature', async () => {
    const secret = 'test-signing-secret';
    const receiver = await startExampleReceiver({
      signingSecret: secret,
      port: 0,
      failFirst: 0,
      report: () => undefined,
    });
    cleanup.push(() => receiver.close());
    const body = JSON.stringify({ id: 'delivery-42', type: 'invoice.paid', data: { amount: 4200 } });
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    const response = await fetch(receiver.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-signature': signature },
      body,
    });

    expect(response.status).toBe(204);
  });

  it('tracks planned receiver failures separately for each delivery', async () => {
    const secret = 'test-signing-secret';
    const receiver = await startExampleReceiver({
      signingSecret: secret,
      port: 0,
      failFirst: 2,
      report: () => undefined,
    });
    cleanup.push(() => receiver.close());

    /** Sends the same signed application event under a selected delivery identity. */
    const send = async (id: string) => {
      const body = JSON.stringify({ id, type: 'invoice.paid', data: { amount: 4200 } });
      return fetch(receiver.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        body,
      });
    };

    expect((await send('delivery-one')).status).toBe(503);
    expect((await send('delivery-one')).status).toBe(503);
    expect((await send('delivery-one')).status).toBe(204);
    expect((await send('delivery-two')).status).toBe(503);
  });

  it('bounds one recovery pass to one S3 discovery page', async () => {
    const hostId = CellHostIdSchema.parse('7a222222-2222-4222-8222-222222222223');
    let discoveryCalls = 0;
    let releaseDiscovery: () => void = () => undefined;
    const discoveryAllowed = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const cells = {
      async discoverRecoverable() {
        discoveryCalls += 1;
        await discoveryAllowed;
        if (discoveryCalls > 1) throw new Error('recovery pass crossed its page bound');
        return Object.freeze({ kind: 'found' as const, cellIds: Object.freeze([]), cursor: 'next-page' });
      },
      async close() {
        return Object.freeze({ kind: 'cell-host-closed' as const, hostId });
      },
    } as unknown as S3CellService;
    const service = new WebhookDeliveryService({ cells, signingSecret: 'test-signing-secret' });

    const first = service.recover();
    const overlapping = service.recover();
    releaseDiscovery();

    expect(await Promise.all([first, overlapping])).toEqual([0, 0]);
    expect(discoveryCalls).toBe(1);

    await service.close();
  });

  it('keeps live status useful when another process owns the delivery', async () => {
    const id = CellIdSchema.parse('7a555555-5555-4555-8555-555555555555');
    let state: WebhookState = Object.freeze({
      id,
      url: 'https://customer.example.test/webhooks',
      event: 'invoice.paid',
      data: Object.freeze({ invoiceId: 'invoice-42' }),
      status: 'waiting' as const,
      attempt: 1,
      nextAttemptAt: TimestampSchema.parse('2026-08-24T12:00:10.000Z'),
      lastStatus: 503,
    });
    const scheduled: (() => void)[] = [];
    const cells = {
      async readState() {
        return Object.freeze({ kind: 'found' as const, sequence: '1', state });
      },
      async close() {
        return Object.freeze({
          kind: 'cell-service-closed' as const,
          host: { kind: 'cell-host-closed' as const },
          authority: { kind: 'authority-broker-closed' as const },
        });
      },
    } as unknown as S3CellService;
    const service = new WebhookDeliveryService({
      cells,
      signingSecret: 'test-signing-secret',
      scheduleStatusRead: (_delay, task) => {
        scheduled.push(task);
        return () => undefined;
      },
    });
    const updates: string[] = [];

    const watch = await service.watch(id, (current) => updates.push(current.status));
    expect(watch).toBeDefined();
    if (watch === undefined) throw new Error('Expected a remote status watcher');
    expect(updates).toEqual(['waiting']);

    state = Object.freeze({
      id,
      url: 'https://customer.example.test/webhooks',
      event: 'invoice.paid',
      data: Object.freeze({ invoiceId: 'invoice-42' }),
      status: 'delivered' as const,
      attempt: 2,
      lastStatus: 204,
    });
    scheduled.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(updates).toEqual(['waiting', 'delivered']);
    await watch.close();
    await service.close();
  });

  it('accepts a real HTTP submission and performs the acknowledged webhook POST', async () => {
    let resolveDelivery: ((value: ReceivedDelivery) => void) | undefined;
    let releaseResponse: () => void = () => undefined;
    const responseAllowed = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const delivered = new Promise<ReceivedDelivery>((resolve) => {
      resolveDelivery = resolve;
    });
    const destination = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      resolveDelivery?.({
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        key: Array.isArray(request.headers['idempotency-key'])
          ? request.headers['idempotency-key'][0]
          : request.headers['idempotency-key'],
        event: Array.isArray(request.headers['webhook-event'])
          ? request.headers['webhook-event'][0]
          : request.headers['webhook-event'],
        signature: Array.isArray(request.headers['webhook-signature'])
          ? request.headers['webhook-signature'][0]
          : request.headers['webhook-signature'],
      });
      await responseAllowed;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      destination.once('error', rejectListen);
      destination.listen(0, '127.0.0.1', () => {
        destination.off('error', rejectListen);
        resolveListen();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolveClose, rejectClose) =>
          destination.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
        ),
    );
    const address = destination.address();
    if (address === null || typeof address === 'string') throw new Error('Destination did not bind');

    const hostId = CellHostIdSchema.parse('7a222222-2222-4222-8222-222222222222');
    const cells = await s3Cells({
      hostId,
      bucket: 'application-test',
      prefix: 'deliveries',
      stateLimitBytes: 256 * 1024,
      maxHeadsPerScan: 10,
      transport: {
        type: 'client',
        client: { ownership: 'borrowed', value: new TestS3Client() as unknown as S3Client },
      },
    });
    const service = new WebhookDeliveryService({ cells, signingSecret: 'test-signing-secret' });
    const server = await startWebhookServer({ service, port: 0 });
    cleanup.push(() => server.close());

    const specificationResponse = await fetch(`${server.origin}/openapi.json`);
    const specification = (await specificationResponse.json()) as {
      paths?: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(specificationResponse.status).toBe(200);
    expect(specification.paths?.['/deliveries']?.post?.operationId).toBe('submitWebhookDelivery');
    expect(specification.paths?.['/deliveries/{deliveryId}/events']?.get?.operationId).toBe('watchWebhookDelivery');

    const documentationResponse = await fetch(`${server.origin}/docs`);
    expect(documentationResponse.status).toBe(200);
    expect(documentationResponse.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(await documentationResponse.text()).toContain('SwaggerUIBundle');
    const [swaggerStyles, swaggerBundle] = await Promise.all([
      fetch(`${server.origin}/docs/swagger-ui.css`),
      fetch(`${server.origin}/docs/swagger-ui-bundle.js`),
    ]);
    expect(swaggerStyles.status).toBe(200);
    expect(swaggerStyles.headers.get('content-type')).toContain('text/css');
    expect(swaggerBundle.status).toBe(200);
    expect(swaggerBundle.headers.get('content-type')).toContain('text/javascript');

    const submission = await fetch(`${server.origin}/deliveries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `http://127.0.0.1:${address.port}/orders`,
        event: 'invoice.paid',
        data: { invoiceId: 'invoice-42', amount: 4200 },
      }),
    });
    expect(submission.status).toBe(202);
    const accepted = (await submission.json()) as AcceptedSubmission;
    const live = await fetch(`${server.origin}/deliveries/${accepted.id}/events`);
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    releaseResponse();
    const [received, updates] = await Promise.all([delivered, live.text()]);

    expect(received.body).toEqual({
      id: accepted.id,
      type: 'invoice.paid',
      data: { invoiceId: 'invoice-42', amount: 4200 },
    });
    expect(received.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(received.event).toBe('invoice.paid');
    expect(received.signature).toMatch(/^sha256=[0-9a-f]{64}$/u);
    expect(updates).toContain('"status":"delivering"');
    expect(updates).toContain('"status":"delivered"');
    let status = await service.status(accepted.id);
    for (let attempts = 0; attempts < 40 && status?.status !== 'delivered'; attempts += 1) {
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      status = await service.status(accepted.id);
    }
    expect(status).toMatchObject({ status: 'delivered', attempt: 1, lastStatus: 204 });
  });
});
