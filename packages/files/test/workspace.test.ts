/**
 * @file Proves private Workspace behavior through the public files package.
 *
 * Fixtures enter through immutable publication and public Authority grants so
 * the suite cannot manufacture lineage or permission that production cannot.
 */

import { describe, expect, it } from 'vitest';

import { CanonicalDecimalSchema, IdempotencyKeySchema, TimestampSchema, borrowed } from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  type GrantRef,
} from '@archer/core/authority';

import * as files from '../src/index.js';
import {
  CHANGE_SET_CREATE_ACTION,
  WORKSPACE_INGESTION_ACCEPT_ACTION,
  WORKSPACE_READ_ACTION,
  WORKSPACE_WRITE_ACTION,
  WorkspaceIdSchema,
  WorkspaceLineageIdSchema,
  IngestionReceiptIdSchema,
  MaterializedViewIdSchema,
  MaterializerIdSchema,
  blobRefForBytes,
  createPhysicalIngestionReceipt,
  createMemoryWorkspace,
  memoryFileStore,
  publishTree,
  type BlobRead,
  type ChangeSetCreateAction,
  type WorkspaceAction,
  type WorkspaceHandle,
  type WorkspaceIngestionAcceptAction,
  type WorkspaceReadAction,
  type WorkspaceWriteAction,
} from '../src/index.js';

/** Stable Authority ledger identity shared by production-reachable fixtures. */
const ledgerId = AuthorityLedgerIdSchema.parse('10000000-0000-4000-8000-000000000001');

/** Stable Workspace identity protected by every fixture grant. */
const workspaceId = WorkspaceIdSchema.parse('10000000-0000-4000-8000-000000000002');

/** Stable private lineage identity rooted at the fixture base tree. */
const lineageId = WorkspaceLineageIdSchema.parse('10000000-0000-4000-8000-000000000003');

/** Stable Principal identity bound to the fixture Workspace handle. */
const principalId = PrincipalIdSchema.parse('10000000-0000-4000-8000-000000000004');

/** Trusted construction instant retained by every bootstrap grant. */
const createdAt = TimestampSchema.parse('2026-08-23T21:00:00.000Z');

/** Stable root grant identity for whole-Workspace reads. */
const readGrantId = AuthorizationGrantIdSchema.parse('10000000-0000-4000-8000-000000000005');

/** Stable root grant identity for whole-Workspace writes. */
const writeGrantId = AuthorizationGrantIdSchema.parse('10000000-0000-4000-8000-000000000006');

/** Stable root grant identity for ingestion acceptance. */
const ingestionGrantId = AuthorizationGrantIdSchema.parse('10000000-0000-4000-8000-000000000007');

/** Stable root grant identity for private ChangeSet creation. */
const changeSetGrantId = AuthorizationGrantIdSchema.parse('10000000-0000-4000-8000-000000000008');

/** First mutation identity used after the fixture reaches generation zero. */
const addKey = IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000009');

/** Retained dependencies and handle opened through the production construction path. */
type WorkspaceFixture = Readonly<{
  /** Process-local immutable store owned by the fixture. */
  store: ReturnType<typeof memoryFileStore>;
  /** Current Authority ledger containing every real Workspace grant. */
  ledger: ReturnType<typeof createMemoryAuthorityLedger<WorkspaceAction>>;
  /** Process-local Workspace handle under test. */
  workspace: WorkspaceHandle;
  /** Whole-Workspace current read authority presented to protected methods. */
  read: GrantRef<WorkspaceReadAction>;
  /** Whole-Workspace current write authority presented to protected methods. */
  write: GrantRef<WorkspaceWriteAction>;
  /** Whole-Workspace current ingestion authority presented to protected methods. */
  ingestion: GrantRef<WorkspaceIngestionAcceptAction>;
  /** Whole-Workspace current proposal authority presented to protected methods. */
  changeSet: GrantRef<ChangeSetCreateAction>;
}>;

/**
 * Consumes one verification-bearing blob read into complete UTF-8 text.
 * @param read - Public streaming read whose terminal iteration proves identity.
 * @returns Exact fixture text after terminal digest and length verification.
 */
