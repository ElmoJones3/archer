/**
 * @file Implements ephemeral and checkpointed process-local Scratchpad handles.
 *
 * The reference composes Workspace's proven private-tree reducer internally but
 * exposes independent Scratchpad Authority, retention, streams, and lifecycle.
 * It deliberately cannot construct `thread-durable`, which requires a durable
 * Thread adapter to persist checkpoint facts and recovery ownership.
 */

import {
  Result,
  TimestampSchema,
  UuidV4Schema,
  borrowed,
  type DiagnosticHub,
  type DiagnosticSpan,
  type DiagnosticSpanAttributes,
  type JsonObject,
  type Result as ResultValue,
} from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  type GrantRef,
} from '@archer/core/authority';
import {
  asReplayableEventStream,
  asTransientEventStream,
  createAtomicLiveAttachmentSource,
  createTransientEventSource,
  createVersionedLiveState,
  replayableEventSource,
  type EventEncoding,
} from '@archer/core/stream';

import { FilesError } from '../errors.js';
import { LogicalPathSchema, type LogicalPath } from '../path.js';
import { publishTree } from '../store.js';
import {
  ScratchpadCheckpointIdSchema,
  ScratchpadIdSchema,
  WorkspaceIdSchema,
  WorkspaceLineageIdSchema,
} from '../work-values.js';
import {
  CHANGE_SET_CREATE_ACTION,
  WORKSPACE_INGESTION_ACCEPT_ACTION,
  WORKSPACE_READ_ACTION,
  WORKSPACE_WRITE_ACTION,
  WorkspaceMutationSchema,
  createMemoryWorkspace,
  type ChangeSetCreateAction,
  type WorkspaceAction,
  type WorkspaceHandle,
  type WorkspaceIngestionAcceptAction,
  type WorkspaceMutationRefusalReason,
  type WorkspaceReadAction,
  type WorkspaceWriteAction,
} from '../workspace/index.js';
import {
  ScratchpadCheckpointSchema,
  ScratchpadOwnerSchema,
  scratchpadCheckpointEvidence,
  type CreateMemoryScratchpadOptions,
  type EphemeralScratchpadHandle,
  type MemoryScratchpadRetention,
  type RetainedScratchpadHandle,
  type ScratchpadCheckpoint,
  type ScratchpadCheckpointAction,
  type ScratchpadCheckpointCommand,
  type ScratchpadCheckpointEvent,
  type ScratchpadCheckpointOutcome,
  type ScratchpadCloseEvidence,
  type ScratchpadLifecycle,
  type ScratchpadListOutcome,
  type ScratchpadListRequest,
  type ScratchpadMutation,
  type ScratchpadMutationOutcome,
  type ScratchpadMutationRefusalReason,
  type ScratchpadOwner,
  type ScratchpadReadAction,
  type ScratchpadReadOutcome,
  type ScratchpadReadRequest,
  type ScratchpadSnapshot,
  type ScratchpadUpdate,
  type ScratchpadWriteAction,
} from './contracts.js';

/** UTF-8 byte accounting shared by Scratchpad update and checkpoint encodings. */
const TEXT_ENCODER = new TextEncoder();

/** Retained checkpoint command identity and exact original settlement. */
type CheckpointReplay = Readonly<{
  /** Detects conflicting expected generation under one command key. */
  fingerprint: string;
  /** Reuses exact checkpoint identity for an identical retry. */
  outcome: ScratchpadCheckpointOutcome;
}>;

/**
 * Supplies host UUIDv4 identity only when a caller did not inject one.
 * @returns Fresh platform-generated UUIDv4 text.
 */
