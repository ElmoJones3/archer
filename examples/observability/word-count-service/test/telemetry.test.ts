/** @file Proves SDK provider failure still settles one retained telemetry lifecycle. */

import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { TelemetryLifecycle } from '../src/telemetry.js';

describe('TelemetryLifecycle', () => {
  it.each([
    { name: 'one provider', failTracer: true, failMeter: false },
    { name: 'both providers', failTracer: true, failMeter: true },
  ])(
    'settles bounded failed evidence when $name rejects shutdown',
    async ({ failTracer, failMeter }) => {
      /** Real SDK providers preserve the production lifecycle surface under a controlled rejection. */
      const tracerProvider = new BasicTracerProvider();
      /** The metric provider is independently fail-able so Promise aggregation cannot hide the second branch. */
      const meterProvider = new MeterProvider();
      if (failTracer)
        vi.spyOn(tracerProvider, 'shutdown').mockRejectedValue(new Error('private trace exporter failure'));
      if (failMeter)
        vi.spyOn(meterProvider, 'shutdown').mockRejectedValue(new Error('private metric exporter failure'));
      /** The application lifecycle must retain one settlement no matter how many callers close it. */
      const lifecycle = new TelemetryLifecycle(tracerProvider, meterProvider);
      /** Both references must be the same pending or settled lifecycle promise. */
      const firstClose = lifecycle.close();
      expect(lifecycle.close()).toBe(firstClose);
      await expect(firstClose).resolves.toEqual({
        kind: 'failed',
        failure: {
          kind: 'protocol-failure',
          code: 'opentelemetry_provider_shutdown_failed',
          message: 'OpenTelemetry providers failed to shut down',
          retryable: false,
        },
      });
      expect(await lifecycle.closed).toBe(await firstClose);
    },
    250,
  );
});
