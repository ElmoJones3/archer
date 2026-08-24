/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Defines private Scratchpad ownership, retention, Authority, and hot handles.
 *
 * Scratchpads are ordinary private working files with lifecycle rules that are
 * deliberately separate from Workspace ingestion and ChangeSet publication.
 */

import { createHash } from 'node:crypto';

import * as z from 'zod';

import {
  UuidV4Schema,
  archerObjectSchema,
  fromZod,
  type ArcherObject,
  type ComponentRef,
  type DiagnosticHub,
  type IdempotencyKey,
  type Timestamp,
  type UuidV4,
} from '@archer/core';
import {
  defineAuthorityAction,
  type AuthorityActionDefinition,
  type AuthorityBroker,
  type AuthorityRefusal,
  type GrantRef,
  type PrincipalId,
  type ProtectedAction,
} from '@archer/core/authority';
import type { OwnedHandle } from '@archer/core/ownership';
import type {
  AtomicLiveAttachmentSource,
  LiveState,
  ReplayableEventStream,
  StreamCursor,
  TransientEventStream,
} from '@archer/core/stream';

import { TreeRefSchema, type TreeRef } from '../encoding.js';
import { LogicalPathSchema, type LogicalPath } from '../path.js';
import type { BlobRead, FileStore, TreeFileEntry } from '../store.js';
import {
  ScratchpadCheckpointIdSchema,
  ScratchpadIdSchema,
  type ScratchpadCheckpointId,
  type ScratchpadId,
} from '../work-values.js';
import type {
  ChangeSetOperation,
  WorkspaceMutation,
  WorkspaceQuota,
  WorkspaceQuotaState,
} from '../workspace/contracts.js';

/** Retention classes that intentionally change a Scratchpad handle's commands. */
export type ScratchpadRetention = 'ephemeral' | 'checkpointed' | 'thread-durable';

/** Retention classes honestly implemented by the process-local reference. */
export type MemoryScratchpadRetention = Exclude<ScratchpadRetention, 'thread-durable'>;

/** Lifecycle visible to late Scratchpad observers without consulting logs. */
export type ScratchpadLifecycle = 'ready' | 'checkpointing' | 'closing' | 'closed' | 'recovery-required';

/** Application owner reference usable before Archer's Task and Thread packages exist. */
export type ScratchpadOwner = Readonly<{
  /** Humanizes ownership for task, conversation, or ordinary application sessions. */
  type: 'task' | 'thread' | 'external';
  /** Carries the owner's UUIDv4 identity without pretending this package owns its brand. */
  id: UuidV4;
}>;

/** Scratchpad quota uses the same complete-tree accounting rules as Workspace. */
export type ScratchpadQuota = WorkspaceQuota;

/** Scratchpad quota state uses the same file and byte facts as Workspace. */
export type ScratchpadQuotaState = WorkspaceQuotaState;

/** Fields shared by all live Scratchpad current-state projections. */
export type ScratchpadSnapshotBase = Readonly<{
  /** Names the private working-file owner independently from its content. */
  scratchpadId: ScratchpadId;
  /** Names the application object responsible for cleanup and recovery policy. */
  owner: ScratchpadOwner;
  /** Advances exactly once for each acknowledged logical mutation. */
  generation: number;
  /** Identifies complete acknowledged private Scratchpad content. */
  head: TreeRef;
  /** Exposes current enforceable file and byte consumption. */
  quota: ScratchpadQuotaState;
}>;

/** Retention-discriminated hot state that exposes only commands the mode earns. */
export type ScratchpadSnapshot<R extends ScratchpadRetention> = R extends 'ephemeral'
  ? Readonly<
      ScratchpadSnapshotBase & {
        /** Prevents ephemeral state from posing as checkpoint evidence. */
        retention: 'ephemeral';
        /** Ephemeral handles cannot acquire a retained checkpoint. */
        checkpoint?: never;
        /** Ephemeral state never enters a checkpointing lifecycle. */
        lifecycle: Exclude<ScratchpadLifecycle, 'checkpointing' | 'recovery-required'>;
      }
    >
  : Readonly<
      ScratchpadSnapshotBase & {
        /** Preserves the exact retained mode selected by the adapter. */
        retention: R;
        /** Identifies the latest explicit checkpoint when one has completed. */
        checkpoint?: TreeRef;
        /** Retained adapters may surface checkpoint or recovery activity. */
        lifecycle: ScratchpadLifecycle;
      }
    >;

