/**
 * @file Proves the Pino adapter preserves normalized diagnostic meaning while
 * respecting destination ownership and retained sink lifecycle.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PublicErrorSchema,
  UuidV4Schema,
  borrowed,
  owned,
  type DiagnosticRecord,
  type DiagnosticSeverity,
  type OwnedHandle,
} from '@archer/core';
import { createDiagnosticEvent, createDiagnostics } from '@archer/core/diagnostics';
import { describe, expect, it } from 'vitest';

import { PinoSinkError, pinoSink, type PinoSinkDestination, type PinoSinkLogger } from '../src/pino/index.js';

/** Absolute package root used to build and pack the declaration fixture. */
const OBSERVABILITY_PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Absolute repository root used to locate the packed core dependency. */
const REPOSITORY_ROOT = resolve(OBSERVABILITY_PACKAGE_ROOT, '../..');

/** Exact supported injected-logger consumer program compiled from the packed package. */
const PACKED_CONSUMER_SOURCE = `import { borrowed } from '@archer/core';
import { pinoSink } from '@archer/observability/pino';
import pino from 'pino';

const logger = pino({ base: null });
pinoSink({ logger: borrowed(logger) });
`;

/** Strict Node 26 declaration settings that previously exposed TS2694. */
const PACKED_CONSUMER_TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ES2024", "ESNext.Disposable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "skipLibCheck": false,
    "strict": true,
    "target": "ES2024",
    "types": ["node"]
  },
  "include": ["index.ts"]
}
`;

/** Process evidence retained from the clean packed-consumer TypeScript compile. */
type PackedConsumerCompile = Readonly<{
  /** Emitted public Pino entrypoint read back from the extracted npm archive. */
  indexDeclaration: string;

  /** Native compiler exit status, which must be zero for declaration compatibility. */
  status: number | null;

  /** Normalized compiler output with the randomized temporary path removed. */
  output: string;

  /** Emitted adapter-owned Node compatibility module read back from the archive. */
  workerThreadsDeclaration: string;
}>;

/**
 * Converts one spawned text command result into stable combined diagnostic output.
 * @param result - Synchronous process result captured with UTF-8 encoding.
 * @param temporaryRoot - Randomized fixture root replaced before assertion.
 * @returns Trimmed stdout and stderr suitable for deterministic failure evidence.
 */
function commandOutput(result: SpawnSyncReturns<string>, temporaryRoot: string): string {
  return `${result.stdout}${result.stderr}`.replaceAll(temporaryRoot, '<packed-consumer>').trim();
}

/**
 * Runs one fixture setup command and stops before the compiler assertion if setup itself failed.
 * @param command - Executable resolved through the test process PATH.
 * @param arguments_ - Exact non-shell arguments supplied to the executable.
 * @param cwd - Directory that owns the command's package or extraction context.
 * @param temporaryRoot - Randomized fixture root removed from any setup failure.
 * @returns The successful command result for callers that need its output.
 */
function runFixtureCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  temporaryRoot: string,
): SpawnSyncReturns<string> {
  /** Runs without a shell so fixture paths and package names cannot become commands. */
  const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Packed-consumer setup failed: ${command}\n${commandOutput(result, temporaryRoot)}`);
  }
  return result;
}

/**
 * Packs one Archer workspace package and identifies only the tarball created by that command.
 * @param packageRoot - Workspace package whose published files form the consumer boundary.
 * @param artifactDirectory - Empty-or-shared temporary directory receiving tarballs.
 * @param temporaryRoot - Randomized fixture root removed from setup failures.
 * @returns Absolute path to the newly created npm package tarball.
 */
function packWorkspacePackage(packageRoot: string, artifactDirectory: string, temporaryRoot: string): string {
  /** Snapshots existing artifacts so two scoped Archer packages may share one directory. */
  const before = new Set(readdirSync(artifactDirectory));
  runFixtureCommand(
    'npm',
    ['pack', '--ignore-scripts', '--cache', join(temporaryRoot, 'npm-cache'), '--pack-destination', artifactDirectory],
    packageRoot,
    temporaryRoot,
  );
  /** Finds the sole tarball added by this package operation. */
  const archive = readdirSync(artifactDirectory).find((entry) => entry.endsWith('.tgz') && !before.has(entry));
  if (archive === undefined) throw new Error(`Packed-consumer setup failed: npm pack produced no archive`);
  return join(artifactDirectory, archive);
}

