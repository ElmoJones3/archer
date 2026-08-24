/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Defines private Workspace values, protected actions, and retained behavior.
 *
 * A Workspace owns acknowledged logical lineage over immutable trees. Physical
 * bytes, sandbox execution, and canonical publication remain outside this
 * contract so callers can adopt private file behavior without adopting Archer's
 * agent runtime.
 */

import * as z from 'zod';

import {
  CanonicalDecimalSchema,
  IdempotencyKeySchema,
  archerObjectSchema,
  fromZod,
  type ArcherObject,
  type CanonicalDecimal,
  type IdempotencyKey,
  type Timestamp,
} from '@archer/core';
import {
  defineAuthorityAction,
  type AuthorityActionDefinition,
  type AuthorityRefusal,
  type GrantRef,
  type ProtectedAction,
} from '@archer/core/authority';
import type { AtomicLiveAttachmentSource, LiveState, ReplayableEventStream, StreamCursor } from '@archer/core/stream';
import type { OwnedHandle } from '@archer/core/ownership';

import {
  BlobRefSchema,
  FileModeSchema,
  TreeRefSchema,
  type BlobRef,
  type FileMode,
  type TreeRef,
} from '../encoding.js';
import { PhysicalIngestionReceiptSchema, type PhysicalIngestionReceipt } from '../ingestion.js';
import { LogicalPathSchema, type LogicalPath } from '../path.js';
import type { BlobRead, TreeFileEntry } from '../store.js';
import {
  ChangeSetIdSchema,
  MaterializedViewIdSchema,
  WorkspaceIdSchema,
  WorkspaceLineageIdSchema,
  WorkspaceSnapshotIdSchema,
  type ChangeSetId,
  type MaterializedViewId,
  type WorkspaceId,
  type WorkspaceLineageId,
  type WorkspaceSnapshotId,
} from '../work-values.js';

/** Default maximum number of regular files admitted by the memory reference. */
export const DEFAULT_WORKSPACE_MAX_FILES = 10_000;

/** Default maximum aggregate logical bytes admitted by the memory reference. */
export const DEFAULT_WORKSPACE_MAX_BYTES = CanonicalDecimalSchema.parse('1073741824');

/** Prevents a cursor for another replay family from resuming Workspace facts. */
export type WorkspaceCursor = StreamCursor<'workspace'>;

/** Limits acknowledged logical content without treating metrics as enforcement. */
export type WorkspaceQuota = Readonly<{
  /** Caps the complete regular-file count after a successful transition. */
  maxFiles: number;
  /** Caps the sum of exact raw blob lengths after a successful transition. */
  maxBytes: CanonicalDecimal;
}>;

/** Reports both configured bounds and current acknowledged consumption. */
export type WorkspaceQuotaState = Readonly<{
  /** Retains the immutable limits selected when the Workspace opened. */
  limits: WorkspaceQuota;
  /** Counts regular files in the acknowledged head tree. */
  usedFiles: number;
  /** Sums exact raw blob lengths in the acknowledged head tree. */
  usedBytes: CanonicalDecimal;
}>;

/** Lifecycle values visible to late state observers without consulting logs. */
export type WorkspaceLifecycle = 'ready' | 'ingesting' | 'closing' | 'closed' | 'recovery-required';

/** One immutable transferable generation of private Workspace lineage. */
export type WorkspaceSnapshot = ArcherObject<'workspace-snapshot', WorkspaceSnapshotId> &
  Readonly<{
    /** Names the retained Workspace that earned this generation. */
    workspaceId: WorkspaceId;
    /** Prevents a snapshot from being substituted across unrelated histories. */
    lineageId: WorkspaceLineageId;
    /** Identifies the complete immutable logical content at this generation. */
    tree: TreeRef;
    /** Advances exactly once for every acknowledged lineage change. */
    generation: number;
    /** Binds the snapshot's identity-bearing fields to redaction-safe evidence. */
    evidenceDigest: `sha256:${string}`;
  }>;

/** Hot current projection owned by one retained Workspace attachment. */
export type WorkspaceHandleSnapshot = Readonly<{
  /** Names the private Workspace whose state this handle projects. */
  workspaceId: WorkspaceId;
  /** Identifies the uninterrupted lineage shared by base and head. */
  lineageId: WorkspaceLineageId;
  /** Retains the immutable starting tree for diff and ChangeSet construction. */
  base: TreeRef;
  /** Identifies the latest acknowledged private tree. */
  head: TreeRef;
  /** Matches the latest acknowledged transferable snapshot. */
  generation: number;
  /** Exposes enforceable limits and acknowledged usage without polling. */
  quota: WorkspaceQuotaState;
  /** Distinguishes logical readiness from ingestion and retained-handle cleanup. */
  lifecycle: WorkspaceLifecycle;
}>;

