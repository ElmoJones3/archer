/**
 * @file Publishes the versioned behavior suite for directory Materializers.
 *
 * This is deliberately a directory-adapter suite rather than a universal
 * Materializer suite. It proves ordinary host-path behavior and cooperative
 * quiescence without implying that another adapter shares those guarantees.
 */

import { link, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { IdempotencyKeySchema, TimestampSchema, toPublicError, type PublicError } from '@archer/core';
import type { GrantRef } from '@archer/core/authority';

import { FilesError } from '../errors.js';
import { restoreTree, type FileStore } from '../store.js';
import type {
  DirectoryMaterializationInput,
  DirectoryMaterializedView,
  DirectoryMaterializer,
  FilesIngestAction,
  FilesMaterializeAction,
} from './contracts.js';

/** Current immutable directory Materializer behavior catalogue. */
export const DIRECTORY_MATERIALIZER_CONFORMANCE_VERSION = 1 as const;

/** Stable identities for every required v1 directory Materializer behavior. */
export type DirectoryMaterializerConformanceCaseId =
  | 'materialization.hot-idempotent-operation'
  | 'view.exposes-separated-ordinary-roots'
  | 'ingestion.workspace-only-receipt'
  | 'ingestion.rejects-linked-entry'
  | 'lifecycle.retained-cleanup';

/** Stable identity and maintained claim for one required directory behavior. */
export type DirectoryMaterializerConformanceCase = Readonly<{
  /** Stable machine identity retained in reports and failure evidence. */
  id: DirectoryMaterializerConformanceCaseId;
  /** Human-readable protocol claim maintained beside executable proof. */
  claim: string;
}>;

/** Ordered public catalogue that prevents partial execution from posing as proof. */
export const DIRECTORY_MATERIALIZER_CONFORMANCE_CASES: readonly DirectoryMaterializerConformanceCase[] = Object.freeze([
  Object.freeze({
    id: 'materialization.hot-idempotent-operation',
    claim: 'Materialization starts immediately and exact command replay shares one retained operation.',
  }),
  Object.freeze({
    id: 'view.exposes-separated-ordinary-roots',
    claim: 'Workspace, Resources, and Scratchpads appear as ordinary paths with distinct ownership roots.',
  }),
  Object.freeze({
    id: 'ingestion.workspace-only-receipt',
    claim: 'A complete receipt includes only the cooperatively quiesced Workspace root.',
  }),
  Object.freeze({
    id: 'ingestion.rejects-linked-entry',
    claim: 'A linked physical entry is refused instead of escaping or aliasing logical identity.',
  }),
  Object.freeze({
    id: 'lifecycle.retained-cleanup',
    claim: 'Adapter close is retained, closes active views, and applies the selected removal policy.',
  }),
]);

/** Fresh production-reachable directory attachment supplied for one case. */
export type DirectoryMaterializerConformanceFixture = Readonly<{
  /** Directory adapter configured with borrowed dependencies and an absent target. */
  materializer: DirectoryMaterializer;
  /** Store containing the fixture trees and later ingestion result. */
  store: FileStore;
  /**
   * Complete command using generation seven and the required fixture contents.
   *
   * The Workspace must contain `README.md` as `workspace\n`, Resources must
   * mount `docs/guide.txt` as `reference\n`, and Scratchpads must mount
   * `session/notes.txt` as `scratch\n`. The target must start absent and select
   * `cleanup: 'remove'`.
   */
  input: DirectoryMaterializationInput;
  /** Current whole-adapter materialization permission. */
  materializeGrant: GrantRef<FilesMaterializeAction>;
  /** Current whole-adapter cooperative-ingestion permission. */
  ingestGrant: GrantRef<FilesIngestAction>;
  /** Releases borrowed dependencies and any fixture-owned parent directory. */
  dispose(): Promise<void>;
}>;

/** Construction boundary implemented by one candidate directory adapter. */
export type DirectoryMaterializerConformanceTarget = Readonly<{
  /** Human-readable implementation identity retained in the report. */
  name: string;
  /** Opens one exact, independent fixture for every required case. */
  open(): Promise<DirectoryMaterializerConformanceFixture>;
}>;

/** Successful execution evidence for one required directory behavior. */
export type PassedDirectoryMaterializerConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: DirectoryMaterializerConformanceCaseId;
  /** Confirms every assertion in this exact case passed. */
  status: 'passed';
}>;

