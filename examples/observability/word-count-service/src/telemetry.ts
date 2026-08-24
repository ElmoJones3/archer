/** @file Adapts OpenTelemetry provider ownership to Archer's explicit sink lifecycle. */

import type { MeterProvider } from '@opentelemetry/sdk-metrics';
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

import { toProtocolFailure, type DiagnosticSinkCloseEvidence } from '@archer/core';
import type { OpenTelemetryFlushLifecycle } from '@archer/observability/opentelemetry';

/** Immutable successful close evidence shared after both SDK providers shut down. */
const CLOSED_EVIDENCE = Object.freeze({ kind: 'closed' } as const);

/** Retained owner that composes the trace and metric provider lifecycles. */
export class TelemetryLifecycle implements OpenTelemetryFlushLifecycle {
  /** Real provider responsible for span processors and exporters. */
  readonly #tracerProvider: BasicTracerProvider;
  /** Real provider responsible for metric readers and exporters. */
  readonly #meterProvider: MeterProvider;
  /** Shared lifecycle settlement visible before and after close begins. */
  readonly closed: Promise<DiagnosticSinkCloseEvidence>;
  /** Resolves shared evidence only after both providers shut down. */
  readonly #resolveClosed: (value: DiagnosticSinkCloseEvidence) => void;
  /** Prevents repeated SDK shutdown calls. */
  #closeStarted = false;

  /**
   * Retains both SDK providers behind Archer's narrow flush contract.
   * @param tracerProvider - Provider driving trace export.
   * @param meterProvider - Provider driving metric export.
   */
  constructor(tracerProvider: BasicTracerProvider, meterProvider: MeterProvider) {
    this.#tracerProvider = tracerProvider;
    this.#meterProvider = meterProvider;
    /** Captures the resolver once so `closed` retains exact evidence identity. */
    let resolveClosed!: (value: DiagnosticSinkCloseEvidence) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  /** Flushes accepted trace and metric work without closing either provider. */
  async forceFlush(): Promise<void> {
    await Promise.all([this.#tracerProvider.forceFlush(), this.#meterProvider.forceFlush()]);
  }

  /**
   * Shuts down both providers once and returns the retained settlement.
   * @returns Shared lifecycle evidence promise.
   */
  close(): Promise<DiagnosticSinkCloseEvidence> {
    if (!this.#closeStarted) {
      this.#closeStarted = true;
      void this.#finishClose();
    }
    return this.closed;
  }

  /** Delegates explicit resource management to ordinary retained closure. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Completes both SDK shutdown attempts before publishing bounded retained evidence. */
  async #finishClose(): Promise<void> {
    /** `allSettled` ensures one early rejection cannot stop observation of the other owned provider. */
    const settlements = await Promise.allSettled([this.#tracerProvider.shutdown(), this.#meterProvider.shutdown()]);
    /** The first rejected identity is normalized without exposing provider exception text. */
    const rejected = settlements.find((settlement) => settlement.status === 'rejected');
    if (rejected !== undefined) {
      this.#resolveClosed(
        Object.freeze({
          kind: 'failed',
          failure: toProtocolFailure(rejected.reason, {
            code: 'opentelemetry_provider_shutdown_failed',
            message: 'OpenTelemetry providers failed to shut down',
          }),
        }),
      );
      return;
    }
    this.#resolveClosed(CLOSED_EVIDENCE);
  }
}
