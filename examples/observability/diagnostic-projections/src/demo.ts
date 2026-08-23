/**
 * @file Demonstrates one normalized wide diagnostic record projected to Pino
 * and OpenTelemetry through independent, explicitly owned sink attachments.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

import { UuidV4Schema, borrowed, owned, type DiagnosticSinkCloseEvidence } from '@archer/core';
import { createDiagnostics } from '@archer/core/diagnostics';
import { openTelemetrySink, type OpenTelemetryFlushLifecycle } from '@archer/observability/opentelemetry';
import { pinoSink, type PinoSinkDestination } from '@archer/observability/pino';

/** Immutable successful dependency close evidence shared by this example. */
const CLOSED_EVIDENCE = Object.freeze({ kind: 'closed' } as const);

/** Retained owner for the real trace and metric providers used by the example. */
class TelemetryLifecycle implements OpenTelemetryFlushLifecycle {
  /** Real provider driving the in-memory span exporter. */
  readonly #tracerProvider: BasicTracerProvider;

  /** Real provider supplying the adapter's metric instruments. */
  readonly #meterProvider: MeterProvider;

  /** Shared lifecycle settlement available before and after close starts. */
  readonly closed: Promise<DiagnosticSinkCloseEvidence>;

  /** Resolves the shared settlement only after both SDK providers shut down. */
  readonly #resolveClosed: (value: DiagnosticSinkCloseEvidence) => void;

  /** Prevents repeated SDK shutdown calls. */
  #closeStarted = false;