/** Precondition that serializes a mutation against one complete generation. */
export type WorkspaceGenerationPrecondition = Readonly<{
  /** Selects optimistic concurrency over the complete acknowledged head. */
  kind: 'generation';
  /** Must equal the current generation when the command reaches settlement. */
  generation: number;
}>;

/** Precondition that requires one logical path to remain absent. */
export type WorkspaceAbsentPrecondition = Readonly<{
  /** Selects path absence without blocking unrelated concurrent changes. */
  kind: 'absent';
}>;

/** Precondition that pins one existing path to exact immutable content. */
export type WorkspaceBlobPrecondition = Readonly<{
  /** Selects content identity as the optimistic concurrency boundary. */
  kind: 'blob';
  /** Must equal the source path's current blob reference. */
  blob: BlobRef;
}>;

/** Preconditions accepted by add operations. */
export type WorkspaceAddPrecondition = WorkspaceGenerationPrecondition | WorkspaceAbsentPrecondition;

/** Preconditions accepted by operations over an existing source path. */
export type WorkspaceExistingPrecondition = WorkspaceGenerationPrecondition | WorkspaceBlobPrecondition;

/** Fields shared by every idempotent Workspace mutation command. */
type WorkspaceMutationBase = Readonly<{
  /** Deduplicates this command at the retained Workspace boundary. */
  idempotencyKey: IdempotencyKey;
}>;

/** Adds one new regular file without overwriting existing logical content. */
export type WorkspaceAddMutation = WorkspaceMutationBase &
  Readonly<{
    /** Selects the add transition. */
    type: 'add';
    /** Names the absent logical path that may enter the next tree. */
    path: string;
    /** Supplies complete UTF-8 text or copied raw bytes for publication. */
    content: string | Uint8Array;
    /** Defaults to portable readable mode when omitted. */
    mode?: FileMode;
    /** Prevents a concurrent writer from turning add into overwrite. */
    precondition: WorkspaceAddPrecondition;
  }>;

/** Replaces one existing file's content and optionally its portable mode. */
export type WorkspaceModifyMutation = WorkspaceMutationBase &
  Readonly<{
    /** Selects the modify transition. */
    type: 'modify';
    /** Names the existing logical file whose identity may change. */
    path: string;
    /** Supplies complete UTF-8 text or copied raw bytes for publication. */
    content: string | Uint8Array;
    /** Preserves the prior mode when omitted. */
    mode?: FileMode;
    /** Rejects stale modification without changing the Workspace head. */
    precondition: WorkspaceExistingPrecondition;
  }>;

/** Moves one existing logical file without changing its immutable blob. */
export type WorkspaceRenameMutation = WorkspaceMutationBase &
  Readonly<{
    /** Selects the rename transition. */
    type: 'rename';
    /** Names the existing source path. */
    from: string;
    /** Names the absent destination path. */
    to: string;
    /** Pins the source against concurrent replacement. */
    precondition: WorkspaceExistingPrecondition;
  }>;

/** Removes one existing logical file from private lineage. */
export type WorkspaceDeleteMutation = WorkspaceMutationBase &
  Readonly<{
    /** Selects the delete transition. */
    type: 'delete';
    /** Names the existing path removed from the next tree. */
    path: string;
    /** Pins the source against concurrent replacement. */
    precondition: WorkspaceExistingPrecondition;
  }>;

/** Complete mutation vocabulary exposed to TypeScript and AI SDK integrations. */
export type WorkspaceMutation =
  WorkspaceAddMutation | WorkspaceModifyMutation | WorkspaceRenameMutation | WorkspaceDeleteMutation;

/** Stable domain refusals that preserve the prior Workspace head. */
export type WorkspaceMutationRefusalReason =
  | 'workspace-closed'
  | 'stale-generation'
  | 'path-exists'
  | 'path-not-found'
  | 'stale-blob'
  | 'quota-exceeded'
  | 'idempotency-conflict';

/** Review-oriented operation derived from exact base and result trees. */
export type ChangeSetOperation =
  | Readonly<{
      /** Records a path absent from the base and present in the result. */
      type: 'add';
      /** Names the added logical path. */
      path: LogicalPath;
      /** Identifies the exact added file content. */
      after: BlobRef;
      /** Records the added portable file mode for human review. */
      afterMode: FileMode;
    }>
  | Readonly<{
      /** Records changed content or portable mode at one retained path. */
      type: 'modify';
      /** Names the modified logical path. */
      path: LogicalPath;
      /** Identifies exact content before the private change. */
      before: BlobRef;
      /** Identifies exact content after the private change. */
      after: BlobRef;
      /** Records the portable mode before the private change. */
      beforeMode: FileMode;
      /** Records the portable mode after the private change. */
      afterMode: FileMode;
    }>
  | Readonly<{
      /** Records an explicitly acknowledged logical move. */
      type: 'rename';
      /** Names the path removed by the move. */
      from: LogicalPath;
      /** Names the path added by the move. */
      to: LogicalPath;
      /** Identifies content preserved across the move. */
      blob: BlobRef;
      /** Records portable mode preserved across the move. */
      mode: FileMode;
    }>
  | Readonly<{
      /** Records a path present in the base and absent from the result. */
      type: 'delete';
      /** Names the removed logical path. */
      path: LogicalPath;
      /** Identifies the exact removed content. */
      before: BlobRef;
      /** Records the removed portable file mode for human review. */
      beforeMode: FileMode;
    }>;

