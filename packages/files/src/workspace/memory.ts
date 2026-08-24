/**
 * @file Implements the process-local reference Workspace over a FileStore.
 *
 * The runtime serializes commands and owns hot observation while delegating
 * immutable bytes, current authorization, and optional diagnostics to explicit
 * dependencies. It makes no process-restart durability claim.
 */

import { createHash } from 'node:crypto';

import {
  Result,
  TimestampSchema,
  UuidV4Schema,
  type ComponentRef,
  type DiagnosticHub,
  type DiagnosticSpan,
  type JsonObject,
  type Result as ResultValue,
} from '@archer/core';
import { PrincipalIdSchema, type AuthorityBroker, type GrantRef, type PrincipalId } from '@archer/core/authority';
import {
  asReplayableEventStream,
  createAtomicLiveAttachmentSource,
  createVersionedLiveState,
  replayableEventSource,
  type EventEncoding,
} from '@archer/core/stream';

import { FileModeSchema, TreeRefSchema, blobRefForBytes, type TreeRef } from '../encoding.js';
import { FilesError } from '../errors.js';
import { LogicalPathSchema, type LogicalPath } from '../path.js';
import { publishTreeEntries, restoreTree, type FileStore, type ImmutableTree } from '../store.js';
import {
  ChangeSetIdSchema,
  WorkspaceIdSchema,
  WorkspaceLineageIdSchema,
  WorkspaceSnapshotIdSchema,
  type WorkspaceId,
  type WorkspaceLineageId,
} from '../work-values.js';
import {
  DEFAULT_WORKSPACE_MAX_BYTES,
  DEFAULT_WORKSPACE_MAX_FILES,
  WorkspaceIngestionCommandSchema,
  WorkspaceMutationSchema,
  WorkspaceQuotaSchema,
  type ChangeSetCreateAction,
  type ChangeSetOutcome,
  type ChangeSetRequest,
  type WorkspaceAction,
  type WorkspaceEvent,
  type WorkspaceHandle,
  type WorkspaceIngestionAcceptAction,
  type WorkspaceIngestionCommand,
  type WorkspaceIngestionOutcome,
  type WorkspaceListOutcome,
  type WorkspaceListRequest,
  type WorkspaceMutation,
  type WorkspaceMutationOutcome,
  type WorkspaceQuota,
  type WorkspaceReadAction,
  type WorkspaceReadOutcome,
  type WorkspaceReadRequest,
  type WorkspaceDiffOutcome,
  type WorkspaceDiffRequest,
  type WorkspaceWriteAction,
} from './contracts.js';
import {
  DEFAULT_WORKSPACE_FILE_MODE,
  advanceWorkspace,
  createChangeSetValue,
  createWorkspaceSnapshot,
  diffWorkspaceTrees,
  equalBlobRef,
  equalTreeRef,
  planWorkspaceMutation,
  projectWorkspaceHandle,
  workspaceEntriesFitQuota,
  type PreparedWorkspaceMutation,
  type WorkspaceAggregate,
} from './model.js';

/** Supplies UUIDv4 text for deterministic identities and source epochs. */
export type WorkspaceIdFactory = () => string;

/** Supplies trusted wall time independently of diagnostics and host globals. */
export type WorkspaceClock = () => Date;

/** Options required to open one process-local private Workspace. */
export type CreateMemoryWorkspaceOptions = Readonly<{
  /** Names the Workspace before any retained state is constructed. */
  workspaceId: WorkspaceId;
  /** Names the uninterrupted private history rooted at the supplied base. */
  lineageId: WorkspaceLineageId;
  /** Selects the exact immutable tree used as generation zero. */
  base: TreeRef;
  /** Binds every protected method to one attributed Principal. */
  subject: PrincipalId;
  /** Marks whether Workspace closure owns the underlying immutable store. */
  store: ComponentRef<FileStore>;
  /** Marks whether Workspace closure owns the current Authority broker. */
  authority: ComponentRef<AuthorityBroker<WorkspaceAction>>;
  /** Replaces the documented process-local file and byte defaults. */
  quota?: WorkspaceQuota;
  /** Supplies deterministic UUIDv4 identities in tests and adapters. */
  createId?: WorkspaceIdFactory;
  /** Supplies trusted snapshot and lifecycle instants. */
  now?: WorkspaceClock;
  /** Receives best-effort wide spans without gaining Workspace authority. */
  diagnostics?: Pick<DiagnosticHub, 'beginSpan'>;
}>;

/** UTF-8 encoder measures normalized event payloads for bounded delivery. */
const TEXT_ENCODER = new TextEncoder();

/**
 * Supplies host UUIDv4 identity only when a caller did not inject one.
 * @returns Fresh platform-generated UUIDv4 text.
 */
