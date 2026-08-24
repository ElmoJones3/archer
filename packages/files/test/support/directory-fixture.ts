/**
 * @file Supplies production-reachable directory Materializer fixtures to tests.
 *
 * The helper keeps logical content, current Authority, deterministic identities,
 * and physical cleanup visible while preventing each suite from quietly
 * inventing a different adapter contract.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IdempotencyKeySchema, TimestampSchema, borrowed } from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  type GrantRef,
} from '@archer/core/authority';

import {
  FILES_INGEST_ACTION,
  FILES_MATERIALIZE_ACTION,
  MaterializerIdSchema,
  ScratchpadIdSchema,
  createDirectoryMaterializer,
  memoryFileStore,
  publishTree,
  type DirectoryMaterializationInput,
  type DirectoryMaterializedView,
  type DirectoryMaterializer,
  type DirectoryMaterializerAction,
  type FilesIngestAction,
  type FilesMaterializeAction,
} from '../../src/index.js';

/** Stable ledger identity used by each independent real-Authority fixture. */
const LEDGER_ID = AuthorityLedgerIdSchema.parse('20000000-0000-4000-8000-000000000001');

/** Stable Materializer attachment protected by fixture grants. */
const MATERIALIZER_ID = MaterializerIdSchema.parse('20000000-0000-4000-8000-000000000002');

/** Stable Principal attributed to every protected physical operation. */
const PRINCIPAL_ID = PrincipalIdSchema.parse('20000000-0000-4000-8000-000000000003');

/** Trusted bootstrap instant shared by Materializer grants. */
const CREATED_AT = TimestampSchema.parse('2026-08-23T22:00:00.000Z');

/** Stable broad materialization root for this one adapter attachment. */
const MATERIALIZE_GRANT_ID = AuthorizationGrantIdSchema.parse('20000000-0000-4000-8000-000000000004');

/** Stable broad cooperative-ingestion root for this one adapter attachment. */
const INGEST_GRANT_ID = AuthorizationGrantIdSchema.parse('20000000-0000-4000-8000-000000000005');

/** Retained dependencies, input values, and current grant references for one test. */
export type DirectoryFixture = Readonly<{
  /** Unique real directory whose child becomes the selected physical target. */
  parent: string;
  /** Process-local immutable store containing every logical fixture tree. */
  store: ReturnType<typeof memoryFileStore>;
  /** Current Authority ledger proving protected start behavior. */
  ledger: ReturnType<typeof createMemoryAuthorityLedger<DirectoryMaterializerAction>>;
  /** Directory adapter under test. */
  materializer: DirectoryMaterializer;
  /** Complete normalized command factory input. */
  input: DirectoryMaterializationInput;
  /** Current whole-adapter materialization reference. */
  materialize: GrantRef<FilesMaterializeAction>;
  /** Current whole-adapter cooperative-ingestion reference. */
  ingest: GrantRef<FilesIngestAction>;
}>;

/**
 * Opens real logical content, Authority, and one local directory adapter.
 * @returns Production-reachable fixture whose selected target does not exist.
 */