/** Immutable private proposal that carries no review or publication authority. */
export type ChangeSet = ArcherObject<'change-set', ChangeSetId> &
  Readonly<{
    /** Names the Workspace that produced the proposal. */
    workspaceId: WorkspaceId;
    /** Prevents proposal substitution across unrelated histories. */
    lineageId: WorkspaceLineageId;
    /** Identifies the exact immutable tree used as the proposal base. */
    base: TreeRef;
    /** Identifies the exact proposed private result. */
    result: TreeRef;
    /** Pins the proposal to the acknowledged Workspace generation. */
    generation: number;
    /** Provides human review context without replacing tree identity. */
    operations: readonly ChangeSetOperation[];
    /** Binds proposal identity, lineage, trees, generation, and operations. */
    evidenceDigest: `sha256:${string}`;
  }>;

/** Integrity-verified physical evidence required before Workspace acceptance. */
export type WorkspaceIngestionReceipt = PhysicalIngestionReceipt;

/** Durable facts emitted after Workspace lineage or proposal settlement. */
export type WorkspaceEvent =
  | Readonly<{
      /** Records one accepted logical mutation. */
      type: 'mutation-applied';
      /** Names the idempotent command that earned this fact. */
      idempotencyKey: IdempotencyKey;
      /** Preserves the semantic operation without retaining raw content. */
      operation: ChangeSetOperation;
      /** Carries the complete acknowledged resulting snapshot. */
      snapshot: WorkspaceSnapshot;
    }>
  | Readonly<{
      /** Records explicit acceptance of verified physical ingestion. */
      type: 'ingestion-accepted';
      /** Names the idempotent acceptance command. */
      idempotencyKey: IdempotencyKey;
      /** Identifies the physical view whose result entered lineage. */
      materializedViewId: MaterializedViewId;
      /** Carries the complete acknowledged resulting snapshot. */
      snapshot: WorkspaceSnapshot;
    }>
  | Readonly<{
      /** Records creation of a private proposal without changing Workspace head. */
      type: 'change-set-created';
      /** Names the idempotent proposal command. */
      idempotencyKey: IdempotencyKey;
      /** Carries the immutable ChangeSet made observable. */
      changeSet: ChangeSet;
    }>;

/** Scope shared by Workspace read and write actions over logical paths. */
export type WorkspacePathScope<Kind extends 'workspace-read' | 'workspace-write'> = Readonly<{
  /** Keeps read and write scope values structurally distinct at runtime. */
  kind: Kind;
  /** Prevents a grant for one Workspace from crossing into another. */
  workspaceId: WorkspaceId;
  /** Omits paths for whole-Workspace access; otherwise names allowed subtrees. */
  paths?: readonly LogicalPath[];
}>;

/** Scope owned by Workspace reads, listings, and diffs. */
export type WorkspaceReadScope = WorkspacePathScope<'workspace-read'>;

/** Scope owned by direct mutation of acknowledged Workspace lineage. */
export type WorkspaceWriteScope = WorkspacePathScope<'workspace-write'>;

/** Scope owned by accepting one exact physical ingestion receipt. */
export type WorkspaceIngestionAcceptScope = Readonly<{
  /** Keeps ingestion authority separate from ordinary logical mutation. */
  kind: 'workspace-ingestion-accept';
  /** Names the only Workspace that may accept the receipt. */
  workspaceId: WorkspaceId;
  /** Pins acceptance to the exact currently expected logical tree. */
  base?: TreeRef;
  /** Pins acceptance to the complete verified physical result. */
  result?: TreeRef;
  /** Pins acceptance to one exact Workspace generation. */
  generation?: number;
  /** Names the physical view whose evidence is being accepted. */
  materializedViewId?: MaterializedViewId;
}>;

/** Scope owned by creation of one exact private ChangeSet. */
export type ChangeSetCreateScope = Readonly<{
  /** Keeps proposal authority distinct from Workspace mutation. */
  kind: 'change-set-create';
  /** Names the Workspace producing the private proposal. */
  workspaceId: WorkspaceId;
  /** Pins the proposal's exact immutable base. */
  base?: TreeRef;
  /** Pins the proposal's exact immutable result. */
  result?: TreeRef;
  /** Pins the proposal to the current acknowledged generation. */
  generation?: number;
}>;

