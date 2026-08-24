/**
 * @file Owns the complete observed HTTP application assembled by the executable.
 *
 * The factory keeps HTTP, normalized diagnostics, Pino, OpenTelemetry, and SDK
 * provider lifecycle in one testable owner. Exporters and an optional Pino
 * destination remain caller-selected transport policy.
 */

import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';

import { borrowed, owned } from '@archer/core';
import { createDiagnostics } from '@archer/core/diagnostics';
import { openTelemetrySink } from '@archer/observability/opentelemetry';
import { pinoSink, type PinoSinkDestination } from '@archer/observability/pino';

import { startWordCountService } from './service.js';
import { TelemetryLifecycle } from './telemetry.js';

/** Transport and listener choices for one complete observed word-count application. */
export type StartObservedWordCountApplicationOptions = Readonly<{
  /** OpenTelemetry destination owned through the constructed trace provider. */
  spanExporter: SpanExporter;
  /** OpenTelemetry destination owned through the constructed metric provider. */
  metricExporter: PushMetricExporter;
  /** Optional caller-owned destination; omission selects Pino's managed stderr default. */
  pinoDestination?: PinoSinkDestination;
  /** Network interface, defaulting to loopback inside the service boundary. */
  host?: string;
  /** TCP port, where zero asks the operating system for an available listener. */
  port?: number;
  /** Metric export cadence, defaulting to ten seconds for the runnable. */
  metricExportIntervalMillis?: number;
}>;

/** Retained application owner that stops admission before draining observability. */
export interface ObservedWordCountApplication {
  /** Complete base URL assigned after the real HTTP listener binds. */
  readonly url: URL;
  /** Stops HTTP and closes diagnostic queues, adapters, and SDK providers once. */
  close(): Promise<void>;
}

/**
 * Starts the same observed application used by the runnable and its boundary test.
 * @param options - Explicit exporters, optional Pino destination, and listener selection.
 * @returns Listening application with retained orderly cleanup.
 */
export async function startObservedWordCountApplication(
  options: StartObservedWordCountApplicationOptions,
): Promise<ObservedWordCountApplication> {
  /** Trace provider owns the caller-selected exporter behind a real SDK processor. */
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(options.spanExporter)],
  });
  /** Metric reader gives synchronous instruments a real push-export path. */
  const metricReader = new PeriodicExportingMetricReader({
    exporter: options.metricExporter,
    exportIntervalMillis: options.metricExportIntervalMillis ?? 10_000,
  });
  /** Metric provider owns the reader and selected exporter. */
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  /** One retained lifecycle composes both SDK providers for the OpenTelemetry sink. */
  const telemetryLifecycle = new TelemetryLifecycle(tracerProvider, meterProvider);
  /** The diagnostic hub is the only record source shared by both projections. */
  const diagnostics = createDiagnostics();

  try {
    /** Pino construction remains real even when a test supplies an inspectable destination. */
    const pino =
      options.pinoDestination === undefined ? pinoSink() : pinoSink({ destination: borrowed(options.pinoDestination) });
    diagnostics.attach(owned(pino));
    /** OpenTelemetry consumes the same normalized records and owns provider shutdown. */
    diagnostics.attach(
      owned(
        openTelemetrySink({
          tracer: tracerProvider.getTracer('@archer/example-word-count-service'),
          meter: meterProvider.getMeter('@archer/example-word-count-service'),
          flushLifecycle: owned(telemetryLifecycle),
        }),
      ),
    );
    /** HTTP admission begins only after both projection paths exist. */
    const service = await startWordCountService({
      diagnostics,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    /** First close invocation owns the complete application teardown sequence. */
    let closePromise: Promise<void> | undefined;
    /** Public application handle keeps transport and observability internals behind one owner. */
    const application: ObservedWordCountApplication = {
      url: service.url,
      /**
       * Stops new requests before draining accepted diagnostics and owned SDK resources.
       * @returns Retained settlement shared by repeated callers.
       */
      close() {
        closePromise ??= (async () => {
          await service.close();
          await diagnostics.close();
        })();
        return closePromise;
      },
    };
    return Object.freeze(application);
  } catch (error) {
    /** Construction failure still closes every sink or provider already admitted by this owner. */
    await diagnostics.close();
    await telemetryLifecycle.close();
    throw error;
  }
}
