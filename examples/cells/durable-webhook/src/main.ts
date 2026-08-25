/**
 * @file Starts either the webhook delivery API or its local customer endpoint.
 *
 * Run `receiver` in one terminal and `service` in another. Both use the same
 * signing secret, while only the service needs AWS credentials and an S3 bucket.
 */

import { CellHostIdSchema } from '@archer/core/cells';
import { s3Cells } from '@archer/core/cells/s3';

import { WebhookDeliveryService } from './application.js';
import { startExampleReceiver } from './receiver.js';
import { startWebhookServer } from './server.js';

const signingSecret = requiredEnvironment(
  'ARCHER_WEBHOOK_SIGNING_SECRET',
  'Set ARCHER_WEBHOOK_SIGNING_SECRET to a shared local or production secret',
);

const mode = process.argv.slice(2).find((argument) => argument !== '--') ?? 'service';
if (mode !== 'service' && mode !== 'receiver') throw new Error('Choose either service or receiver');

/** Starts the local endpoint that verifies signatures and makes retries visible. */
async function runReceiver(): Promise<void> {
  const receiver = await startExampleReceiver({ signingSecret });
  process.stdout.write(`Customer webhook endpoint listening at ${receiver.url}\n`);
  installShutdown(() => receiver.close());
}

/** Starts S3-backed delivery, recovery, status reads, and live status streams. */
async function runService(): Promise<void> {
  const bucket = requiredEnvironment('ARCHER_WEBHOOK_BUCKET', 'Set ARCHER_WEBHOOK_BUCKET to an existing S3 bucket');

  const hostId = CellHostIdSchema.parse(process.env.ARCHER_CELL_HOST_ID ?? '7a111111-1111-4111-8111-111111111111');
  const endpoint = process.env.ARCHER_S3_ENDPOINT;
  const region = process.env.AWS_REGION;
  const forcePathStyle = process.env.ARCHER_S3_FORCE_PATH_STYLE === 'true';
  const cells = await s3Cells({
    hostId,
    bucket,
    prefix: process.env.ARCHER_WEBHOOK_PREFIX ?? 'archer-durable-webhooks',
    stateLimitBytes: 256 * 1024,
    maxHeadsPerScan: 100,
    transport: {
      type: 'managed',
      config: {
        ...(region === undefined ? {} : { region }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(forcePathStyle ? { forcePathStyle: true } : {}),
      },
    },
  });
  const service = new WebhookDeliveryService({ cells, signingSecret });
  const recovered = await service.recover();
  const server = await startWebhookServer({ service });
  process.stdout.write(`Webhook API listening at ${server.origin}. Resumed ${recovered} unfinished deliveries.\n`);

  const recoveryTimer = setInterval(() => {
    void service
      .recover()
      .then((count) => {
        if (count > 0) process.stdout.write(`Resumed ${count} unfinished deliveries.\n`);
      })
      .catch((error: unknown) => {
        process.stderr.write(`Recovery scan failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`);
      });
  }, 5_000);

  installShutdown(async () => {
    clearInterval(recoveryTimer);
    await server.close();
  });
}

/**
 * Reads one required environment variable without spreading nullable checks through startup.
 * @param name - Environment variable selected by the executable mode.
 * @param message - Actionable setup error shown to the developer.
 * @returns The non-empty configured value.
 */
function requiredEnvironment(name: string, message: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(message);
  return value;
}

/**
 * Installs one shared shutdown for the two standard process signals.
 * @param close - Cleanup for the selected executable mode.
 */
function installShutdown(close: () => Promise<unknown>): void {
  let shutdown: Promise<unknown> | undefined;
  const stop = () => {
    shutdown ??= close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (mode === 'receiver') await runReceiver();
else await runService();