  /**
   * Retains the providers behind Archer's explicit ownership interface.
   * @param tracerProvider - Real provider driving the in-memory span exporter.
   * @param meterProvider - Real provider supplying adapter metric instruments.
   */
  constructor(tracerProvider: BasicTracerProvider, meterProvider: MeterProvider) {
    this.#tracerProvider = tracerProvider;
    this.#meterProvider = meterProvider;
    /** Captures the one resolver during shared promise construction. */
    let resolveClosed!: (value: DiagnosticSinkCloseEvidence) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  /** Flushes both SDK planes without granting them domain authority. */
  async forceFlush(): Promise<void> {
    await Promise.all([this.#tracerProvider.forceFlush(), this.#meterProvider.forceFlush()]);
  }

  /**
   * Starts provider shutdown once and returns the exact retained settlement.
   * @returns Shared lifecycle promise.
   */
  close(): Promise<DiagnosticSinkCloseEvidence> {
    if (!this.#closeStarted) {
      this.#closeStarted = true;
      void this.#finishClose();
    }
    return this.closed;
  }

  /** Makes explicit resource management equivalent to ordinary closure. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Shuts down both providers before publishing successful close evidence. */
  async #finishClose(): Promise<void> {
    await Promise.all([this.#tracerProvider.shutdown(), this.#meterProvider.shutdown()]);
    this.#resolveClosed(CLOSED_EVIDENCE);
  }
}

/** One parsed structured Pino envelope produced by the real adapter. */
type PinoEnvelope = Readonly<{
  /** Pino message uses the normalized Archer record name. */
  msg: string;

  /** Complete normalized diagnostic record retained under the adapter namespace. */
  archer: Readonly<{
    /** Stable record name independently confirms projection identity. */
    name: string;

    /** Wide record context includes the final model usage accumulated over the span. */
    attributes: Readonly<Record<string, unknown>>;
  }>;
}>;

/** Portable evidence printed by the diagnostic-projections example. */
export type DiagnosticProjectionDemoResult = Readonly<{
  /** Exact normalized record name observed in the structured log projection. */
  pinoName: string;

  /** Exact normalized record name observed in the OpenTelemetry span projection. */
  telemetryName: string;

  /** Confirms final accumulated context reached the one terminal Pino record. */
  hasAccumulatedUsage: boolean;

  /** Confirms explicit SDK lifecycle ownership completed during hub shutdown. */
  telemetryClosed: boolean;
}>;

/**
 * Runs one deterministic wide-record fan-out through both first-party adapters.
 * @returns Projection and lifecycle evidence from real destination boundaries.
 */
export async function diagnosticProjectionDemo(): Promise<DiagnosticProjectionDemoResult> {
  /** Captures real newline-delimited Pino writes without console or file side effects. */
  const pinoLines: string[] = [];
  /** Borrowed destination remains application-owned when its sink closes. */
  const destination: PinoSinkDestination = Object.freeze({
    /**
     * Records one complete Pino line for later structured inspection.
     * @param message - Adapter-produced newline-delimited JSON.
     */
    write(message: string) {
      pinoLines.push(message);
    },
  });

  /** Real SDK exporter proves the adapter creates ordinary OpenTelemetry spans. */
  const spanExporter = new InMemorySpanExporter();
  /** Simple processing keeps the deterministic example free of timers. */
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  /** Meter provider accepts the adapter's bounded synchronous instruments. */
  const meterProvider = new MeterProvider();
  /** Explicit retained owner composes both SDK provider lifecycles. */
  const lifecycle = new TelemetryLifecycle(tracerProvider, meterProvider);

  /** Core hub owns record normalization and fans out without sharing sink authority. */
  const diagnostics = createDiagnostics({
    /**
     * Supplies deterministic wall time for stable runnable output.
     * @returns Fixed wall instant for admission and settlement.
     */
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    /**
     * Supplies deterministic elapsed duration without sleeping.
     * @returns Fixed monotonic reading.
     */
    monotonicNow: () => 100,
    /**
     * Supplies one valid process-local span identity.
     * @returns Deterministic UUIDv4 fixture.
     */
    createSpanId: () => UuidV4Schema.parse('00000000-0000-4000-8000-000000000901'),
  });
  /** Hub owns sink closure while the Pino sink borrows its tiny destination. */
  diagnostics.attach(owned(pinoSink({ destination: borrowed(destination), level: 'trace' })));
  /** Hub owns the adapter while the application retains its shared SDK providers. */
  diagnostics.attach(
    owned(
      openTelemetrySink({
        tracer: tracerProvider.getTracer('@archer/example-observability'),
        meter: meterProvider.getMeter('@archer/example-observability'),
        flushLifecycle: borrowed(lifecycle),
      }),
    ),
  );

  /** Begins one concrete operation with admission-time context. */
  const span = diagnostics.beginSpan({
    name: 'model.attempt',
    component: 'examples.observability',
    correlation: {},
    attributes: { model: { provider: 'example', name: 'deterministic' } },
  });
  /** Accumulates context during work without emitting a breadcrumb. */
  const enriched = span.enrich('usage', { inputTokens: 12, outputTokens: 4 });
  if (!enriched.ok) throw enriched.error;
  /** Emits the only terminal wide record shared by both projections. */
  const completed = span.complete({ outcome: 'completed' });
  if (!completed.ok) throw completed.error;
  /** Drains both attachments and closes both sinks without closing borrowed resources. */
  await diagnostics.close();

  /** Parses only adapter-produced JSON after all writes have drained. */
  const pinoRecord = JSON.parse(pinoLines[0] ?? '{}') as PinoEnvelope;
  /** Reads real SDK output after lifecycle flush and shutdown. */
  const telemetrySpan = spanExporter.getFinishedSpans()[0];
  if (telemetrySpan === undefined) throw new Error('Missing OpenTelemetry projection');
  /** Application closes its borrowed SDK lifecycle only after inspecting projection. */
  const lifecycleEvidence = await lifecycle.close();
  return Object.freeze({
    pinoName: pinoRecord.archer.name,
    telemetryName: telemetrySpan.name,
    hasAccumulatedUsage: 'usage' in pinoRecord.archer.attributes,
    telemetryClosed: lifecycleEvidence.kind === 'closed',
  });
}
