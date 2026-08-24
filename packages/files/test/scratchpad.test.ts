/**
 * @file Proves retention-discriminated Scratchpads through public contracts.
 *
 * Fixtures use ordinary external-session ownership so the behavior is useful
 * before an application adopts Archer Tasks, Threads, models, or sandboxes.
 */

import { describe, expect, it } from 'vitest';

import { IdempotencyKeySchema, TimestampSchema, UuidV4Schema, borrowed } from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  type GrantRef,
} from '@archer/core/authority';

import {
  SCRATCHPAD_CHECKPOINT_ACTION,
  SCRATCHPAD_READ_ACTION,
  SCRATCHPAD_WRITE_ACTION,
  ScratchpadIdSchema,
  blobRefForBytes,
  createMemoryScratchpad,
  memoryFileStore,
  type EphemeralScratchpadHandle,
  type MemoryScratchpadRetention,
  type RetainedScratchpadHandle,
  type ScratchpadAction,
  type ScratchpadCheckpointAction,
  type ScratchpadReadAction,
  type ScratchpadWriteAction,
} from '../src/index.js';

/** Stable external Authority ledger identity for Scratchpad fixtures. */
const ledgerId = AuthorityLedgerIdSchema.parse('30000000-0000-4000-8000-000000000001');

/** Stable private Scratchpad identity protected by every fixture grant. */
const scratchpadId = ScratchpadIdSchema.parse('30000000-0000-4000-8000-000000000002');

/** Stable Principal attributed to every protected Scratchpad method. */
const principalId = PrincipalIdSchema.parse('30000000-0000-4000-8000-000000000003');

/** Stable ordinary application-session owner independent of Archer agent concepts. */
const owner = Object.freeze({
  type: 'external' as const,
  id: UuidV4Schema.parse('30000000-0000-4000-8000-000000000004'),
});

/** Stable external trust-root creation time. */
const createdAt = TimestampSchema.parse('2026-08-23T22:00:00.000Z');

/** Stable whole-Scratchpad read root. */
const readGrantId = AuthorizationGrantIdSchema.parse('30000000-0000-4000-8000-000000000005');

/** Stable whole-Scratchpad write root. */
const writeGrantId = AuthorizationGrantIdSchema.parse('30000000-0000-4000-8000-000000000006');

/** Stable broad checkpoint root used only by retained fixture handles. */
const checkpointGrantId = AuthorizationGrantIdSchema.parse('30000000-0000-4000-8000-000000000007');

/** Scratchpad handle selected precisely by one process-local retention mode. */
type MemoryScratchpadHandle<R extends MemoryScratchpadRetention> = R extends 'ephemeral'
  ? EphemeralScratchpadHandle
  : RetainedScratchpadHandle<'checkpointed'>;

/** Retained handle, dependencies, and current grant references for one test. */
type ScratchpadFixture<R extends MemoryScratchpadRetention> = Readonly<{
  /** Process-local immutable content store owned by the fixture. */
  store: ReturnType<typeof memoryFileStore>;
  /** Current external Authority ledger under test. */
  ledger: ReturnType<typeof createMemoryAuthorityLedger<ScratchpadAction>>;
  /** Retention-discriminated private Scratchpad handle. */
  scratchpad: MemoryScratchpadHandle<R>;
  /** Current whole-Scratchpad read lookup. */
  read: GrantRef<ScratchpadReadAction>;
  /** Current whole-Scratchpad write lookup. */
  write: GrantRef<ScratchpadWriteAction>;
  /** Current broad checkpoint lookup. */
  checkpoint: GrantRef<ScratchpadCheckpointAction>;
}>;

/**
 * Opens one real external Authority ledger and process-local Scratchpad.
 * @param retention - Exact honest process-local cleanup and checkpoint mode.
 * @returns Production-reachable empty Scratchpad fixture.
 */