/**
 * Extracts one npm archive directly into its clean consumer package location.
 * @param archive - Tarball returned by npm pack.
 * @param packageDirectory - Scoped node_modules directory representing installation.
 * @param temporaryRoot - Randomized fixture root removed from setup failures.
 */
function extractPackedPackage(archive: string, packageDirectory: string, temporaryRoot: string): void {
  mkdirSync(packageDirectory, { recursive: true });
  runFixtureCommand(
    'tar',
    ['-xzf', archive, '--strip-components=1', '-C', packageDirectory],
    temporaryRoot,
    temporaryRoot,
  );
}

/**
 * Builds declarations, installs packed Archer packages into an isolated consumer, and runs strict TypeScript.
 * Real Pino and Node 26 types are linked from the package's installed baseline so only Archer is under test.
 * @returns Exact compiler status and deterministic output after fixture cleanup.
 */
function compilePackedConsumer(): PackedConsumerCompile {
  /** Owns every generated archive, extracted package, source file, and compiler artifact. */
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'archer-pino-packed-consumer-'));
  try {
    /** Mirrors the publishable observability inputs without writing into the working package. */
    const stagedObservabilityRoot = join(temporaryRoot, 'staged-observability');
    mkdirSync(stagedObservabilityRoot);
    cpSync(join(OBSERVABILITY_PACKAGE_ROOT, 'package.json'), join(stagedObservabilityRoot, 'package.json'));
    cpSync(join(OBSERVABILITY_PACKAGE_ROOT, 'README.md'), join(stagedObservabilityRoot, 'README.md'));
    cpSync(join(OBSERVABILITY_PACKAGE_ROOT, 'src'), join(stagedObservabilityRoot, 'src'), { recursive: true });
    /** Emits fresh declarations only into staging so stale or concurrently built dist cannot affect the proof. */
    runFixtureCommand(
      resolve(OBSERVABILITY_PACKAGE_ROOT, 'node_modules/.bin/tsc'),
      [
        '-p',
        'tsconfig.build.json',
        '--outDir',
        join(stagedObservabilityRoot, 'dist'),
        '--declarationDir',
        join(stagedObservabilityRoot, 'dist'),
      ],
      OBSERVABILITY_PACKAGE_ROOT,
      temporaryRoot,
    );
    /** Separates package archives from their extracted consumer installation. */
    const artifactDirectory = join(temporaryRoot, 'artifacts');
    mkdirSync(artifactDirectory);
    /** Packs the exact observability files selected by its package manifest. */
    const observabilityArchive = packWorkspacePackage(stagedObservabilityRoot, artifactDirectory, temporaryRoot);
    /** Packs core so borrowed ownership resolves through a published declaration boundary too. */
    const coreArchive = packWorkspacePackage(
      resolve(REPOSITORY_ROOT, 'packages/core'),
      artifactDirectory,
      temporaryRoot,
    );
    /** Owns the isolated TypeScript project and installed package graph. */
    const consumerRoot = join(temporaryRoot, 'consumer');
    /** Holds both scoped Archer packages exactly where NodeNext package resolution expects them. */
    const archerModules = join(consumerRoot, 'node_modules/@archer');
    mkdirSync(archerModules, { recursive: true });
    extractPackedPackage(observabilityArchive, join(archerModules, 'observability'), temporaryRoot);
    extractPackedPackage(coreArchive, join(archerModules, 'core'), temporaryRoot);
    /** Reads the installed public entrypoint rather than trusting the staging tree. */
    const indexDeclaration = readFileSync(join(archerModules, 'observability/dist/pino/index.d.ts'), 'utf8');
    /** Reads the installed compatibility declaration that the public entrypoint must retain. */
    const workerThreadsDeclaration = readFileSync(
      join(archerModules, 'observability/dist/pino/worker-threads.d.ts'),
      'utf8',
    );
    /** Links the real pinned Pino installation, including its thread-stream dependency graph. */
    symlinkSync(resolve(OBSERVABILITY_PACKAGE_ROOT, 'node_modules/pino'), join(consumerRoot, 'node_modules/pino'));
    /** Links every ordinary core dependency exposed through its root declaration graph. */
    symlinkSync(resolve(REPOSITORY_ROOT, 'packages/core/node_modules/rxjs'), join(consumerRoot, 'node_modules/rxjs'));
    symlinkSync(resolve(REPOSITORY_ROOT, 'packages/core/node_modules/zod'), join(consumerRoot, 'node_modules/zod'));
    /** Links the repository's exact Node 26.2.0 declaration baseline. */
    const typeModules = join(consumerRoot, 'node_modules/@types');
    mkdirSync(typeModules);
    symlinkSync(resolve(OBSERVABILITY_PACKAGE_ROOT, 'node_modules/@types/node'), join(typeModules, 'node'));
    /** Marks the consumer as ESM so its source matches the supported package import path. */
    writeFileSync(join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
    /** Writes the exact injected-logger example reproduced by independent acceptance. */
    writeFileSync(join(consumerRoot, 'index.ts'), PACKED_CONSUMER_SOURCE);
    /** Writes strict settings explicitly, including the required false skipLibCheck value. */
    writeFileSync(join(consumerRoot, 'tsconfig.json'), PACKED_CONSUMER_TSCONFIG);
    /** Compiles through installed package exports rather than source paths or workspace aliases. */
    const compile = spawnSync(
      resolve(OBSERVABILITY_PACKAGE_ROOT, 'node_modules/.bin/tsc'),
      ['-p', 'tsconfig.json', '--pretty', 'false'],
      { cwd: consumerRoot, encoding: 'utf8' },
    );
    return Object.freeze({
      indexDeclaration,
      status: compile.status,
      output: commandOutput(compile, temporaryRoot),
      workerThreadsDeclaration,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Immutable success evidence returned by retained recording resources. */
type ResourceCloseEvidence = Readonly<{
  /** Confirms the fixture resource completed its owned close operation. */
  kind: 'closed';
}>;

/** Failure controls for one recording Pino destination. */
type RecordingDestinationOptions = Readonly<{
  /** Selects the one-indexed write call that rejects, when present. */
  failWriteAt?: number;

  /** Counts callback flush failures before later flushes may succeed. */
  flushFailures?: number;

  /** Makes retained close reject after recording the attempt. */
  closeFailure?: boolean;
}>;

/** Minimal decoded Pino envelope needed for exact projection assertions. */
type RecordedPinoLine = Readonly<{
  /** Numeric Pino level selected by the Archer severity call. */
  level: number;

  /** Destination-ingestion time owned by Pino rather than Archer. */
  time: number;

  /** Complete normalized record nested without a second adapter schema. */
  archer: DiagnosticRecord;

  /** Human-readable Pino message copied from the stable record name. */
  msg: string;
}>;

/** Numeric Pino levels expected from the four Archer severity methods. */
const PINO_LEVEL_BY_SEVERITY: Readonly<Record<DiagnosticSeverity, number>> = Object.freeze({
  /** Pino's standard debug level. */
  debug: 20,
  /** Pino's standard informational level. */
  info: 30,
  /** Pino's standard warning level. */
  warn: 40,
  /** Pino's standard error level. */
  error: 50,
});

/**
 * Records real Pino serialization and exposes explicit flush and close behavior.
 * The destination stays deliberately small so tests can see every handoff.
 */
class RecordingDestination implements PinoSinkDestination, OwnedHandle<ResourceCloseEvidence> {
  /** Retains successful newline-delimited Pino writes in destination order. */
  readonly lines: string[] = [];

  /** Retains write, flush, and close attempts in exact call order. */
  readonly operations: string[] = [];

  /** Settles only after this fixture's retained close path succeeds. */
  readonly closed: Promise<ResourceCloseEvidence>;

  /** Failure policy injected for the individual test that names it. */
  readonly #options: RecordingDestinationOptions;

  /** Resolves the one retained close promise after successful teardown. */
  readonly #settleClosed: (evidence: ResourceCloseEvidence) => void;

  /** Counts destination writes independently of successful retention. */
  #writeCalls = 0;

  /** Counts callback flush attempts for retry and close-order proofs. */
  #flushCalls = 0;

  /** Counts retained close attempts to prove sink idempotence. */
  #closeCalls = 0;

  /**
   * Creates one recording boundary with an optional single-axis failure.
   * @param options - Exact write, flush, or close failure selected by the test.
   */
  constructor(options: RecordingDestinationOptions = {}) {
    this.#options = options;
    /** Captures one native promise resolver for stable close identity. */
    let settle: ((evidence: ResourceCloseEvidence) => void) | undefined;
    this.closed = new Promise((resolve) => {
      settle = resolve;
    });
    /**
     * Freezes fixture evidence before any close waiter observes it.
     * @param evidence - Normal fixture resource settlement.
     * @returns Nothing after resolving the retained promise.
     */
    this.#settleClosed = (evidence) => settle?.(Object.freeze(evidence));
  }

  /**
   * Exposes exact destination write-attempt cardinality.
   * @returns The number of Pino destination write calls.
   */
  get writeCalls(): number {
    return this.#writeCalls;
  }

  /**
   * Exposes exact callback flush-attempt cardinality.
   * @returns The number of Pino callback flush calls.
   */
  get flushCalls(): number {
    return this.#flushCalls;
  }

  /**
   * Exposes exact retained close-attempt cardinality.
   * @returns The number of retained resource close calls.
   */
  get closeCalls(): number {
    return this.#closeCalls;
  }

  /**
   * Receives one fully serialized Pino line and optionally rejects that handoff.
   * @param line - Newline-delimited JSON produced by the real Pino logger.
   */
  write(line: string): void {
    this.#writeCalls += 1;
    this.operations.push(`write:${this.#writeCalls}`);
    if (this.#options.failWriteAt === this.#writeCalls) {
      throw new Error('private recording destination write detail');
    }
    this.lines.push(line);
  }

  /**
   * Implements Pino's callback flush contract with deterministic failure counts.
   * @param callback - Pino callback settled by this recording boundary.
   */
  flush(callback?: (error?: Error) => unknown): void {
    this.#flushCalls += 1;
    this.operations.push('flush');
    if (this.#flushCalls <= (this.#options.flushFailures ?? 0)) {
      callback?.(new Error('private recording destination flush detail'));
      return;
    }
    callback?.();
  }

  /**
   * Starts retained destination teardown once the sink has flushed accepted writes.
   * @returns Shared close evidence or a fixture-selected native rejection.
   */
  close(): Promise<ResourceCloseEvidence> {
    this.#closeCalls += 1;
    this.operations.push('close');
    if (this.#options.closeFailure === true) {
      return Promise.reject(new Error('private recording destination close detail'));
    }
    this.#settleClosed({ kind: 'closed' });
    return this.closed;
  }

  /** Delegates fixture disposal to the same retained close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Decodes every successful recording destination write.
 * @param destination - Recording destination populated by real Pino.
 * @returns Parsed envelopes in destination order.
 */
function recordedLines(destination: RecordingDestination): readonly RecordedPinoLine[] {
  return destination.lines.map((line) => JSON.parse(line) as RecordedPinoLine);
}

/**
 * Creates one deterministic production-normalized point event.
 * @param name - Stable event identity visible in Pino's message.
 * @param severity - Archer severity that chooses the Pino method.
 * @returns A frozen DiagnosticEventRecord admitted by core.
 */
function pointRecord(name: string, severity: DiagnosticSeverity = 'info'): DiagnosticRecord {
  return createDiagnosticEvent(
    {
      name,
      severity,
      component: 'observability.fixture',
      correlation: {},
      attributes: { fixture: { sequence: name } },
    },
    () => new Date('2026-08-22T01:02:03.004Z'),
  );
}

/**
 * Produces every terminal span settlement and every point-event severity through core behavior.
 * @returns Frozen production-reachable records in a recognizable expected order.
 */
async function productionRecords(): Promise<readonly DiagnosticRecord[]> {
  /** Supplies stable process-local identities through the same span factory used in production. */
  const spanIds = [
    UuidV4Schema.parse('00000000-0000-4000-8000-000000000201'),
    UuidV4Schema.parse('00000000-0000-4000-8000-000000000202'),
    UuidV4Schema.parse('00000000-0000-4000-8000-000000000203'),
  ];
  /** Owns the three span lifecycles until each earns one terminal state. */
  const diagnostics = createDiagnostics({
    /**
     * Keeps wall timing deterministic across all fixture transitions.
     * @returns The fixed wall instant used by each span transition.
     */
    now: () => new Date('2026-08-22T01:02:03.004Z'),
    /**
     * Keeps elapsed timing deterministic without sleeping.
     * @returns The fixed monotonic millisecond reading.
     */
    monotonicNow: () => 125,
    /**
     * Returns the next controlled process-local span identity.
     * @returns A valid UUIDv4 fixture in admission order.
     */
    createSpanId: () => spanIds.shift() ?? UuidV4Schema.parse('00000000-0000-4000-8000-000000000204'),
  });
  /** Earns the completed settlement through DiagnosticSpan behavior. */
  const completed = diagnostics
    .beginSpan({
      name: 'model.step',
      component: 'models.ai-sdk',
      correlation: {},
      attributes: { model: { provider: 'openai' } },
    })
    .complete({ outcome: 'completed', severity: 'debug' });
  if (!completed.ok) throw completed.error;
  /** Supplies already-redacted failure evidence admitted by the core schema. */
  const failure = PublicErrorSchema.parse({
    code: 'tool_failed',
    message: 'Tool invocation failed',
    retryable: false,
  });
  /** Earns the failed settlement through DiagnosticSpan behavior. */
  const failed = diagnostics
    .beginSpan({
      name: 'tool.invoke',
      component: 'agent.tools',
      correlation: {},
      attributes: { tool: { name: 'read_file' } },
    })
    .fail({ outcome: 'failed', error: failure });
  if (!failed.ok) throw failed.error;
  /** Earns the abandoned settlement through DiagnosticSpan behavior. */
  const abandoned = diagnostics
    .beginSpan({
      name: 'sandbox.execute',
      component: 'sandbox.runtime',
      correlation: {},
      attributes: { sandbox: { backend: 'local' } },
    })
    .abandon({ reason: 'shutdown' });
  if (!abandoned.ok) throw abandoned.error;
  /** Produces every point severity through the normal event constructor. */
  const events = (['debug', 'info', 'warn', 'error'] as const).map((severity) =>
    diagnostics.event({
      name: `runtime.point.${severity}`,
      severity,
      component: 'runtime.process',
      correlation: {},
      attributes: { signal: severity },
      ...(severity === 'error' ? { error: failure, outcome: 'refused' } : {}),
    }),
  );
  await diagnostics.close();
  return Object.freeze([completed.value, failed.value, abandoned.value, ...events]);
}

/**
 * Records the focused injected-logger contract while retaining an explicit outer lifecycle.
 * Destination-injection tests separately exercise real Pino serialization.
 */
class RecordingLogger implements PinoSinkLogger, OwnedHandle<ResourceCloseEvidence> {
  /** Projects debug calls through the same recording path as every other level. */
  readonly debug: PinoSinkLogger['debug'];

  /** Projects informational calls through the same recording path as every other level. */
  readonly info: PinoSinkLogger['info'];

  /** Projects warning calls through the same recording path as every other level. */
  readonly warn: PinoSinkLogger['warn'];

  /** Projects error calls through the same recording path as every other level. */
  readonly error: PinoSinkLogger['error'];

  /** Exposes retained outer logger settlement independently of its nested destination. */
  readonly closed: Promise<ResourceCloseEvidence>;

  /** Receives focused logger calls without granting direct destination ownership. */
  readonly #destination: RecordingDestination;

  /** Selects a private native rejection from the retained outer close path. */
  readonly #failClose: boolean;

  /** Resolves the retained outer logger lifecycle after successful close. */
  readonly #settleClosed: (evidence: ResourceCloseEvidence) => void;

  /** Counts flush calls independently of the nested destination lifecycle. */
  #flushCalls = 0;

  /**
   * Creates one production-shaped logger boundary with explicit retained ownership.
   * @param destination - Recording resource nested opaquely inside this logger.
   * @param failClose - Selects a private retained logger close rejection.
   */
  constructor(destination: RecordingDestination, failClose = false) {
    this.#destination = destination;
    this.#failClose = failClose;
    /** Binds each standard level to the shared exact recording behavior. */
    this.debug = this.#level(20);
    this.info = this.#level(30);
    this.warn = this.#level(40);
    this.error = this.#level(50);
    /** Captures one resolver for the retained logger lifecycle. */
    let settle: ((evidence: ResourceCloseEvidence) => void) | undefined;
    this.closed = new Promise((resolve) => {
      settle = resolve;
    });
    /**
     * Freezes outer logger evidence before resolving the retained lifecycle.
     * @param evidence - Normal retained logger settlement.
     * @returns Nothing after resolving the retained promise.
     */
    this.#settleClosed = (evidence) => settle?.(Object.freeze(evidence));
  }

  /**
   * Exposes logger flush cardinality without observing nested destination lifecycle.
   * @returns The number of focused logger flush calls.
   */
  get flushCalls(): number {
    return this.#flushCalls;
  }

  /**
   * Records a logger-owned flush without claiming direct destination flush authority.
   * @param callback - Pino-compatible completion callback.
   */
  flush(callback?: (error?: Error) => void): void {
    this.#flushCalls += 1;
    this.#destination.operations.push('logger-flush');
    callback?.();
  }

  /**
   * Closes the explicitly owned outer logger handle and leaves nested policy opaque.
   * @returns Shared close evidence or the selected private fixture rejection.
   */
  close(): Promise<ResourceCloseEvidence> {
    this.#destination.operations.push('logger-close');
    if (this.#failClose) return Promise.reject(new Error('private retained logger close detail'));
    this.#settleClosed({ kind: 'closed' });
    return this.closed;
  }

  /** Delegates fixture disposal to the retained outer logger close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Creates one focused logger method that records exact object and message projection.
   * @param level - Numeric Pino severity represented by the returned method.
   * @returns A Pino-compatible logging function bound to this recording logger.
   */
  #level(level: number): PinoSinkLogger['info'] {
    return ((object: unknown, message?: string): void => {
      this.#destination.write(`${JSON.stringify({ level, time: 0, ...(object as object), msg: message })}\n`);
    }) as PinoSinkLogger['info'];
  }
}

describe('pinoSink', () => {
  it('compiles the supported real Pino logger injection from the packed declaration graph', () => {
    /** Runs the strict consumer as the public package-boundary behavior under test. */
    const compile = compilePackedConsumer();

    expect(compile.indexDeclaration).toContain("export type {} from './worker-threads.js';");
    expect(compile.workerThreadsDeclaration).toContain("declare module 'worker_threads'");
    expect(compile.workerThreadsDeclaration).toContain('type TransferListItem = Transferable;');
    expect({ status: compile.status, output: compile.output }).toEqual({ status: 0, output: '' });
  });

  it('projects every terminal settlement and point severity exactly once in batch order without mutation', async () => {
    /** Uses a real Pino destination while leaving its lifecycle with the test. */
    const destination = new RecordingDestination();
    /** Enables all four diagnostic severities for exact destination observation. */
    const sink = pinoSink({ destination: borrowed(destination), level: 'trace' });
    /** Builds all behavior-bearing records through core constructors and transitions. */
    const records = await productionRecords();
    /** Preserves the complete normalized graph for post-projection non-mutation proof. */
    const before = structuredClone(records);
    /** Leaves the caller's array mutable to prove sink-owned batch admission. */
    const batch = [...records];

    /** Starts projection before caller-owned batch order changes. */
    const write = sink.write(batch);
    batch.reverse();
    await write;

    /** Decodes only after Pino has serialized the complete accepted batch. */
    const lines = recordedLines(destination);
    expect(lines).toHaveLength(records.length);
    expect(lines.map((line) => line.msg)).toEqual(records.map((record) => record.name));
    /** Proves every accepted source position produces its exact one-line projection. */
    for (const [index, line] of lines.entries()) {
      /** Uses accepted-order indexing so one extra breadcrumb fails every later projection. */
      const record = records[index];
      expect(record).toBeDefined();
      if (record === undefined) continue;
      expect(line.level).toBe(PINO_LEVEL_BY_SEVERITY[record.severity]);
      expect(line.archer).toEqual(record);
      expect(line.msg).toBe(record.name);
      expect(Object.keys(line).sort()).toEqual(['archer', 'level', 'msg', 'time']);
    }
    expect(records.filter((record) => record.kind === 'span').map((record) => record.settlement.kind)).toEqual([
      'completed',
      'failed',
      'abandoned',
    ]);
    expect(records.filter((record) => record.kind === 'event')).toHaveLength(4);
    expect(records).toEqual(before);
    expect(JSON.stringify(lines)).not.toContain('private');

    expect(await sink.close()).toEqual({ kind: 'closed' });
    expect(destination.flushCalls).toBe(0);
    expect(destination.closeCalls).toBe(0);
  });

  it('honors the configured Pino threshold for an injected destination', async () => {
    /** Records only output Pino admits at the configured warning threshold. */
    const destination = new RecordingDestination();
    /** Constructs the logger over a borrowed destination without mutating an injected logger. */
    const sink = pinoSink({ destination: borrowed(destination), level: 'warn' });

    await sink.write([pointRecord('filtered.info', 'info'), pointRecord('visible.warn', 'warn')]);

    expect(recordedLines(destination).map((line) => line.msg)).toEqual(['visible.warn']);
    await sink.close();
  });

  it('provides a safe managed default with shared idempotent close evidence', async () => {
    /** Uses silent output to exercise managed asynchronous stderr ownership without test noise. */
    const sink = pinoSink({ level: 'silent' });
    await sink.write([pointRecord('managed.default')]);

    /** Starts the only managed flush and destination-close transition. */
    const firstClose = sink.close();
    /** Repeats close while the managed destination may still be draining. */
    const secondClose = sink.close();

    expect(firstClose).toBe(sink.closed);
    expect(secondClose).toBe(firstClose);
    expect(await firstClose).toEqual({ kind: 'closed' });
  });

  it('does not flush or close an injected borrowed logger', async () => {
    /** Records focused logger output underneath the borrowed logger handle. */
    const destination = new RecordingDestination();
    /** Leaves logger and its nested destination under application ownership. */
    const logger = new RecordingLogger(destination);
    /** Borrows the logger without claiming knowledge of its nested resource tree. */
    const sink = pinoSink({ logger: borrowed(logger) });

    await sink.write([pointRecord('borrowed.logger')]);
    await sink.flush();
    expect(await sink.close()).toEqual({ kind: 'closed' });

    expect(recordedLines(destination).map((line) => line.msg)).toEqual(['borrowed.logger']);
    expect(logger.flushCalls).toBe(0);
    expect(destination.flushCalls).toBe(0);
    expect(destination.closeCalls).toBe(0);
  });

  it('drains accepted writes before flushing and closing an owned destination once', async () => {
    /** Transfers the complete retained destination lifecycle to the sink. */
    const destination = new RecordingDestination();
    /** Lets the adapter construct its own logger over the explicitly owned destination. */
    const sink = pinoSink({ destination: owned(destination), level: 'trace' });
    /** Admits one write without awaiting it before shutdown begins. */
    const write = sink.write([pointRecord('owned.destination')]);

    /** Starts finalization while the accepted write remains queued. */
    const close = sink.close();

    expect(close).toBe(sink.closed);
    expect(sink.close()).toBe(close);
    expect(await close).toEqual({ kind: 'closed' });
    await write;
    expect(destination.operations).toEqual(['write:1', 'flush', 'close']);
    expect(destination.closeCalls).toBe(1);
    await expect(sink.write([pointRecord('late.write')])).rejects.toMatchObject({
      code: 'pino_sink_closed',
      message: 'The Pino diagnostic sink is closed',
    });
    await expect(sink.flush()).rejects.toMatchObject({ code: 'pino_sink_closed' });
    expect(destination.operations).toEqual(['write:1', 'flush', 'close']);
  });

  it('flushes and closes only the retained outer handle for an owned logger', async () => {
    /** Remains nested inside the logger without transferring direct ownership to the sink. */
    const destination = new RecordingDestination();
    /** Gives the logger an explicit retained lifecycle that owns any nested policy. */
    const logger = new RecordingLogger(destination);
    /** Transfers the outer logger handle rather than separately claiming its destination. */
    const sink = pinoSink({ logger: owned(logger) });

    await sink.write([pointRecord('owned.logger')]);
    expect(await sink.close()).toEqual({ kind: 'closed' });

    expect(destination.operations).toEqual(['write:1', 'logger-flush', 'logger-close']);
    expect(destination.closeCalls).toBe(0);
  });

  it('redacts a rejected Pino write, stops that batch, and never retries it', async () => {
    /** Rejects only the first real Pino destination handoff with private detail. */
    const destination = new RecordingDestination({ failWriteAt: 1 });
    /** Borrows the failing boundary so close behavior cannot obscure write failure. */
    const sink = pinoSink({ destination: borrowed(destination), level: 'trace' });
    /** Uses two valid records so one failed call cannot masquerade as full batch traversal. */
    const records = [pointRecord('write.failure.first'), pointRecord('write.failure.second')];
    /** Preserves normalized input while Pino exercises the rejection path. */
    const before = structuredClone(records);

    /** Captures the adapter-owned rejection for exact identity and redaction checks. */
    const failure = await sink.write(records).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PinoSinkError);
    expect(failure).toMatchObject({
      code: 'pino_sink_write_failed',
      message: 'Pino rejected a diagnostic record',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain('private recording destination');
    expect(destination.writeCalls).toBe(1);
    expect(destination.lines).toHaveLength(0);
    expect(records).toEqual(before);
    expect(await sink.close()).toEqual({ kind: 'closed' });
  });

  it('redacts explicit flush failure while preserving later owned close', async () => {
    /** Rejects the first explicit flush and accepts the close-time flush. */
    const destination = new RecordingDestination({ flushFailures: 1 });
    /** Transfers lifecycle so explicit flush has authority to reach the resource. */
    const sink = pinoSink({ destination: owned(destination), level: 'trace' });
    await sink.write([pointRecord('flush.failure')]);

    /** Captures explicit flush rejection without converting it to close evidence. */
    const failure = await sink.flush().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PinoSinkError);
    expect(failure).toMatchObject({
      code: 'pino_sink_flush_failed',
      message: 'Pino failed to flush accepted diagnostic records',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain('private recording destination');
    expect(await sink.close()).toEqual({ kind: 'closed' });
    expect(destination.operations).toEqual(['write:1', 'flush', 'flush', 'close']);
  });

  it('continues owned cleanup after close-time flush failure and returns redacted evidence', async () => {
    /** Rejects the close-time flush while allowing retained destination close. */
    const destination = new RecordingDestination({ flushFailures: 1 });
    /** Transfers destination flush and close authority to the sink. */
    const sink = pinoSink({ destination: owned(destination), level: 'trace' });
    await sink.write([pointRecord('close.flush.failure')]);

    /** Retains failed close evidence after cleanup continues through resource close. */
    const evidence = await sink.close();

    expect(evidence).toEqual({
      kind: 'failed',
      failure: {
        kind: 'protocol-failure',
        code: 'pino_sink_flush_failed',
        message: 'Pino failed to flush accepted diagnostic records',
        retryable: false,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain('private recording destination');
    expect(destination.operations).toEqual(['write:1', 'flush', 'close']);
  });

  it('redacts owned destination and logger close failures after flushing', async () => {
    /** Rejects destination close only after its accepted write flushes. */
    const destination = new RecordingDestination({ closeFailure: true });
    /** Transfers the failing destination lifecycle to one sink. */
    const destinationSink = pinoSink({ destination: owned(destination), level: 'trace' });
    await destinationSink.write([pointRecord('destination.close.failure')]);

    /** Retains redacted evidence from the explicitly owned destination branch. */
    const destinationEvidence = await destinationSink.close();

    expect(destinationEvidence).toMatchObject({
      kind: 'failed',
      failure: {
        kind: 'protocol-failure',
        code: 'pino_sink_resource_close_failed',
        message: 'Pino failed to close its owned resource',
      },
    });
    expect(destination.operations).toEqual(['write:1', 'flush', 'close']);
    expect(JSON.stringify(destinationEvidence)).not.toContain('private recording destination');

    /** Keeps a second recording boundary under the retained logger wrapper. */
    const loggerDestination = new RecordingDestination();
    /** Rejects only the explicitly owned outer logger close. */
    const logger = new RecordingLogger(loggerDestination, true);
    /** Transfers the outer logger lifecycle without direct destination authority. */
    const loggerSink = pinoSink({ logger: owned(logger) });
    await loggerSink.write([pointRecord('logger.close.failure')]);

    /** Retains redacted evidence from the explicitly owned outer logger branch. */
    const loggerEvidence = await loggerSink.close();

    expect(loggerEvidence).toMatchObject({
      kind: 'failed',
      failure: {
        code: 'pino_sink_resource_close_failed',
        message: 'Pino failed to close its owned resource',
      },
    });
    expect(loggerDestination.operations).toEqual(['write:1', 'logger-flush', 'logger-close']);
    expect(JSON.stringify(loggerEvidence)).not.toContain('private retained logger');
  });

  it('rejects an ambiguous logger and destination configuration with redacted identity', () => {
    /** Supplies two otherwise valid borrowed dependencies to reach only the ambiguity guard. */
    const destination = new RecordingDestination();
    /** Builds the focused logger contract so the rejected configuration reaches only ambiguity. */
    const logger = new RecordingLogger(destination);
    /** Simulates a JavaScript caller bypassing the compile-time mutually exclusive union. */
    const ambiguous = {
      logger: borrowed(logger),
      destination: borrowed(destination),
    } as unknown as Parameters<typeof pinoSink>[0];

    expect(() => pinoSink(ambiguous)).toThrow(
      expect.objectContaining({
        code: 'pino_sink_configuration_failed',
        message: 'Pino sink configuration failed',
      }),
    );
  });
});