/** Permission to read exact private Workspace content. */
export type WorkspaceReadAction = ProtectedAction<'workspace-read', WorkspaceReadScope>;

/** Permission to mutate exact private Workspace content. */
export type WorkspaceWriteAction = ProtectedAction<'workspace-write', WorkspaceWriteScope>;

/** Permission to accept one exact ingestion result into private lineage. */
export type WorkspaceIngestionAcceptAction = ProtectedAction<
  'workspace-ingestion-accept',
  WorkspaceIngestionAcceptScope
>;

/** Permission to construct one exact private ChangeSet. */
export type ChangeSetCreateAction = ProtectedAction<'change-set-create', ChangeSetCreateScope>;

/** Union registered by a Workspace's current Authority broker. */
export type WorkspaceAction =
  WorkspaceReadAction | WorkspaceWriteAction | WorkspaceIngestionAcceptAction | ChangeSetCreateAction;

/** Canonical runtime admission for Workspace quota configuration. */
export const WorkspaceQuotaSchema: z.ZodType<WorkspaceQuota> = z
  .strictObject({
    maxFiles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxBytes: CanonicalDecimalSchema,
  })
  .transform((value) => Object.freeze(value));

/** Canonical runtime admission for immutable Workspace generation snapshots. */
export const WorkspaceSnapshotSchema: z.ZodType<WorkspaceSnapshot> = archerObjectSchema(
  'workspace-snapshot',
  WorkspaceSnapshotIdSchema,
)
  .and(
    z.strictObject({
      workspaceId: WorkspaceIdSchema,
      lineageId: WorkspaceLineageIdSchema,
      tree: TreeRefSchema,
      generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
  )
  .transform((value) => Object.freeze(value) as WorkspaceSnapshot);

/** Runtime admission for one review-oriented ChangeSet operation. */
const ChangeSetOperationSchema: z.ZodType<ChangeSetOperation> = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('add'),
      path: LogicalPathSchema,
      after: BlobRefSchema,
      afterMode: FileModeSchema,
    }),
    z.strictObject({
      type: z.literal('modify'),
      path: LogicalPathSchema,
      before: BlobRefSchema,
      after: BlobRefSchema,
      beforeMode: FileModeSchema,
      afterMode: FileModeSchema,
    }),
    z.strictObject({
      type: z.literal('rename'),
      from: LogicalPathSchema,
      to: LogicalPathSchema,
      blob: BlobRefSchema,
      mode: FileModeSchema,
    }),
    z.strictObject({
      type: z.literal('delete'),
      path: LogicalPathSchema,
      before: BlobRefSchema,
      beforeMode: FileModeSchema,
    }),
  ])
  .transform((value) => Object.freeze(value) as ChangeSetOperation);

