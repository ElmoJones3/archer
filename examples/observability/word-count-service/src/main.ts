/** @file Runs the HTTP service with Pino logs and OpenTelemetry console export. */

import { ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';

import { startObservedWordCountApplication } from './application.js';

/** Optional environment configuration keeps the default local while supporting deployment. */
const configuredPort = process.env.PORT;
/** Parsed port remains explicit before it reaches the service boundary. */
const port = configuredPort === undefined ? 3000 : Number(configuredPort);

/** Listening begins only after both observability destinations are attached. */
const application = await startObservedWordCountApplication({
  spanExporter: new ConsoleSpanExporter(),
  metricExporter: new ConsoleMetricExporter(),
  metricExportIntervalMillis: 10_000,
  port,
});
process.stdout.write(`Word count service listening at ${new URL('/count', application.url)}\n`);
process.stdout.write(
  `curl -X POST ${new URL('/count', application.url)} -H 'content-type: application/json' -d '{"text":"count these words"}'\n`,
);

/** Process signals initiate orderly HTTP, diagnostic, and provider shutdown. */
await new Promise<void>((resolveStop) => {
  process.once('SIGINT', resolveStop);
  process.once('SIGTERM', resolveStop);
});
await application.close();