/** Failed execution evidence with bounded public identity. */
export type FailedDirectoryMaterializerConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: DirectoryMaterializerConformanceCaseId;
  /** Confirms this exact required case ran and failed. */
  status: 'failed';
  /** Redacted portable failure suitable for CI serialization. */
  failure: PublicError;
}>;

/** Complete result of one required directory Materializer behavior. */
export type DirectoryMaterializerConformanceCaseResult =
  PassedDirectoryMaterializerConformanceCase | FailedDirectoryMaterializerConformanceCase;

/** Exact execution accounting that cannot hide an unexecuted required case. */
export type DirectoryMaterializerConformanceExecution = Readonly<{
  /** Published required case count for this suite version. */
  required: number;
  /** Number of required cases that produced a result. */
  executed: number;
  /** Required cases not executed for any reason. */
  skipped: number;
}>;

/** Portable complete report returned by the v1 directory Materializer runner. */
export type DirectoryMaterializerConformanceReport = Readonly<{
  /** Pins interpretation to one immutable required-case catalogue. */
  version: typeof DIRECTORY_MATERIALIZER_CONFORMANCE_VERSION;
  /** Identifies the candidate implementation supplied by its author. */
  implementation: string;
  /** Passes only when every required case executed successfully. */
  status: 'passed' | 'failed';
  /** Proves the runner neither skipped nor silently filtered a required case. */
  execution: DirectoryMaterializerConformanceExecution;
  /** Contains exactly one ordered result per required case. */
  cases: readonly DirectoryMaterializerConformanceCaseResult[];
}>;

/** Stable command identities remain independent from candidate-generated evidence. */
const COMMAND_KEYS = Object.freeze({
  /** Drives Workspace-only ingestion proof. */
  ingest: IdempotencyKeySchema.parse('62000000-0000-4000-8000-000000000001'),
  /** Drives linked-entry refusal proof. */
  linkedEntry: IdempotencyKeySchema.parse('62000000-0000-4000-8000-000000000002'),
});

/** Fixed trusted acknowledgement time keeps the executable suite deterministic. */
const ACKNOWLEDGED_AT = TimestampSchema.parse('2026-08-24T03:00:00.000Z');

/**
 * Raises one Archer-owned failure when a required production observation is false.
 * @param condition - Exact public observation under evaluation.
 * @param message - Catalogue-owned explanation containing no adapter-private data.
 */
function requireClaim(condition: boolean, message: string): asserts condition {
  if (!condition) throw new FilesError('files_integrity_failed', message);
}

/**
 * Reports whether an exact path does not exist without swallowing another I/O failure.
 * @param path - Candidate fixture path selected by the public view.
 * @returns Whether the host reports this exact path as absent.
 */
async function isAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Starts and settles one complete physical view through the public operation boundary.
 * @param fixture - Fresh exact directory fixture and current materialization grant.
 * @returns Independently owned completed directory view.
 */
async function materialize(fixture: DirectoryMaterializerConformanceFixture): Promise<DirectoryMaterializedView> {
  /** Current Authority is checked before the hot attempt becomes observable. */
  const started = await fixture.materializer.startMaterialization(fixture.input, fixture.materializeGrant);
  requireClaim(started.kind === 'started' && !started.replayed, 'Directory materialization did not start once');
  /** Complete settlement transfers the view only after atomic physical publication. */
  const result = await started.operation.result;
  await started.operation.close();
  requireClaim(result.kind === 'materialized', 'Directory materialization did not publish a complete view');
  return result.view;
}

/**
 * Builds one exact cooperative acknowledgement for the supplied physical view.
 * @param view - Completed view whose fixed generation and identity are acknowledged.
 * @param idempotencyKey - Suite-owned scan identity.
 * @returns Frozen ingestion command pinned to the view's original logical base.
 */
function ingestionCommand(
  view: DirectoryMaterializedView,
  idempotencyKey: (typeof COMMAND_KEYS)[keyof typeof COMMAND_KEYS],
) {
  return Object.freeze({
    quiescence: Object.freeze({
      type: 'cooperative-directory' as const,
      materializedViewId: view.materializedViewId,
      generation: view.generation,
      acknowledgedBy: 'directory Materializer conformance suite',
      acknowledgedAt: ACKNOWLEDGED_AT,
    }),
    expectedBase: view.base,
    expectedGeneration: view.generation,
    idempotencyKey,
  });
}

/**
 * Proves an exact retry shares one already-running or terminal hot operation.
 * @param fixture - Fresh exact directory fixture and current grants.
 */