function systemIdFactory(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Supplies host wall time only when a caller did not inject a trusted clock.
 * @returns Fresh mutable Date that is immediately normalized by the caller.
 */
function systemClock(): Date {
  return new Date();
}

/**
 * Normalizes one trusted clock read into Archer's canonical UTC timestamp.
 * @param now - Injected or system wall-clock capability.
 * @returns Canonical immutable timestamp text.
 */
function workspaceTimestamp(now: WorkspaceClock) {
  return TimestampSchema.parse(now().toISOString());
}

/**
 * Creates a bounded invalid-construction error while retaining a local cause.
 * @param cause - Schema, restore, or configuration failure kept process-local.
 * @returns Stable files-domain Error suitable for the ordinary Result branch.
 */
function invalidWorkspace(cause: unknown): FilesError {
  return new FilesError('files_invalid_input', 'Invalid private Workspace construction', { cause });
}

/** Event encoding owns normalization and byte measurement for Workspace replay. */
const WORKSPACE_EVENT_ENCODING: EventEncoding<WorkspaceEvent> = Object.freeze({
  revision: 'archer-workspace-event/1',
  /**
   * Retains only runtime-owned immutable facts at the publication boundary.
   * @param event - Event assembled after complete Workspace settlement.
   * @returns Frozen event safe for replay retention.
   */
  normalize(event) {
    return Object.freeze(event);
  },
  /**
   * Measures the exact JSON projection used by this process-local reference.
   * @param event - Normalized Workspace fact.
   * @returns UTF-8 bytes charged independently to each subscriber.
   */
  measure(event) {
    return TEXT_ENCODER.encode(JSON.stringify(event)).byteLength;
  },
});

/**
 * Returns the exact logical paths affected by one mutation for Authority scope.
 * @param mutation - Admitted immutable mutation command.
 * @returns One or two canonical paths with duplicates removed.
 */
function mutationPaths(mutation: WorkspaceMutation): readonly LogicalPath[] {
  return mutation.type === 'rename'
    ? Object.freeze([...new Set([LogicalPathSchema.parse(mutation.from), LogicalPathSchema.parse(mutation.to)])])
    : Object.freeze([LogicalPathSchema.parse(mutation.path)]);
}

/**
 * Produces deterministic command identity without retaining raw content.
 * @param mutation - Admitted command whose idempotency key is excluded.
 * @returns SHA-256 fingerprint over exact semantic mutation input.
 */
function mutationFingerprint(mutation: WorkspaceMutation): string {
  /** Byte content is copied by admission and encoded only for local comparison. */
  const content =
    'content' in mutation
      ? typeof mutation.content === 'string'
        ? `text:${mutation.content}`
        : `bytes:${Buffer.from(mutation.content).toString('base64')}`
      : undefined;
  /** Explicit property order avoids dependence on caller object insertion order. */
  const identity =
    mutation.type === 'rename'
      ? {
          type: mutation.type,
          from: mutation.from,
          to: mutation.to,
          precondition: mutation.precondition,
        }
      : {
          type: mutation.type,
          path: mutation.path,
          content,
          ...('mode' in mutation ? { mode: mutation.mode } : {}),
          precondition: mutation.precondition,
        };
  /** Hashing prevents replay bookkeeping from retaining private plaintext or bytes. */
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

/**
 * Begins one best-effort wide Workspace span with no protected paths or bytes.
 * @param diagnostics - Optional borrowed diagnostic capability.
 * @param name - Stable Workspace operation name.
 * @param workspaceId - Safe correlation identity for this retained owner.
 * @param attributes - Bounded operation context excluding file content and paths.
 * @returns Open span or absence when diagnostics are missing or fail.
 */
function beginWorkspaceSpan(
  diagnostics: Pick<DiagnosticHub, 'beginSpan'> | undefined,
  name: string,
  workspaceId: WorkspaceId,
  attributes: JsonObject,
): DiagnosticSpan | undefined {
  if (diagnostics === undefined) return undefined;
  try {
    return diagnostics.beginSpan({
      name,
      component: 'files.workspace.memory',
      correlation: { workspaceId },
      attributes: { workspace: attributes },
    });
  } catch {
    return undefined;
  }
}

/**
 * Completes best-effort Workspace observation without influencing its result.
 * @param span - Optional open span returned by the admission helper.
 * @param outcome - Stable domain outcome discriminator.
 * @param attributes - Bounded terminal context excluding private content.
 */
function completeWorkspaceSpan(span: DiagnosticSpan | undefined, outcome: string, attributes: JsonObject): void {
  if (span === undefined) return;
  try {
    span.enrich('workspace.result', attributes);
    span.complete({ outcome });
  } catch {
    // Diagnostics are deliberately non-authoritative over private lineage.
  }
}

/**
 * Fails best-effort Workspace observation without replacing the thrown Error.
 * @param span - Optional open span returned by the admission helper.
 * @param outcome - Stable operation-local failure category.
 */
function failWorkspaceSpan(span: DiagnosticSpan | undefined, outcome: string): void {
  if (span === undefined) return;
  try {
    span.abandon({ reason: outcome });
  } catch {
    // A diagnostic implementation defect cannot change Workspace failure.
  }
}

/** Retained idempotency evidence for a completed Workspace mutation command. */
type MutationReplay = Readonly<{
  /** Detects one key reused for different semantic command input. */
  fingerprint: string;
  /** Retains the immutable original command outcome. */
  outcome: WorkspaceMutationOutcome;
}>;

/** Retained idempotency evidence for a completed ChangeSet command. */
type ChangeSetReplay = Readonly<{
  /** Detects one key reused for a different expected generation. */
  fingerprint: string;
  /** Retains the immutable original proposal outcome. */
  outcome: ChangeSetOutcome;
}>;

/** Retained idempotency evidence for completed ingestion acceptance. */
type IngestionReplay = Readonly<{
  /** Detects one key reused for different receipt evidence. */
  fingerprint: string;
  /** Retains the immutable original acceptance outcome. */
  outcome: WorkspaceIngestionOutcome;
}>;

/**
 * Rewrites only the replay marker on a successful mutation outcome.
 * @param outcome - Original immutable retained outcome.
 * @returns Replay-visible outcome without changing snapshots or operations.
 */
function replayMutation(outcome: WorkspaceMutationOutcome): WorkspaceMutationOutcome {
  return outcome.kind === 'applied' || outcome.kind === 'unchanged'
    ? Object.freeze({ ...outcome, replayed: true })
    : outcome;
}

/**
 * Rewrites only the replay marker on a successful ChangeSet outcome.
 * @param outcome - Original immutable retained outcome.
 * @returns Replay-visible outcome without changing proposal identity.
 */
function replayChangeSet(outcome: ChangeSetOutcome): ChangeSetOutcome {
  return outcome.kind === 'created' ? Object.freeze({ ...outcome, replayed: true }) : outcome;
}

/**
 * Rewrites only the replay marker on a successful ingestion outcome.
 * @param outcome - Original immutable retained outcome.
 * @returns Replay-visible outcome without changing snapshot identity.
 */
function replayIngestion(outcome: WorkspaceIngestionOutcome): WorkspaceIngestionOutcome {
  return outcome.kind === 'accepted' || outcome.kind === 'unchanged'
    ? Object.freeze({ ...outcome, replayed: true })
    : outcome;
}

/**
 * Opens the process-local Workspace reference after restoring its exact base.
 * @param options - Explicit identity, ownership, authority, quota, and clocks.
 * @returns A retained Workspace or one ordinary files-domain construction error.
 */
export async function createMemoryWorkspace(
  options: CreateMemoryWorkspaceOptions,
): Promise<ResultValue<WorkspaceHandle, FilesError>> {
  /** Dependencies transfer only on successful construction or explicit cleanup below. */
  const store = options.store.value;
  /** Current broker remains the sole permission decision owner. */
  const authority = options.authority.value;
  /** Caller injection controls every generated identity in deterministic tests. */
  const createId = options.createId ?? systemIdFactory;
  /** Caller injection controls snapshots and lifecycle time independently of diagnostics. */
  const now = options.now ?? systemClock;

  try {
    /** Re-admits branded identities at the JavaScript construction boundary. */
    const workspaceId = WorkspaceIdSchema.parse(options.workspaceId);
    /** Re-admits lineage independently from Workspace identity. */
    const lineageId = WorkspaceLineageIdSchema.parse(options.lineageId);
    /** Binds every method to one admitted Principal attribution value. */
    const subject = PrincipalIdSchema.parse(options.subject);
    /** Re-admits immutable base identity before touching storage. */
    const baseRef = TreeRefSchema.parse(options.base);
    /** Copies and freezes quota so caller mutation cannot weaken later enforcement. */
    const quota = WorkspaceQuotaSchema.parse(
      options.quota ?? { maxFiles: DEFAULT_WORKSPACE_MAX_FILES, maxBytes: DEFAULT_WORKSPACE_MAX_BYTES },
    );
    /** Restoration verifies every referenced node and blob before a handle exists. */
    const restored = await restoreTree(store, baseRef);
    if (!restored.ok) return restored;
    if (!workspaceEntriesFitQuota(restored.value.files, quota)) {
      return Result.error(
        new FilesError('files_invalid_input', 'Workspace base exceeds configured quota', {
          details: { workspaceId },
        }),
      );
    }

    /** Stream generation remains process-local and never claims persistent cursor recovery. */
    const epoch = UuidV4Schema.parse(createId());
    /** Generation-zero snapshot is earned only after full verified restoration. */
    const initialSnapshot = createWorkspaceSnapshot({
      id: WorkspaceSnapshotIdSchema.parse(createId()),
      workspaceId,
      lineageId,
      tree: restored.value.ref,
      generation: 0,
      createdAt: workspaceTimestamp(now),
    });
    /** Aggregate is replaced atomically only after successful transition settlement. */
    let aggregate: WorkspaceAggregate = Object.freeze({
      workspaceId,
      lineageId,
      base: restored.value,
      head: restored.value,
      generation: 0,
      snapshot: initialSnapshot,
      quota,
    });
    /** Versioned state owns one hot projection and coalescing callback graph. */
    const state = createVersionedLiveState(projectWorkspaceHandle(aggregate, 'ready'), {
      source: 'workspace',
      epoch,
    });
    /** Replayable events retain acknowledged facts only for this live process attachment. */
    const events = replayableEventSource<WorkspaceEvent>()({
      source: 'workspace',
      scope: lineageId,
      streamId: workspaceId,
      epoch,
      retentionItems: 4_096,
      eventEncoding: WORKSPACE_EVENT_ENCODING,
    });
    /** Atomic bridge has no transient lane until a physical ingestion operation attaches one. */
    const bridge = createAtomicLiveAttachmentSource({
      state,
      durable: events,
      transient: Object.freeze({}),
    });
    /** Mutation replays remain separate from proposal and ingestion command spaces. */
    const mutationReplays = new Map<string, MutationReplay>();
    /** Proposal replays retain stable ChangeSet identities. */
    const changeSetReplays = new Map<string, ChangeSetReplay>();
    /** Ingestion replays prevent duplicate lineage advancement. */
    const ingestionReplays = new Map<string, IngestionReplay>();
    /** Promise tail serializes every state-sensitive command without a hidden scheduler. */
    let commandTail: Promise<void> = Promise.resolve();
    /** Stops command acceptance after close reaches its serialized boundary. */
    let closed = false;
    /** Starts retained cleanup once while keeping `closed` observable immediately. */
    let closeStarted = false;
    /** Resolves the public close settlement exactly once. */
    let settleClosed: ((evidence: import('./contracts.js').WorkspaceCloseEvidence) => void) | undefined;
    /** Rejects the public close settlement if owned dependency cleanup rejects. */
    let rejectClosed: ((reason: unknown) => void) | undefined;
    /** Public lifecycle promise exists before close is requested. */
    const closedPromise = new Promise<import('./contracts.js').WorkspaceCloseEvidence>((resolve, reject) => {
      settleClosed = resolve;
      rejectClosed = reject;
    });

    /**
     * Runs one command after every previously admitted state-sensitive command.
     * @param work - Exclusive asynchronous operation over current aggregate state.
     * @returns Exact operation result after releasing the next queued command.
     */
    async function exclusive<Value>(work: () => Promise<Value>): Promise<Value> {
      /** Captures the prior tail before this command installs its release barrier. */
      const prior = commandTail;
      /** Releases the next command even when this one rejects. */
      let release: (() => void) | undefined;
      /** New tail blocks later commands until this command finishes. */
      commandTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await work();
      } finally {
        release?.();
      }
    }

    /**
     * Derives immutable content identity without publishing unacknowledged bytes.
     * @param mutation - Admitted mutation currently holding exclusive state access.
     * @returns Prepared pure mutation ready for domain planning.
     */
    function prepareMutation(mutation: WorkspaceMutation): PreparedWorkspaceMutation {
      if (mutation.type === 'add' || mutation.type === 'modify') {
        /** Pure raw identity lets preconditions and quotas reject before storage changes. */
        const blob = blobRefForBytes(
          typeof mutation.content === 'string' ? TEXT_ENCODER.encode(mutation.content) : mutation.content,
        );
        if (mutation.type === 'add') {
          return Object.freeze({
            type: 'add',
            path: LogicalPathSchema.parse(mutation.path),
            blob,
            mode: FileModeSchema.parse(mutation.mode ?? DEFAULT_WORKSPACE_FILE_MODE),
            precondition: mutation.precondition,
          });
        }
        return Object.freeze({
          type: 'modify',
          path: LogicalPathSchema.parse(mutation.path),
          blob,
          ...(mutation.mode === undefined ? {} : { mode: FileModeSchema.parse(mutation.mode) }),
          precondition: mutation.precondition,
        });
      }
      return mutation.type === 'rename'
        ? Object.freeze({
            type: 'rename',
            from: LogicalPathSchema.parse(mutation.from),
            to: LogicalPathSchema.parse(mutation.to),
            precondition: mutation.precondition,
          })
        : Object.freeze({
            type: 'delete',
            path: LogicalPathSchema.parse(mutation.path),
            precondition: mutation.precondition,
          });
    }

    /** Public retained handle delegates observation to source-owned facades. */
    const handle: WorkspaceHandle = {
      workspaceId,
      lineageId,
      closed: closedPromise,
      durableEvents: asReplayableEventStream(events),
      attachLive: bridge.attachLive,
      /** Returns the latest acknowledged immutable projection by stable identity. */
      getSnapshot: state.getSnapshot,
      /** Attaches one deferred coalescing state listener without causing work. */
      subscribe: state.subscribe,
      /**
       * Reads one exact file after current path-scoped Authority verification.
       * @param request - Logical path to read from the acknowledged head.
       * @param grant - Current permission presented for that exact private path.
       * @returns Found streaming content, absence, closure, or current Authority refusal.
       */
      async read(request: WorkspaceReadRequest, grant: GrantRef<WorkspaceReadAction>): Promise<WorkspaceReadOutcome> {
        /** Re-admits JavaScript callers before scope construction. */
        const path = LogicalPathSchema.parse(request.path);
        return exclusive(async () => {
          if (closed) return Object.freeze({ kind: 'closed' });
          /** Verification occurs against the exact current path immediately before read. */
          const decision = await authority.verify<WorkspaceReadAction>({
            grant,
            subject,
            scope: { kind: 'workspace-read', workspaceId, paths: [path] },
          });
          if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
          /** Entry selection observes one acknowledged aggregate while exclusive. */
          const entry = aggregate.head.files.find((candidate) => candidate.path === path);
          if (entry === undefined) return Object.freeze({ kind: 'not-found', path });
          /** Blob stream verifies exact bytes only if its caller consumes terminal completion. */
          const read = await store.blobs.read(entry.blob);
          if (!read.ok) throw read.error;
          return Object.freeze({ kind: 'found', entry, read: read.value });
        });
      },
      /**
       * Lists one acknowledged subtree after current path-scoped verification.
       * @param request - Optional logical subtree prefix; omission requests the whole Workspace.
       * @param grant - Current permission presented for the requested private subtree.
       * @returns Canonical entries, closure, or current Authority refusal.
       */
      async list(request: WorkspaceListRequest, grant: GrantRef<WorkspaceReadAction>): Promise<WorkspaceListOutcome> {
        /** Omission means whole-Workspace access and remains distinct from an empty path. */
        const prefix = request.prefix === undefined ? undefined : LogicalPathSchema.parse(request.prefix);
        return exclusive(async () => {
          if (closed) return Object.freeze({ kind: 'closed' });
          /** Exact prefix or whole-Workspace scope is verified before private names are returned. */
          const decision = await authority.verify<WorkspaceReadAction>({
            grant,
            subject,
            scope: {
              kind: 'workspace-read',
              workspaceId,
              ...(prefix === undefined ? {} : { paths: [prefix] }),
            },
          });
          if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
          /** Segment-aware prefix prevents sibling names from entering the listing. */
          const entries = Object.freeze(
            aggregate.head.files.filter(
              (entry) => prefix === undefined || entry.path === prefix || entry.path.startsWith(`${prefix}/`),
            ),
          );
          return Object.freeze({ kind: 'listed', entries });
        });
      },
      /**
       * Computes base-to-head review data after current whole-Workspace authorization.
       * @param request - Optional expected generation guarding the review projection.
       * @param grant - Current whole-Workspace read permission.
       * @returns Exact review operations, staleness, closure, or current Authority refusal.
       */
      async diff(request: WorkspaceDiffRequest, grant: GrantRef<WorkspaceReadAction>): Promise<WorkspaceDiffOutcome> {
        return exclusive(async () => {
          if (closed) return Object.freeze({ kind: 'closed' });
          /** Whole-Workspace request cannot be satisfied by a path-attenuated read grant. */
          const decision = await authority.verify<WorkspaceReadAction>({
            grant,
            subject,
            scope: { kind: 'workspace-read', workspaceId },
          });
          if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
          if (request.expectedGeneration !== undefined && request.expectedGeneration !== aggregate.generation) {
            return Object.freeze({ kind: 'stale-generation', actualGeneration: aggregate.generation });
          }
          return Object.freeze({
            kind: 'diffed',
            base: aggregate.base.ref,
            result: aggregate.head.ref,
            operations: diffWorkspaceTrees(aggregate.base, aggregate.head),
          });
        });
      },
      /**
       * Applies one serialized mutation after current authorization and optimistic checks.
       * @param command - Add, modify, rename, or delete command with explicit precondition and idempotency.
       * @param grant - Current write permission covering every affected logical path.
       * @returns Acknowledged transition, no-op, expected refusal, or current Authority evidence.
       */
      async apply(
        command: WorkspaceMutation,
        grant: GrantRef<WorkspaceWriteAction>,
      ): Promise<WorkspaceMutationOutcome> {
        /** Runtime admission copies mutable byte content before any await. */
        const mutation = WorkspaceMutationSchema.parse(command);
        /** Paths remain private and therefore never enter the diagnostic span. */
        const span = beginWorkspaceSpan(options.diagnostics, 'workspace.apply', workspaceId, {
          type: mutation.type,
        });
        try {
          /** Exclusive settlement prevents state and idempotency races across concurrent commands. */
          const outcome = await exclusive(async () => {
            if (closed) {
              return Object.freeze({ kind: 'refused', reason: 'workspace-closed', snapshot: aggregate.snapshot });
            }
            /** Verification occurs after serialization and immediately before immutable writes. */
            const decision = await authority.verify<WorkspaceWriteAction>({
              grant,
              subject,
              scope: { kind: 'workspace-write', workspaceId, paths: mutationPaths(mutation) },
            });
            if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
            /** Fingerprint excludes key while retaining all semantic command input. */
            const fingerprint = mutationFingerprint(mutation);
            /** Existing settlement is safe to replay only for exact command identity. */
            const replay = mutationReplays.get(mutation.idempotencyKey);
            if (replay !== undefined) {
              return replay.fingerprint === fingerprint
                ? replayMutation(replay.outcome)
                : Object.freeze({
                    kind: 'refused',
                    reason: 'idempotency-conflict',
                    snapshot: aggregate.snapshot,
                  });
            }
            /** Content publication cannot race state because this command retains exclusivity. */
            const prepared = prepareMutation(mutation);
            /** Pure model owns path, precondition, no-op, and quota rules. */
            const planned = planWorkspaceMutation(aggregate, prepared);
            if (!planned.ok) {
              /** Expected domain refusal preserves the exact current transferable snapshot. */
              const refused = Object.freeze({ kind: 'refused', reason: planned.reason, snapshot: aggregate.snapshot });
              mutationReplays.set(mutation.idempotencyKey, Object.freeze({ fingerprint, outcome: refused }));
              return refused;
            }
            if (!planned.value.changed) {
              /** A legal no-op retains lineage generation while still becoming replayable. */
              const unchanged = Object.freeze({ kind: 'unchanged', snapshot: aggregate.snapshot, replayed: false });
              mutationReplays.set(mutation.idempotencyKey, Object.freeze({ fingerprint, outcome: unchanged }));
              return unchanged;
            }
            if (mutation.type === 'add' || mutation.type === 'modify') {
              if (prepared.type !== 'add' && prepared.type !== 'modify') {
                throw new FilesError('files_integrity_failed', 'Workspace prepared the wrong candidate mutation');
              }
              /** Accepted candidate content is published only after every pure refusal boundary passes. */
              const content =
                typeof mutation.content === 'string' ? TEXT_ENCODER.encode(mutation.content) : mutation.content;
              /** Store publication remains fallible and cannot advance lineage by itself. */
              const stored = await store.blobs.put(content);
              if (!stored.ok) throw stored.error;
              if (!equalBlobRef(stored.value, prepared.blob)) {
                throw new FilesError('files_integrity_failed', 'FileStore returned the wrong candidate blob identity');
              }
            }
            /** Canonical publication happens before lineage may advance. */
            const published = await publishTreeEntries(store, planned.value.entries);
            if (!published.ok) throw published.error;
            /** Restoration is unnecessary because publication returns complete admitted entries. */
            const nextTree: ImmutableTree = Object.freeze({ ref: published.value.ref, files: planned.value.entries });
            /** Retains prior snapshot for exact transition evidence. */
            const previous = aggregate.snapshot;
            /** One new identity and trusted instant earn one new generation. */
            aggregate = advanceWorkspace(
              aggregate,
              nextTree,
              WorkspaceSnapshotIdSchema.parse(createId()),
              workspaceTimestamp(now),
            );
            /** State publication precedes event publication for an atomic attachment barrier. */
            state.publish(projectWorkspaceHandle(aggregate, 'ready'));
            events.publish(
              Object.freeze({
                type: 'mutation-applied',
                idempotencyKey: mutation.idempotencyKey,
                operation: planned.value.operation,
                snapshot: aggregate.snapshot,
              }),
            );
            /** Successful result retains both sides of the exact acknowledged transition. */
            const applied = Object.freeze({
              kind: 'applied',
              previous,
              snapshot: aggregate.snapshot,
              operation: planned.value.operation,
              replayed: false,
            });
            mutationReplays.set(mutation.idempotencyKey, Object.freeze({ fingerprint, outcome: applied }));
            return applied;
          });
          completeWorkspaceSpan(span, outcome.kind, {
            generation: aggregate.generation,
            outcome: outcome.kind,
          });
          return outcome;
        } catch (error) {
          failWorkspaceSpan(span, 'failed');
          throw error;
        }
      },
      /**
       * Accepts one exact verified tree only after current receipt authorization.
       * @param command - Verified physical receipt and idempotency identity proposed for acceptance.
       * @param grant - Current acceptance permission pinned to the receipt's lineage facts.
       * @returns Acknowledged transition, no-op, expected refusal, or current Authority evidence.
       */
      async acceptIngestion(
        command: WorkspaceIngestionCommand,
        grant: GrantRef<WorkspaceIngestionAcceptAction>,
      ): Promise<WorkspaceIngestionOutcome> {
        /** Runtime verification recomputes receipt evidence before Authority or storage access. */
        const admitted = WorkspaceIngestionCommandSchema.parse(command);
        return exclusive(async () => {
          if (closed) {
            return Object.freeze({ kind: 'refused', reason: 'workspace-closed', snapshot: aggregate.snapshot });
          }
          /** Scope pins every receipt field relevant to current lineage acceptance. */
          const scope = {
            kind: 'workspace-ingestion-accept' as const,
            workspaceId,
            base: admitted.receipt.base,
            result: admitted.receipt.result,
            generation: admitted.receipt.generation,
            materializedViewId: admitted.receipt.materializedViewId,
          };
          /** Authority is checked immediately before receipt identity and immutable content are trusted. */
          const decision = await authority.verify<WorkspaceIngestionAcceptAction>({ grant, subject, scope });
          if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
          /** Exact receipt fields form local idempotency identity. */
          const fingerprint = JSON.stringify({ receipt: admitted.receipt });
          /** One key may replay only the exact receipt command first settled. */
          const replay = ingestionReplays.get(admitted.idempotencyKey);
          if (replay !== undefined) {
            return replay.fingerprint === fingerprint
              ? replayIngestion(replay.outcome)
              : Object.freeze({
                  kind: 'refused',
                  reason: 'idempotency-conflict',
                  snapshot: aggregate.snapshot,
                });
          }
          if (admitted.receipt.generation !== aggregate.generation) {
            /** Generation mismatch preserves current lineage and becomes the replayable settlement. */
            const refused = Object.freeze({
              kind: 'refused',
              reason: 'stale-generation' as const,
              snapshot: aggregate.snapshot,
            });
            ingestionReplays.set(admitted.idempotencyKey, Object.freeze({ fingerprint, outcome: refused }));
            return refused;
          }
          if (!equalTreeRef(admitted.receipt.base, aggregate.head.ref)) {
            /** Base mismatch prevents a valid receipt for an older head from replacing current work. */
            const refused = Object.freeze({
              kind: 'refused',
              reason: 'base-mismatch' as const,
              snapshot: aggregate.snapshot,
            });
            ingestionReplays.set(admitted.idempotencyKey, Object.freeze({ fingerprint, outcome: refused }));
            return refused;
          }
          /** Full restoration proves the receipt's result exists and matches all content. */
          const restoredResult = await restoreTree(store, admitted.receipt.result);
          if (!restoredResult.ok) throw restoredResult.error;
          if (!workspaceEntriesFitQuota(restoredResult.value.files, quota)) {
            /** Quota refusal occurs after proof but before any acknowledged lineage change. */
            const refused = Object.freeze({
              kind: 'refused',
              reason: 'quota-exceeded' as const,
              snapshot: aggregate.snapshot,
            });
            ingestionReplays.set(admitted.idempotencyKey, Object.freeze({ fingerprint, outcome: refused }));
            return refused;
          }
          if (equalTreeRef(restoredResult.value.ref, aggregate.head.ref)) {
            /** An identical verified result is acknowledged as a generation-preserving no-op. */
            const unchanged = Object.freeze({ kind: 'unchanged', snapshot: aggregate.snapshot, replayed: false });
            ingestionReplays.set(admitted.idempotencyKey, Object.freeze({ fingerprint, outcome: unchanged }));
            return unchanged;
          }
          /** Ingestion lifecycle is visible but cannot advance logical lineage on its own. */
          state.publish(projectWorkspaceHandle(aggregate, 'ingesting'));
          /** Previous snapshot anchors exact transition evidence for the successful branch. */
          const previous = aggregate.snapshot;
          aggregate = advanceWorkspace(
            aggregate,
            restoredResult.value,
            WorkspaceSnapshotIdSchema.parse(createId()),
            workspaceTimestamp(now),
          );
          state.publish(projectWorkspaceHandle(aggregate, 'ready'));
          events.publish(
            Object.freeze({
              type: 'ingestion-accepted',
              idempotencyKey: admitted.idempotencyKey,
              materializedViewId: admitted.receipt.materializedViewId,
              snapshot: aggregate.snapshot,
            }),
          );
          /** Accepted result carries both acknowledged generations without materializer internals. */
          const accepted = Object.freeze({
            kind: 'accepted',
            previous,
            snapshot: aggregate.snapshot,
            replayed: false,
          });
          ingestionReplays.set(admitted.idempotencyKey, Object.freeze({ fingerprint, outcome: accepted }));
          return accepted;
        });
      },
      /**
       * Creates one proposal from exact current lineage without promotion.
       * @param input - Expected generation and idempotency identity for proposal construction.
       * @param grant - Current permission to create a proposal over the exact private lineage.
       * @returns Private ChangeSet, unchanged tree, staleness, closure, conflict, or Authority refusal.
       */
      async createChangeSet(
        input: ChangeSetRequest,
        grant: GrantRef<ChangeSetCreateAction>,
      ): Promise<ChangeSetOutcome> {
        return exclusive(async () => {
          if (closed) return Object.freeze({ kind: 'closed' });
          /** Request pins exact current trees even when the grant covers the whole Workspace. */
          const decision = await authority.verify<ChangeSetCreateAction>({
            grant,
            subject,
            scope: {
              kind: 'change-set-create',
              workspaceId,
              base: aggregate.base.ref,
              result: aggregate.head.ref,
              generation: aggregate.generation,
            },
          });
          if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
          /** Stable local identity excludes the idempotency key itself. */
          const fingerprint = String(input.expectedGeneration);
          /** One key may replay only the exact expected-generation request first settled. */
          const replay = changeSetReplays.get(input.idempotencyKey);
          if (replay !== undefined) {
            return replay.fingerprint === fingerprint
              ? replayChangeSet(replay.outcome)
              : { kind: 'idempotency-conflict' };
          }
          if (input.expectedGeneration !== aggregate.generation) {
            /** Staleness reports current generation without constructing proposal identity. */
            const stale = Object.freeze({ kind: 'stale-generation', actualGeneration: aggregate.generation });
            changeSetReplays.set(input.idempotencyKey, Object.freeze({ fingerprint, outcome: stale }));
            return stale;
          }
          if (equalTreeRef(aggregate.base.ref, aggregate.head.ref)) {
            /** No private difference means there is intentionally no empty proposal object. */
            const unchanged = Object.freeze({ kind: 'unchanged', tree: aggregate.head.ref });
            changeSetReplays.set(input.idempotencyKey, Object.freeze({ fingerprint, outcome: unchanged }));
            return unchanged;
          }
          /** Proposal identity is allocated only after current authority and generation pass. */
          const changeSet = createChangeSetValue({
            id: ChangeSetIdSchema.parse(createId()),
            aggregate,
            createdAt: workspaceTimestamp(now),
          });
          events.publish(
            Object.freeze({
              type: 'change-set-created',
              idempotencyKey: input.idempotencyKey,
              changeSet,
            }),
          );
          /** Created outcome retains proposal identity for exact later replay. */
          const created = Object.freeze({ kind: 'created', changeSet, replayed: false });
          changeSetReplays.set(input.idempotencyKey, Object.freeze({ fingerprint, outcome: created }));
          return created;
        });
      },
      /**
       * Starts one serialized retained-handle release and returns its stable settlement.
       * @returns Shared closure evidence after sources and owned dependencies settle.
       */
      close() {
        if (!closeStarted) {
          closeStarted = true;
          void exclusive(async () => {
            /** Closing becomes visible before command acceptance stops permanently. */
            state.publish(projectWorkspaceHandle(aggregate, 'closing'));
            closed = true;
            /** Final current state remains inspectable after callbacks stop. */
            state.publish(projectWorkspaceHandle(aggregate, 'closed'));
            await events.close();
            await state.close();
            /** Owned dependencies close only after Workspace work and sources settle. */
            if (options.store.ownership === 'owned') await store.close();
            if (options.authority.ownership === 'owned') await authority.close();
            /** Final evidence retains the last acknowledged snapshot for lifecycle inspection. */
            const evidence = Object.freeze({
              kind: 'workspace-closed' as const,
              workspaceId,
              snapshot: aggregate.snapshot,
              closedAt: workspaceTimestamp(now),
            });
            settleClosed?.(evidence);
          }).catch((error: unknown) => rejectClosed?.(error));
        }
        return closedPromise;
      },
      /** Delegates language disposal to the same idempotent retained close path. */
      async [Symbol.asyncDispose]() {
        await handle.close();
      },
    };

    return Result.ok(Object.freeze(handle));
  } catch (error) {
    /** Construction failure retains dependencies with callers unless ownership transferred. */
    return Result.error(error instanceof FilesError ? error : invalidWorkspace(error));
  }
}