async function openScratchpadFixture<R extends MemoryScratchpadRetention>(retention: R): Promise<ScratchpadFixture<R>> {
  /** Content-addressed storage makes every edit and checkpoint production-reachable. */
  const store = memoryFileStore();
  /** Whole read root may later be attenuated to one logical subtree. */
  const readRoot = createBootstrapAuthorizationGrant<ScratchpadReadAction>(SCRATCHPAD_READ_ACTION, {
    id: readGrantId,
    ledgerId,
    subject: principalId,
    scope: { kind: 'scratchpad-read', scratchpadId },
    issuedBy: principalId,
    createdAt,
  });
  /** Whole write root still requires current verification on every command. */
  const writeRoot = createBootstrapAuthorizationGrant<ScratchpadWriteAction>(SCRATCHPAD_WRITE_ACTION, {
    id: writeGrantId,
    ledgerId,
    subject: principalId,
    scope: { kind: 'scratchpad-write', scratchpadId },
    issuedBy: principalId,
    createdAt,
  });
  /** Broad retained root may later be attenuated to one exact generation. */
  const checkpointRoot = createBootstrapAuthorizationGrant<ScratchpadCheckpointAction>(SCRATCHPAD_CHECKPOINT_ACTION, {
    id: checkpointGrantId,
    ledgerId,
    subject: principalId,
    scope: { kind: 'scratchpad-checkpoint', scratchpadId },
    issuedBy: principalId,
    createdAt,
  });
  /** Real broker prevents structurally valid grant references from becoming permission. */
  const ledger = createMemoryAuthorityLedger<ScratchpadAction>({
    ledgerId,
    actions: [SCRATCHPAD_READ_ACTION, SCRATCHPAD_WRITE_ACTION, SCRATCHPAD_CHECKPOINT_ACTION],
    bootstrap: [readRoot, writeRoot, checkpointRoot],
    /**
     * Keeps every fixture grant current without consulting wall time.
     * @returns Fixed trusted instant after every bootstrap grant became active.
     */
    now: () => new Date('2026-08-23T22:30:00.000Z'),
  });
  /** Deterministic identity counter covers internal composition and public checkpoint facts. */
  let nextId = 101;
  /**
   * Supplies valid UUIDv4 text in exact construction and mutation order.
   * @returns Next deterministic process-local identity.
   */
  const createId = (): string => `30000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  /** Runtime overload returns a handle whose methods match the selected retention. */
  const opened = await createMemoryScratchpad({
    scratchpadId,
    owner,
    retention,
    subject: principalId,
    store: borrowed(store),
    authority: borrowed(ledger),
    createId,
    /**
     * Keeps checkpoint and close evidence deterministic.
     * @returns Fixed trusted instant used by the Scratchpad runtime.
     */
    now: () => new Date('2026-08-23T22:30:00.000Z'),
  } as Parameters<typeof createMemoryScratchpad>[0]);
  if (!opened.ok) throw opened.error;
  return Object.freeze({
    store,
    ledger,
    scratchpad: opened.value as MemoryScratchpadHandle<R>,
    read: Object.freeze({ grantId: readRoot.id, action: readRoot.action }),
    write: Object.freeze({ grantId: writeRoot.id, action: writeRoot.action }),
    checkpoint: Object.freeze({ grantId: checkpointRoot.id, action: checkpointRoot.action }),
  });
}

/**
 * Closes one Scratchpad fixture in retained-owner order.
 * @param fixture - Scratchpad, external Authority, and store to release.
 */
async function closeScratchpadFixture(fixture: ScratchpadFixture<MemoryScratchpadRetention>): Promise<void> {
  await fixture.scratchpad.close();
  await fixture.ledger.close();
  await fixture.store.close();
}

describe('memory Scratchpad', () => {
  it('makes retention change the actual runtime method surface', async () => {
    /** Ephemeral mode must not suggest a checkpoint guarantee it cannot earn. */
    const ephemeral = await openScratchpadFixture('ephemeral');
    /** Checkpointed mode must expose both the command and replayable facts. */
    const retained = await openScratchpadFixture('checkpointed');
    expect(ephemeral.scratchpad.retention).toBe('ephemeral');
    expect('checkpoint' in ephemeral.scratchpad).toBe(false);
    expect('checkpointEvents' in ephemeral.scratchpad).toBe(false);
    expect(retained.scratchpad.retention).toBe('checkpointed');
    expect(retained.scratchpad.checkpoint).toBeTypeOf('function');
    expect(retained.scratchpad.checkpointEvents.kind).toBe('replayable');
    await closeScratchpadFixture(ephemeral);
    await closeScratchpadFixture(retained);
  });

  it('exposes ordinary private file edits as hot state and transient updates', async () => {
    /** Existing application code can treat the Scratchpad as scoped working files. */
    const fixture = await openScratchpadFixture('ephemeral');
    /** Transient subscription is attached before mutation to control delivery timing. */
    const updates = fixture.scratchpad.updates.subscribe();
    /** Pending read proves a live update wakes an already-attached consumer. */
    const nextUpdate = updates[Symbol.asyncIterator]().next();
    /** State callback captures acknowledged generations rather than transient phases. */
    const observed: number[] = [];
    /** Explicit unsubscribe handle proves ordinary callback lifecycle. */
    const unsubscribe = fixture.scratchpad.subscribe((snapshot) => observed.push(snapshot.generation));
    /** Mutation exercises ordinary private notes instead of an Archer agent abstraction. */
    const applied = await fixture.scratchpad.apply(
      {
        type: 'add',
        path: 'research/notes.md',
        content: '# Working notes\n',
        precondition: { kind: 'absent' },
        idempotencyKey: IdempotencyKeySchema.parse('30000000-0000-4000-8000-000000000201'),
      },
      fixture.write,
    );
    /** Awaiting the pre-attached read distinguishes live delivery from later inspection. */
    const delivered = await nextUpdate;
    await Promise.resolve();

    expect(applied).toMatchObject({ kind: 'applied', snapshot: { retention: 'ephemeral', generation: 1 } });
    expect(fixture.scratchpad.getSnapshot()).toMatchObject({ generation: 1, quota: { usedFiles: 1 } });
    expect(observed).toEqual([1]);
    expect(delivered).toMatchObject({
      done: false,
      value: { kind: 'event', value: { type: 'mutation-applied', generation: 1, operation: { type: 'add' } } },
    });
    expect(await fixture.scratchpad.list({ prefix: 'research' }, fixture.read)).toMatchObject({
      kind: 'listed',
      entries: [{ path: 'research/notes.md' }],
    });
    unsubscribe();
    await updates.close();
    await closeScratchpadFixture(fixture);
  });

  it('creates one immutable checkpoint fact and replays exact command identity', async () => {
    /** Retained mode acknowledges private content only at an explicit command boundary. */
    const fixture = await openScratchpadFixture('checkpointed');
    await fixture.scratchpad.apply(
      {
        type: 'add',
        path: 'draft.txt',
        content: 'checkpoint me',
        precondition: { kind: 'absent' },
        idempotencyKey: IdempotencyKeySchema.parse('30000000-0000-4000-8000-000000000202'),
      },
      fixture.write,
    );
    /** Durable subscription starts after content mutation but before checkpoint acknowledgement. */
    const events = fixture.scratchpad.checkpointEvents.subscribe();
    /** Pending read controls the exact first retained-event delivery boundary. */
    const nextEvent = events[Symbol.asyncIterator]().next();
    /** Exact command value is reused to prove stable checkpoint identity. */
    const command = {
      expectedGeneration: 1,
      idempotencyKey: IdempotencyKeySchema.parse('30000000-0000-4000-8000-000000000203'),
    };
    /** First command earns one immutable checkpoint and retained event. */
    const created = await fixture.scratchpad.checkpoint(command, fixture.checkpoint);
    /** Exact retry must return the same checkpoint and emit no duplicate fact. */
    const replay = await fixture.scratchpad.checkpoint(command, fixture.checkpoint);
    /** Awaiting the pending read proves retained fact publication occurred. */
    const delivered = await nextEvent;

    expect(created).toMatchObject({
      kind: 'created',
      replayed: false,
      checkpoint: { object: 'scratchpad-checkpoint', scratchpadId, generation: 1, retention: 'checkpointed' },
    });
    expect(replay).toMatchObject({ kind: 'created', replayed: true });
    if (created.kind !== 'created' || replay.kind !== 'created') throw new Error('Expected checkpoint creation');
    expect(replay.checkpoint).toBe(created.checkpoint);
    expect(fixture.scratchpad.getSnapshot().checkpoint).toEqual(created.checkpoint.tree);
    expect(delivered).toMatchObject({ done: false, value: { value: { type: 'checkpoint-created' } } });
    await events.close();
    expect(await fixture.scratchpad.close()).toMatchObject({ disposition: 'checkpoint-retained' });
    await fixture.ledger.close();
    await fixture.store.close();
  });

  it('preserves current content on stale checkpoint and missing current Authority', async () => {
    /** Expected refusals return tagged evidence and never manufacture Error control flow. */
    const fixture = await openScratchpadFixture('checkpointed');
    /** Exact current object identity proves refused commands preserve state. */
    const before = fixture.scratchpad.getSnapshot();
    /** Expected generation one is stale against the empty generation-zero Scratchpad. */
    const stale = await fixture.scratchpad.checkpoint(
      {
        expectedGeneration: 1,
        idempotencyKey: IdempotencyKeySchema.parse('30000000-0000-4000-8000-000000000204'),
      },
      fixture.checkpoint,
    );
    expect(stale).toEqual({ kind: 'stale-generation', actualGeneration: 0 });
    expect(fixture.scratchpad.getSnapshot()).toBe(before);

    /** Missing current grant must refuse before private content changes. */
    const unauthorized = await fixture.scratchpad.apply(
      {
        type: 'add',
        path: 'secret.txt',
        content: 'private',
        precondition: { kind: 'absent' },
        idempotencyKey: IdempotencyKeySchema.parse('30000000-0000-4000-8000-000000000205'),
      },
      {
        grantId: AuthorizationGrantIdSchema.parse('30000000-0000-4000-8000-000000000099'),
        action: 'scratchpad-write',
      },
    );
    expect(unauthorized).toMatchObject({ kind: 'authority-refused', refusal: { reason: 'grant-not-found' } });
    expect(fixture.scratchpad.getSnapshot()).toBe(before);
    await closeScratchpadFixture(fixture);
  });

  it('states ephemeral release honestly without claiming shared blob deletion', async () => {
    /** Closing an attachment releases recoverability; a borrowed content store remains alive. */
    const fixture = await openScratchpadFixture('ephemeral');
    /** First close call owns the one retained cleanup settlement. */
    const first = fixture.scratchpad.close();
    /** Second close call must reuse exact promise identity. */
    const second = fixture.scratchpad.close();
    expect(first).toBe(second);
    expect(first).toBe(fixture.scratchpad.closed);
    expect(await first).toMatchObject({ kind: 'scratchpad-closed', disposition: 'ephemeral-released' });
    expect(await fixture.store.blobs.has(blobRefForBytes(new Uint8Array()))).toMatchObject({
      ok: true,
    });
    await fixture.ledger.close();
    await fixture.store.close();
  });
});