async function hotOperationCase(fixture: DirectoryMaterializerConformanceFixture): Promise<void> {
  /** First call activates the attempt without a separate execute command. */
  const first = await fixture.materializer.startMaterialization(fixture.input, fixture.materializeGrant);
  requireClaim(first.kind === 'started' && !first.replayed, 'First materialization was not a fresh hot operation');
  /** Exact retry must return the same observation and settlement owner. */
  const replay = await fixture.materializer.startMaterialization(fixture.input, fixture.materializeGrant);
  requireClaim(replay.kind === 'started' && replay.replayed, 'Materialization retry did not report replay');
  requireClaim(replay.operation === first.operation, 'Materialization retry created a second operation');
  /** Successful terminal settlement proves the shared operation actually ran. */
  const result = await first.operation.result;
  requireClaim(result.kind === 'materialized', 'Shared materialization operation did not complete');
  await first.operation.close();
}

/**
 * Proves ordinary paths expose three distinct ownership roots with expected bytes.
 * @param fixture - Fresh exact directory fixture and current grants.
 */
async function separatedRootsCase(fixture: DirectoryMaterializerConformanceFixture): Promise<void> {
  /** Materialization bridges immutable identity into familiar host paths. */
  const view = await materialize(fixture);
  /** Each recognizable file exists beneath only its contract-owned root. */
  const workspace = await readFile(join(view.paths.workspace, 'README.md'), 'utf8');
  /** Resource placement proves explicit mount paths survive realization. */
  const resource = await readFile(join(view.paths.resources, 'docs', 'guide.txt'), 'utf8');
  /** Scratchpad placement proves private state does not enter Workspace paths. */
  const scratchpad = await readFile(join(view.paths.scratchpads, 'session', 'notes.txt'), 'utf8');
  requireClaim(workspace === 'workspace\n', 'Directory view changed Workspace fixture bytes');
  requireClaim(resource === 'reference\n', 'Directory view changed Resource fixture bytes');
  requireClaim(scratchpad === 'scratch\n', 'Directory view changed Scratchpad fixture bytes');
  requireClaim(view.generation === 7, 'Directory view changed the acknowledged Workspace generation');
}

/**
 * Proves ingestion includes ordinary Workspace edits and excludes private mounts.
 * @param fixture - Fresh exact directory fixture and current grants.
 */
async function workspaceOnlyCase(fixture: DirectoryMaterializerConformanceFixture): Promise<void> {
  /** Existing tools mutate ordinary paths after complete physical publication. */
  const view = await materialize(fixture);
  await writeFile(join(view.paths.workspace, 'answer.txt'), 'answer\n');
  await writeFile(join(view.paths.scratchpads, 'session', 'notes.txt'), 'private change\n');
  /** Explicit application acknowledgement selects this adapter's deliberately weak quiescence class. */
  const started = await view.startIngestion(ingestionCommand(view, COMMAND_KEYS.ingest), fixture.ingestGrant);
  requireClaim(started.kind === 'started' && !started.replayed, 'Directory ingestion did not start once');
  /** Receipt becomes usable only after the whole scan and stability proof complete. */
  const result = await started.operation.result;
  await started.operation.close();
  requireClaim(result.kind === 'ingested', 'Directory ingestion did not produce a complete receipt');
  requireClaim(
    result.receipt.excludedRoots[0] === 'resources' && result.receipt.excludedRoots[1] === 'scratchpads',
    'Directory receipt did not state its excluded ownership roots',
  );
  /** Restoring immutable identity proves the exclusion rather than trusting metadata alone. */
  const restored = await restoreTree(fixture.store, result.receipt.result);
  if (!restored.ok) throw restored.error;
  requireClaim(
    restored.value.files.map((entry) => entry.path).join(',') === 'README.md,answer.txt',
    'Directory ingestion included the wrong logical paths',
  );
}

/**
 * Proves a physical hard link cannot alias bytes into logical identity.
 * @param fixture - Fresh exact directory fixture and current grants.
 */
async function linkedEntryCase(fixture: DirectoryMaterializerConformanceFixture): Promise<void> {
  /** A hard link needs no platform-specific symlink privilege but still violates isolation. */
  const view = await materialize(fixture);
  await link(join(view.paths.workspace, 'README.md'), join(view.paths.workspace, 'linked.txt'));
  /** Scan may activate, but terminal evidence must refuse the unsupported physical entry. */
  const started = await view.startIngestion(ingestionCommand(view, COMMAND_KEYS.linkedEntry), fixture.ingestGrant);
  requireClaim(started.kind === 'started', 'Linked-entry ingestion did not reach physical verification');
  /** Terminal branch must be a named refusal and cannot contain a receipt. */
  const result = await started.operation.result;
  await started.operation.close();
  requireClaim(
    result.kind === 'refused' && result.reason === 'unsupported-entry',
    'Directory ingestion admitted a linked physical entry',
  );
}