/** Canonical runtime admission for immutable private ChangeSet proposals. */
export const ChangeSetSchema: z.ZodType<ChangeSet> = archerObjectSchema('change-set', ChangeSetIdSchema)
  .and(
    z.strictObject({
      workspaceId: WorkspaceIdSchema,
      lineageId: WorkspaceLineageIdSchema,
      base: TreeRefSchema,
      result: TreeRefSchema,
      generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      operations: z.array(ChangeSetOperationSchema),
      evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
  )
  .transform((value) => Object.freeze({ ...value, operations: Object.freeze(value.operations) }) as ChangeSet);

/** Canonical runtime admission for generation-based optimistic concurrency. */
const WorkspaceGenerationPreconditionSchema = z
  .strictObject({
    kind: z.literal('generation'),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .readonly();

/** Canonical runtime admission for absence-based optimistic concurrency. */
const WorkspaceAbsentPreconditionSchema = z.strictObject({ kind: z.literal('absent') }).readonly();

/** Canonical runtime admission for immutable-blob optimistic concurrency. */
const WorkspaceBlobPreconditionSchema = z.strictObject({ kind: z.literal('blob'), blob: BlobRefSchema }).readonly();

/** Copies string or byte mutation content before asynchronous work can retain it. */
const WorkspaceContentSchema = z
  .union([z.string(), z.instanceof(Uint8Array)])
  .transform((value) => (typeof value === 'string' ? value : Uint8Array.from(value)));

/** Untransformed add command used by the discriminated mutation union. */
const WorkspaceAddMutationInputSchema = z.strictObject({
  type: z.literal('add'),
  path: LogicalPathSchema,
  content: WorkspaceContentSchema,
  mode: FileModeSchema.optional(),
  precondition: z.union([WorkspaceGenerationPreconditionSchema, WorkspaceAbsentPreconditionSchema]),
  idempotencyKey: IdempotencyKeySchema,
});

/** Untransformed modify command used by the discriminated mutation union. */
const WorkspaceModifyMutationInputSchema = z.strictObject({
  type: z.literal('modify'),
  path: LogicalPathSchema,
  content: WorkspaceContentSchema,
  mode: FileModeSchema.optional(),
  precondition: z.union([WorkspaceGenerationPreconditionSchema, WorkspaceBlobPreconditionSchema]),
  idempotencyKey: IdempotencyKeySchema,
});

/** Untransformed rename command used by the discriminated mutation union. */
const WorkspaceRenameMutationInputSchema = z.strictObject({
  type: z.literal('rename'),
  from: LogicalPathSchema,
  to: LogicalPathSchema,
  precondition: z.union([WorkspaceGenerationPreconditionSchema, WorkspaceBlobPreconditionSchema]),
  idempotencyKey: IdempotencyKeySchema,
});

/** Untransformed delete command used by the discriminated mutation union. */
const WorkspaceDeleteMutationInputSchema = z.strictObject({
  type: z.literal('delete'),
  path: LogicalPathSchema,
  precondition: z.union([WorkspaceGenerationPreconditionSchema, WorkspaceBlobPreconditionSchema]),
  idempotencyKey: IdempotencyKeySchema,
});

/** Canonical runtime admission for all Workspace mutation commands. */
export const WorkspaceMutationSchema: z.ZodType<WorkspaceMutation> = z
  .discriminatedUnion('type', [
    WorkspaceAddMutationInputSchema,
    WorkspaceModifyMutationInputSchema,
    WorkspaceRenameMutationInputSchema,
    WorkspaceDeleteMutationInputSchema,
  ])
  .transform((value) => Object.freeze(value) as WorkspaceMutation);

/**
 * Builds runtime scope admission for one path-scoped action discriminator.
 * @param kind - Exact read or write scope discriminator.
 * @returns A schema that normalizes paths before Authority retains them.
 */
function workspacePathScopeSchema<Kind extends 'workspace-read' | 'workspace-write'>(
  kind: Kind,
): z.ZodType<WorkspacePathScope<Kind>> {
  return z
    .strictObject({
      kind: z.literal(kind),
      workspaceId: WorkspaceIdSchema,
      paths: z.array(LogicalPathSchema).min(1).optional(),
    })
    .transform(
      (value) =>
        Object.freeze({
          ...value,
          ...(value.paths === undefined ? {} : { paths: Object.freeze([...new Set(value.paths)].sort()) }),
        }) as WorkspacePathScope<Kind>,
    );
}

/** Canonical runtime admission for Workspace read scopes. */
const WorkspaceReadScopeSchema = workspacePathScopeSchema('workspace-read');

/** Canonical runtime admission for Workspace write scopes. */
const WorkspaceWriteScopeSchema = workspacePathScopeSchema('workspace-write');

/** Canonical runtime admission for exact ingestion acceptance scopes. */
const WorkspaceIngestionAcceptScopeSchema = z
  .strictObject({
    kind: z.literal('workspace-ingestion-accept'),
    workspaceId: WorkspaceIdSchema,
    base: TreeRefSchema.optional(),
    result: TreeRefSchema.optional(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    materializedViewId: MaterializedViewIdSchema.optional(),
  })
  .transform((value): WorkspaceIngestionAcceptScope =>
    Object.freeze({
      kind: value.kind,
      workspaceId: value.workspaceId,
      ...(value.base === undefined ? {} : { base: value.base }),
      ...(value.result === undefined ? {} : { result: value.result }),
      ...(value.generation === undefined ? {} : { generation: value.generation }),
      ...(value.materializedViewId === undefined ? {} : { materializedViewId: value.materializedViewId }),
    }),
  );

/** Canonical runtime admission for exact ChangeSet creation scopes. */
const ChangeSetCreateScopeSchema = z
  .strictObject({
    kind: z.literal('change-set-create'),
    workspaceId: WorkspaceIdSchema,
    base: TreeRefSchema.optional(),
    result: TreeRefSchema.optional(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .transform((value): ChangeSetCreateScope =>
    Object.freeze({
      kind: value.kind,
      workspaceId: value.workspaceId,
      ...(value.base === undefined ? {} : { base: value.base }),
      ...(value.result === undefined ? {} : { result: value.result }),
      ...(value.generation === undefined ? {} : { generation: value.generation }),
    }),
  );

/**
 * Reports whether a requested path falls under one admitted grant root.
 * @param root - Granted exact file or directory prefix.
 * @param requested - Requested exact file or directory prefix.
 * @returns Whether segment boundaries preserve containment.
 */
function containsLogicalPath(root: LogicalPath, requested: LogicalPath): boolean {
  return requested === root || requested.startsWith(`${root}/`);
}

/**
 * Evaluates path-scope containment without consulting mutable Workspace state.
 * @param granted - Admitted grant scope stored by Authority.
 * @param requested - Exact current operation scope.
 * @returns Whether workspace identity and every requested path are contained.
 */
function allowsWorkspacePaths<Kind extends 'workspace-read' | 'workspace-write'>(
  granted: WorkspacePathScope<Kind>,
  requested: WorkspacePathScope<Kind>,
): boolean {
  if (granted.workspaceId !== requested.workspaceId) return false;
  if (granted.paths === undefined) return true;
  if (requested.paths === undefined) return false;
  return requested.paths.every((path) => granted.paths?.some((root) => containsLogicalPath(root, path)) === true);
}

/** Public action definition for Workspace reads, listings, and diffs. */
export const WORKSPACE_READ_ACTION: AuthorityActionDefinition<WorkspaceReadAction> =
  defineAuthorityAction<WorkspaceReadAction>({
    action: 'workspace-read',
    scope: fromZod(WorkspaceReadScopeSchema),
    allows: allowsWorkspacePaths,
  });

/** Public action definition for direct Workspace lineage mutation. */
export const WORKSPACE_WRITE_ACTION: AuthorityActionDefinition<WorkspaceWriteAction> =
  defineAuthorityAction<WorkspaceWriteAction>({
    action: 'workspace-write',
    scope: fromZod(WorkspaceWriteScopeSchema),
    allows: allowsWorkspacePaths,
  });

/** Public action definition for accepting one exact ingestion receipt. */
export const WORKSPACE_INGESTION_ACCEPT_ACTION: AuthorityActionDefinition<WorkspaceIngestionAcceptAction> =
  defineAuthorityAction<WorkspaceIngestionAcceptAction>({
    action: 'workspace-ingestion-accept',
    scope: fromZod(WorkspaceIngestionAcceptScopeSchema),
    /**
     * Allows broad Workspace ingestion or a receipt-specific attenuation.
     * @param granted - Scope retained by the current grant chain.
     * @param requested - Exact current receipt acceptance request.
     * @returns Whether every present grant constraint contains the request.
     */
    allows: (granted, requested) =>
      granted.workspaceId === requested.workspaceId &&
      (granted.base === undefined ||
        (requested.base !== undefined &&
          granted.base.digest === requested.base.digest &&
          granted.base.byteLength === requested.base.byteLength)) &&
      (granted.result === undefined ||
        (requested.result !== undefined &&
          granted.result.digest === requested.result.digest &&
          granted.result.byteLength === requested.result.byteLength)) &&
      (granted.generation === undefined || granted.generation === requested.generation) &&
      (granted.materializedViewId === undefined || granted.materializedViewId === requested.materializedViewId),
  });

/** Public action definition for constructing one exact private ChangeSet. */
export const CHANGE_SET_CREATE_ACTION: AuthorityActionDefinition<ChangeSetCreateAction> =
  defineAuthorityAction<ChangeSetCreateAction>({
    action: 'change-set-create',
    scope: fromZod(ChangeSetCreateScopeSchema),
    /**
     * Allows broad proposal creation or an attenuation pinned to exact lineage.
     * @param granted - Scope retained by the current grant chain.
     * @param requested - Exact current base-to-head proposal request.
     * @returns Whether every present grant constraint contains the request.
     */
    allows: (granted, requested) =>
      granted.workspaceId === requested.workspaceId &&
      (granted.base === undefined ||
        (requested.base !== undefined &&
          granted.base.digest === requested.base.digest &&
          granted.base.byteLength === requested.base.byteLength)) &&
      (granted.result === undefined ||
        (requested.result !== undefined &&
          granted.result.digest === requested.result.digest &&
          granted.result.byteLength === requested.result.byteLength)) &&
      (granted.generation === undefined || granted.generation === requested.generation),
  });

/** Result of reading one exact acknowledged logical file. */
export type WorkspaceReadOutcome =
  | Readonly<{
      /** Reports that the retained Workspace attachment no longer accepts reads. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Selects a successful verified streaming read. */
      kind: 'found';
      /** Carries the acknowledged logical entry selected at this call. */
      entry: TreeFileEntry;
      /** Verifies exact bytes at successful terminal iteration. */
      read: BlobRead;
    }>
  | Readonly<{
      /** Reports ordinary absence without manufacturing an Error. */
      kind: 'not-found';
      /** Retains the admitted path that was absent. */
      path: LogicalPath;
    }>
  | Readonly<{
      /** Reports a current Authority denial without throwing. */
      kind: 'authority-refused';
      /** Preserves exact current refusal evidence for this read. */
      refusal: AuthorityRefusal<WorkspaceReadAction>;
    }>;

/** Result of listing acknowledged logical entries under an optional prefix. */
export type WorkspaceListOutcome =
  | Readonly<{
      /** Reports that the retained Workspace attachment no longer accepts listings. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Selects successful canonical listing. */
      kind: 'listed';
      /** Contains immutable entries in normalized UTF-8 path order. */
      entries: readonly TreeFileEntry[];
    }>
  | Readonly<{
      /** Reports a current Authority denial without throwing. */
      kind: 'authority-refused';
      /** Preserves exact current refusal evidence for this listing. */
      refusal: AuthorityRefusal<WorkspaceReadAction>;
    }>;

/** Successful or refused Workspace mutation settlement. */
export type WorkspaceMutationOutcome =
  | Readonly<{
      /** Selects a lineage-changing accepted mutation. */
      kind: 'applied';
      /** Carries the prior acknowledged immutable snapshot. */
      previous: WorkspaceSnapshot;
      /** Carries the new acknowledged immutable snapshot. */
      snapshot: WorkspaceSnapshot;
      /** Carries the review-oriented operation recorded in the fact. */
      operation: ChangeSetOperation;
      /** Distinguishes original settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Selects an accepted mutation that produced no logical change. */
      kind: 'unchanged';
      /** Retains the still-current immutable snapshot. */
      snapshot: WorkspaceSnapshot;
      /** Distinguishes original settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Selects a domain refusal that preserved the prior head. */
      kind: 'refused';
      /** Identifies the exact rule that rejected the mutation. */
      reason: WorkspaceMutationRefusalReason;
      /** Carries the unchanged current snapshot as preserved-state evidence. */
      snapshot: WorkspaceSnapshot;
    }>
  | Readonly<{
      /** Reports a current Authority denial without invoking the model. */
      kind: 'authority-refused';
      /** Preserves exact current refusal evidence for this write. */
      refusal: AuthorityRefusal<WorkspaceWriteAction>;
    }>;

/** Request for canonical listing under one optional logical subtree. */
export type WorkspaceListRequest = Readonly<{
  /** Omits the prefix to list the complete Workspace. */
  prefix?: string;
}>;

/** Request for one exact acknowledged logical file. */
export type WorkspaceReadRequest = Readonly<{
  /** Names the file selected from the current acknowledged head. */
  path: string;
}>;

/** Request for a base-to-head review projection. */
export type WorkspaceDiffRequest = Readonly<{
  /** Must equal the current generation when supplied. */
  expectedGeneration?: number;
}>;

/** Successful, stale, or unauthorized base-to-head diff result. */
export type WorkspaceDiffOutcome =
  | Readonly<{
      /** Reports that the retained Workspace attachment no longer computes diffs. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Selects one exact canonical diff. */
      kind: 'diffed';
      /** Identifies the immutable starting tree. */
      base: TreeRef;
      /** Identifies the immutable current private result. */
      result: TreeRef;
      /** Carries deterministic review operations in logical path order. */
      operations: readonly ChangeSetOperation[];
    }>
  | Readonly<{
      /** Reports a stale requested generation while preserving state. */
      kind: 'stale-generation';
      /** Carries the current generation needed for an informed retry. */
      actualGeneration: number;
    }>
  | Readonly<{
      /** Reports a current Authority denial without computing private differences. */
      kind: 'authority-refused';
      /** Preserves exact current refusal evidence for this diff. */
      refusal: AuthorityRefusal<WorkspaceReadAction>;
    }>;

/** Idempotent request to create a ChangeSet from the current private head. */
export type ChangeSetRequest = Readonly<{
  /** Prevents proposal creation from racing past a reviewed generation. */
  expectedGeneration: number;
  /** Deduplicates proposal identity and event publication. */
  idempotencyKey: IdempotencyKey;
}>;

/** Successful, unchanged, stale, or unauthorized ChangeSet creation. */
export type ChangeSetOutcome =
  | Readonly<{
      /** Reports that the retained Workspace attachment no longer creates proposals. */
      kind: 'closed';
    }>
  | Readonly<{
      /** Selects a newly created or replayed immutable proposal. */
      kind: 'created';
      /** Carries the private proposal without promotion authority. */
      changeSet: ChangeSet;
      /** Distinguishes original settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Reports that base and result contain no logical difference. */
      kind: 'unchanged';
      /** Identifies the current tree equal to the base. */
      tree: TreeRef;
    }>
  | Readonly<{
      /** Reports a stale requested generation without creating a proposal. */
      kind: 'stale-generation';
      /** Carries the current generation needed for an informed retry. */
      actualGeneration: number;
    }>
  | Readonly<{
      /** Reports conflicting reuse of one proposal idempotency key. */
      kind: 'idempotency-conflict';
    }>
  | Readonly<{
      /** Reports a current Authority denial without creating a proposal. */
      kind: 'authority-refused';
      /** Preserves exact current refusal evidence for this proposal. */
      refusal: AuthorityRefusal<ChangeSetCreateAction>;
    }>;

/** Idempotent command that accepts one exact verified ingestion receipt. */
export type WorkspaceIngestionCommand = Readonly<{
  /** Carries the physical-to-logical evidence selected for acceptance. */
  receipt: WorkspaceIngestionReceipt;
  /** Deduplicates lineage settlement for this receipt. */
  idempotencyKey: IdempotencyKey;
}>;

/** Canonical runtime admission for an exact integrity-bearing acceptance command. */
export const WorkspaceIngestionCommandSchema: z.ZodType<WorkspaceIngestionCommand> = z
  .strictObject({
    receipt: PhysicalIngestionReceiptSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .transform((value) => Object.freeze(value));

/** Successful or refused ingestion acceptance. */
export type WorkspaceIngestionOutcome =
  | Readonly<{
      /** Selects a lineage-changing accepted receipt. */
      kind: 'accepted';
      /** Carries the prior acknowledged immutable snapshot. */
      previous: WorkspaceSnapshot;
      /** Carries the new acknowledged immutable snapshot. */
      snapshot: WorkspaceSnapshot;
      /** Distinguishes original settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Selects an accepted receipt whose result equals the current head. */
      kind: 'unchanged';
      /** Retains the still-current immutable snapshot. */
      snapshot: WorkspaceSnapshot;
      /** Distinguishes original settlement from exact idempotent replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Reports receipt mismatch while preserving the current head. */
      kind: 'refused';
      /** Identifies the exact failed receipt precondition. */
      reason: 'workspace-closed' | 'stale-generation' | 'base-mismatch' | 'quota-exceeded' | 'idempotency-conflict';
      /** Carries the unchanged current snapshot as preserved-state evidence. */
      snapshot: WorkspaceSnapshot;
    }>
  | Readonly<{
      /** Reports current Authority denial before receipt settlement. */
      kind: 'authority-refused';
      /** Preserves exact current refusal evidence for ingestion acceptance. */
      refusal: AuthorityRefusal<WorkspaceIngestionAcceptAction>;
    }>;

/** Immutable retained-handle close evidence that never implies deletion. */
export type WorkspaceCloseEvidence = Readonly<{
  /** Distinguishes handle release from Workspace mutation or cancellation. */
  kind: 'workspace-closed';
  /** Names the attachment that stopped accepting commands. */
  workspaceId: WorkspaceId;
  /** Retains the final acknowledged transferable snapshot. */
  snapshot: WorkspaceSnapshot;
  /** Records when cleanup finished through the injected trusted clock. */
  closedAt: Timestamp;
}>;

/** Retained behavior for one process-local private Workspace attachment. */
export interface WorkspaceHandle
  extends
    LiveState<WorkspaceHandleSnapshot>,
    AtomicLiveAttachmentSource<WorkspaceHandleSnapshot, 'workspace', WorkspaceCursor, WorkspaceEvent, Readonly<{}>>,
    OwnedHandle<WorkspaceCloseEvidence> {
  /** Names this private Workspace independently of its current tree. */
  readonly workspaceId: WorkspaceId;
  /** Names the uninterrupted history shared by every acknowledged snapshot. */
  readonly lineageId: WorkspaceLineageId;
  /** Replays acknowledged mutations, ingestion acceptance, and ChangeSet facts. */
  readonly durableEvents: ReplayableEventStream<WorkspaceEvent, WorkspaceCursor>;
  /** Reads one exact current file after current path-scoped authorization. */
  read(request: WorkspaceReadRequest, grant: GrantRef<WorkspaceReadAction>): Promise<WorkspaceReadOutcome>;
  /** Lists current entries after current subtree-scoped authorization. */
  list(request: WorkspaceListRequest, grant: GrantRef<WorkspaceReadAction>): Promise<WorkspaceListOutcome>;
  /** Computes a deterministic base-to-head review projection after authorization. */
  diff(request: WorkspaceDiffRequest, grant: GrantRef<WorkspaceReadAction>): Promise<WorkspaceDiffOutcome>;
  /** Applies one authorized optimistic mutation and acknowledges a new tree. */
  apply(command: WorkspaceMutation, grant: GrantRef<WorkspaceWriteAction>): Promise<WorkspaceMutationOutcome>;
  /** Accepts one authorized verified physical result into private lineage. */
  acceptIngestion(
    command: WorkspaceIngestionCommand,
    grant: GrantRef<WorkspaceIngestionAcceptAction>,
  ): Promise<WorkspaceIngestionOutcome>;
  /** Creates an immutable private proposal without promoting it. */
  createChangeSet(input: ChangeSetRequest, grant: GrantRef<ChangeSetCreateAction>): Promise<ChangeSetOutcome>;
}