/** Immutable checkpoint fact returned and replayed after explicit acknowledgement. */
export type ScratchpadCheckpoint = ArcherObject<'scratchpad-checkpoint', ScratchpadCheckpointId> &
  Readonly<{
    /** Names the private Scratchpad whose content was acknowledged. */
    scratchpadId: ScratchpadId;
    /** Preserves application cleanup and recovery ownership. */
    owner: ScratchpadOwner;
    /** Excludes ephemeral mode because it cannot call checkpoint. */
    retention: Exclude<ScratchpadRetention, 'ephemeral'>;
    /** Pins checkpoint identity to one acknowledged Scratchpad generation. */
    generation: number;
    /** Identifies the complete immutable content retained by this checkpoint. */
    tree: TreeRef;
    /** Binds identity, owner, mode, generation, tree, and creation time. */
    evidenceDigest: `sha256:${string}`;
  }>;

/** Canonical runtime admission for one application owner reference. */
export const ScratchpadOwnerSchema: z.ZodType<ScratchpadOwner> = z
  .strictObject({
    type: z.union([z.literal('task'), z.literal('thread'), z.literal('external')]),
    id: UuidV4Schema,
  })
  .transform((value) => Object.freeze(value));

/** Canonical runtime admission for one immutable retained checkpoint. */
export const ScratchpadCheckpointSchema: z.ZodType<ScratchpadCheckpoint> = archerObjectSchema(
  'scratchpad-checkpoint',
  ScratchpadCheckpointIdSchema,
)
  .and(
    z.strictObject({
      scratchpadId: ScratchpadIdSchema,
      owner: ScratchpadOwnerSchema,
      retention: z.union([z.literal('checkpointed'), z.literal('thread-durable')]),
      generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      tree: TreeRefSchema,
      evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
  )
  .transform(
    (value) =>
      Object.freeze({ ...value, evidenceDigest: value.evidenceDigest as `sha256:${string}` }) as ScratchpadCheckpoint,
  );

/** Scratchpad mutation vocabulary intentionally matches Workspace editing ergonomics. */
export type ScratchpadMutation = WorkspaceMutation;

/** Stable expected mutation refusals that preserve prior Scratchpad state. */
export type ScratchpadMutationRefusalReason =
  | 'scratchpad-closed'
  | 'stale-generation'
  | 'path-exists'
  | 'path-not-found'
  | 'stale-blob'
  | 'quota-exceeded'
  | 'idempotency-conflict';

/** Request for one exact acknowledged private Scratchpad file. */
export type ScratchpadReadRequest = Readonly<{
  /** Supplies an ergonomic JavaScript string admitted at the method boundary. */
  path: string;
}>;

/** Request for canonical Scratchpad listing under one optional subtree. */
export type ScratchpadListRequest = Readonly<{
  /** Omission selects the complete Scratchpad after whole-scope authorization. */
  prefix?: string;
}>;

/** Scope shared by Scratchpad read and write actions over logical subtrees. */
export type ScratchpadPathScope<Kind extends 'scratchpad-read' | 'scratchpad-write'> = Readonly<{
  /** Keeps read and write permissions structurally distinct. */
  kind: Kind;
  /** Prevents a grant for one Scratchpad from crossing into another. */
  scratchpadId: ScratchpadId;
  /** Omission grants the complete Scratchpad; values constrain logical subtrees. */
  paths?: readonly LogicalPath[];
}>;

/** Permission to read or list exact private Scratchpad content. */
export type ScratchpadReadAction = ProtectedAction<'scratchpad-read', ScratchpadPathScope<'scratchpad-read'>>;

/** Permission to mutate exact private Scratchpad content. */
export type ScratchpadWriteAction = ProtectedAction<'scratchpad-write', ScratchpadPathScope<'scratchpad-write'>>;

/** Scope owned by explicit creation of one retained Scratchpad checkpoint. */
export type ScratchpadCheckpointScope = Readonly<{
  /** Keeps checkpoint authority distinct from ordinary mutation. */
  kind: 'scratchpad-checkpoint';
  /** Names the only private Scratchpad covered by the grant. */
  scratchpadId: ScratchpadId;
  /** When present, pins checkpoint authority to one acknowledged generation. */
  generation?: number;
}>;

/** Permission to acknowledge one exact retained Scratchpad checkpoint. */
export type ScratchpadCheckpointAction = ProtectedAction<'scratchpad-checkpoint', ScratchpadCheckpointScope>;

/** Actions registered by one retained Scratchpad Authority broker. */
export type ScratchpadAction = ScratchpadReadAction | ScratchpadWriteAction | ScratchpadCheckpointAction;

/**
 * Constructs canonical path-scope admission for one Scratchpad action.
 * @param kind - Exact protected read or write action discriminator.
 * @returns Runtime codec that normalizes, deduplicates, and sorts path roots.
 */
function scratchpadPathScopeSchema<Kind extends 'scratchpad-read' | 'scratchpad-write'>(
  kind: Kind,
): z.ZodType<ScratchpadPathScope<Kind>> {
  return z
    .strictObject({
      kind: z.literal(kind),
      scratchpadId: ScratchpadIdSchema,
      paths: z.array(LogicalPathSchema).min(1).optional(),
    })
    .transform(
      (value) =>
        Object.freeze({
          kind: value.kind,
          scratchpadId: value.scratchpadId,
          ...(value.paths === undefined ? {} : { paths: Object.freeze([...new Set(value.paths)].sort()) }),
        }) as ScratchpadPathScope<Kind>,
    );
}

/** Canonical runtime admission for private Scratchpad read scopes. */
const ScratchpadReadScopeSchema = scratchpadPathScopeSchema('scratchpad-read');

/** Canonical runtime admission for private Scratchpad write scopes. */
const ScratchpadWriteScopeSchema = scratchpadPathScopeSchema('scratchpad-write');

/** Canonical runtime admission for broad or generation-pinned checkpoint scopes. */
const ScratchpadCheckpointScopeSchema = z
  .strictObject({
    kind: z.literal('scratchpad-checkpoint'),
    scratchpadId: ScratchpadIdSchema,
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .transform((value): ScratchpadCheckpointScope =>
    Object.freeze({
      kind: value.kind,
      scratchpadId: value.scratchpadId,
      ...(value.generation === undefined ? {} : { generation: value.generation }),
    }),
  );

/**
 * Reports segment-aware containment for a granted logical subtree.
 * @param root - Granted exact file or directory root.
 * @param requested - Requested exact file or directory root.
 * @returns Whether the request stays at or below the granted root.
 */
function containsPath(root: LogicalPath, requested: LogicalPath): boolean {
  return requested === root || requested.startsWith(`${root}/`);
}

/**
 * Evaluates Scratchpad path attenuation without consulting mutable content.
 * @param granted - Admitted scope retained by Authority.
 * @param requested - Exact current operation scope.
 * @returns Whether identity and every requested path remain contained.
 */
function allowsScratchpadPaths<Kind extends 'scratchpad-read' | 'scratchpad-write'>(
  granted: ScratchpadPathScope<Kind>,
  requested: ScratchpadPathScope<Kind>,
): boolean {
  if (granted.scratchpadId !== requested.scratchpadId) return false;
  if (granted.paths === undefined) return true;
  if (requested.paths === undefined) return false;
  return requested.paths.every((path) => granted.paths?.some((root) => containsPath(root, path)) === true);
}

/** Public action definition for exact Scratchpad reads and listings. */
export const SCRATCHPAD_READ_ACTION: AuthorityActionDefinition<ScratchpadReadAction> =
  defineAuthorityAction<ScratchpadReadAction>({
    action: 'scratchpad-read',
    scope: fromZod(ScratchpadReadScopeSchema),
    allows: allowsScratchpadPaths,
  });

/** Public action definition for exact Scratchpad mutations. */
export const SCRATCHPAD_WRITE_ACTION: AuthorityActionDefinition<ScratchpadWriteAction> =
  defineAuthorityAction<ScratchpadWriteAction>({
    action: 'scratchpad-write',
    scope: fromZod(ScratchpadWriteScopeSchema),
    allows: allowsScratchpadPaths,
  });

/** Public action definition for broad or exact-generation checkpoint creation. */
export const SCRATCHPAD_CHECKPOINT_ACTION: AuthorityActionDefinition<ScratchpadCheckpointAction> =
  defineAuthorityAction<ScratchpadCheckpointAction>({
    action: 'scratchpad-checkpoint',
    scope: fromZod(ScratchpadCheckpointScopeSchema),
    /**
     * Allows a broad checkpoint root or one generation-pinned attenuation.
     * @param granted - Scope retained by the current grant chain.
     * @param requested - Exact checkpoint generation requested now.
     * @returns Whether Scratchpad identity and optional generation contain the request.
     */
    allows: (granted, requested) =>
      granted.scratchpadId === requested.scratchpadId &&
      (granted.generation === undefined || granted.generation === requested.generation),
  });

/** Successful, absent, closed, or unauthorized Scratchpad read result. */
export type ScratchpadReadOutcome =
  | Readonly<{
      /** Reports retained handle closure before any private content was inspected. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Selects exact current content found at the authorized logical path. */
      kind: 'found';
      /** Carries immutable path, blob, and portable-mode identity. */
      entry: TreeFileEntry;
      /** Streams verified blob bytes without assembling them in the handle. */
      read: BlobRead;
    }>
  | Readonly<{
      /** Selects an authorized path absent from current private content. */
      kind: 'not-found';
      /** Returns the normalized logical path that was not found. */
      path: LogicalPath;
    }>
  | Readonly<{
      /** Reports current Authority denial before private content was inspected. */
      kind: 'authority-refused';
      /** Preserves the exact current refusal evidence. */
      refusal: AuthorityRefusal<ScratchpadReadAction>;
    }>;

/** Successful, closed, or unauthorized Scratchpad listing result. */
export type ScratchpadListOutcome =
  | Readonly<{
      /** Reports retained handle closure before any private names were inspected. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Selects an authorized canonical current listing. */
      kind: 'listed';
      /** Carries immutable entries within the requested subtree. */
      entries: readonly TreeFileEntry[];
    }>
  | Readonly<{
      /** Reports current Authority denial before private names were inspected. */
      kind: 'authority-refused';
      /** Preserves the exact current refusal evidence. */
      refusal: AuthorityRefusal<ScratchpadReadAction>;
    }>;

/** Successful or refused private Scratchpad mutation settlement. */
export type ScratchpadMutationOutcome<R extends ScratchpadRetention = ScratchpadRetention> =
  | Readonly<{
      /** Selects a lineage-changing acknowledged mutation. */
      kind: 'applied';
      /** Carries the prior hot state projection as preserved transition evidence. */
      previous: ScratchpadSnapshot<R>;
      /** Carries the resulting hot state projection. */
      snapshot: ScratchpadSnapshot<R>;
      /** Carries human-readable semantic change without raw content. */
      operation: ChangeSetOperation;
      /** Distinguishes first settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Selects an accepted mutation with no logical content change. */
      kind: 'unchanged';
      /** Carries the still-current hot projection. */
      snapshot: ScratchpadSnapshot<R>;
      /** Distinguishes first settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Selects an expected private-work refusal. */
      kind: 'refused';
      /** Names the exact rule that preserved current content. */
      reason: ScratchpadMutationRefusalReason;
      /** Carries unchanged current state as preserved-state evidence. */
      snapshot: ScratchpadSnapshot<R>;
    }>
  | Readonly<{
      /** Reports current Authority denial before any private mutation. */
      kind: 'authority-refused';
      /** Preserves the exact current refusal evidence. */
      refusal: AuthorityRefusal<ScratchpadWriteAction>;
    }>;

/** Transient acknowledged-update signal intended for live UI and tool feedback. */
export type ScratchpadUpdate = Readonly<{
  /** Selects the only v1 update family. */
  type: 'mutation-applied';
  /** Names the exact acknowledged Scratchpad generation. */
  generation: number;
  /** Carries semantic path and identity evidence without raw content bytes. */
  operation: ChangeSetOperation;
}>;

/** Prevents a checkpoint cursor from resuming another durable stream family. */
export type ScratchpadCursor = StreamCursor<'scratchpad-checkpoint'>;

/** Durable fact emitted only after explicit retained checkpoint acknowledgement. */
export type ScratchpadCheckpointEvent = Readonly<{
  /** Selects one acknowledged checkpoint fact. */
  type: 'checkpoint-created';
  /** Names the idempotent command that earned this fact. */
  idempotencyKey: IdempotencyKey;
  /** Carries the complete immutable checkpoint value. */
  checkpoint: ScratchpadCheckpoint;
}>;

/** Idempotent request for a checkpoint at one exact generation. */
export type ScratchpadCheckpointCommand = Readonly<{
  /** Prevents checkpoint creation from racing past reviewed content. */
  expectedGeneration: number;
  /** Deduplicates checkpoint identity and durable event publication. */
  idempotencyKey: IdempotencyKey;
}>;

/** Successful, stale, closed, conflicting, or unauthorized checkpoint settlement. */
export type ScratchpadCheckpointOutcome =
  | Readonly<{
      /** Selects a newly acknowledged or exactly replayed retained checkpoint. */
      kind: 'created';
      /** Carries immutable recoverability evidence for one exact generation. */
      checkpoint: ScratchpadCheckpoint;
      /** Distinguishes first settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Reports that the command no longer names current private content. */
      kind: 'stale-generation';
      /** Exposes the generation a caller must deliberately inspect before retrying. */
      actualGeneration: number;
    }>
  | Readonly<{
      /** Reports one key reused for different semantic checkpoint input. */
      kind: 'idempotency-conflict';
    }>
  | Readonly<{
      /** Reports retained handle closure before checkpoint construction. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Reports current Authority denial before checkpoint construction. */
      kind: 'authority-refused';
      /** Preserves the exact current refusal evidence. */
      refusal: AuthorityRefusal<ScratchpadCheckpointAction>;
    }>;

/** Retained close evidence that states recoverability without claiming byte deletion. */
export type ScratchpadCloseEvidence = Readonly<{
  /** Distinguishes retained-handle release from a content mutation. */
  kind: 'scratchpad-closed';
  /** Names the exact private owner that stopped accepting commands. */
  scratchpadId: ScratchpadId;
  /** Reports what recoverability evidence existed when the handle closed. */
  disposition: 'ephemeral-released' | 'checkpoint-retained' | 'uncheckpointed-released';
  /** Carries the final acknowledged immutable content tree. */
  head: TreeRef;
  /** Carries the latest retained checkpoint when one existed. */
  checkpoint?: TreeRef;
  /** Records lifecycle completion through the injected trusted clock. */
  closedAt: Timestamp;
}>;

/** Methods shared by every retention-discriminated Scratchpad handle. */
export interface ScratchpadHandleBase<R extends ScratchpadRetention>
  extends LiveState<ScratchpadSnapshot<R>>, OwnedHandle<ScratchpadCloseEvidence> {
  /** Names the private owner independently from its content. */
  readonly scratchpadId: ScratchpadId;
  /** Makes cleanup and recovery semantics inspectable without method probing. */
  readonly retention: R;
  /** Exposes gap-aware live updates without pretending they are checkpoint history. */
  readonly updates: TransientEventStream<ScratchpadUpdate>;
  /** Reads one exact current file after current path-scoped authorization. */
  read(request: ScratchpadReadRequest, grant: GrantRef<ScratchpadReadAction>): Promise<ScratchpadReadOutcome>;
  /** Lists one current subtree after current path-scoped authorization. */
  list(request: ScratchpadListRequest, grant: GrantRef<ScratchpadReadAction>): Promise<ScratchpadListOutcome>;
  /** Applies one authorized optimistic mutation to private Scratchpad content. */
  apply(command: ScratchpadMutation, grant: GrantRef<ScratchpadWriteAction>): Promise<ScratchpadMutationOutcome<R>>;
}

/** Ephemeral Scratchpad has hot state and transient updates but no checkpoint API. */
export interface EphemeralScratchpadHandle
  extends
    ScratchpadHandleBase<'ephemeral'>,
    AtomicLiveAttachmentSource<
      ScratchpadSnapshot<'ephemeral'>,
      never,
      never,
      never,
      Readonly<{
        /** Names the gap-aware transient update plane available during live attachment. */
        updates: ScratchpadUpdate;
      }>
    > {}

/** Retained Scratchpad adds replayable checkpoint facts and an explicit command. */
export interface RetainedScratchpadHandle<R extends Exclude<ScratchpadRetention, 'ephemeral'>>
  extends
    ScratchpadHandleBase<R>,
    AtomicLiveAttachmentSource<
      ScratchpadSnapshot<R>,
      'scratchpad-checkpoint',
      ScratchpadCursor,
      ScratchpadCheckpointEvent,
      Readonly<{
        /** Names the gap-aware transient update plane available during live attachment. */
        updates: ScratchpadUpdate;
      }>
    > {
  /** Replays acknowledged checkpoint facts, never transient path updates. */
  readonly checkpointEvents: ReplayableEventStream<ScratchpadCheckpointEvent, ScratchpadCursor>;
  /** Acknowledges one exact current tree as a retained checkpoint. */
  checkpoint(
    command: ScratchpadCheckpointCommand,
    grant: GrantRef<ScratchpadCheckpointAction>,
  ): Promise<ScratchpadCheckpointOutcome>;
}

/** Complete handle union whose discriminator changes available commands. */
export type ScratchpadHandle =
  EphemeralScratchpadHandle | RetainedScratchpadHandle<'checkpointed'> | RetainedScratchpadHandle<'thread-durable'>;

/** Options shared by both honest process-local Scratchpad retention modes. */
export type CreateMemoryScratchpadOptions<R extends MemoryScratchpadRetention> = Readonly<{
  /** Supplies stable private owner identity before any retained state exists. */
  scratchpadId: ScratchpadId;
  /** Names the application object responsible for lifecycle policy. */
  owner: ScratchpadOwner;
  /** Selects either non-recoverable or explicitly checkpointable process-local behavior. */
  retention: R;
  /** Uses this exact immutable tree or creates an empty tree when omitted. */
  base?: TreeRef;
  /** Replaces the documented process-local file and byte defaults. */
  quota?: ScratchpadQuota;
  /** Attributes every protected method to one admitted Principal. */
  subject: PrincipalId;
  /** Supplies immutable logical storage with explicit lifecycle ownership. */
  store: ComponentRef<FileStore>;
  /** Supplies current external Scratchpad authorization with explicit lifecycle ownership. */
  authority: ComponentRef<AuthorityBroker<ScratchpadAction>>;
  /** Supplies deterministic internal, stream, snapshot, and checkpoint UUIDv4 values. */
  createId?: () => string;
  /** Supplies trusted checkpoint and close instants. */
  now?: () => Date;
  /** Receives best-effort wide spans without gaining control of Scratchpad outcomes. */
  diagnostics?: Pick<DiagnosticHub, 'beginSpan'>;
}>;

/**
 * Builds deterministic checkpoint evidence over explicit identity-bearing fields.
 * @param checkpoint - Complete checkpoint excluding its evidence digest.
 * @returns SHA-256 evidence independent from object property enumeration.
 */
export function scratchpadCheckpointEvidence(
  checkpoint: Omit<ScratchpadCheckpoint, 'evidenceDigest'>,
): `sha256:${string}` {
  /** Explicit field order prevents runtime enumeration from defining checkpoint identity. */
  const canonical = [
    'archer-scratchpad-checkpoint-v1',
    checkpoint.id,
    checkpoint.createdAt,
    checkpoint.scratchpadId,
    checkpoint.owner.type,
    checkpoint.owner.id,
    checkpoint.retention,
    String(checkpoint.generation),
    checkpoint.tree.format,
    checkpoint.tree.digest,
    checkpoint.tree.byteLength,
  ].join('\0');
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