export async function openDirectoryFixture(): Promise<DirectoryFixture> {
  /** Unique test parent bounds all physical writes and later cleanup. */
  const parent = await mkdtemp(join(tmpdir(), 'archer-directory-materializer-'));
  /** Memory storage still exercises canonical publication and verified reads. */
  const store = memoryFileStore();
  /** Workspace tree remains the only root eligible for later ingestion. */
  const workspace = await publishTree(store, [{ path: 'README.md', content: 'workspace\n' }]);
  if (!workspace.ok) throw workspace.error;
  /** Resource tree proves ordinary read paths without entering Workspace results. */
  const resource = await publishTree(store, [{ path: 'guide.txt', content: 'reference\n' }]);
  if (!resource.ok) throw resource.error;
  /** Scratchpad tree proves private writable state receives its own physical root. */
  const scratchpad = await publishTree(store, [{ path: 'notes.txt', content: 'scratch\n' }]);
  if (!scratchpad.ok) throw scratchpad.error;

  /** Broad root may later be attenuated to `directoryMaterializationInputDigest`. */
  const materializeRoot = createBootstrapAuthorizationGrant<FilesMaterializeAction>(FILES_MATERIALIZE_ACTION, {
    id: MATERIALIZE_GRANT_ID,
    ledgerId: LEDGER_ID,
    subject: PRINCIPAL_ID,
    scope: { kind: 'files-materialize', materializerId: MATERIALIZER_ID },
    issuedBy: PRINCIPAL_ID,
    createdAt: CREATED_AT,
  });
  /** Broad ingestion root remains constrained to this adapter and cooperative guarantee. */
  const ingestRoot = createBootstrapAuthorizationGrant<FilesIngestAction>(FILES_INGEST_ACTION, {
    id: INGEST_GRANT_ID,
    ledgerId: LEDGER_ID,
    subject: PRINCIPAL_ID,
    scope: { kind: 'files-ingest', materializerId: MATERIALIZER_ID, quiescence: 'cooperative-directory' },
    issuedBy: PRINCIPAL_ID,
    createdAt: CREATED_AT,
  });
  /** Real ledger ensures structurally valid but absent references cannot authorize I/O. */
  const ledger = createMemoryAuthorityLedger<DirectoryMaterializerAction>({
    ledgerId: LEDGER_ID,
    actions: [FILES_MATERIALIZE_ACTION, FILES_INGEST_ACTION],
    bootstrap: [materializeRoot, ingestRoot],
    /**
     * Keeps every fixture grant current without consulting wall time.
     * @returns Fixed trusted instant after both bootstrap grants became active.
     */
    now: () => new Date('2026-08-23T22:30:00.000Z'),
  });
  /** Deterministic counter covers operation epochs, view identity, and receipt identity. */
  let nextId = 101;
  /**
   * Supplies valid UUIDv4 text in exact runtime construction order.
   * @returns Next deterministic adapter-owned identity.
   */
  const createId = (): string => `20000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  /** Constructor receives dependencies as borrowed so fixture cleanup can prove ownership. */
  const opened = createDirectoryMaterializer({
    materializerId: MATERIALIZER_ID,
    subject: PRINCIPAL_ID,
    store: borrowed(store),
    authority: borrowed(ledger),
    createId,
    /**
     * Keeps receipt and lifecycle evidence deterministic.
     * @returns Fixed trusted instant used by the directory adapter.
     */
    now: () => new Date('2026-08-23T22:30:00.000Z'),
  });
  if (!opened.ok) throw opened.error;
  /** One explicit target configuration avoids host-inferred guarantee or cleanup semantics. */
  const input: DirectoryMaterializationInput = Object.freeze({
    workspace: workspace.value.ref,
    generation: 7,
    resources: Object.freeze([{ mountPath: 'docs', tree: resource.value.ref }]),
    scratchpads: Object.freeze([
      {
        scratchpadId: ScratchpadIdSchema.parse('20000000-0000-4000-8000-000000000006'),
        mountPath: 'session',
        tree: scratchpad.value.ref,
        retention: 'ephemeral' as const,
      },
    ]),
    target: Object.freeze({
      type: 'directory',
      rootPath: join(parent, 'view'),
      caseSensitivity: 'sensitive',
      cleanup: 'remove',
    }),
    idempotencyKey: IdempotencyKeySchema.parse('20000000-0000-4000-8000-000000000007'),
  });
  return Object.freeze({
    parent,
    store,
    ledger,
    materializer: opened.value,
    input,
    materialize: Object.freeze({ grantId: materializeRoot.id, action: materializeRoot.action }),
    ingest: Object.freeze({ grantId: ingestRoot.id, action: ingestRoot.action }),
  });
}

/**
 * Releases only the dependencies and temporary parent owned by the fixture.
 * @param fixture - Directory fixture returned by `openDirectoryFixture`.
 */
export async function disposeDirectoryFixture(fixture: DirectoryFixture): Promise<void> {
  await fixture.ledger.close();
  await fixture.store.close();
  await rm(fixture.parent, { recursive: true, force: true });
}

/**
 * Closes the adapter before releasing its borrowed fixture dependencies.
 * @param fixture - Directory fixture returned by `openDirectoryFixture`.
 */
export async function closeDirectoryFixture(fixture: DirectoryFixture): Promise<void> {
  await fixture.materializer.close();
  await disposeDirectoryFixture(fixture);
}

/**
 * Starts and settles one successful materialization from a fixture.
 * @param fixture - Current authorized fixture with an absent selected target.
 * @returns Owned completed physical directory view.
 */
export async function materializeFixture(fixture: DirectoryFixture): Promise<DirectoryMaterializedView> {
  /** Start outcome proves current Authority before exposing the hot operation. */
  const started = await fixture.materializer.startMaterialization(fixture.input, fixture.materialize);
  if (started.kind !== 'started') throw new Error(`Expected materialization start, received ${started.kind}`);
  /** Terminal result transfers the physical-view handle only after complete publication. */
  const result = await started.operation.result;
  await started.operation.close();
  if (result.kind !== 'materialized') throw new Error(`Expected materialized view, received ${result.kind}`);
  return result.view;
}
