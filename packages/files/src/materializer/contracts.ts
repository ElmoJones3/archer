/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Defines logical-to-physical Materializer contracts and directory guarantees.
 *
 * A Materializer makes immutable logical inputs usable through ordinary host
 * paths. It neither acknowledges Workspace lineage nor claims that a caller's
 * cooperative pause is equivalent to sandbox-enforced process quiescence.
 */

import * as z from 'zod';

import {
  IdempotencyKeySchema,
  TimestampSchema,
  fromZod,
  type ComponentRef,
  type DiagnosticHub,
  type IdempotencyKey,
  type PublicError,
  type Timestamp,
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
import type { LiveOperation } from '@archer/core/stream';

import { TreeRefSchema, type TreeRef } from '../encoding.js';
import { PhysicalIngestionReceiptSchema, type PhysicalIngestionReceipt } from '../ingestion.js';
import type { FileStore } from '../store.js';
import {
  MaterializedViewIdSchema,
  MaterializerIdSchema,
  type MaterializedViewId,
  type MaterializerId,
  type ScratchpadId,
} from '../work-values.js';

/** Current version of Archer's logical-to-physical adapter protocol. */
export const MATERIALIZER_PROTOCOL_VERSION = 1 as const;

/** Current version of the directory layout and ingestion evidence grammar. */
export const DIRECTORY_MAPPING_VERSION = 1 as const;

/** Exact first-party adapter identity recorded in physical-view evidence. */
export const DIRECTORY_MATERIALIZER_ADAPTER_ID = 'archer.directory' as const;

/** Logical retention carried into a separately rooted Scratchpad mount. */
export type MaterializedScratchpadRetention = 'ephemeral' | 'checkpointed' | 'thread-durable';

/** One immutable resource tree mounted below the fixed resources root. */
export type ReadonlyTreeMount = Readonly<{
  /** Names a relative subtree below the physical `resources` directory. */
  mountPath: string;
  /** Identifies the complete immutable resource content. */
  tree: TreeRef;
}>;

/** One private Scratchpad tree mounted outside the Workspace ingestion root. */
export type ScratchpadMount = Readonly<{
  /** Names the Scratchpad whose bytes remain independently owned. */
  scratchpadId: ScratchpadId;
  /** Names a relative subtree below the physical `scratchpads` directory. */
  mountPath: string;
  /** Identifies the acknowledged Scratchpad content being realized. */
  tree: TreeRef;
  /** Preserves cleanup and recovery intent without changing physical writability. */
  retention: MaterializedScratchpadRetention;
}>;

/** Explicit local-directory target with no implied process containment. */
export type DirectoryMaterializationTarget = Readonly<{
  /** Prevents a directory target from satisfying a volume or image adapter. */
  type: 'directory';
  /** Names an absolute path that must not already exist when materialization starts. */
  rootPath: string;
  /** Makes target collision behavior explicit rather than host-dependent. */
  caseSensitivity: 'sensitive' | 'insensitive';
  /** Selects whether view closure removes or preserves the completed physical tree. */
  cleanup: 'remove' | 'preserve';
}>;

/** Complete immutable inputs bound into one materialization attempt. */
export type DirectoryMaterializationInput = Readonly<{
  /** Identifies the exact Workspace tree realized as writable physical files. */
  workspace: TreeRef;
  /** Pins the physical view to one acknowledged Workspace generation. */
  generation: number;
  /** Realizes immutable Resources below a read-only root excluded from ingestion. */
  resources: readonly ReadonlyTreeMount[];
  /** Realizes private Scratchpads below a writable root excluded from ingestion. */
  scratchpads: readonly ScratchpadMount[];
  /** Selects the exact local physical target and cleanup policy. */
  target: DirectoryMaterializationTarget;
  /** Deduplicates complete attempt construction at one Materializer attachment. */
  idempotencyKey: IdempotencyKey;
}>;

/** Scope owned by creation of one exact physical directory view. */
export type FilesMaterializeScope = Readonly<{
  /** Keeps logical-to-physical authority distinct from file mutation authority. */
  kind: 'files-materialize';
  /** Names the Materializer attachment allowed to perform the attempt. */
  materializerId: MaterializerId;
  /** When present, pins permission to one complete normalized input including mounts and target. */
  inputDigest?: `sha256:${string}`;
}>;

/** Permission to construct one exact physical file view. */
export type FilesMaterializeAction = ProtectedAction<'files-materialize', FilesMaterializeScope>;

/** Scope owned by verified ingestion of one exact directory generation. */
export type FilesIngestScope = Readonly<{
  /** Keeps physical ingestion authority distinct from Workspace acceptance. */
  kind: 'files-ingest';
  /** Names the Materializer that created the view. */
  materializerId: MaterializerId;
  /** When present, names the only physical view allowed to produce a receipt. */
  materializedViewId?: MaterializedViewId;
  /** When present, pins ingestion to the logical tree originally materialized. */
  base?: TreeRef;
  /** When present, pins ingestion to the view's fixed Workspace generation. */
  generation?: number;
  /** Records that this adapter accepts only cooperative caller quiescence. */
  quiescence: 'cooperative-directory';
}>;

/** Permission to verify one quiesced physical directory into immutable content. */
export type FilesIngestAction = ProtectedAction<'files-ingest', FilesIngestScope>;

/** Actions registered by the first-party directory Materializer. */
export type DirectoryMaterializerAction = FilesMaterializeAction | FilesIngestAction;

/** Canonical admission for a materialization Authority scope. */
const FilesMaterializeScopeSchema = z
  .strictObject({
    kind: z.literal('files-materialize'),
    materializerId: MaterializerIdSchema,
    inputDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .transform((value): FilesMaterializeScope =>
    Object.freeze({
      kind: value.kind,
      materializerId: value.materializerId,
      ...(value.inputDigest === undefined ? {} : { inputDigest: value.inputDigest as `sha256:${string}` }),
    }),
  );

/** Canonical admission for an ingestion Authority scope. */
const FilesIngestScopeSchema = z
  .strictObject({
    kind: z.literal('files-ingest'),
    materializerId: MaterializerIdSchema,
    materializedViewId: MaterializedViewIdSchema.optional(),
    base: TreeRefSchema.optional(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    quiescence: z.literal('cooperative-directory'),
  })
  .transform((value): FilesIngestScope =>
    Object.freeze({
      kind: value.kind,
      materializerId: value.materializerId,
      ...(value.materializedViewId === undefined ? {} : { materializedViewId: value.materializedViewId }),
      ...(value.base === undefined ? {} : { base: value.base }),
      ...(value.generation === undefined ? {} : { generation: value.generation }),
      quiescence: value.quiescence,
    }),
  );

/**
 * Compares immutable tree identity fields without relying on object identity.
 * @param left - First admitted immutable tree reference.
 * @param right - Second admitted immutable tree reference.
 * @returns Whether format, digest, and encoded byte length match exactly.
 */
function sameTree(left: TreeRef, right: TreeRef): boolean {
  return left.format === right.format && left.digest === right.digest && left.byteLength === right.byteLength;
}

/** Public action definition for exact directory materialization. */
export const FILES_MATERIALIZE_ACTION: AuthorityActionDefinition<FilesMaterializeAction> =
  defineAuthorityAction<FilesMaterializeAction>({
    action: 'files-materialize',
    scope: fromZod(FilesMaterializeScopeSchema),
    /**
     * Allows an attachment-wide root or one complete normalized input digest.
     * @param granted - Scope retained by the current grant chain.
     * @param requested - Exact materialization input digest requested now.
     * @returns Whether adapter identity and any digest attenuation contain the request.
     */
    allows: (granted, requested) =>
      granted.materializerId === requested.materializerId &&
      (granted.inputDigest === undefined || granted.inputDigest === requested.inputDigest),
  });

/** Public action definition for one exact cooperative-directory ingestion. */
export const FILES_INGEST_ACTION: AuthorityActionDefinition<FilesIngestAction> =
  defineAuthorityAction<FilesIngestAction>({
    action: 'files-ingest',
    scope: fromZod(FilesIngestScopeSchema),
    /**
     * Allows broad adapter ingestion or an attenuation pinned to current view facts.
     * @param granted - Scope retained by the current grant chain.
     * @param requested - Exact physical view and generation requested now.
     * @returns Whether every present grant constraint contains the request.
     */
    allows: (granted, requested) =>
      granted.materializerId === requested.materializerId &&
      (granted.materializedViewId === undefined || granted.materializedViewId === requested.materializedViewId) &&
      (granted.base === undefined || (requested.base !== undefined && sameTree(granted.base, requested.base))) &&
      (granted.generation === undefined || granted.generation === requested.generation) &&
      granted.quiescence === requested.quiescence,
  });

/** Non-authoritative progress emitted while physical inputs are being realized. */
export type MaterializationEvent = Readonly<{
  /** Selects a stable coarse phase without exposing host paths. */
  phase: 'preparing-target' | 'writing-workspace' | 'writing-resources' | 'writing-scratchpads' | 'publishing-view';
  /** Counts complete logical files settled through the end of this phase. */
  filesCompleted: number;
}>;

/** Fixed absolute paths owned by one completed directory view. */
export type DirectoryViewPaths = Readonly<{
  /** Names the complete physical view root selected by the caller. */
  root: string;
  /** Names the only subtree eligible for Workspace ingestion. */
  workspace: string;
  /** Names the immutable resource root excluded from Workspace ingestion. */
  resources: string;
  /** Names the private Scratchpad root excluded from Workspace ingestion. */
  scratchpads: string;
}>;

/** Explicit caller acknowledgement accepted by the local directory adapter. */
export type DirectoryCooperativeQuiescence = Readonly<{
  /** States the exact weak guarantee rather than borrowing a sandbox proof name. */
  type: 'cooperative-directory';
  /** Prevents an acknowledgement for another physical view from being replayed. */
  materializedViewId: MaterializedViewId;
  /** Pins the acknowledgement to the fixed generation being inspected. */
  generation: number;
  /** Records who claims that all cooperating writers have stopped. */
  acknowledgedBy: string;
  /** Records when the cooperating owner made that claim. */
  acknowledgedAt: Timestamp;
}>;

/** Request to verify a cooperatively quiesced directory into immutable content. */
export type DirectoryIngestionInput = Readonly<{
  /** Supplies the only quiescence evidence this adapter is qualified to interpret. */
  quiescence: DirectoryCooperativeQuiescence;
  /** Must equal the exact Workspace tree used to construct the view. */
  expectedBase: TreeRef;
  /** Must equal the fixed Workspace generation used to construct the view. */
  expectedGeneration: number;
  /** Deduplicates one complete physical scan and receipt. */
  idempotencyKey: IdempotencyKey;
}>;

/** Non-authoritative progress emitted while a quiesced directory is verified. */
export type IngestionEvent = Readonly<{
  /** Selects a stable coarse phase without exposing private paths. */
  phase: 'checking-quiescence' | 'scanning-workspace' | 'publishing-tree' | 'creating-receipt';
  /** Counts complete regular files observed through the end of this phase. */
  filesCompleted: number;
}>;

/** Complete directory evidence produced only after full verification and publication. */
export type IngestionReceipt = Omit<PhysicalIngestionReceipt, 'adapterId' | 'mappingVersion' | 'excludedRoots'> &
  Readonly<{
    /** Pins interpretation to the first-party local directory adapter. */
    adapterId: typeof DIRECTORY_MATERIALIZER_ADAPTER_ID;
    /** Pins interpretation to one stable physical mapping grammar. */
    mappingVersion: typeof DIRECTORY_MAPPING_VERSION;
    /** Names fixed roots deliberately excluded from Workspace ingestion. */
    excludedRoots: readonly ['resources', 'scratchpads'];
  }>;

/** Canonical integrity verification plus exact local-directory specialization. */
export const IngestionReceiptSchema: z.ZodType<IngestionReceipt> = PhysicalIngestionReceiptSchema.superRefine(
  (value, context) => {
    if (value.adapterId !== DIRECTORY_MATERIALIZER_ADAPTER_ID) {
      context.addIssue({ code: 'custom', path: ['adapterId'], message: 'Receipt is not directory evidence' });
    }
    if (value.mappingVersion !== DIRECTORY_MAPPING_VERSION) {
      context.addIssue({ code: 'custom', path: ['mappingVersion'], message: 'Unsupported directory mapping' });
    }
    if (
      value.excludedRoots.length !== 2 ||
      value.excludedRoots[0] !== 'resources' ||
      value.excludedRoots[1] !== 'scratchpads'
    ) {
      context.addIssue({ code: 'custom', path: ['excludedRoots'], message: 'Directory exclusions are incomplete' });
    }
  },
).transform(
  (value) =>
    Object.freeze({
      ...value,
      adapterId: DIRECTORY_MATERIALIZER_ADAPTER_ID,
      mappingVersion: DIRECTORY_MAPPING_VERSION,
      excludedRoots: Object.freeze(['resources', 'scratchpads'] as const),
    }) as IngestionReceipt,
);

/** Terminal result of one directory materialization attempt. */
export type DirectoryMaterializationRefusalReason = 'target-exists' | 'case-collision' | 'aborted';

/** Terminal result of one directory materialization attempt. */
export type DirectoryMaterializationResult =
  | Readonly<{
      /** Selects complete physical publication and transfers one owned view handle. */
      kind: 'materialized';
      /** Owns the exact physical realization and later ingestion entry point. */
      view: DirectoryMaterializedView;
    }>
  | Readonly<{
      /** Selects an expected attempt refusal with no published target view. */
      kind: 'refused';
      /** Names the exact expected condition that prevented publication. */
      reason: DirectoryMaterializationRefusalReason;
    }>
  | Readonly<{
      /** Selects an unexpected redacted implementation failure. */
      kind: 'failed';
      /** Carries bounded portable evidence instead of leaking native I/O text. */
      failure: PublicError;
    }>;

/** Expected conditions that prevent a directory scan from producing evidence. */
export type DirectoryIngestionRefusalReason =
  | 'view-closed'
  | 'base-mismatch'
  | 'stale-generation'
  | 'quiescence-mismatch'
  | 'unsupported-entry'
  | 'unstable-view'
  | 'aborted';

/** Terminal result of one complete directory ingestion attempt. */
export type DirectoryIngestionResult =
  | Readonly<{
      /** Selects complete immutable publication and verified evidence. */
      kind: 'ingested';
      /** Carries the only receipt eligible for later Workspace acceptance. */
      receipt: IngestionReceipt;
      /** Distinguishes original scanning from exact idempotent operation replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Selects an expected refusal that produced no receipt. */
      kind: 'refused';
      /** Names the exact view or quiescence precondition that failed. */
      reason: DirectoryIngestionRefusalReason;
    }>
  | Readonly<{
      /** Selects an unexpected redacted implementation failure. */
      kind: 'failed';
      /** Carries bounded portable evidence without private paths or native messages. */
      failure: PublicError;
    }>;

/** Retained materialization-operation release evidence. */
export type MaterializationOperationCloseEvidence = Readonly<{
  /** Distinguishes observation release from physical-view closure. */
  kind: 'materialization-operation-closed';
  /** Records the terminal result category without duplicating its data. */
  outcome: DirectoryMaterializationResult['kind'] | 'failed';
}>;

/** Retained ingestion-operation release evidence. */
export type IngestionOperationCloseEvidence = Readonly<{
  /** Distinguishes operation observation release from view closure. */
  kind: 'ingestion-operation-closed';
  /** Records the terminal result category without duplicating its data. */
  outcome: DirectoryIngestionResult['kind'] | 'failed';
}>;

/** Shared hot operation returned for one exact directory materialization attempt. */
export type DirectoryMaterializationOperation = LiveOperation<
  MaterializationEvent,
  DirectoryMaterializationResult,
  MaterializationOperationCloseEvidence
>;

/** Shared hot operation returned for one exact directory ingestion attempt. */
export type DirectoryIngestionOperation = LiveOperation<
  IngestionEvent,
  DirectoryIngestionResult,
  IngestionOperationCloseEvidence
>;

/** Result of current-authority and idempotency checks before materialization starts. */
export type MaterializationStartOutcome =
  | Readonly<{
      /** Selects one already-running or terminal hot attempt. */
      kind: 'started';
      /** Carries the shared operation for this exact idempotency identity. */
      operation: DirectoryMaterializationOperation;
      /** Distinguishes first construction from exact operation replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Reports Materializer closure or conflicting command identity. */
      kind: 'refused';
      /** Identifies the exact start rule that failed. */
      reason: 'materializer-closed' | 'idempotency-conflict';
    }>
  | Readonly<{
      /** Reports current Authority denial before any physical work starts. */
      kind: 'authority-refused';
      /** Preserves the exact current refusal evidence. */
      refusal: AuthorityRefusal<FilesMaterializeAction>;
    }>;

/** Result of view checks, Authority verification, and idempotency before scanning. */
export type IngestionStartOutcome =
  | Readonly<{
      /** Selects one already-running or terminal hot ingestion attempt. */
      kind: 'started';
      /** Carries the shared operation for this exact idempotency identity. */
      operation: DirectoryIngestionOperation;
      /** Distinguishes first construction from exact operation replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Reports view closure or conflicting command identity before scanning. */
      kind: 'refused';
      /** Identifies the exact start rule that failed. */
      reason: 'view-closed' | 'idempotency-conflict';
    }>
  | Readonly<{
      /** Reports current Authority denial before physical bytes are inspected. */
      kind: 'authority-refused';
      /** Preserves exact current refusal evidence. */
      refusal: AuthorityRefusal<FilesIngestAction>;
    }>;

/** Evidence returned when one physical directory view releases its path. */
export type DirectoryMaterializedViewCloseEvidence = Readonly<{
  /** Distinguishes physical-view release from ingestion or Workspace acceptance. */
  kind: 'directory-view-closed';
  /** Names the exact physical view that stopped accepting ingestion. */
  materializedViewId: MaterializedViewId;
  /** Records whether close preserved or removed the caller-selected root. */
  disposition: 'preserved' | 'removed';
  /** Records lifecycle completion through the Materializer clock. */
  closedAt: Timestamp;
}>;

/** One completed local directory realization with explicitly weak quiescence. */
export interface DirectoryMaterializedView extends OwnedHandle<DirectoryMaterializedViewCloseEvidence> {
  /** Discriminates the local directory guarantee and configuration surface. */
  readonly type: 'directory';
  /** Names this physical realization independently of its logical base. */
  readonly materializedViewId: MaterializedViewId;
  /** Names the adapter attachment responsible for this view. */
  readonly materializerId: MaterializerId;
  /** Pins adapter behavior to the first Materializer protocol. */
  readonly protocolVersion: typeof MATERIALIZER_PROTOCOL_VERSION;
  /** Pins physical layout and receipt evidence to one mapping revision. */
  readonly mappingVersion: typeof DIRECTORY_MAPPING_VERSION;
  /** Identifies the exact logical Workspace tree originally realized. */
  readonly base: TreeRef;
  /** Pins ingestion and quiescence to one acknowledged Workspace generation. */
  readonly generation: number;
  /** Exposes ordinary host paths so existing tools need no Archer filesystem SDK. */
  readonly paths: DirectoryViewPaths;
  /** Starts verified ingestion only after exact current Authority checks. */
  startIngestion(input: DirectoryIngestionInput, grant: GrantRef<FilesIngestAction>): Promise<IngestionStartOutcome>;
}

/** Evidence returned when one directory Materializer and its active views close. */
export type DirectoryMaterializerCloseEvidence = Readonly<{
  /** Distinguishes adapter release from physical view or operation release. */
  kind: 'directory-materializer-closed';
  /** Names the exact attachment that stopped accepting materialization. */
  materializerId: MaterializerId;
  /** Records lifecycle completion through the injected trusted clock. */
  closedAt: Timestamp;
}>;

/** First-party local directory Materializer with exact action-bound methods. */
export interface DirectoryMaterializer extends OwnedHandle<DirectoryMaterializerCloseEvidence> {
  /** Names the adapter attachment independently from its fixed product identity. */
  readonly materializerId: MaterializerId;
  /** Identifies the exact first-party adapter family in evidence. */
  readonly adapterId: typeof DIRECTORY_MATERIALIZER_ADAPTER_ID;
  /** Pins callers and conformance to the first Materializer protocol. */
  readonly protocolVersion: typeof MATERIALIZER_PROTOCOL_VERSION;
  /** Starts one authorized physical realization as a shared hot operation. */
  startMaterialization(
    input: DirectoryMaterializationInput,
    grant: GrantRef<FilesMaterializeAction>,
  ): Promise<MaterializationStartOutcome>;
}

/** Options required to construct one directory Materializer attachment. */
export type CreateDirectoryMaterializerOptions = Readonly<{
  /** Supplies stable adapter-attachment identity before any operation starts. */
  materializerId: MaterializerId;
  /** Attributes every protected operation to one admitted Principal. */
  subject: PrincipalId;
  /** Supplies immutable logical content and records explicit lifecycle ownership. */
  store: ComponentRef<FileStore>;
  /** Supplies current action verification and records explicit lifecycle ownership. */
  authority: ComponentRef<AuthorityBroker<DirectoryMaterializerAction>>;
  /** Supplies deterministic UUIDv4 identities for views, receipts, and hot attempts. */
  createId?: () => string;
  /** Supplies trusted lifecycle and receipt instants. */
  now?: () => Date;
  /** Receives best-effort wide spans without gaining control over file outcomes. */
  diagnostics?: Pick<DiagnosticHub, 'beginSpan'>;
}>;

/** Canonical runtime admission for cooperative quiescence acknowledgements. */
export const DirectoryCooperativeQuiescenceSchema: z.ZodType<DirectoryCooperativeQuiescence> = z
  .strictObject({
    type: z.literal('cooperative-directory'),
    materializedViewId: MaterializedViewIdSchema,
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    acknowledgedBy: z.string().trim().min(1).max(200),
    acknowledgedAt: TimestampSchema,
  })
  .transform((value) => Object.freeze(value));

/** Canonical runtime admission for exact ingestion commands. */
export const DirectoryIngestionInputSchema: z.ZodType<DirectoryIngestionInput> = z
  .strictObject({
    quiescence: DirectoryCooperativeQuiescenceSchema,
    expectedBase: TreeRefSchema,
    expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: IdempotencyKeySchema,
  })
  .transform((value) => Object.freeze(value));
