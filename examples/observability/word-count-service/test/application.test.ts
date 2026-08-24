/** @file Proves the runnable HTTP application reaches both real diagnostic adapters. */

import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import { startObservedWordCountApplication } from '../src/application.js';

/** Real in-memory exporter that snapshots dependency-owned test data before SDK shutdown resets it. */
class InspectableSpanExporter extends InMemorySpanExporter {
  /** Finished spans retained only for assertions after the complete application closes. */
  readonly retained: ReadableSpan[] = [];

  /**
   * Preserves the SDK's real shutdown while copying its documented in-memory test observations first.
   * @returns Settlement of the dependency-owned exporter shutdown.
   */
  override shutdown(): Promise<void> {
    this.retained.push(...this.getFinishedSpans());
    return super.shutdown();
  }
}

/** Narrow decoded Pino shape needed to prove the normalized record reached serialization. */
type PinoRecordEvidence = Readonly<{
  /** Adapter-owned binding retaining one Archer diagnostic. */
  archer?: Readonly<{
    /** Stable normalized diagnostic name used as the Pino message. */
    name?: string;
  }>;
}>;

describe('observed word-count application', () => {
  it('serves HTTP and projects the same wide record through Pino and OpenTelemetry', async () => {
    /** Real Pino serialization writes complete newline-delimited records into this caller-owned destination. */
    const pinoLines: string[] = [];
    /** The real OpenTelemetry SDK retains ended spans for application-level inspection. */
    const spanExporter = new InspectableSpanExporter();
    /** Cumulative in-memory export preserves the counter and duration projections after flush. */
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    /** The production application factory owns HTTP, diagnostics, adapters, and provider lifecycle together. */
    const application = await startObservedWordCountApplication({
      port: 0,
      pinoDestination: {
        /**
         * Retains the exact serialized write produced by Pino rather than impersonating a logger.
         * @param message - Complete newline-delimited Pino record.
         */
        write(message) {
          pinoLines.push(message);
        },
      },
      spanExporter,
      metricExporter,
      metricExportIntervalMillis: 60_000,
    });
    try {
      /** Fetch crosses the same operating-system HTTP boundary used by the executable. */
      const response = await fetch(new URL('/count', application.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Archer keeps useful work observable.' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ words: 5 });
    } finally {
      await application.close();
    }

    /** Pino must retain the normalized terminal record rather than narrating request breadcrumbs. */
    const pinoRecords = pinoLines.map((line) => JSON.parse(line) as PinoRecordEvidence);
    expect(pinoRecords).toHaveLength(1);
    expect(pinoRecords[0]?.archer?.name).toBe('http.request');
    /** A real SDK span proves the OpenTelemetry adapter remained in the executable composition. */
    expect(spanExporter.retained.map((span) => span.name)).toEqual(['http.request']);
    /** Provider flush publishes the adapter's bounded metric instruments before shutdown. */
    const metricNames = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => metric.descriptor.name);
    expect(metricNames).toEqual(
      expect.arrayContaining(['archer.diagnostic.span.duration', 'archer.diagnostic.span.count']),
    );
  });
});
