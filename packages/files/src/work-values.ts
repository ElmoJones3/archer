/**
 * @file Defines UUIDv4 identities shared by Archer's private-work contracts.
 *
 * The brands prevent a Workspace, Scratchpad, materialized view, receipt, or
 * ChangeSet identity from crossing into another owner merely because every
 * value uses the same UUID representation at runtime.
 */

import { UuidV4Schema, type UuidV4 } from '@archer/core';

/** Prevents an ordinary UUIDv4 from naming a Workspace. */
declare const workspaceIdBrand: unique symbol;

/** Identifies one private mutable Workspace. */
export type WorkspaceId = UuidV4 & {
  /** Carries compile-time evidence of Workspace identity admission. */
  readonly [workspaceIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming Workspace lineage. */
declare const workspaceLineageIdBrand: unique symbol;

/** Identifies the uninterrupted private history shared by Workspace snapshots. */
export type WorkspaceLineageId = UuidV4 & {
  /** Carries compile-time evidence of Workspace-lineage identity admission. */
  readonly [workspaceLineageIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming a Workspace snapshot. */
declare const workspaceSnapshotIdBrand: unique symbol;

/** Identifies one acknowledged immutable Workspace generation. */
export type WorkspaceSnapshotId = UuidV4 & {
  /** Carries compile-time evidence of Workspace-snapshot identity admission. */
  readonly [workspaceSnapshotIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming a ChangeSet. */
declare const changeSetIdBrand: unique symbol;

/** Identifies one immutable proposal derived from private Workspace lineage. */
export type ChangeSetId = UuidV4 & {
  /** Carries compile-time evidence of ChangeSet identity admission. */
  readonly [changeSetIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming a Scratchpad. */
declare const scratchpadIdBrand: unique symbol;

/** Identifies one private mutable Scratchpad. */
export type ScratchpadId = UuidV4 & {
  /** Carries compile-time evidence of Scratchpad identity admission. */
  readonly [scratchpadIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming a Scratchpad checkpoint. */
declare const scratchpadCheckpointIdBrand: unique symbol;

/** Identifies one retained Scratchpad checkpoint fact. */
export type ScratchpadCheckpointId = UuidV4 & {
  /** Carries compile-time evidence of Scratchpad-checkpoint identity admission. */
  readonly [scratchpadCheckpointIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming a materialized view. */
declare const materializedViewIdBrand: unique symbol;

/** Prevents an ordinary UUIDv4 from naming a Materializer attachment. */
declare const materializerIdBrand: unique symbol;

/** Identifies one logical-to-physical adapter attachment. */
export type MaterializerId = UuidV4 & {
  /** Carries compile-time evidence of Materializer identity admission. */
  readonly [materializerIdBrand]: true;
};

/** Identifies one physical realization of exact logical file inputs. */
export type MaterializedViewId = UuidV4 & {
  /** Carries compile-time evidence of materialized-view identity admission. */
  readonly [materializedViewIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming an ingestion receipt. */
declare const ingestionReceiptIdBrand: unique symbol;

/** Identifies evidence produced by one complete physical-view ingestion. */
export type IngestionReceiptId = UuidV4 & {
  /** Carries compile-time evidence of ingestion-receipt identity admission. */
  readonly [ingestionReceiptIdBrand]: true;
};

/** Canonical runtime admission for Workspace UUIDv4 identities. */
export const WorkspaceIdSchema = UuidV4Schema.transform((value) => value as WorkspaceId);

/** Canonical runtime admission for Workspace-lineage UUIDv4 identities. */
export const WorkspaceLineageIdSchema = UuidV4Schema.transform((value) => value as WorkspaceLineageId);

/** Canonical runtime admission for Workspace-snapshot UUIDv4 identities. */
export const WorkspaceSnapshotIdSchema = UuidV4Schema.transform((value) => value as WorkspaceSnapshotId);

/** Canonical runtime admission for ChangeSet UUIDv4 identities. */
export const ChangeSetIdSchema = UuidV4Schema.transform((value) => value as ChangeSetId);

/** Canonical runtime admission for Scratchpad UUIDv4 identities. */
export const ScratchpadIdSchema = UuidV4Schema.transform((value) => value as ScratchpadId);

/** Canonical runtime admission for Scratchpad-checkpoint UUIDv4 identities. */
export const ScratchpadCheckpointIdSchema = UuidV4Schema.transform((value) => value as ScratchpadCheckpointId);

/** Canonical runtime admission for materialized-view UUIDv4 identities. */
export const MaterializedViewIdSchema = UuidV4Schema.transform((value) => value as MaterializedViewId);

/** Canonical runtime admission for Materializer UUIDv4 identities. */
export const MaterializerIdSchema = UuidV4Schema.transform((value) => value as MaterializerId);

/** Canonical runtime admission for ingestion-receipt UUIDv4 identities. */
export const IngestionReceiptIdSchema = UuidV4Schema.transform((value) => value as IngestionReceiptId);