/**
 * Proves adapter closure shares one settlement and owns active-view cleanup.
 * @param fixture - Fresh exact directory fixture and current grants.
 */
async function lifecycleCase(fixture: DirectoryMaterializerConformanceFixture): Promise<void> {
  /** An active view makes adapter close prove child ownership rather than an empty no-op. */
  const view = await materialize(fixture);
  /** Capturing both promises before awaiting proves retained close identity. */
  const first = fixture.materializer.close();
  /** Second close must share the already-running cleanup. */
  const second = fixture.materializer.close();
  requireClaim(first === second && first === fixture.materializer.closed, 'Materializer close was not retained');
  /** Adapter evidence settles only after its active physical view closes. */
  const evidence = await first;
  requireClaim(evidence.kind === 'directory-materializer-closed', 'Materializer close returned the wrong evidence');
  requireClaim((await view.closed).disposition === 'removed', 'Active view did not apply its removal policy');
  requireClaim(await isAbsent(view.paths.root), 'Materializer close left its removal target behind');
}

/** Executable case selected exhaustively by stable catalogue identity. */
type DirectoryMaterializerCase = (fixture: DirectoryMaterializerConformanceFixture) => Promise<void>;

/** Required behavior implementation map checked exhaustively by TypeScript. */
const CASES = Object.freeze({
  'materialization.hot-idempotent-operation': hotOperationCase,
  'view.exposes-separated-ordinary-roots': separatedRootsCase,
  'ingestion.workspace-only-receipt': workspaceOnlyCase,
  'ingestion.rejects-linked-entry': linkedEntryCase,
  'lifecycle.retained-cleanup': lifecycleCase,
} satisfies Record<DirectoryMaterializerConformanceCaseId, DirectoryMaterializerCase>);

/**
 * Executes every required directory behavior against independent fresh attachments.
 * @param target - Named candidate factory supplying exact local-directory fixtures.
 * @returns Complete ordered report whose passing state requires zero skipped cases.
 */
export async function runDirectoryMaterializerConformance(
  target: DirectoryMaterializerConformanceTarget,
): Promise<DirectoryMaterializerConformanceReport> {
  if (target.name.length === 0) throw new RangeError('A directory Materializer implementation name is required');
  /** Receives exactly one result for every required case in catalogue order. */
  const results: DirectoryMaterializerConformanceCaseResult[] = [];
  /** Every case receives an independent physical target, immutable store, and Authority ledger. */
  for (const definition of DIRECTORY_MATERIALIZER_CONFORMANCE_CASES) {
    /** Retains an opened fixture for unconditional owner-first cleanup. */
    let fixture: DirectoryMaterializerConformanceFixture | undefined;
    try {
      fixture = await target.open();
      requireClaim(fixture.input.generation === 7, 'Directory target did not use the required generation');
      requireClaim(fixture.input.target.cleanup === 'remove', 'Directory target did not select removal cleanup');
      requireClaim(await isAbsent(fixture.input.target.rootPath), 'Directory target existed before its case');
      await CASES[definition.id](fixture);
      results.push(Object.freeze({ id: definition.id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id: definition.id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'directory_materializer_conformance_failed',
            message: 'Directory Materializer conformance case failed',
          }),
        }),
      );
    } finally {
      if (fixture !== undefined) {
        await fixture.materializer.close().catch(() => undefined);
        await fixture.dispose().catch(() => undefined);
      }
    }
  }
  /** Passing requires one successful result for every immutable required definition. */
  const passed =
    results.length === DIRECTORY_MATERIALIZER_CONFORMANCE_CASES.length &&
    results.every((item) => item.status === 'passed');
  return Object.freeze({
    version: DIRECTORY_MATERIALIZER_CONFORMANCE_VERSION,
    implementation: target.name,
    status: passed ? 'passed' : 'failed',
    execution: Object.freeze({
      required: DIRECTORY_MATERIALIZER_CONFORMANCE_CASES.length,
      executed: results.length,
      skipped: DIRECTORY_MATERIALIZER_CONFORMANCE_CASES.length - results.length,
    }),
    cases: Object.freeze([...results]),
  });
}