function systemIdFactory(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Supplies host wall time only when a caller did not inject a trusted clock.
 * @returns Fresh mutable Date immediately normalized by its caller.
 */
function systemClock(): Date {
  return new Date();
}

/**
 * Normalizes one trusted clock read into Archer's canonical UTC timestamp.
 * @param now - Injected or system clock capability.
 * @returns Canonical immutable timestamp text.
 */
function scratchpadTimestamp(now: () => Date) {
  return TimestampSchema.parse(now().toISOString());
}

/**
 * Creates a bounded invalid-construction Error while retaining a local cause.
 * @param cause - Schema, store, or internal-composition failure kept process-local.
 * @returns Stable files-domain Error suitable for Archer's ordinary Result branch.
 */
function invalidScratchpad(cause: unknown): FilesError {
  return new FilesError('files_invalid_input', 'Invalid process-local Scratchpad construction', { cause });
}

/**
 * Returns the exact logical paths affected by one admitted mutation.
 * @param mutation - Runtime-admitted Scratchpad mutation.
 * @returns One or two canonical paths with duplicate rename paths removed.
 */
function mutationPaths(mutation: ScratchpadMutation): readonly LogicalPath[] {
  return mutation.type === 'rename'
    ? Object.freeze([...new Set([LogicalPathSchema.parse(mutation.from), LogicalPathSchema.parse(mutation.to)])])
    : Object.freeze([LogicalPathSchema.parse(mutation.path)]);
}

/**
 * Creates one hot retention-discriminated Scratchpad projection.
 * @param scratchpadId - Stable private owner identity.
 * @param owner - Application lifecycle owner.
 * @param retention - Exact cleanup and checkpoint contract.
 * @param workspace - Internal acknowledged private-tree owner.
 * @param checkpoint - Latest retained checkpoint or absence.
 * @param lifecycle - Current attachment activity.
 * @returns Frozen projection whose method family agrees with its discriminator.
 */
function projectScratchpad<R extends MemoryScratchpadRetention>(
  scratchpadId: ReturnType<typeof ScratchpadIdSchema.parse>,
  owner: ScratchpadOwner,
  retention: R,
  workspace: WorkspaceHandle,
  checkpoint: ScratchpadCheckpoint | undefined,
  lifecycle: ScratchpadLifecycle,
): ScratchpadSnapshot<R> {
  /** Internal Workspace owns generation, head, and complete-tree quota accounting. */
  const privateTree = workspace.getSnapshot();
  if (retention === 'ephemeral') {
    return Object.freeze({
      scratchpadId,
      owner,
      retention: 'ephemeral',
      generation: privateTree.generation,
      head: privateTree.head,
      quota: privateTree.quota,
      lifecycle: lifecycle === 'closing' || lifecycle === 'closed' ? lifecycle : 'ready',
    }) as ScratchpadSnapshot<R>;
  }
  return Object.freeze({
    scratchpadId,
    owner,
    retention,
    generation: privateTree.generation,
    head: privateTree.head,
    quota: privateTree.quota,
    ...(checkpoint === undefined ? {} : { checkpoint: checkpoint.tree }),
    lifecycle,
  }) as ScratchpadSnapshot<R>;
}

/** Scratchpad update encoding owns copying and transient delivery byte accounting. */
const SCRATCHPAD_UPDATE_ENCODING: EventEncoding<ScratchpadUpdate> = Object.freeze({
  revision: 'archer-scratchpad-update/1',
  /**
   * Freezes one acknowledged semantic update before transient fan-out.
   * @param update - Runtime-owned generation and operation evidence.
   * @returns Frozen update independent from caller mutation.
   */
  normalize(update) {
    return Object.freeze(update);
  },
  /**
   * Measures the exact JSON projection used by the process-local reference.
   * @param update - Normalized Scratchpad update.
   * @returns UTF-8 bytes charged independently to every subscriber.
   */
  measure(update) {
    return TEXT_ENCODER.encode(JSON.stringify(update)).byteLength;
  },
});

/** Checkpoint event encoding owns copying and replay delivery byte accounting. */
const SCRATCHPAD_CHECKPOINT_ENCODING: EventEncoding<ScratchpadCheckpointEvent> = Object.freeze({
  revision: 'archer-scratchpad-checkpoint-event/1',
  /**
   * Freezes one acknowledged checkpoint fact before replay retention.
   * @param event - Runtime-owned idempotency identity and immutable checkpoint.
   * @returns Frozen durable event value.
   */
  normalize(event) {
    return Object.freeze(event);
  },
  /**
   * Measures the exact JSON projection used by the process-local reference.
   * @param event - Normalized checkpoint fact.
   * @returns UTF-8 bytes charged independently to every subscriber.
   */
  measure(event) {
    return TEXT_ENCODER.encode(JSON.stringify(event)).byteLength;
  },
});

/**
 * Begins one best-effort wide Scratchpad span without logical paths or bytes.
 * @param diagnostics - Optional borrowed diagnostic capability.
 * @param name - Stable Scratchpad operation name.
 * @param scratchpadId - Safe correlation identity retained as namespaced context.
 * @param attributes - Bounded operation context accumulated before settlement.
 * @returns Open span or absence when diagnostics are missing or defective.
 */
function beginScratchpadSpan(
  diagnostics: Pick<DiagnosticHub, 'beginSpan'> | undefined,
  name: string,
  scratchpadId: ReturnType<typeof ScratchpadIdSchema.parse>,
  attributes: DiagnosticSpanAttributes,
): DiagnosticSpan | undefined {
  try {
    return diagnostics?.beginSpan({
      name,
      component: 'files.scratchpad.memory',
      correlation: {},
      attributes: {
        ...attributes,
        scratchpad: { ...(attributes.scratchpad ?? {}), scratchpadId },
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * Completes one best-effort Scratchpad span without influencing its result.
 * @param span - Optional open span returned by the admission helper.
 * @param outcome - Stable terminal domain discriminator.
 * @param attributes - Bounded terminal context excluding private paths and content.
 */
function completeScratchpadSpan(span: DiagnosticSpan | undefined, outcome: string, attributes: JsonObject): void {
  if (span === undefined) return;
  try {
    span.enrich('scratchpad.result', attributes);
    span.complete({ outcome });
  } catch {
    // Diagnostics are deliberately non-authoritative over private Scratchpad state.
  }
}

/**
 * Replays only the marker on a successful checkpoint settlement.
 * @param outcome - Exact original immutable checkpoint outcome.
 * @returns Replay-visible branch without changing checkpoint identity.
 */
function replayCheckpoint(outcome: ScratchpadCheckpointOutcome): ScratchpadCheckpointOutcome {
  return outcome.kind === 'created' ? Object.freeze({ ...outcome, replayed: true }) : outcome;
}

/**
 * Converts Workspace's internal close vocabulary into Scratchpad mutation vocabulary.
 * @param reason - Internal private-tree domain refusal.
 * @returns Exact public Scratchpad refusal category.
 */
function scratchpadRefusal(reason: WorkspaceMutationRefusalReason): ScratchpadMutationRefusalReason {
  return reason === 'workspace-closed' ? 'scratchpad-closed' : reason;
}

/**
 * Opens an ephemeral process-local Scratchpad.
 * @param options - Exact private owner, base, Authority, storage, and lifecycle configuration.
 * @returns Ephemeral handle or one ordinary files-domain construction Error.
 */
export function createMemoryScratchpad(
  options: CreateMemoryScratchpadOptions<'ephemeral'>,
): Promise<ResultValue<EphemeralScratchpadHandle, FilesError>>;

/**
 * Opens an explicitly checkpointable process-local Scratchpad.
 * @param options - Exact private owner, base, Authority, storage, and lifecycle configuration.
 * @returns Checkpointed handle or one ordinary files-domain construction Error.
 */
export function createMemoryScratchpad(
  options: CreateMemoryScratchpadOptions<'checkpointed'>,
): Promise<ResultValue<RetainedScratchpadHandle<'checkpointed'>, FilesError>>;

/**
 * Implements both honest process-local retention overloads.
 * @param options - Ephemeral or checkpointed construction values.
 * @returns Matching discriminator-specific handle or construction Error.
 */
export async function createMemoryScratchpad(
  options: CreateMemoryScratchpadOptions<MemoryScratchpadRetention>,
): Promise<ResultValue<EphemeralScratchpadHandle | RetainedScratchpadHandle<'checkpointed'>, FilesError>> {
  /** External dependencies transfer only if the complete retained handle is returned. */
  const store = options.store.value;
  /** External broker remains the sole caller-facing permission owner. */
  const authority = options.authority.value;
  /** Deterministic identity capability covers internal composition and public facts. */
  const createId = options.createId ?? systemIdFactory;
  /** Trusted clock covers internal grants, checkpoints, diagnostics, and closure. */
  const now = options.now ?? systemClock;
  /** Internal current ledger is closed on every post-construction failure path. */
  let internalAuthority: ReturnType<typeof createMemoryAuthorityLedger<WorkspaceAction>> | undefined;
  /** Internal Workspace is closed on every post-construction failure path. */
  let workspace: WorkspaceHandle | undefined;

  try {
    /** Re-admits Scratchpad identity at the JavaScript construction boundary. */
    const scratchpadId = ScratchpadIdSchema.parse(options.scratchpadId);
    /** Copies and freezes external ownership so later caller mutation cannot rewrite cleanup policy. */
    const owner = ScratchpadOwnerSchema.parse(options.owner);
    /** Binds every protected method to one admitted Principal attribution value. */
    const subject = PrincipalIdSchema.parse(options.subject);
    /** Empty Scratchpads still begin from one canonical immutable tree identity. */
    const base =
      options.base === undefined
        ? await publishTree(store, [])
        : Result.ok(Object.freeze({ ref: options.base, files: Object.freeze([]) }));
    if (!base.ok) return base;
    /** Supplied bases are fully restored by internal Workspace construction before use. */
    const baseRef = options.base ?? base.value.ref;
    /** Internal ledger identities never escape as Scratchpad authority or evidence. */
    const internalLedgerId = AuthorityLedgerIdSchema.parse(createId());
    /** Internal Workspace identity exists only to reuse its proven private-tree behavior. */
    const internalWorkspaceId = WorkspaceIdSchema.parse(createId());
    /** Internal lineage identity prevents accidental cross-instance snapshot substitution. */
    const internalLineageId = WorkspaceLineageIdSchema.parse(createId());
    /** Internal whole-tree read authority is never exposed to Scratchpad callers. */
    const internalReadRoot = createBootstrapAuthorizationGrant<WorkspaceReadAction>(WORKSPACE_READ_ACTION, {
      id: AuthorizationGrantIdSchema.parse(createId()),
      ledgerId: internalLedgerId,
      subject,
      scope: { kind: 'workspace-read', workspaceId: internalWorkspaceId },
      issuedBy: subject,
      createdAt: scratchpadTimestamp(now),
    });
    /** Internal whole-tree write authority is invoked only after external verification. */
    const internalWriteRoot = createBootstrapAuthorizationGrant<WorkspaceWriteAction>(WORKSPACE_WRITE_ACTION, {
      id: AuthorizationGrantIdSchema.parse(createId()),
      ledgerId: internalLedgerId,
      subject,
      scope: { kind: 'workspace-write', workspaceId: internalWorkspaceId },
      issuedBy: subject,
      createdAt: scratchpadTimestamp(now),
    });
    /** Internal ingestion definition is registered only to satisfy the complete Workspace action family. */
    const internalIngestionRoot = createBootstrapAuthorizationGrant<WorkspaceIngestionAcceptAction>(
      WORKSPACE_INGESTION_ACCEPT_ACTION,
      {
        id: AuthorizationGrantIdSchema.parse(createId()),
        ledgerId: internalLedgerId,
        subject,
        scope: { kind: 'workspace-ingestion-accept', workspaceId: internalWorkspaceId },
        issuedBy: subject,
        createdAt: scratchpadTimestamp(now),
      },
    );
    /** Internal proposal definition is registered but no Scratchpad method can invoke it. */
    const internalChangeSetRoot = createBootstrapAuthorizationGrant<ChangeSetCreateAction>(CHANGE_SET_CREATE_ACTION, {
      id: AuthorizationGrantIdSchema.parse(createId()),
      ledgerId: internalLedgerId,
      subject,
      scope: { kind: 'change-set-create', workspaceId: internalWorkspaceId },
      issuedBy: subject,
      createdAt: scratchpadTimestamp(now),
    });
    /** Process-local composition keeps private-tree capability references unreachable to callers. */
    internalAuthority = createMemoryAuthorityLedger<WorkspaceAction>({
      ledgerId: internalLedgerId,
      actions: [
        WORKSPACE_READ_ACTION,
        WORKSPACE_WRITE_ACTION,
        WORKSPACE_INGESTION_ACCEPT_ACTION,
        CHANGE_SET_CREATE_ACTION,
      ],
      bootstrap: [internalReadRoot, internalWriteRoot, internalIngestionRoot, internalChangeSetRoot],
      now,
    });
    /** Internal grant references are forgeable lookups but remain closure-private capabilities. */
    const internalRead: GrantRef<WorkspaceReadAction> = Object.freeze({
      grantId: internalReadRoot.id,
      action: internalReadRoot.action,
    });
    /** Internal write lookup is presented only after Scratchpad Authority permits the operation. */
    const internalWrite: GrantRef<WorkspaceWriteAction> = Object.freeze({
      grantId: internalWriteRoot.id,
      action: internalWriteRoot.action,
    });
    /** Internal Workspace owns private tree logic but borrows externally owned storage. */
    const openedWorkspace = await createMemoryWorkspace({
      workspaceId: internalWorkspaceId,
      lineageId: internalLineageId,
      base: baseRef,
      subject,
      store: borrowed(store),
      authority: borrowed(internalAuthority),
      ...(options.quota === undefined ? {} : { quota: options.quota }),
      createId,
      now,
    });
    if (!openedWorkspace.ok) throw openedWorkspace.error;
    /** Stable non-optional binding lets every retained closure share the successful construction proof. */
    const privateWorkspace = openedWorkspace.value;
    workspace = privateWorkspace;
    /** One process-local epoch scopes current state, transient updates, and optional replay. */
    const epoch = UuidV4Schema.parse(createId());
    /** Latest acknowledged checkpoint remains absent until an explicit retained command succeeds. */
    let checkpoint: ScratchpadCheckpoint | undefined;
    /** Current state projects internal tree facts through the selected retention discriminator. */
    const state = createVersionedLiveState(
      projectScratchpad(scratchpadId, owner, options.retention, privateWorkspace, checkpoint, 'ready'),
      { source: 'scratchpad', epoch },
    );
    /** Transient updates remain gap-aware and never pose as retained checkpoint history. */
    const updates = createTransientEventSource<ScratchpadUpdate>({
      source: 'scratchpad-updates',
      epoch,
      eventEncoding: SCRATCHPAD_UPDATE_ENCODING,
    });
    /** Retained mode alone creates the replayable checkpoint plane. */
    const checkpointEvents =
      options.retention === 'checkpointed'
        ? replayableEventSource<ScratchpadCheckpointEvent>()({
            source: 'scratchpad-checkpoint',
            streamId: scratchpadId,
            scope: owner.id,
            epoch,
            retentionItems: 1_024,
            eventEncoding: SCRATCHPAD_CHECKPOINT_ENCODING,
          })
        : undefined;
    /** Checkpoint replays belong only to this retained process attachment. */
    const checkpointReplays = new Map<string, CheckpointReplay>();
    /** Promise tail makes mutation, checkpoint, read, list, and close state observations serializable. */
    let commandTail: Promise<void> = Promise.resolve();
    /** Prevents later commands after close reaches its serialized boundary. */
    let closed = false;
    /** Starts retained cleanup exactly once. */
    let closeStarted = false;
    /** Resolves public lifecycle observation after all owned cleanup. */
    let settleClosed: ((evidence: ScratchpadCloseEvidence) => void) | undefined;
    /** Mirrors cleanup rejection through both close access paths. */
    let rejectClosed: ((error: unknown) => void) | undefined;
    /** Public retained close settlement exists before the handle is exposed. */
    const closedSettlement = new Promise<ScratchpadCloseEvidence>((resolveClosed, rejectClose) => {
      settleClosed = resolveClosed;
      rejectClosed = rejectClose;
    });

    /**
     * Serializes every state-sensitive public Scratchpad operation.
     * @param work - Operation over current internal Workspace and checkpoint state.
     * @returns Exact operation settlement after releasing the next command.
     */
    async function exclusive<Value>(work: () => Promise<Value>): Promise<Value> {
      /** Prior tail must settle before this operation can inspect private state. */
      const prior = commandTail;
      /** Release advances exactly one waiting operation in arrival order. */
      let release: (() => void) | undefined;
      commandTail = new Promise<void>((resolveTail) => {
        release = resolveTail;
      });
      await prior;
      try {
        return await work();
      } finally {
        release?.();
      }
    }

    /**
     * Reads one exact path after external current Authority verification.
     * @param request - Ergonomic JavaScript path input.
     * @param grant - Current Scratchpad read lookup reference.
     * @returns Scratchpad-owned read outcome over verified internal bytes.
     */
    async function read(
      request: ScratchpadReadRequest,
      grant: GrantRef<ScratchpadReadAction>,
    ): Promise<ScratchpadReadOutcome> {
      /** JavaScript input is normalized before serialization or authorization. */
      const path = LogicalPathSchema.parse(request.path);
      return exclusive(async () => {
        if (closed) return Object.freeze({ kind: 'closed' as const });
        /** External Authority is checked against the exact normalized private path. */
        const decision = await authority.verify<ScratchpadReadAction>({
          grant,
          subject,
          scope: { kind: 'scratchpad-read', scratchpadId, paths: [path] },
        });
        if (!decision.allowed) return Object.freeze({ kind: 'authority-refused' as const, refusal: decision.refusal });
        /** Proven internal Workspace read supplies immutable entry and streaming bytes. */
        const outcome = await privateWorkspace.read({ path }, internalRead);
        if (outcome.kind === 'authority-refused')
          throw new FilesError('files_integrity_failed', 'Internal read authority failed');
        return outcome;
      });
    }

    /**
     * Lists one exact subtree after external current Authority verification.
     * @param request - Optional ergonomic JavaScript subtree input.
     * @param grant - Current Scratchpad read lookup reference.
     * @returns Canonical private entry listing or exact refusal.
     */
    async function list(
      request: ScratchpadListRequest,
      grant: GrantRef<ScratchpadReadAction>,
    ): Promise<ScratchpadListOutcome> {
      /** Omission retains whole-Scratchpad meaning; supplied prefixes are normalized. */
      const prefix = request.prefix === undefined ? undefined : LogicalPathSchema.parse(request.prefix);
      return exclusive(async () => {
        if (closed) return Object.freeze({ kind: 'closed' as const });
        /** External Authority is checked before private path names are inspected. */
        const decision = await authority.verify<ScratchpadReadAction>({
          grant,
          subject,
          scope: {
            kind: 'scratchpad-read',
            scratchpadId,
            ...(prefix === undefined ? {} : { paths: [prefix] }),
          },
        });
        if (!decision.allowed) return Object.freeze({ kind: 'authority-refused' as const, refusal: decision.refusal });
        /** Proven internal Workspace listing supplies canonical immutable entries. */
        const outcome = await privateWorkspace.list(prefix === undefined ? {} : { prefix }, internalRead);
        if (outcome.kind === 'authority-refused')
          throw new FilesError('files_integrity_failed', 'Internal list authority failed');
        return outcome;
      });
    }

    /**
     * Applies one externally authorized private mutation through the proven Workspace reducer.
     * @param command - Ergonomic mutation input admitted before any await.
     * @param grant - Current Scratchpad write lookup reference.
     * @returns Retention-preserving hot state transition or exact refusal.
     */
    async function apply<R extends MemoryScratchpadRetention>(
      command: ScratchpadMutation,
      grant: GrantRef<ScratchpadWriteAction>,
    ): Promise<ScratchpadMutationOutcome<R>> {
      /** Runtime admission copies mutable bytes before current Authority introduces an await. */
      const mutation = WorkspaceMutationSchema.parse(command);
      /** One wide span accumulates bounded mutation context without paths or bytes. */
      const span = beginScratchpadSpan(options.diagnostics, 'scratchpad.apply', scratchpadId, {
        scratchpad: { type: mutation.type, retention: options.retention },
      });
      /** Exclusive settlement preserves state, transient update, and result ordering. */
      const outcome = await exclusive(async (): Promise<ScratchpadMutationOutcome<R>> => {
        if (closed) {
          return Object.freeze({
            kind: 'refused',
            reason: 'scratchpad-closed',
            snapshot: state.getSnapshot() as ScratchpadSnapshot<R>,
          });
        }
        /** Current external Authority is checked immediately before the private transition. */
        const decision = await authority.verify<ScratchpadWriteAction>({
          grant,
          subject,
          scope: { kind: 'scratchpad-write', scratchpadId, paths: mutationPaths(mutation) },
        });
        if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
        /** Prior Scratchpad state remains exact transition evidence. */
        const previous = state.getSnapshot() as ScratchpadSnapshot<R>;
        /** Internal Workspace applies the already-authorized mutation through its proven reducer. */
        const internal = await privateWorkspace.apply(mutation, internalWrite);
        if (internal.kind === 'authority-refused') {
          throw new FilesError('files_integrity_failed', 'Internal write authority failed');
        }
        if (internal.kind === 'refused') {
          return Object.freeze({
            kind: 'refused',
            reason: scratchpadRefusal(internal.reason),
            snapshot: state.getSnapshot() as ScratchpadSnapshot<R>,
          });
        }
        if (internal.kind === 'unchanged') {
          return Object.freeze({
            kind: 'unchanged',
            snapshot: state.getSnapshot() as ScratchpadSnapshot<R>,
            replayed: internal.replayed,
          });
        }
        /** Hot state acknowledgement precedes transient update fan-out. */
        const snapshot = projectScratchpad(
          scratchpadId,
          owner,
          options.retention,
          privateWorkspace,
          checkpoint,
          'ready',
        );
        state.publish(snapshot);
        updates.publish(
          Object.freeze({ type: 'mutation-applied', generation: snapshot.generation, operation: internal.operation }),
        );
        return Object.freeze({
          kind: 'applied',
          previous,
          snapshot: snapshot as ScratchpadSnapshot<R>,
          operation: internal.operation,
          replayed: internal.replayed,
        });
      });
      completeScratchpadSpan(span, outcome.kind, {
        generation: state.getSnapshot().generation,
        outcome: outcome.kind,
      });
      return outcome;
    }

    /**
     * Creates one exact retained checkpoint for a checkpointed handle.
     * @param command - Expected generation and idempotency identity.
     * @param grant - Current checkpoint lookup reference.
     * @returns Immutable checkpoint settlement without promoting content.
     */
    async function createCheckpoint(
      command: ScratchpadCheckpointCommand,
      grant: GrantRef<ScratchpadCheckpointAction>,
    ): Promise<ScratchpadCheckpointOutcome> {
      /** One wide span accumulates generation and retention without private paths or bytes. */
      const span = beginScratchpadSpan(options.diagnostics, 'scratchpad.checkpoint', scratchpadId, {
        scratchpad: { expectedGeneration: command.expectedGeneration, retention: options.retention },
      });
      /** Exclusive settlement prevents checkpoint identity from racing content mutations. */
      const outcome = await exclusive(async (): Promise<ScratchpadCheckpointOutcome> => {
        if (closed) return Object.freeze({ kind: 'closed' });
        /** Current external Authority is checked against the exact requested generation. */
        const decision = await authority.verify<ScratchpadCheckpointAction>({
          grant,
          subject,
          scope: { kind: 'scratchpad-checkpoint', scratchpadId, generation: command.expectedGeneration },
        });
        if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
        /** Semantic identity excludes the key and consists solely of expected generation. */
        const fingerprint = String(command.expectedGeneration);
        /** One key may replay only the exact generation request first settled. */
        const replay = checkpointReplays.get(command.idempotencyKey);
        if (replay !== undefined) {
          return replay.fingerprint === fingerprint
            ? replayCheckpoint(replay.outcome)
            : Object.freeze({ kind: 'idempotency-conflict' });
        }
        /** Current internal tree projection supplies the generation and immutable head. */
        const current = privateWorkspace.getSnapshot();
        if (command.expectedGeneration !== current.generation) {
          /** Staleness preserves content and creates no checkpoint identity. */
          const stale = Object.freeze({ kind: 'stale-generation' as const, actualGeneration: current.generation });
          checkpointReplays.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome: stale }));
          return stale;
        }
        /** Checkpointing becomes visible to late observers before evidence construction. */
        state.publish(
          projectScratchpad(scratchpadId, owner, options.retention, privateWorkspace, checkpoint, 'checkpointing'),
        );
        /** Evidence input owns every checkpoint field except its derived digest. */
        const checkpointWithoutEvidence = Object.freeze({
          id: ScratchpadCheckpointIdSchema.parse(createId()),
          object: 'scratchpad-checkpoint' as const,
          createdAt: scratchpadTimestamp(now),
          scratchpadId,
          owner,
          retention: 'checkpointed' as const,
          generation: current.generation,
          tree: current.head,
        });
        checkpoint = ScratchpadCheckpointSchema.parse({
          ...checkpointWithoutEvidence,
          evidenceDigest: scratchpadCheckpointEvidence(checkpointWithoutEvidence),
        });
        /** Ready state with checkpoint identity precedes durable fact publication. */
        state.publish(projectScratchpad(scratchpadId, owner, options.retention, privateWorkspace, checkpoint, 'ready'));
        checkpointEvents?.publish(
          Object.freeze({ type: 'checkpoint-created', idempotencyKey: command.idempotencyKey, checkpoint }),
        );
        /** Created outcome retains checkpoint identity for exact later replay. */
        const created = Object.freeze({ kind: 'created' as const, checkpoint, replayed: false });
        checkpointReplays.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome: created }));
        return created;
      });
      completeScratchpadSpan(span, outcome.kind, {
        generation: state.getSnapshot().generation,
        outcome: outcome.kind,
      });
      return outcome;
    }

    /** Shared methods keep behavior identical across retention-discriminated handles. */
    const common = {
      scratchpadId,
      closed: closedSettlement,
      updates: asTransientEventStream(updates),
      read,
      list,
      /**
       * Starts one serialized retained cleanup and returns its shared settlement.
       * @returns Shared evidence describing recoverability when all owned resources settle.
       */
      close() {
        if (!closeStarted) {
          closeStarted = true;
          void exclusive(async () => {
            state.publish(
              projectScratchpad(scratchpadId, owner, options.retention, privateWorkspace, checkpoint, 'closing'),
            );
            closed = true;
            state.publish(
              projectScratchpad(scratchpadId, owner, options.retention, privateWorkspace, checkpoint, 'closed'),
            );
            await privateWorkspace.close();
            await internalAuthority?.close();
            await updates.close();
            await checkpointEvents?.close();
            await state.close();
            if (options.store.ownership === 'owned') await store.close();
            if (options.authority.ownership === 'owned') await authority.close();
            /** Retention plus checkpoint presence determines the honest recoverability claim. */
            const disposition =
              options.retention === 'ephemeral'
                ? ('ephemeral-released' as const)
                : checkpoint === undefined
                  ? ('uncheckpointed-released' as const)
                  : ('checkpoint-retained' as const);
            /** Close evidence names logical recovery state without claiming shared blob deletion. */
            const evidence = Object.freeze({
              kind: 'scratchpad-closed' as const,
              scratchpadId,
              disposition,
              head: privateWorkspace.getSnapshot().head,
              ...(checkpoint === undefined ? {} : { checkpoint: checkpoint.tree }),
              closedAt: scratchpadTimestamp(now),
            });
            settleClosed?.(evidence);
          }).catch((error: unknown) => rejectClosed?.(error));
        }
        return closedSettlement;
      },
    };

    if (options.retention === 'ephemeral') {
      /** Branch-local bridge prevents a retained checkpoint plane from leaking into ephemeral types. */
      const ephemeralBridge = createAtomicLiveAttachmentSource({ state, transient: { updates } });
      /** Ephemeral bridge has no durable source and therefore no checkpoint members. */
      const handle: EphemeralScratchpadHandle = Object.freeze({
        ...common,
        retention: 'ephemeral',
        /**
         * Returns the latest ephemeral projection without exposing internal Workspace identity.
         * @returns Current immutable ephemeral Scratchpad state.
         */
        getSnapshot: () => state.getSnapshot() as ScratchpadSnapshot<'ephemeral'>,
        /**
         * Subscribes to coalesced current ephemeral state.
         * @param listener - Callback receiving the newest immutable projection.
         * @returns Idempotent subscription handle.
         */
        subscribe: (listener: (snapshot: ScratchpadSnapshot<'ephemeral'>) => void) =>
          state.subscribe((snapshot) => listener(snapshot as ScratchpadSnapshot<'ephemeral'>)),
        /**
         * Applies one mutation while preserving the ephemeral result discriminator.
         * @param command - Private file mutation and optimistic precondition.
         * @param grant - Current write permission for every affected path.
         * @returns Exact mutation settlement with ephemeral state projections.
         */
        apply: (command: ScratchpadMutation, grant: GrantRef<ScratchpadWriteAction>) =>
          apply<'ephemeral'>(command, grant),
        attachLive: ephemeralBridge.attachLive as EphemeralScratchpadHandle['attachLive'],
        /** Delegates language disposal to the same retained close path. */
        async [Symbol.asyncDispose]() {
          await handle.close();
        },
      });
      return Result.ok(handle);
    }

    if (checkpointEvents === undefined) {
      throw new FilesError('files_integrity_failed', 'Checkpointed Scratchpad did not construct durable events');
    }
    /** Branch-local bridge proves the retained handle owns one durable checkpoint plane. */
    const retainedBridge = createAtomicLiveAttachmentSource({
      state,
      durable: checkpointEvents,
      transient: { updates },
    });
    /** Checkpointed bridge exposes replay and command members unavailable on ephemeral handles. */
    const handle: RetainedScratchpadHandle<'checkpointed'> = Object.freeze({
      ...common,
      retention: 'checkpointed',
      /**
       * Returns the latest checkpointable projection without exposing internal Workspace identity.
       * @returns Current immutable checkpointed Scratchpad state.
       */
      getSnapshot: () => state.getSnapshot() as ScratchpadSnapshot<'checkpointed'>,
      /**
       * Subscribes to coalesced current checkpointable state.
       * @param listener - Callback receiving the newest immutable projection.
       * @returns Idempotent subscription handle.
       */
      subscribe: (listener: (snapshot: ScratchpadSnapshot<'checkpointed'>) => void) =>
        state.subscribe((snapshot) => listener(snapshot as ScratchpadSnapshot<'checkpointed'>)),
      /**
       * Applies one mutation while preserving the checkpointed result discriminator.
       * @param command - Private file mutation and optimistic precondition.
       * @param grant - Current write permission for every affected path.
       * @returns Exact mutation settlement with checkpointable state projections.
       */
      apply: (command: ScratchpadMutation, grant: GrantRef<ScratchpadWriteAction>) =>
        apply<'checkpointed'>(command, grant),
      attachLive: retainedBridge.attachLive as RetainedScratchpadHandle<'checkpointed'>['attachLive'],
      checkpointEvents: asReplayableEventStream(checkpointEvents),
      checkpoint: createCheckpoint,
      /** Delegates language disposal to the same retained close path. */
      async [Symbol.asyncDispose]() {
        await handle.close();
      },
    });
    return Result.ok(handle);
  } catch (error) {
    await workspace?.close().catch(() => undefined);
    await internalAuthority?.close().catch(() => undefined);
    return Result.error(error instanceof FilesError ? error : invalidScratchpad(error));
  }
}