async function readText(read: BlobRead): Promise<string> {
  /** Test data is deliberately bounded, so complete collection keeps assertions legible. */
  const chunks: Uint8Array[] = [];
  /** Counts output bytes without trusting stream chunk boundaries. */
  let byteLength = 0;
  /** Every delivered chunk contributes to exact terminal reconstruction. */
  for await (const chunk of read.content) {
    /** Copying exposes an implementation that aliases a mutable storage buffer. */
    const copy = Uint8Array.from(chunk);
    chunks.push(copy);
    byteLength += copy.byteLength;
  }
  /** One owned output buffer makes decoding independent of adapter chunking. */
  const bytes = new Uint8Array(byteLength);
  /** Tracks the next output offset while preserving source order. */
  let offset = 0;
  /** Copied chunks are flattened without relying on their original boundaries. */
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Opens a real immutable store, current Authority ledger, and private Workspace.
 * @returns Production-reachable generation-zero fixture with explicit ownership.
 */
async function openWorkspaceFixture(): Promise<WorkspaceFixture> {
  /** Base publication gives Workspace construction one exact restorable tree. */
  const store = memoryFileStore();
  /** Recognizable base content makes later preservation and diff claims visible. */
  const base = await publishTree(store, [{ path: 'README.md', content: 'base\n' }]);
  if (!base.ok) throw base.error;

  /** Whole-Workspace read root still requires current verification on every method. */
  const readRoot = createBootstrapAuthorizationGrant<WorkspaceReadAction>(WORKSPACE_READ_ACTION, {
    id: readGrantId,
    ledgerId,
    subject: principalId,
    scope: { kind: 'workspace-read', workspaceId },
    issuedBy: principalId,
    createdAt,
  });
  /** Whole-Workspace write root can later be attenuated to logical subtrees. */
  const writeRoot = createBootstrapAuthorizationGrant<WorkspaceWriteAction>(WORKSPACE_WRITE_ACTION, {
    id: writeGrantId,
    ledgerId,
    subject: principalId,
    scope: { kind: 'workspace-write', workspaceId },
    issuedBy: principalId,
    createdAt,
  });
  /** Broad local root contains only exact receipts presented by the Workspace. */
  const ingestionRoot = createBootstrapAuthorizationGrant<WorkspaceIngestionAcceptAction>(
    WORKSPACE_INGESTION_ACCEPT_ACTION,
    {
      id: ingestionGrantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'workspace-ingestion-accept', workspaceId },
      issuedBy: principalId,
      createdAt,
    },
  );
  /** Broad proposal root contains only the exact current base and result request. */
  const changeSetRoot = createBootstrapAuthorizationGrant<ChangeSetCreateAction>(CHANGE_SET_CREATE_ACTION, {
    id: changeSetGrantId,
    ledgerId,
    subject: principalId,
    scope: { kind: 'change-set-create', workspaceId },
    issuedBy: principalId,
    createdAt,
  });
  /** Real ledger ensures the fixture cannot turn structurally valid refs into authority. */
  const ledger = createMemoryAuthorityLedger<WorkspaceAction>({
    ledgerId,
    actions: [
      WORKSPACE_READ_ACTION,
      WORKSPACE_WRITE_ACTION,
      WORKSPACE_INGESTION_ACCEPT_ACTION,
      CHANGE_SET_CREATE_ACTION,
    ],
    bootstrap: [readRoot, writeRoot, ingestionRoot, changeSetRoot],
    /**
     * Keeps every grant current without consulting wall time.
     * @returns Fixed trusted instant after every bootstrap grant became active.
     */
    now: () => new Date('2026-08-23T21:30:00.000Z'),
  });
  /** Deterministic identity counter covers stream, snapshots, and proposals without fallback randomness. */
  let nextId = 101;
  /**
   * Returns the next valid identity expected by the process-local runtime.
   * @returns Deterministic UUIDv4 text in construction order.
   */
  const createId = (): string => `10000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  /** Public factory restores the base rather than trusting the supplied TreeRef shape. */
  const opened = await createMemoryWorkspace({
    workspaceId,
    lineageId,
    base: base.value.ref,
    subject: principalId,
    store: borrowed(store),
    authority: borrowed(ledger),
    createId,
    /**
     * Keeps initial snapshot and close evidence deterministic.
     * @returns Fixed trusted instant used by the Workspace runtime.
     */
    now: () => new Date('2026-08-23T21:30:00.000Z'),
  });
  if (!opened.ok) throw opened.error;
  return Object.freeze({
    store,
    ledger,
    workspace: opened.value,
    read: Object.freeze({ grantId: readRoot.id, action: readRoot.action }),
    write: Object.freeze({ grantId: writeRoot.id, action: writeRoot.action }),
    ingestion: Object.freeze({ grantId: ingestionRoot.id, action: ingestionRoot.action }),
    changeSet: Object.freeze({ grantId: changeSetRoot.id, action: changeSetRoot.action }),
  });
}

/**
 * Closes a borrowed-dependency fixture in owner-first order.
 * @param fixture - Workspace, ledger, and store opened by `openWorkspaceFixture`.
 */
async function closeWorkspaceFixture(fixture: WorkspaceFixture): Promise<void> {
  await fixture.workspace.close();
  await fixture.ledger.close();
  await fixture.store.close();
}

describe('memory Workspace', () => {
  it('publishes the process-local Workspace constructor', () => {
    /** Runtime lookup keeps this first TDD proof executable before types exist. */
    const createMemoryWorkspace = (files as Readonly<Record<string, unknown>>).createMemoryWorkspace;

    expect(createMemoryWorkspace).toBeTypeOf('function');
  });

  it('opens generation zero from a verified immutable base', async () => {
    /** Fixture uses public tree publication, grant construction, and Workspace creation. */
    const fixture = await openWorkspaceFixture();

    expect(fixture.workspace.workspaceId).toBe(workspaceId);
    expect(fixture.workspace.lineageId).toBe(lineageId);
    expect(fixture.workspace.getSnapshot()).toMatchObject({
      workspaceId,
      lineageId,
      generation: 0,
      lifecycle: 'ready',
      quota: { usedFiles: 1, usedBytes: '5' },
    });

    /** The first real mutation key remains unused in this construction-only proof. */
    expect(addKey).toBe('10000000-0000-4000-8000-000000000009');
    await closeWorkspaceFixture(fixture);
  });

  it('applies add, modify, rename, and delete as explicit private lineage transitions', async () => {
    /** One retained Workspace preserves generation and immutable identity across all commands. */
    const fixture = await openWorkspaceFixture();
    /** Addition requires either exact generation or exact absence instead of implicit overwrite. */
    const added = await fixture.workspace.apply(
      {
        type: 'add',
        path: 'src/index.ts',
        content: 'export const value = 1;\n',
        precondition: { kind: 'absent' },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000201'),
      },
      fixture.write,
    );
    expect(added).toMatchObject({ kind: 'applied', snapshot: { generation: 1 }, operation: { type: 'add' } });
    if (added.kind !== 'applied' || added.operation.type !== 'add') throw new Error('Expected an applied add');

    /** Blob precondition allows an edit without excluding unrelated concurrent paths. */
    const modified = await fixture.workspace.apply(
      {
        type: 'modify',
        path: 'src/index.ts',
        content: 'export const value = 2;\n',
        precondition: { kind: 'blob', blob: added.operation.after },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000202'),
      },
      fixture.write,
    );
    expect(modified).toMatchObject({ kind: 'applied', snapshot: { generation: 2 }, operation: { type: 'modify' } });

    /** Rename preserves content identity while acknowledging path intent explicitly. */
    const renamed = await fixture.workspace.apply(
      {
        type: 'rename',
        from: 'src/index.ts',
        to: 'src/main.ts',
        precondition: { kind: 'generation', generation: 2 },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000203'),
      },
      fixture.write,
    );
    expect(renamed).toMatchObject({ kind: 'applied', snapshot: { generation: 3 }, operation: { type: 'rename' } });

    /** Reading through the same public boundary proves the renamed bytes survived. */
    const read = await fixture.workspace.read({ path: 'src/main.ts' }, fixture.read);
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('Expected the renamed file');
    expect(await readText(read.read)).toBe('export const value = 2;\n');

    /** Base-to-head diff remains authoritative and does not infer rename from blob equality. */
    const diff = await fixture.workspace.diff({ expectedGeneration: 3 }, fixture.read);
    expect(diff).toMatchObject({ kind: 'diffed', operations: [{ type: 'add', path: 'src/main.ts' }] });

    /** Deletion uses the current generation and returns the exact removed identity for review. */
    const deleted = await fixture.workspace.apply(
      {
        type: 'delete',
        path: 'src/main.ts',
        precondition: { kind: 'generation', generation: 3 },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000204'),
      },
      fixture.write,
    );
    expect(deleted).toMatchObject({ kind: 'applied', snapshot: { generation: 4 }, operation: { type: 'delete' } });
    expect(await fixture.workspace.list({}, fixture.read)).toMatchObject({
      kind: 'listed',
      entries: [{ path: 'README.md' }],
    });
    await closeWorkspaceFixture(fixture);
  });

  it('returns exact mutation refusals and preserves the acknowledged snapshot', async () => {
    /** Current snapshot identity makes preservation stronger than comparing only generation numbers. */
    const fixture = await openWorkspaceFixture();
    /** Exact object identity proves every refusal retained the acknowledged projection. */
    const before = fixture.workspace.getSnapshot();
    /** Candidate identity lets the test prove refusal does not retain unacknowledged private bytes. */
    const staleAddBlob = blobRefForBytes(new TextEncoder().encode('private'));
    /** Stale generation must fail before an add can enter acknowledged lineage. */
    const staleGeneration = await fixture.workspace.apply(
      {
        type: 'add',
        path: 'notes.txt',
        content: 'private',
        precondition: { kind: 'generation', generation: 4 },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000205'),
      },
      fixture.write,
    );
    expect(staleGeneration).toMatchObject({ kind: 'refused', reason: 'stale-generation' });
    expect(fixture.workspace.getSnapshot()).toBe(before);
    /** Expected refusal must not leave otherwise unreachable candidate content in storage. */
    expect(await fixture.store.blobs.has(staleAddBlob)).toEqual({ ok: true, value: false });

    /** A valid but unrelated digest proves exact stale-content refusal. */
    const staleModifyBlob = blobRefForBytes(new TextEncoder().encode('replacement'));
    /** Replacement bytes must remain unpublished when the current blob precondition fails. */
    const staleBlob = await fixture.workspace.apply(
      {
        type: 'modify',
        path: 'README.md',
        content: 'replacement',
        precondition: { kind: 'blob', blob: blobRefForBytes(new TextEncoder().encode('not the base')) },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000206'),
      },
      fixture.write,
    );
    expect(staleBlob).toMatchObject({ kind: 'refused', reason: 'stale-blob' });
    expect(fixture.workspace.getSnapshot()).toBe(before);
    /** Stale modification also preserves storage, not merely Workspace projection identity. */
    expect(await fixture.store.blobs.has(staleModifyBlob)).toEqual({ ok: true, value: false });

    /** A missing current grant is a current Authority refusal, not a file-domain refusal. */
    const unauthorized = await fixture.workspace.apply(
      {
        type: 'delete',
        path: 'README.md',
        precondition: { kind: 'generation', generation: 0 },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000207'),
      },
      {
        grantId: AuthorizationGrantIdSchema.parse('10000000-0000-4000-8000-000000000299'),
        action: 'workspace-write',
      },
    );
    expect(unauthorized).toMatchObject({ kind: 'authority-refused', refusal: { reason: 'grant-not-found' } });
    expect(fixture.workspace.getSnapshot()).toBe(before);
    await closeWorkspaceFixture(fixture);
  });

  it('replays an identical mutation once and rejects conflicting key reuse', async () => {
    /** One command value is reused byte-for-byte to prove idempotent settlement. */
    const fixture = await openWorkspaceFixture();
    /** Semantic command is held constant for replay and varied only for conflict proof. */
    const command = {
      type: 'add' as const,
      path: 'notes.txt' as const,
      content: 'one',
      precondition: { kind: 'absent' as const },
      idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000208'),
    };
    /** First settlement establishes the retained idempotency result. */
    const first = await fixture.workspace.apply(command, fixture.write);
    /** Exact retry must preserve snapshot identity and report replay. */
    const replay = await fixture.workspace.apply(command, fixture.write);
    /** Reusing the key with different content must preserve generation one. */
    const conflict = await fixture.workspace.apply({ ...command, content: 'two' }, fixture.write);

    expect(first).toMatchObject({ kind: 'applied', replayed: false, snapshot: { generation: 1 } });
    expect(replay).toMatchObject({ kind: 'applied', replayed: true, snapshot: { generation: 1 } });
    expect(conflict).toMatchObject({ kind: 'refused', reason: 'idempotency-conflict', snapshot: { generation: 1 } });
    expect(fixture.workspace.getSnapshot().generation).toBe(1);
    await closeWorkspaceFixture(fixture);
  });

  it('publishes hot state and replayable facts after acknowledgement', async () => {
    /** Durable subscription is attached before mutation so delivery timing is deterministic. */
    const fixture = await openWorkspaceFixture();
    /** Durable subscription receives acknowledged facts from the current epoch. */
    const durable = fixture.workspace.durableEvents.subscribe();
    /** Iterator is retained so the test controls the first delivery boundary exactly. */
    const iterator = durable[Symbol.asyncIterator]();
    /** Pending read proves publication wakes an already-attached observer. */
    const nextEvent = iterator.next();
    /** State callbacks are deferred and coalescing while current reads update synchronously. */
    const observed: number[] = [];
    /** Unsubscribe handle proves the ordinary callback lifecycle remains explicit. */
    const unsubscribe = fixture.workspace.subscribe((snapshot) => observed.push(snapshot.generation));
    /** Mutation settles state and durable event before test observation resumes. */
    const outcome = await fixture.workspace.apply(
      {
        type: 'add',
        path: 'notes.txt',
        content: 'observable',
        precondition: { kind: 'absent' },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000209'),
      },
      fixture.write,
    );
    /** Awaiting the pre-attached read proves delivery rather than post-hoc replay. */
    const delivered = await nextEvent;
    await Promise.resolve();

    expect(outcome).toMatchObject({ kind: 'applied', snapshot: { generation: 1 } });
    expect(fixture.workspace.getSnapshot().generation).toBe(1);
    expect(observed).toEqual([1]);
    expect(delivered).toMatchObject({ done: false, value: { value: { type: 'mutation-applied' } } });
    unsubscribe();
    await durable.close();
    await closeWorkspaceFixture(fixture);
  });

  it('creates one immutable ChangeSet without promoting private work', async () => {
    /** Private mutation first establishes a non-empty base-to-head proposal. */
    const fixture = await openWorkspaceFixture();
    await fixture.workspace.apply(
      {
        type: 'add',
        path: 'notes.txt',
        content: 'proposal',
        precondition: { kind: 'absent' },
        idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000210'),
      },
      fixture.write,
    );
    /** Request value is reused exactly to prove stable proposal identity. */
    const request = {
      expectedGeneration: 1,
      idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000211'),
    };
    /** First command earns one private proposal identity. */
    const created = await fixture.workspace.createChangeSet(request, fixture.changeSet);
    /** Exact retry must return that same proposal as replayed. */
    const replay = await fixture.workspace.createChangeSet(request, fixture.changeSet);

    expect(created).toMatchObject({
      kind: 'created',
      replayed: false,
      changeSet: { object: 'change-set', workspaceId, lineageId, generation: 1, operations: [{ type: 'add' }] },
    });
    expect(replay).toMatchObject({ kind: 'created', replayed: true });
    if (created.kind !== 'created' || replay.kind !== 'created') throw new Error('Expected ChangeSet creation');
    expect(replay.changeSet).toBe(created.changeSet);
    expect(fixture.workspace.getSnapshot().generation).toBe(1);
    await closeWorkspaceFixture(fixture);
  });

  it('accepts only a verified receipt pinned to the current Workspace generation', async () => {
    /** Candidate publication represents bytes independently verified by a Materializer. */
    const fixture = await openWorkspaceFixture();
    /** Candidate tree is published through the same immutable store used by real ingestion. */
    const candidate = await publishTree(fixture.store, [
      { path: 'README.md', content: 'base\n' },
      { path: 'generated.txt', content: 'from physical view' },
    ]);
    if (!candidate.ok) throw candidate.error;
    /** Shared envelope binds adapter identity, mapping, counts, trees, and current generation. */
    const receipt = createPhysicalIngestionReceipt({
      id: IngestionReceiptIdSchema.parse('10000000-0000-4000-8000-000000000214'),
      object: 'ingestion-receipt',
      createdAt: TimestampSchema.parse('2026-08-23T21:02:00.000Z'),
      materializerId: MaterializerIdSchema.parse('10000000-0000-4000-8000-000000000215'),
      materializedViewId: MaterializedViewIdSchema.parse('10000000-0000-4000-8000-000000000212'),
      adapterId: 'archer.directory',
      mappingVersion: 1,
      base: fixture.workspace.getSnapshot().head,
      result: candidate.value.ref,
      generation: 0,
      excludedRoots: Object.freeze(['resources', 'scratchpads']),
      fileCount: candidate.value.files.length,
      byteCount: CanonicalDecimalSchema.parse(
        candidate.value.files.reduce((total, entry) => total + BigInt(entry.blob.byteLength), 0n).toString(),
      ),
      status: 'complete',
    });
    /** A correctly shaped but false digest must fail before Authority or lineage can observe it. */
    const forgedReceipt = Object.freeze({ ...receipt, evidenceDigest: `sha256:${'0'.repeat(64)}` as const });
    await expect(
      fixture.workspace.acceptIngestion(
        {
          receipt: forgedReceipt,
          idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000213'),
        },
        fixture.ingestion,
      ),
    ).rejects.toThrow('Ingestion receipt evidence mismatch');
    expect(fixture.workspace.getSnapshot().generation).toBe(0);

    /** Verified command pins the same exact receipt and current acceptance identity. */
    const command = {
      receipt,
      idempotencyKey: IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000213'),
    };
    /** First acceptance advances acknowledged private lineage exactly once. */
    const accepted = await fixture.workspace.acceptIngestion(command, fixture.ingestion);
    /** Exact retry must preserve generation and report replay. */
    const replay = await fixture.workspace.acceptIngestion(command, fixture.ingestion);

    expect(accepted).toMatchObject({ kind: 'accepted', replayed: false, snapshot: { generation: 1 } });
    expect(replay).toMatchObject({ kind: 'accepted', replayed: true, snapshot: { generation: 1 } });
    expect(await fixture.workspace.list({}, fixture.read)).toMatchObject({
      kind: 'listed',
      entries: [{ path: 'README.md' }, { path: 'generated.txt' }],
    });
    await closeWorkspaceFixture(fixture);
  });

  it('shares one close settlement and refuses later work without closing borrowed dependencies', async () => {
    /** Borrowed store and Authority must outlive the Workspace attachment that used them. */
    const fixture = await openWorkspaceFixture();
    /** First close call owns the one retained cleanup settlement. */
    const first = fixture.workspace.close();
    /** Second close call must reuse exact promise identity. */
    const second = fixture.workspace.close();
    expect(first).toBe(second);
    expect(first).toBe(fixture.workspace.closed);
    expect(await first).toMatchObject({ kind: 'workspace-closed', snapshot: { generation: 0 } });
    expect(await fixture.workspace.read({ path: 'README.md' }, fixture.read)).toEqual({ kind: 'closed' });
    expect(await fixture.store.blobs.has(blobRefForBytes(new TextEncoder().encode('base\n')))).toMatchObject({
      ok: true,
      value: true,
    });
    await fixture.ledger.close();
    await fixture.store.close();
  });
});
