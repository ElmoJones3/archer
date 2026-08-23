/**
 * @file Proves the OpenTelemetry adapter against SDK 2.10 in-memory exporters.
 *
 * Tests create Archer records through the public diagnostics lifecycle so the
 * adapter never receives states that production cannot produce.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpanStatusCode, type HrTime, type Meter } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  ArcherError,
  UuidV4Schema,
  borrowed,
  owned,
  type DiagnosticCorrelation,
  type DiagnosticEventRecord,
  type DiagnosticSink,
  type DiagnosticSinkCloseEvidence,
  type DiagnosticSpanAttributes,
  type DiagnosticSpanRecord,
  type JsonObject,
  type PublicError,
  type UuidV4,
} from '@archer/core';
import { createDiagnosticEvent, createDiagnostics } from '@archer/core/diagnostics';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openTelemetrySink,
  type OpenTelemetryFlushLifecycle,
  type OpenTelemetryRetentionBounds,
} from '../src/opentelemetry/index.js';

/** Normal close evidence shared by real SDK lifecycle fixtures. */
const CLOSED_EVIDENCE: DiagnosticSinkCloseEvidence = Object.freeze({ kind: 'closed' });

/** Stable event instant used to prove zero-duration point projections. */
const EVENT_AT = '2026-08-22T03:04:05.678Z';

/** Supported optional API peer rendered in construction guidance. */
const OPENTELEMETRY_API_RANGE = '^1.9.1';

/** Result of importing and constructing the adapter in an isolated Node package tree. */
type IsolatedPeerProbe = Readonly<{
  /** Process exit status, or `null` when Node could not start. */
  status: number | null;

  /** Consumer-owned structured output written after import and construction. */
  stdout: string;

  /** Node loader or consumer failure text retained only by the test process. */
  stderr: string;
}>;

/** Stable shape written by the successful isolated peerless consumer. */
type PeerlessConsumerEvidence = Readonly<{
  /** Confirms module evaluation exposed the public synchronous factory. */
  importedFactory: string;

  /** Confirms importing OpenTelemetry did not evaluate the Pino sentinel module. */
  otherAdapterInitialized: boolean;

  /** Captures bounded adapter-owned construction failure identity. */
  failure: Readonly<{
    /** Focused public Error class name. */
    name: string;

    /** Stable machine-readable adapter code. */
    code: string;

    /** Actionable package and supported-version guidance. */
    message: string;

    /** Confirms no dependency cause escaped the construction boundary. */
    hasCause: boolean;
  }>;
}>;

/**
 * Imports transpiled production adapter code from a clean package tree with no
 * OpenTelemetry API in its module-resolution ancestry.
 * @returns Process evidence that distinguishes import from factory construction.
 */
async function probeIsolatedPeerlessConsumer(): Promise<IsolatedPeerProbe> {
  /** Owns every generated package and module for one clean-process probe. */
  const directory = await mkdtemp(join(tmpdir(), 'archer-opentelemetry-peerless-'));
  try {
    /** Reads the production source that the package declaration build compiles. */
    const source = await readFile(new URL('../src/opentelemetry/index.ts', import.meta.url), 'utf8');
    /** Emits ESM without resolving imports against the workspace dependency tree. */
    const compiled = transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2024 },
    }).outputText;
    /** Places the adapter below an isolated package-owned dependency directory. */
    const packageDirectory = join(directory, 'package');
    /** Supplies only Archer core, deliberately omitting `@opentelemetry/api`. */
    const coreDirectory = join(packageDirectory, 'node_modules', '@archer', 'core');
    /** Supplies a sentinel package that fails the no-other-adapter assertion if loaded. */
    const pinoDirectory = join(packageDirectory, 'node_modules', 'pino');
    /** Matches the published OpenTelemetry subpath layout inside the isolated package. */
    const adapterDirectory = join(packageDirectory, 'dist', 'opentelemetry');
    await Promise.all([
      mkdir(coreDirectory, { recursive: true }),
      mkdir(pinoDirectory, { recursive: true }),
      mkdir(adapterDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module' })),
      writeFile(join(adapterDirectory, 'index.js'), compiled),
      writeFile(
        join(coreDirectory, 'package.json'),
        JSON.stringify({ name: '@archer/core', type: 'module', exports: './index.js' }),
      ),
      writeFile(
        join(coreDirectory, 'index.js'),
        `export class ArcherError extends Error {
  constructor(message, options) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
  }
}
export function toProtocolFailure(error, fallback) {
  const identity = error instanceof ArcherError ? error : fallback;
  return Object.freeze({
    kind: 'protocol-failure',
    code: identity.code,
    message: identity.message,
    retryable: false,
  });
}
`,
      ),
      writeFile(
        join(pinoDirectory, 'package.json'),
        JSON.stringify({ name: 'pino', type: 'module', exports: './index.js' }),
      ),
      writeFile(
        join(pinoDirectory, 'index.js'),
        `globalThis.__archerOtherAdapterInitialized = true;
export default function pino() {
  throw new Error('Pino sentinel must never initialize');
}
`,
      ),
    ]);
    /** Runs import and construction separately so an eager peer load is observable. */
    const consumerPath = join(directory, 'consumer.mjs');
    await writeFile(
      consumerPath,
      `globalThis.__archerOtherAdapterInitialized = false;
const adapter = await import('./package/dist/opentelemetry/index.js');
let failure;
try {
  adapter.openTelemetrySink({});
} catch (error) {
  failure = {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    hasCause: error?.cause !== undefined,
  };
}
process.stdout.write(JSON.stringify({
  importedFactory: typeof adapter.openTelemetrySink,
  otherAdapterInitialized: globalThis.__archerOtherAdapterInitialized,
  failure,
}));
`,
    );
    /** Removes ambient legacy lookup paths before starting the clean Node process. */
    const environment = { ...process.env };
    delete environment.NODE_PATH;
    /** Starts Node with no working-directory ancestry shared with the repository. */
    const result = spawnSync(process.execPath, [consumerPath], {
      cwd: directory,
      encoding: 'utf8',
      env: environment,
    });
    return Object.freeze({ status: result.status, stdout: result.stdout, stderr: result.stderr });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * Captures one rejected adapter operation and proves its shared Archer identity.
 * @param operation - Public asynchronous adapter operation expected to reject.
 * @returns The focused Archer-owned failure for case-specific assertions.
 */
async function rejectedAdapterOperation(operation: Promise<unknown>): Promise<ArcherError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ArcherError);
    expect(error).toMatchObject({ name: 'OpenTelemetrySinkError' });
    return error as ArcherError;
  }
  throw new Error('Expected OpenTelemetry adapter operation to reject');
}

/**
 * Captures one synchronous factory refusal and proves its shared Archer identity.
 * @param construct - Public adapter construction expected to throw.
 * @returns The focused Archer-owned failure for case-specific assertions.
 */
function rejectedAdapterConstruction(construct: () => unknown): ArcherError {
  try {
    construct();
  } catch (error) {
    expect(error).toBeInstanceOf(ArcherError);
    expect(error).toMatchObject({ name: 'OpenTelemetrySinkError' });
    return error as ArcherError;
  }
  throw new Error('Expected OpenTelemetry adapter construction to fail');
}

/**
 * Creates recognizable valid UUIDv4 identities through Archer's runtime schema.
 * @param index - Synthetic number encoded into the UUID node segment.
 * @returns A runtime-validated branded UUIDv4.
 */
function uuid(index: number): UuidV4 {
  /** Encodes the fixture index only in the UUID node segment. */
  const suffix = index.toString(16).padStart(12, '0');
  return UuidV4Schema.parse(`00000000-0000-4000-8000-${suffix}`);
}

/** Settlement choices exercised through the public DiagnosticSpan behavior. */
type SpanFixtureSettlement =
  | Readonly<{
      /** Selects ordinary successful settlement. */
      kind: 'completed';

      /** Supplies the component-owned successful outcome. */
      outcome: string;
    }>
  | Readonly<{
      /** Selects bounded failed settlement. */
      kind: 'failed';

      /** Supplies the component-owned failed outcome. */
      outcome: string;

      /** Supplies already-redacted public failure evidence. */
      error: PublicError;
    }>
  | Readonly<{
      /** Selects settlement without a domain work result. */
      kind: 'abandoned';

      /** Supplies the bounded observation-stop reason. */
      reason: string;
    }>;

/** Inputs varied by adapter proofs while core owns record normalization. */
type SpanFixtureOptions = Readonly<{
  /** Stable destination span name. */
  name: string;

  /** Process-local Archer identity generated at span admission. */
  spanId: UuidV4;

  /** Optional explicit Archer parent identity. */
  parentSpanId?: UuidV4;

  /** Wall-clock start retained independently from elapsed duration. */
  startedAt?: string;

  /** Wall-clock settlement retained as the Archer `at` attribute. */
  at?: string;

  /** Injected monotonic elapsed milliseconds. */
  durationMs?: number;

  /** Terminal behavior invoked through the production span owner. */
  settlement?: SpanFixtureSettlement;

  /** Package-owned context admitted through the production span boundary. */
  attributes?: DiagnosticSpanAttributes;

  /** High-cardinality Archer identity retained only on traces. */
  correlation?: DiagnosticCorrelation;
}>;

/**
 * Creates one production-reachable terminal span with controlled wall and monotonic time.
 * @param options - Identity, timing, context, and terminal behavior for the case.
 * @returns The immutable record emitted by public DiagnosticSpan settlement.
 */
async function spanRecord(options: SpanFixtureOptions): Promise<DiagnosticSpanRecord> {
  /** Separates wall settlement from monotonic duration on purpose. */
  const wallReadings = [
    new Date(options.startedAt ?? '2026-08-22T01:00:00.000Z'),
    new Date(options.at ?? '2026-08-22T01:10:00.000Z'),
  ];
  /** Starts at a nonzero monotonic value to catch wall-time derivation. */
  const monotonicReadings = [100, 100 + (options.durationMs ?? 37.5)];
  /** Owns the same public lifecycle that production components use. */
  const diagnostics = createDiagnostics({
    /**
     * Supplies controlled wall time for both span admission and settlement.
     * @returns The next deterministic wall instant.
     */
    now: () => wallReadings.shift() ?? new Date(options.at ?? '2026-08-22T01:10:00.000Z'),
    /**
     * Supplies controlled elapsed readings independently from wall time.
     * @returns The next deterministic monotonic millisecond reading.
     */
    monotonicNow: () => monotonicReadings.shift() ?? 100 + (options.durationMs ?? 37.5),
    /**
     * Supplies the case's runtime-validated process-local identity.
     * @returns The fixture's branded UUIDv4.
     */
    createSpanId: () => options.spanId,
  });
  /** Begins concrete work before selecting one legal terminal command. */
  const span = diagnostics.beginSpan({
    name: options.name,
    component: 'tests.opentelemetry',
    correlation: options.correlation ?? {},
    ...(options.parentSpanId === undefined ? {} : { parentSpanId: options.parentSpanId }),
    ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
  });
  /** Uses successful settlement unless a case names another terminal branch. */
  const settlement = options.settlement ?? { kind: 'completed', outcome: 'completed' };
  /** Captures the exact record returned by the public behavior owner. */
  const result =
    settlement.kind === 'completed'
      ? span.complete({ outcome: settlement.outcome })
      : settlement.kind === 'failed'
        ? span.fail({ outcome: settlement.outcome, error: settlement.error })
        : span.abandon({ reason: settlement.reason });
  if (!result.ok) throw result.error;
  await diagnostics.close();
  return result.value;
}

/**
 * Creates one production-normalized point event at a deterministic instant.
 * @param name - Stable event name used as the destination span name.
 * @param input - Optional outcome, error, correlation, and JSON attributes.
 * @returns The immutable point event from core's public factory.
 */
function eventRecord(
  name: string,
  input: Readonly<{
    /** Optional bounded event outcome. */
    outcome?: string;

    /** Optional already-redacted public failure. */
    error?: PublicError;

    /** Optional high-cardinality Archer correlation. */
    correlation?: DiagnosticCorrelation;

    /** Optional event-owned JSON evidence. */
    attributes?: JsonObject;
  }> = {},
): DiagnosticEventRecord {
  return createDiagnosticEvent(
    {
      name,
      severity: input.error === undefined ? 'info' : 'error',
      component: 'tests.opentelemetry',
      correlation: input.correlation ?? {},
      attributes: input.attributes ?? {},
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    () => new Date(EVENT_AT),
  );
}

/**
 * Retains real trace and metric providers behind the adapter's ownership contract.
 * Test-selected failures happen after real flush or shutdown so the dependency
 * boundary remains faithful while redaction behavior is exercised.
 */
class SdkFlushLifecycle implements OpenTelemetryFlushLifecycle {
  /** Counts force-flush calls made through the adapter contract. */
  forceFlushCalls = 0;

  /** Counts idempotent lifecycle close starts. */
  closeCalls = 0;

  /** Pauses force-flush settlement so closing-state tests control interleaving. */
  forceFlushGate?: Promise<void>;

  /** Makes a real provider flush reject with private dependency text when selected. */
  failForceFlush = false;

  /** Makes real provider shutdown reject with private dependency text when selected. */
  failClose = false;

  /** Selects retained evidence returned after successful provider shutdown. */
  closeEvidence: DiagnosticSinkCloseEvidence = CLOSED_EVIDENCE;

  /** Shares one retained lifecycle result before or after close starts. */
  readonly closed: Promise<DiagnosticSinkCloseEvidence>;

  /** Resolves the retained lifecycle after both providers shut down. */
  readonly #resolveClosed: (evidence: DiagnosticSinkCloseEvidence) => void;

  /** Rejects the retained lifecycle only for the explicit failure proof. */
  readonly #rejectClosed: (error: unknown) => void;

  /** Prevents repeated SDK shutdown calls. */
  #closeStarted = false;

  /** Real provider driving the in-memory span exporter. */
  readonly tracerProvider: BasicTracerProvider;

  /** Real provider driving the in-memory metric exporter. */
  readonly meterProvider: MeterProvider;

  /**
   * Binds the real SDK providers used by every adapter test.
   * @param tracerProvider - Provider driving the in-memory span exporter.
   * @param meterProvider - Provider driving the in-memory metric exporter.
   */
  constructor(tracerProvider: BasicTracerProvider, meterProvider: MeterProvider) {
    this.tracerProvider = tracerProvider;
    this.meterProvider = meterProvider;
    /** Captures both retained promise callbacks during construction. */
    let resolveClosed!: (evidence: DiagnosticSinkCloseEvidence) => void;
    /** Captures rejection without storing native failure on public evidence. */
    let rejectClosed!: (error: unknown) => void;
    this.closed = new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.#resolveClosed = resolveClosed;
    this.#rejectClosed = rejectClosed;
  }

  /** Flushes both real providers before an optional private failure is raised. */
  async forceFlush(): Promise<void> {
    this.forceFlushCalls += 1;
    await this.forceFlushGate;
    await Promise.all([this.tracerProvider.forceFlush(), this.meterProvider.forceFlush()]);
    if (this.failForceFlush) throw new Error('private exporter credential token');
  }

  /**
   * Starts real provider shutdown once and returns the retained settlement.
   * @returns The same lifecycle promise exposed by `closed`.
   */
  close(): Promise<DiagnosticSinkCloseEvidence> {
    if (this.#closeStarted) return this.closed;
    this.#closeStarted = true;
    this.closeCalls += 1;
    void this.#finishClose();
    return this.closed;
  }

  /** Delegates language disposal to the retained close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Shuts down both providers before resolving or rejecting retained evidence. */
  async #finishClose(): Promise<void> {
    try {
      await Promise.all([this.tracerProvider.shutdown(), this.meterProvider.shutdown()]);
      if (this.failClose) throw new Error('private shutdown authorization header');
      this.#resolveClosed(this.closeEvidence);
    } catch (error) {
      this.#rejectClosed(error);
    }
  }
}

/** Real in-memory SDK boundary plus the adapter created over it. */
type TelemetryHarness = Readonly<{
  /** Adapter under test. */
  sink: DiagnosticSink;

  /** In-memory trace exporter supplied through SDK 2.10. */
  spanExporter: InMemorySpanExporter;

  /** In-memory metric exporter supplied through SDK 2.10. */
  metricExporter: InMemoryMetricExporter;

  /** Explicit provider lifecycle supplied to the adapter. */
  lifecycle: SdkFlushLifecycle;
}>;

/** Active real-SDK fixtures cleaned after each test even when an assertion fails. */
const activeLifecycles = new Set<SdkFlushLifecycle>();

/**
 * Creates one adapter over real SDK 2.10 exporters.
 * @param options - Ownership and optional graph or context bounds.
 * @returns The retained adapter and inspectable in-memory destinations.
 */
function telemetryHarness(
  options: Readonly<{
    /** Transfers lifecycle close authority when true. */
    ownedLifecycle?: boolean;

    /** Overrides pending-parent retention. */
    pending?: OpenTelemetryRetentionBounds;

    /** Overrides projected-context retention. */
    projectedContexts?: OpenTelemetryRetentionBounds;
  }> = {},
): TelemetryHarness {
  /** Records ended spans without replacing SDK parenting or timing semantics. */
  const spanExporter = new InMemorySpanExporter();
  /** Exports each ended SDK span through the real processor implementation. */
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  /** Accumulates real SDK metric data for exact label and value inspection. */
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  /** Connects synchronous instruments to the in-memory metric exporter. */
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  /** Owns the meter and its reader for this test only. */
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  /** Composes both provider lifecycles behind one explicit adapter boundary. */
  const lifecycle = new SdkFlushLifecycle(tracerProvider, meterProvider);
  activeLifecycles.add(lifecycle);
  /** Selects ownership without asking the adapter to infer it from SDK methods. */
  const flushLifecycle = options.ownedLifecycle ? owned(lifecycle) : borrowed(lifecycle);
  /** Constructs the public retained DiagnosticSink. */
  const sink = openTelemetrySink({
    tracer: tracerProvider.getTracer('@archer/observability/opentelemetry', '0.0.0'),
    meter: meterProvider.getMeter('@archer/observability/opentelemetry', '0.0.0'),
    flushLifecycle,
    ...(options.pending === undefined ? {} : { pending: options.pending }),
    ...(options.projectedContexts === undefined ? {} : { projectedContexts: options.projectedContexts }),
  });
  return Object.freeze({ sink, spanExporter, metricExporter, lifecycle });
}

/** Closes every real provider that a failed assertion may have left borrowed. */
afterEach(async () => {
  /** Restores failure switches before idempotently closing every active fixture. */
  for (const lifecycle of activeLifecycles) {
    try {
      lifecycle.failForceFlush = false;
      lifecycle.failClose = false;
      await lifecycle.close();
    } catch {
      // A named failure test may have already settled this lifecycle as rejected.
    }
  }
  activeLifecycles.clear();
});

/**
 * Converts SDK high-resolution time into fractional epoch milliseconds.
 * @param time - SDK seconds and nanoseconds tuple.
 * @returns Epoch or duration milliseconds without dropping fractional precision.
 */
function hrTimeMilliseconds(time: HrTime): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

/**
 * Finds one ended span by its stable Archer record name.
 * @param exporter - Real in-memory exporter containing ended SDK spans.
 * @param name - Exact destination span name.
 * @returns The sole matching span or a focused fixture failure.
 */
function finishedSpan(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  /** Finds by stable operation name rather than exporter position. */
  const span = exporter.getFinishedSpans().find((candidate) => candidate.name === name);
  if (span === undefined) throw new Error(`Expected finished span ${name}`);
  return span;
}

/**
 * Finds the latest exported metric with one exact descriptor name.
 * @param exporter - Real in-memory metric exporter.
 * @param name - Stable adapter instrument name.
 * @returns The latest cumulative SDK metric data.
 */
function exportedMetric(exporter: InMemoryMetricExporter, name: string): MetricData {
  /** Later force-flush snapshots supersede earlier cumulative snapshots. */
  const resources = exporter.getMetrics();
  /** Searches cumulative snapshots newest first so repeated flushes remain deterministic. */
  for (let resourceIndex = resources.length - 1; resourceIndex >= 0; resourceIndex -= 1) {
    /** Reads one cumulative resource snapshot. */
    const resource = resources[resourceIndex];
    if (resource === undefined) continue;
    /** Searches every instrumentation scope in the selected resource snapshot. */
    for (const scope of resource.scopeMetrics) {
      /** Selects the adapter's stable instrument descriptor. */
      const metric = scope.metrics.find((candidate) => candidate.descriptor.name === name);
      if (metric !== undefined) return metric;
    }
  }
  throw new Error(`Expected exported metric ${name}`);
}

/** Already-redacted production failure used by status and label proofs. */
const PUBLIC_FAILURE: PublicError = Object.freeze({
  code: 'provider_refused',
  message: 'Provider request failed',
  retryable: true,
  details: Object.freeze({ phase: 'response' }),
});

describe('openTelemetrySink', () => {
  it('imports without its optional API peer and fails only at construction', async () => {
    /** Runs module evaluation beyond every workspace module-resolution ancestor. */
    const probe = await probeIsolatedPeerlessConsumer();

    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stderr).toBe('');
    /** Parses only output from the consumer fixture controlled by this test. */
    const evidence = JSON.parse(probe.stdout) as PeerlessConsumerEvidence;
    expect(evidence).toEqual({
      importedFactory: 'function',
      otherAdapterInitialized: false,
      failure: {
        name: 'OpenTelemetrySinkError',
        code: 'opentelemetry_api_unavailable',
        message: `OpenTelemetry adapter requires @opentelemetry/api@${OPENTELEMETRY_API_RANGE}; install that peer before constructing a sink`,
        hasCause: false,
      },
    });
  });

  it('uses startedAt plus monotonic duration and retains Archer attributes', async () => {
    /** Exercises every correlation mapping without admitting any metric identity label. */
    const correlation: DiagnosticCorrelation = {
      taskId: uuid(1),
      threadId: uuid(2),
      turnId: uuid(3),
      cellId: uuid(4),
      effectId: uuid(5),
      attemptId: uuid(6),
      modelRequestId: uuid(7),
      invocationId: uuid(8),
      sandboxId: uuid(9),
      materializedViewId: uuid(10),
      workspaceId: uuid(11),
      resourceSetId: uuid(12),
      changeSetId: uuid(13),
    };
    /** Produces a wide terminal record through core's begin and complete path. */
    const record = await spanRecord({
      name: 'model.step.completed',
      spanId: uuid(20),
      parentSpanId: uuid(21),
      startedAt: '2026-08-22T01:00:00.000Z',
      at: '2026-08-22T01:10:00.000Z',
      durationMs: 37.5,
      correlation,
      attributes: {
        model: { provider: 'openai', family: 'gpt-5' },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });
    /** Uses a one-byte pending limit so the unresolved parent projects immediately. */
    const harness = telemetryHarness({ pending: { capacityBytes: 1 } });

    await harness.sink.write([record]);
    await harness.sink.flush();

    /** Reads exact timing and status from the real SDK exporter. */
    const span = finishedSpan(harness.spanExporter, record.name);
    expect(hrTimeMilliseconds(span.startTime)).toBe(Date.parse(record.startedAt));
    expect(hrTimeMilliseconds(span.endTime)).toBe(Date.parse(record.startedAt) + record.durationMs);
    expect(hrTimeMilliseconds(span.duration)).toBe(record.durationMs);
    expect(span.status).toEqual({ code: SpanStatusCode.OK });
    expect(span.attributes).toMatchObject({
      'archer.at': record.at,
      'archer.span_id': record.spanId,
      'archer.parent_span_id': record.parentSpanId,
      'archer.parent_resolution': 'missing',
      'archer.task_id': correlation.taskId,
      'archer.thread_id': correlation.threadId,
      'archer.turn_id': correlation.turnId,
      'archer.cell_id': correlation.cellId,
      'archer.effect_id': correlation.effectId,
      'archer.attempt_id': correlation.attemptId,
      'archer.model_request_id': correlation.modelRequestId,
      'archer.invocation_id': correlation.invocationId,
      'archer.sandbox_id': correlation.sandboxId,
      'archer.materialized_view_id': correlation.materializedViewId,
      'archer.workspace_id': correlation.workspaceId,
      'archer.resource_set_id': correlation.resourceSetId,
      'archer.change_set_id': correlation.changeSetId,
      'archer.context.model': '{"provider":"openai","family":"gpt-5"}',
      'archer.context.usage': '{"inputTokens":100,"outputTokens":20}',
    });
    /** Confirms arbitrary nested context did not become flattened trace keys. */
    const contextKeys = Object.keys(span.attributes).filter((key) => key.startsWith('archer.context.'));
    expect(contextKeys.sort()).toEqual(['archer.context.model', 'archer.context.usage']);
  });

  it('maps terminal and point-event statuses exactly', async () => {
    /** Creates one record for each terminal status branch. */
    const completed = await spanRecord({ name: 'status.completed', spanId: uuid(30) });
    /** Uses core failure settlement so native exceptions never enter the record. */
    const failed = await spanRecord({
      name: 'status.failed',
      spanId: uuid(31),
      settlement: { kind: 'failed', outcome: 'provider-failed', error: PUBLIC_FAILURE },
    });
    /** Uses public abandonment rather than forging terminal record state. */
    const abandoned = await spanRecord({
      name: 'status.abandoned',
      spanId: uuid(32),
      settlement: { kind: 'abandoned', reason: 'worker_replaced' },
    });
    /** Creates one failed and one ordinary point event through core normalization. */
    const errorEvent = eventRecord('status.event.error', { error: PUBLIC_FAILURE });
    /** Leaves error absent so severity-independent UNSET behavior stays explicit. */
    const ordinaryEvent = eventRecord('status.event.ordinary');
    /** Projects every status through one real tracer. */
    const harness = telemetryHarness();

    await harness.sink.write([completed, failed, abandoned, errorEvent, ordinaryEvent]);
    await harness.sink.flush();

    expect(finishedSpan(harness.spanExporter, completed.name).status.code).toBe(SpanStatusCode.OK);
    expect(finishedSpan(harness.spanExporter, failed.name).status).toEqual({
      code: SpanStatusCode.ERROR,
      message: PUBLIC_FAILURE.message,
    });
    expect(finishedSpan(harness.spanExporter, abandoned.name).status.code).toBe(SpanStatusCode.UNSET);
    expect(finishedSpan(harness.spanExporter, errorEvent.name).status.code).toBe(SpanStatusCode.ERROR);
    expect(finishedSpan(harness.spanExporter, ordinaryEvent.name).status.code).toBe(SpanStatusCode.UNSET);
    expect(finishedSpan(harness.spanExporter, abandoned.name).attributes).toMatchObject({
      'archer.abandonment.reason': 'worker_replaced',
    });
    expect(finishedSpan(harness.spanExporter, failed.name).attributes).toMatchObject({
      'archer.error.code': PUBLIC_FAILURE.code,
      'archer.error.message': PUBLIC_FAILURE.message,
      'archer.error.retryable': PUBLIC_FAILURE.retryable,
      'archer.error.details': '{"phase":"response"}',
    });
  });

  it('emits duration, span count, and event count with only allowlisted labels', async () => {
    /** Supplies forbidden metric identity and context fields to catch accidental labeling. */
    const span = await spanRecord({
      name: 'metrics.span',
      spanId: uuid(40),
      durationMs: 25,
      correlation: { taskId: uuid(41), invocationId: uuid(42) },
      attributes: { provider: { id: 'high-cardinality-adapter-id' } },
      settlement: { kind: 'failed', outcome: 'refused', error: PUBLIC_FAILURE },
    });
    /** Supplies the event label variants allowed by the package contract. */
    const event = eventRecord('metrics.event', {
      outcome: 'continued',
      error: PUBLIC_FAILURE,
      correlation: { workspaceId: uuid(43) },
      attributes: { path: '/private/high-cardinality' },
    });
    /** Uses the real SDK metric reader and exporter. */
    const harness = telemetryHarness();

    await harness.sink.write([span, event]);
    await harness.sink.flush();

    /** Reads all three stable instruments from one cumulative export. */
    const duration = exportedMetric(harness.metricExporter, 'archer.diagnostic.span.duration');
    /** Finds the terminal span counter after real SDK aggregation. */
    const spanCount = exportedMetric(harness.metricExporter, 'archer.diagnostic.span.count');
    /** Finds the point-event counter after real SDK aggregation. */
    const eventCount = exportedMetric(harness.metricExporter, 'archer.diagnostic.event.count');
    expect(duration.dataPointType).toBe(DataPointType.HISTOGRAM);
    if (duration.dataPointType !== DataPointType.HISTOGRAM) throw new Error('Expected histogram metric data');
    expect(duration.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 25, min: 25, max: 25 });
    expect(duration.dataPoints[0]?.attributes).toEqual({
      'archer.name': span.name,
      'archer.component': span.component,
      'archer.severity': span.severity,
      'archer.settlement': 'failed',
      'archer.outcome': 'refused',
      'archer.error_code': PUBLIC_FAILURE.code,
    });
    expect(spanCount.dataPointType).toBe(DataPointType.SUM);
    if (spanCount.dataPointType !== DataPointType.SUM) throw new Error('Expected span sum metric data');
    expect(spanCount.dataPoints[0]?.value).toBe(1);
    expect(spanCount.dataPoints[0]?.attributes).toEqual(duration.dataPoints[0]?.attributes);
    expect(eventCount.dataPointType).toBe(DataPointType.SUM);
    if (eventCount.dataPointType !== DataPointType.SUM) throw new Error('Expected event sum metric data');
    expect(eventCount.dataPoints[0]?.value).toBe(1);
    expect(eventCount.dataPoints[0]?.attributes).toEqual({
      'archer.name': event.name,
      'archer.component': event.component,
      'archer.severity': event.severity,
      'archer.outcome': 'continued',
      'archer.error_code': PUBLIC_FAILURE.code,
    });
  });

  it('projects a late parent before its retained child using the real SDK context', async () => {
    /** Creates child and parent records through separate legal span lifecycles. */
    const parent = await spanRecord({ name: 'graph.parent', spanId: uuid(50) });
    /** Settles before its explicit parent to reproduce ordinary terminal arrival. */
    const child = await spanRecord({
      name: 'graph.child',
      spanId: uuid(51),
      parentSpanId: parent.spanId,
    });
    /** Retains unresolved graph state until the parent arrives. */
    const harness = telemetryHarness();

    await harness.sink.write([child, parent]);
    await harness.sink.flush();

    /** Requires destination creation order to be parent before retained child. */
    const spans = harness.spanExporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([parent.name, child.name]);
    /** Proves real trace identity rather than matching Archer UUID strings. */
    const parentSpan = finishedSpan(harness.spanExporter, parent.name);
    /** Reads the child after its SDK parent has already ended and exported. */
    const childSpan = finishedSpan(harness.spanExporter, child.name);
    expect(childSpan.parentSpanContext).toMatchObject({
      traceId: parentSpan.spanContext().traceId,
      spanId: parentSpan.spanContext().spanId,
    });
    expect(parentSpan.spanContext().traceId).not.toBe(parent.spanId.replaceAll('-', ''));
    expect(childSpan.attributes['archer.parent_resolution']).toBeUndefined();
  });

  it('parents a late child from the bounded projected-context cache', async () => {
    /** Projects the parent before its child record exists at the sink. */
    const parent = await spanRecord({ name: 'late.parent', spanId: uuid(60) });
    /** Arrives only after the parent has already become a completed SDK span. */
    const child = await spanRecord({ name: 'late.child', spanId: uuid(61), parentSpanId: parent.spanId });
    /** Keeps enough projected context for this ordinary late-child case. */
    const harness = telemetryHarness();

    await harness.sink.write([parent]);
    await harness.lifecycle.forceFlush();
    await harness.sink.write([child]);
    await harness.sink.flush();

    /** Compares SDK-generated identity across separate sink writes. */
    const parentSpan = finishedSpan(harness.spanExporter, parent.name);
    /** Reads child parentage from the real exporter. */
    const childSpan = finishedSpan(harness.spanExporter, child.name);
    expect(childSpan.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
    expect(childSpan.parentSpanContext?.traceId).toBe(parentSpan.spanContext().traceId);
  });

  it('uses item pressure to project unresolved records without loss or reordering', async () => {
    /** Fills the one-item pending graph with the first unresolved child. */
    const first = await spanRecord({ name: 'pressure.item.first', spanId: uuid(70), parentSpanId: uuid(71) });
    /** Forces pressure before this second unrelated orphan can be retained. */
    const second = await spanRecord({ name: 'pressure.item.second', spanId: uuid(72), parentSpanId: uuid(73) });
    /** Selects one retained pending item while leaving byte capacity ample. */
    const harness = telemetryHarness({ pending: { capacityItems: 1, capacityBytes: 1_000_000 } });

    await harness.sink.write([first, second]);
    await harness.lifecycle.forceFlush();

    expect(harness.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([first.name]);
    expect(finishedSpan(harness.spanExporter, first.name).attributes).toMatchObject({
      'archer.parent_span_id': first.parentSpanId,
      'archer.parent_resolution': 'missing',
    });
    await harness.sink.flush();
    expect(harness.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([first.name, second.name]);
  });

  it('uses byte pressure to project an oversized unresolved record without loss', async () => {
    /** Carries enough admitted context to exceed the one-byte pending budget. */
    const orphan = await spanRecord({
      name: 'pressure.bytes',
      spanId: uuid(80),
      parentSpanId: uuid(81),
      attributes: { request: { toolCount: 12, provider: 'openai' } },
    });
    /** Makes every valid normalized record oversized without disabling the bound. */
    const harness = telemetryHarness({ pending: { capacityItems: 100, capacityBytes: 1 } });

    await harness.sink.write([orphan]);
    await harness.lifecycle.forceFlush();

    expect(harness.spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(finishedSpan(harness.spanExporter, orphan.name).attributes['archer.parent_resolution']).toBe('missing');
  });

  it('flushes an unresolved orphan as a marked root', async () => {
    /** Remains below ordinary bounds so only explicit flush can release it. */
    const orphan = await spanRecord({ name: 'flush.orphan', spanId: uuid(90), parentSpanId: uuid(91) });
    /** Uses default retention to distinguish flush from pressure behavior. */
    const harness = telemetryHarness();

    await harness.sink.write([orphan]);
    await harness.lifecycle.forceFlush();
    expect(harness.spanExporter.getFinishedSpans()).toHaveLength(0);
    await harness.sink.flush();

    /** Proves the source record survived with explicit hierarchy degradation. */
    const projected = finishedSpan(harness.spanExporter, orphan.name);
    expect(projected.parentSpanContext).toBeUndefined();
    expect(projected.attributes).toMatchObject({
      'archer.parent_span_id': orphan.parentSpanId,
      'archer.parent_resolution': 'missing',
    });
  });

  it('bounds projected contexts and marks a child whose cached parent was evicted', async () => {
    /** Becomes the oldest projected context and therefore the eviction target. */
    const firstParent = await spanRecord({ name: 'cache.parent.first', spanId: uuid(100) });
    /** Fills the one-item context cache after the first parent. */
    const secondParent = await spanRecord({ name: 'cache.parent.second', spanId: uuid(101) });
    /** Arrives after its first parent's SDK context has left the bounded cache. */
    const lateChild = await spanRecord({
      name: 'cache.child.evicted',
      spanId: uuid(102),
      parentSpanId: firstParent.spanId,
    });
    /** Retains only the newest projected SDK context. */
    const harness = telemetryHarness({ projectedContexts: { capacityItems: 1, capacityBytes: 1_000_000 } });

    await harness.sink.write([firstParent, secondParent, lateChild]);
    await harness.sink.flush();

    /** Confirms eviction loses hierarchy fidelity rather than the child record. */
    const childSpan = finishedSpan(harness.spanExporter, lateChild.name);
    expect(childSpan.parentSpanContext).toBeUndefined();
    expect(childSpan.attributes['archer.parent_resolution']).toBe('missing');
    expect(harness.spanExporter.getFinishedSpans()).toHaveLength(3);
  });

  it('applies projected-context byte pressure without fabricating late-child context', async () => {
    /** Projects normally but cannot fit its real SDK identity into a one-byte cache. */
    const parent = await spanRecord({ name: 'cache.bytes.parent', spanId: uuid(103) });
    /** Arrives after the real parent context was refused by the cache byte bound. */
    const child = await spanRecord({
      name: 'cache.bytes.child',
      spanId: uuid(104),
      parentSpanId: parent.spanId,
    });
    /** Makes every valid projected SDK context oversized. */
    const harness = telemetryHarness({ projectedContexts: { capacityItems: 100, capacityBytes: 1 } });

    await harness.sink.write([parent, child]);
    await harness.sink.flush();

    /** Requires hierarchy degradation rather than an Archer-UUID-derived parent. */
    const childSpan = finishedSpan(harness.spanExporter, child.name);
    expect(childSpan.parentSpanContext).toBeUndefined();
    expect(childSpan.attributes['archer.parent_resolution']).toBe('missing');
    expect(harness.spanExporter.getFinishedSpans()).toHaveLength(2);
  });

  it('breaks parent cycles and detects duplicate identities without hanging or loss', async () => {
    /** First half of a two-record explicit parent cycle. */
    const cycleA = await spanRecord({ name: 'cycle.a', spanId: uuid(110), parentSpanId: uuid(111) });
    /** Closes the cycle through a production-valid explicit parent field. */
    const cycleB = await spanRecord({ name: 'cycle.b', spanId: uuid(111), parentSpanId: uuid(110) });
    /** First record whose intentionally colliding factory identity owns child lookup. */
    const duplicateA = await spanRecord({ name: 'duplicate.first', spanId: uuid(112) });
    /** Repeats that production-generated identity without forging a record literal. */
    const duplicateB = await spanRecord({ name: 'duplicate.second', spanId: uuid(112) });
    /** Uses real exporter cardinality to detect both loss and duplicate projection. */
    const harness = telemetryHarness();

    await harness.sink.write([cycleA, cycleB, duplicateA, duplicateB]);
    await harness.sink.flush();

    /** Requires one destination observation for each source record. */
    const spans = harness.spanExporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([cycleA.name, cycleB.name, duplicateA.name, duplicateB.name]);
    expect(spans).toHaveLength(4);
    expect(finishedSpan(harness.spanExporter, cycleA.name).attributes['archer.parent_resolution']).toBe('missing');
    expect(finishedSpan(harness.spanExporter, cycleB.name).parentSpanContext?.spanId).toBe(
      finishedSpan(harness.spanExporter, cycleA.name).spanContext().spanId,
    );
    expect(finishedSpan(harness.spanExporter, duplicateB.name).attributes['archer.span_identity_resolution']).toBe(
      'duplicate',
    );
  });

  it('preserves source order for immediately projectable records and zero-duration events', async () => {
    /** First independent root in source order. */
    const first = await spanRecord({ name: 'order.first', spanId: uuid(120) });
    /** Point event whose zero duration must not change its position. */
    const point = eventRecord('order.point', { attributes: { signal: 'SIGTERM' } });
    /** Final independent root in source order. */
    const last = await spanRecord({ name: 'order.last', spanId: uuid(121) });
    /** Projects the ordered batch through one SDK processor. */
    const harness = telemetryHarness();

    await harness.sink.write([first, point, last]);
    await harness.sink.flush();

    expect(harness.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      first.name,
      point.name,
      last.name,
    ]);
    /** Reads the event after exact order has been established. */
    const eventSpan = finishedSpan(harness.spanExporter, point.name);
    expect(hrTimeMilliseconds(eventSpan.startTime)).toBe(Date.parse(EVENT_AT));
    expect(hrTimeMilliseconds(eventSpan.endTime)).toBe(Date.parse(EVENT_AT));
    expect(hrTimeMilliseconds(eventSpan.duration)).toBe(0);
    expect(eventSpan.attributes['archer.attributes']).toBe('{"signal":"SIGTERM"}');
  });

  it('keeps borrowed lifecycle authority and closes idempotently', async () => {
    /** Leaves SDK shutdown authority with the fixture owner. */
    const harness = telemetryHarness();
    /** Starts retained closure once. */
    const firstClose = harness.sink.close();
    /** Repeats close before settlement to prove promise identity and no second flush. */
    const secondClose = harness.sink.close();

    expect(firstClose).toBe(harness.sink.closed);
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toEqual({ kind: 'closed' });
    expect(harness.lifecycle.forceFlushCalls).toBe(1);
    expect(harness.lifecycle.closeCalls).toBe(0);
  });

  it('rejects flush after close starts without touching the borrowed lifecycle', async () => {
    /** Holds the close-owned SDK flush at a deterministic asynchronous boundary. */
    let releaseFlush!: () => void;
    /** Settles only when this test has invoked flush in the closing state. */
    const forceFlushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    /** Uses a real borrowed SDK lifecycle behind the controlled gate. */
    const harness = telemetryHarness();
    harness.lifecycle.forceFlushGate = forceFlushGate;

    /** Moves the sink to closing synchronously before the lifecycle flush settles. */
    const close = harness.sink.close();
    /** Attaches rejection handling before releasing either concurrent operation. */
    const lateFlushFailure = rejectedAdapterOperation(harness.sink.flush());
    releaseFlush();
    /** Awaits both operations so the red case cannot leave provider work running. */
    const settlements = await Promise.allSettled([close, lateFlushFailure]);

    expect(settlements[0]).toEqual({ status: 'fulfilled', value: { kind: 'closed' } });
    expect(settlements[1]).toMatchObject({
      status: 'fulfilled',
      value: {
        name: 'OpenTelemetrySinkError',
        code: 'opentelemetry_sink_closed',
        message: 'OpenTelemetry diagnostic sink is closing or closed',
      },
    });
    expect(harness.lifecycle.forceFlushCalls).toBe(1);
  });

  it('rejects flush after close settles without touching the borrowed lifecycle', async () => {
    /** Closes one borrowed sink completely before probing the closed transition. */
    const harness = telemetryHarness();
    await harness.sink.close();
    /** Captures the closed-state refusal without calling the operation twice. */
    const failure = await rejectedAdapterOperation(harness.sink.flush());

    expect(failure).toMatchObject({
      code: 'opentelemetry_sink_closed',
      message: 'OpenTelemetry diagnostic sink is closing or closed',
    });
    expect(failure.cause).toBeUndefined();
    expect(harness.lifecycle.forceFlushCalls).toBe(1);
  });

  it('rejects writes after close settles with the same stable state failure', async () => {
    /** Closes one borrowed sink before supplying a production-normalized event. */
    const harness = telemetryHarness();
    await harness.sink.close();
    /** Calls the ordinary public write boundary in its closed state. */
    const failure = await rejectedAdapterOperation(harness.sink.write([eventRecord('closed.write')]));

    expect(failure).toMatchObject({
      code: 'opentelemetry_sink_closed',
      message: 'OpenTelemetry diagnostic sink is closing or closed',
    });
    expect(failure.cause).toBeUndefined();
    expect(harness.lifecycle.forceFlushCalls).toBe(1);
  });

  it('flushes and closes an owned lifecycle exactly once', async () => {
    /** Transfers SDK shutdown authority to the retained adapter. */
    const harness = telemetryHarness({ ownedLifecycle: true });

    await expect(harness.sink.close()).resolves.toEqual({ kind: 'closed' });
    await expect(harness.sink.close()).resolves.toEqual({ kind: 'closed' });

    expect(harness.lifecycle.forceFlushCalls).toBe(1);
    expect(harness.lifecycle.closeCalls).toBe(1);
  });

  it('projects a pending orphan during close before flushing the borrowed lifecycle', async () => {
    /** Remains unresolved until retained sink close starts. */
    const orphan = await spanRecord({ name: 'close.orphan', spanId: uuid(122), parentSpanId: uuid(123) });
    /** Keeps SDK shutdown borrowed while close still owns projection and flush. */
    const harness = telemetryHarness();

    await harness.sink.write([orphan]);
    await expect(harness.sink.close()).resolves.toEqual({ kind: 'closed' });

    /** Confirms close cannot discard the final unresolved record. */
    expect(finishedSpan(harness.spanExporter, orphan.name).attributes['archer.parent_resolution']).toBe('missing');
    expect(harness.lifecycle.forceFlushCalls).toBe(1);
    expect(harness.lifecycle.closeCalls).toBe(0);
  });

  it('returns bounded redacted close evidence for flush and owned-close failures', async () => {
    /** Uses a real SDK flush before raising private exporter text. */
    const flushHarness = telemetryHarness();
    flushHarness.lifecycle.failForceFlush = true;
    /** Captures public failure data returned rather than a rejected retained close. */
    const flushEvidence = await flushHarness.sink.close();

    expect(flushEvidence).toMatchObject({
      kind: 'failed',
      failure: {
        kind: 'protocol-failure',
        code: 'opentelemetry_flush_failed',
        message: 'OpenTelemetry flush failed',
        retryable: false,
      },
    });
    expect(JSON.stringify(flushEvidence)).not.toContain('credential token');

    /** Uses real provider shutdown before raising private close text. */
    const closeHarness = telemetryHarness({ ownedLifecycle: true });
    closeHarness.lifecycle.failClose = true;
    /** Captures the adapter-owned redacted teardown evidence. */
    const closeEvidence = await closeHarness.sink.close();
    expect(closeEvidence).toMatchObject({
      kind: 'failed',
      failure: {
        kind: 'protocol-failure',
        code: 'opentelemetry_close_failed',
        message: 'OpenTelemetry close failed',
        retryable: false,
      },
    });
    expect(JSON.stringify(closeEvidence)).not.toContain('authorization header');

    /** Returns dependency-owned failed evidence containing details the adapter must discard. */
    const evidenceHarness = telemetryHarness({ ownedLifecycle: true });
    evidenceHarness.lifecycle.closeEvidence = Object.freeze({
      kind: 'failed',
      failure: Object.freeze({
        kind: 'protocol-failure',
        code: 'sdk_exporter_refused_secret',
        message: 'Credential from /var/lib/collector/exporter.json was refused',
        retryable: true,
        details: Object.freeze({ exporter: 'private-tenant-exporter' }),
      }),
    });
    /** Captures adapter-owned evidence rather than passing dependency identity through. */
    const returnedEvidence = await evidenceHarness.sink.close();
    expect(returnedEvidence).toMatchObject({
      kind: 'failed',
      failure: {
        kind: 'protocol-failure',
        code: 'opentelemetry_close_failed',
        message: 'OpenTelemetry close failed',
        retryable: false,
      },
    });
    expect(JSON.stringify(returnedEvidence)).not.toContain('Credential');
    expect(JSON.stringify(returnedEvidence)).not.toContain('/var/lib');
    expect(JSON.stringify(returnedEvidence)).not.toContain('private-tenant-exporter');
  });

  it('uses stable redacted Archer errors for projection and direct flush failures', async () => {
    /** Supplies a production-reachable record to the failing projection boundary. */
    const record = await spanRecord({ name: 'failure.projection', spanId: uuid(124) });
    /** Owns real providers while replacing only the SDK call that rejects projection. */
    const projectionHarness = telemetryHarness();
    /** Throws private dependency text only when the adapter creates a destination span. */
    const tracer = new Proxy(projectionHarness.lifecycle.tracerProvider.getTracer('projection-failure'), {
      /**
       * Preserves the real tracer except for the one method whose rejection is under test.
       * @param target - Real SDK tracer receiving every unaffected property lookup.
       * @param property - Tracer member requested by the adapter.
       * @param receiver - Proxy receiver preserving ordinary property semantics.
       * @returns The failing start method or the real tracer member.
       */
      get(target, property, receiver) {
        if (property === 'startSpan') {
          return () => {
            throw new Error('private credential at /srv/exporters/trace.ts');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    /** Creates the public adapter over real metric and lifecycle dependencies. */
    const projectionSink = openTelemetrySink({
      tracer,
      meter: projectionHarness.lifecycle.meterProvider.getMeter('projection-failure'),
      flushLifecycle: borrowed(projectionHarness.lifecycle),
    });
    /** Captures one public write rejection without losing its focused Error identity. */
    const projectionFailure = await rejectedAdapterOperation(projectionSink.write([record]));
    expect(projectionFailure).toMatchObject({
      code: 'opentelemetry_projection_failed',
      message: 'OpenTelemetry diagnostic projection failed',
    });
    expect(projectionFailure.cause).toBeUndefined();
    expect(JSON.stringify(projectionFailure)).not.toContain('credential');
    expect(JSON.stringify(projectionFailure)).not.toContain('/srv/exporters');
    await projectionSink.close();

    /** Uses real provider flush before its lifecycle raises private exporter text. */
    const flushHarness = telemetryHarness();
    flushHarness.lifecycle.failForceFlush = true;
    /** Captures the direct flush rejection rather than close evidence. */
    const flushFailure = await rejectedAdapterOperation(flushHarness.sink.flush());
    expect(flushFailure).toMatchObject({
      code: 'opentelemetry_flush_failed',
      message: 'OpenTelemetry flush failed',
    });
    expect(flushFailure.cause).toBeUndefined();
    expect(JSON.stringify(flushFailure)).not.toContain('credential token');
    flushHarness.lifecycle.failForceFlush = false;
    await flushHarness.sink.close();
  });

  it('uses stable redacted Archer errors for invalid bounds and SDK construction failures', () => {
    /** Supplies real API values while isolating configuration admission. */
    const harness = telemetryHarness();
    /** Reuses the harness providers but constructs independent invalid adapters. */
    const tracer = harness.lifecycle.tracerProvider.getTracer('invalid-bounds');
    /** Reuses the real meter without needing another reader or exporter. */
    const meter = harness.lifecycle.meterProvider.getMeter('invalid-bounds');

    /** Changes only the pending item bound from a valid adapter configuration. */
    const itemFailure = rejectedAdapterConstruction(() =>
      openTelemetrySink({
        tracer,
        meter,
        flushLifecycle: borrowed(harness.lifecycle),
        pending: { capacityItems: 0 },
      }),
    );
    expect(itemFailure).toMatchObject({
      code: 'opentelemetry_configuration_invalid',
      message: 'OpenTelemetry pending.capacityItems must be a positive safe integer',
    });
    expect(itemFailure.cause).toBeUndefined();

    /** Changes only the projected-context byte bound from a valid configuration. */
    const byteFailure = rejectedAdapterConstruction(() =>
      openTelemetrySink({
        tracer,
        meter,
        flushLifecycle: borrowed(harness.lifecycle),
        projectedContexts: { capacityBytes: Number.MAX_SAFE_INTEGER + 1 },
      }),
    );
    expect(byteFailure).toMatchObject({
      code: 'opentelemetry_configuration_invalid',
      message: 'OpenTelemetry projectedContexts.capacityBytes must be a positive safe integer',
    });
    expect(byteFailure.cause).toBeUndefined();

    /** Replaces only SDK instrument creation while keeping a real Meter boundary. */
    const failingMeter = new Proxy<Meter>(meter, {
      /**
       * Preserves the real meter except for constructor-time histogram creation.
       * @param target - Real SDK meter receiving every unaffected property lookup.
       * @param property - Meter member requested during adapter construction.
       * @param receiver - Proxy receiver preserving ordinary property semantics.
       * @returns The failing histogram factory or the real meter member.
       */
      get(target, property, receiver) {
        if (property === 'createHistogram') {
          return () => {
            throw new Error('exporter token from /etc/archer/collector.yaml');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    /** Proves SDK construction faults follow the same adapter-owned policy. */
    const sdkFailure = rejectedAdapterConstruction(() =>
      openTelemetrySink({ tracer, meter: failingMeter, flushLifecycle: borrowed(harness.lifecycle) }),
    );
    expect(sdkFailure).toMatchObject({
      code: 'opentelemetry_configuration_invalid',
      message: 'OpenTelemetry sink configuration failed',
    });
    expect(sdkFailure.cause).toBeUndefined();
    expect(JSON.stringify(sdkFailure)).not.toContain('exporter token');
    expect(JSON.stringify(sdkFailure)).not.toContain('/etc/archer');
  });
});
