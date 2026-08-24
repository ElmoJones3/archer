/**
 * @file Owns pure Workspace mutation, quota, snapshot, and diff decisions.
 *
 * Storage, Authority, clocks, identity generation, streams, and diagnostics
 * remain in the retained runtime. This module receives every changing fact as
 * an argument and returns complete next values or exact refusals without I/O.
 */

import { createHash } from 'node:crypto';

import { CanonicalDecimalSchema, type Timestamp } from '@archer/core';

import { FileMode, type BlobRef, type FileMode as FileModeValue, type TreeRef } from '../encoding.js';
import { compareLogicalPaths, type LogicalPath } from '../path.js';
import type { ImmutableTree, TreeFileEntry } from '../store.js';
import type { ChangeSetId, WorkspaceSnapshotId } from '../work-values.js';
import {
  ChangeSetSchema,
  WorkspaceSnapshotSchema,
  type ChangeSet,
  type ChangeSetOperation,
  type WorkspaceHandleSnapshot,
  type WorkspaceAddPrecondition,
  type WorkspaceExistingPrecondition,
  type WorkspaceLifecycle,
  type WorkspaceMutationRefusalReason,
  type WorkspaceQuota,
  type WorkspaceQuotaState,
  type WorkspaceSnapshot,
} from './contracts.js';
import type { WorkspaceId, WorkspaceLineageId } from '../work-values.js';

/** Internal state needed to decide one Workspace transition. */
export type WorkspaceAggregate = Readonly<{
  /** Names the private owner independently of tree identity. */
  workspaceId: WorkspaceId;
  /** Prevents state substitution across unrelated private histories. */
  lineageId: WorkspaceLineageId;
  /** Retains the immutable starting tree and entries. */
  base: ImmutableTree;
  /** Retains the latest acknowledged immutable tree and entries. */
  head: ImmutableTree;
  /** Advances only after a complete next tree is published and accepted. */
  generation: number;
  /** Carries the latest transferable identity-bearing snapshot. */
  snapshot: WorkspaceSnapshot;
  /** Enforces logical file and byte limits at every transition. */
  quota: WorkspaceQuota;
}>;

/** Mutation form whose add or modify content already has pure immutable identity. */
export type PreparedWorkspaceMutation =
  | Readonly<{
      /** Selects addition of one absent path. */
      type: 'add';
      /** Names the absent logical destination. */
      path: LogicalPath;
      /** Identifies candidate content without asserting it has been stored. */
      blob: BlobRef;
      /** Carries the admitted portable mode. */
      mode: FileModeValue;
      /** Retains the caller's exact optimistic condition. */
      precondition: WorkspaceAddPrecondition;
    }>
  | Readonly<{
      /** Selects replacement of one existing path. */
      type: 'modify';
      /** Names the existing logical file. */
      path: LogicalPath;
      /** Identifies candidate replacement content without asserting storage. */
      blob: BlobRef;
      /** Replaces mode when supplied and otherwise preserves current mode. */
      mode?: FileModeValue;
      /** Retains the caller's exact optimistic condition. */
      precondition: WorkspaceExistingPrecondition;
    }>
  | Readonly<{
      /** Selects movement of one existing entry. */
      type: 'rename';
      /** Names the existing source. */
      from: LogicalPath;
      /** Names the absent destination. */
      to: LogicalPath;
      /** Retains the caller's exact optimistic condition. */
      precondition: WorkspaceExistingPrecondition;
    }>
  | Readonly<{
      /** Selects removal of one existing entry. */
      type: 'delete';
      /** Names the existing source. */
      path: LogicalPath;
      /** Retains the caller's exact optimistic condition. */
      precondition: WorkspaceExistingPrecondition;
    }>;

/** Complete pure plan that may be published without re-deriving domain rules. */
export type WorkspaceMutationPlan = Readonly<{
  /** Contains every resulting entry in canonical complete-path order. */
  entries: readonly TreeFileEntry[];
  /** Records the human-review projection forced by the transition. */
  operation: ChangeSetOperation;
  /** Distinguishes a legal no-op from a new lineage generation. */
  changed: boolean;
}>;

/** Pure planning settlement that keeps ordinary domain refusal out of Error-based Result. */
export type WorkspaceMutationPlanOutcome =
  | Readonly<{
      /** Selects a complete candidate that the retained runtime may publish. */
      ok: true;
      /** Carries all next entries and review evidence without performing I/O. */
      value: WorkspaceMutationPlan;
    }>
  | Readonly<{
      /** Selects an expected business-rule refusal rather than an exceptional Error. */
      ok: false;
      /** Names the exact rule that preserved current Workspace state. */
      reason: WorkspaceMutationRefusalReason;
    }>;

/**
 * Constructs one immutable accepted planning branch.
 * @param value - Complete pure mutation plan owned by the caller.
 * @returns Frozen success branch without borrowing Archer's Error-based Result.
 */
function acceptMutationPlan(value: WorkspaceMutationPlan): WorkspaceMutationPlanOutcome {
  return Object.freeze({ ok: true, value });
}

/**
 * Constructs one immutable expected-refusal planning branch.
 * @param reason - Exact business rule that prevented a candidate transition.
 * @returns Frozen refusal branch whose meaning is not exceptional failure.
 */
function refuseMutationPlan(reason: WorkspaceMutationRefusalReason): WorkspaceMutationPlanOutcome {
  return Object.freeze({ ok: false, reason });
}

/** Input required to construct one transferable acknowledged snapshot. */
export type CreateWorkspaceSnapshotInput = Readonly<{
  /** Supplies stable snapshot identity before persistence. */
  id: WorkspaceSnapshotId;
  /** Names the Workspace that earned the generation. */
  workspaceId: WorkspaceId;
  /** Names the uninterrupted private history. */
  lineageId: WorkspaceLineageId;
  /** Identifies the complete acknowledged logical content. */
  tree: TreeRef;
  /** Supplies the monotonic lineage generation. */
  generation: number;
  /** Supplies the trusted instant at which the snapshot was earned. */
  createdAt: Timestamp;
}>;

/** Input required to construct one immutable private ChangeSet. */
export type CreateChangeSetInput = Readonly<{
  /** Supplies stable proposal identity before event publication. */
  id: ChangeSetId;
  /** Supplies the current Workspace aggregate whose base and head are proposed. */
  aggregate: WorkspaceAggregate;
  /** Supplies the trusted instant at which proposal identity was created. */
  createdAt: Timestamp;
}>;

/**
 * Compares two raw content references without relying on object identity.
 * @param left - First immutable raw-content identity.
 * @param right - Second immutable raw-content identity.
 * @returns Whether digest and byte length match exactly.
 */
export function equalBlobRef(left: BlobRef, right: BlobRef): boolean {
  return left.digest === right.digest && left.byteLength === right.byteLength;
}

/**
 * Compares two immutable tree references without relying on object identity.
 * @param left - First immutable tree identity.
 * @param right - Second immutable tree identity.
 * @returns Whether format, digest, and encoded byte length match exactly.
 */
export function equalTreeRef(left: TreeRef, right: TreeRef): boolean {
  return left.format === right.format && left.digest === right.digest && left.byteLength === right.byteLength;
}

/**
 * Creates stable evidence over explicitly ordered snapshot fields.
 * @param input - Identity, lineage, tree, generation, and creation time.
 * @returns SHA-256 evidence independent of object property enumeration.
 */
function snapshotEvidence(input: CreateWorkspaceSnapshotInput): `sha256:${string}` {
  /** NUL separators prevent adjacent text fields from becoming ambiguous. */
  const canonical = [
    'archer-workspace-snapshot-v1',
    input.id,
    input.workspaceId,
    input.lineageId,
    input.tree.format,
    input.tree.digest,
    input.tree.byteLength,
    String(input.generation),
    input.createdAt,
  ].join('\0');
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Constructs one validated immutable Workspace generation.
 * @param input - Complete trusted identity and acknowledged lineage facts.
 * @returns Frozen snapshot with deterministic evidence.
 */
export function createWorkspaceSnapshot(input: CreateWorkspaceSnapshotInput): WorkspaceSnapshot {
  return WorkspaceSnapshotSchema.parse({
    id: input.id,
    object: 'workspace-snapshot',
    createdAt: input.createdAt,
    workspaceId: input.workspaceId,
    lineageId: input.lineageId,
    tree: input.tree,
    generation: input.generation,
    evidenceDigest: snapshotEvidence(input),
  });
}

/**
 * Computes enforceable Workspace usage from immutable entries.
 * @param entries - Complete canonical file set selected for one head.
 * @param limits - Immutable configured file and byte limits.
 * @returns Frozen current usage beside the exact limits that enforce it.
 */
export function workspaceQuotaState(entries: readonly TreeFileEntry[], limits: WorkspaceQuota): WorkspaceQuotaState {
  /** BigInt retains exact aggregate bytes beyond JavaScript's safe integer range. */
  const usedBytes = entries.reduce((total, entry) => total + BigInt(entry.blob.byteLength), 0n);
  return Object.freeze({
    limits,
    usedFiles: entries.length,
    usedBytes: CanonicalDecimalSchema.parse(usedBytes.toString(10)),
  });
}

/**
 * Reports whether one complete entry set fits its Workspace quota.
 * @param entries - Candidate complete canonical file set.
 * @param quota - Limits chosen when the Workspace opened.
 * @returns Whether neither file nor exact byte bounds are exceeded.
 */
export function workspaceEntriesFitQuota(entries: readonly TreeFileEntry[], quota: WorkspaceQuota): boolean {
  if (entries.length > quota.maxFiles) return false;
  /** Exact aggregate arithmetic avoids an overflow allowing oversized content. */
  const usedBytes = entries.reduce((total, entry) => total + BigInt(entry.blob.byteLength), 0n);
  return usedBytes <= BigInt(quota.maxBytes);
}

/**
 * Projects retained aggregate state into the bounded hot handle shape.
 * @param aggregate - Current acknowledged Workspace value.
 * @param lifecycle - Attachment activity that must not enter durable lineage.
 * @returns Frozen current projection suitable for callbacks and transports.
 */
export function projectWorkspaceHandle(
  aggregate: WorkspaceAggregate,
  lifecycle: WorkspaceLifecycle,
): WorkspaceHandleSnapshot {
  return Object.freeze({
    workspaceId: aggregate.workspaceId,
    lineageId: aggregate.lineageId,
    base: aggregate.base.ref,
    head: aggregate.head.ref,
    generation: aggregate.generation,
    quota: workspaceQuotaState(aggregate.head.files, aggregate.quota),
    lifecycle,
  });
}

/**
 * Finds one entry by canonical logical path.
 * @param entries - Canonically ordered immutable entry set.
 * @param path - Exact normalized logical path.
 * @returns Matching entry or absence without modifying the array.
 */
function findEntry(entries: readonly TreeFileEntry[], path: LogicalPath): TreeFileEntry | undefined {
  return entries.find((entry) => entry.path === path);
}

/**
 * Applies generation or blob preconditions to one current source entry.
 * @param aggregate - Current acknowledged aggregate.
 * @param entry - Current source entry when the operation requires one.
 * @param precondition - Caller-selected optimistic concurrency boundary.
 * @returns Exact refusal or successful proof with no state change.
 */
function proveExistingPrecondition(
  aggregate: WorkspaceAggregate,
  entry: TreeFileEntry | undefined,
  precondition: WorkspaceExistingPrecondition,
): WorkspaceMutationRefusalReason | undefined {
  if (entry === undefined) return 'path-not-found';
  if (precondition.kind === 'generation') {
    return precondition.generation === aggregate.generation ? undefined : 'stale-generation';
  }
  return equalBlobRef(precondition.blob, entry.blob) ? undefined : 'stale-blob';
}

/**
 * Freezes entries in canonical order after one pure edit.
 * @param entries - Fresh transition-owned file values.
 * @returns Frozen canonically ordered file collection.
 */
function canonicalEntries(entries: readonly TreeFileEntry[]): readonly TreeFileEntry[] {
  return Object.freeze([...entries].sort((left, right) => compareLogicalPaths(left.path, right.path)));
}

/**
 * Plans one Workspace mutation and every review fact it forces.
 * @param aggregate - Current acknowledged private lineage.
 * @param mutation - Admitted command with immutable content already identified.
 * @returns Complete candidate entries or exact refusal with no leaked change.
 */
export function planWorkspaceMutation(
  aggregate: WorkspaceAggregate,
  mutation: PreparedWorkspaceMutation,
): WorkspaceMutationPlanOutcome {
  /** Existing source path differs by operation but always comes from current head. */
  const sourcePath = mutation.type === 'rename' ? mutation.from : mutation.path;
  /** Current entry remains borrowed because every successful branch returns fresh values. */
  const existing = findEntry(aggregate.head.files, sourcePath);

  if (mutation.type === 'add') {
    if (mutation.precondition.kind === 'generation' && mutation.precondition.generation !== aggregate.generation) {
      return refuseMutationPlan('stale-generation');
    }
    if (existing !== undefined) return refuseMutationPlan('path-exists');
    /** New entry owns only immutable references and the admitted canonical path. */
    const added = Object.freeze({ path: mutation.path, blob: mutation.blob, mode: mutation.mode });
    /** Candidate remains separate until quota and storage publication succeed. */
    const entries = canonicalEntries([...aggregate.head.files, added]);
    if (!workspaceEntriesFitQuota(entries, aggregate.quota)) return refuseMutationPlan('quota-exceeded');
    return acceptMutationPlan(
      Object.freeze({
        entries,
        operation: Object.freeze({
          type: 'add',
          path: mutation.path,
          after: mutation.blob,
          afterMode: mutation.mode,
        }),
        changed: true,
      }),
    );
  }

  /** All remaining operations require an existing source and matching precondition. */
  const precondition = proveExistingPrecondition(aggregate, existing, mutation.precondition);
  if (precondition !== undefined) return refuseMutationPlan(precondition);
  /** Precondition proof guarantees source presence on all remaining branches. */
  const current = existing as TreeFileEntry;

  if (mutation.type === 'modify') {
    /** Omitted mode preserves prior executable intent. */
    const mode = mutation.mode ?? current.mode;
    /** Exact identical replacement is a legal idempotent no-op. */
    const changed = !equalBlobRef(current.blob, mutation.blob) || current.mode !== mode;
    /** Replaces only the selected entry and never mutates the current array. */
    const entries = changed
      ? canonicalEntries(
          aggregate.head.files.map((entry) =>
            entry.path === mutation.path ? Object.freeze({ path: entry.path, blob: mutation.blob, mode }) : entry,
          ),
        )
      : aggregate.head.files;
    if (!workspaceEntriesFitQuota(entries, aggregate.quota)) return refuseMutationPlan('quota-exceeded');
    return acceptMutationPlan(
      Object.freeze({
        entries,
        operation: Object.freeze({
          type: 'modify',
          path: mutation.path,
          before: current.blob,
          after: mutation.blob,
          beforeMode: current.mode,
          afterMode: mode,
        }),
        changed,
      }),
    );
  }

  if (mutation.type === 'rename') {
    if (mutation.from === mutation.to) {
      return acceptMutationPlan(
        Object.freeze({
          entries: aggregate.head.files,
          operation: Object.freeze({
            type: 'rename',
            from: mutation.from,
            to: mutation.to,
            blob: current.blob,
            mode: current.mode,
          }),
          changed: false,
        }),
      );
    }
    if (findEntry(aggregate.head.files, mutation.to) !== undefined) return refuseMutationPlan('path-exists');
    /** Rename replaces only logical path while preserving exact blob and mode. */
    const entries = canonicalEntries(
      aggregate.head.files.map((entry) =>
        entry.path === mutation.from ? Object.freeze({ path: mutation.to, blob: entry.blob, mode: entry.mode }) : entry,
      ),
    );
    return acceptMutationPlan(
      Object.freeze({
        entries,
        operation: Object.freeze({
          type: 'rename',
          from: mutation.from,
          to: mutation.to,
          blob: current.blob,
          mode: current.mode,
        }),
        changed: true,
      }),
    );
  }

  /** Delete removes the exact proven source while retaining every sibling. */
  const entries = canonicalEntries(aggregate.head.files.filter((entry) => entry.path !== mutation.path));
  return acceptMutationPlan(
    Object.freeze({
      entries,
      operation: Object.freeze({
        type: 'delete',
        path: mutation.path,
        before: current.blob,
        beforeMode: current.mode,
      }),
      changed: true,
    }),
  );
}

/**
 * Derives deterministic human-review operations from exact trees.
 * @param base - Immutable starting content.
 * @param result - Immutable private result content.
 * @returns Frozen additions, modifications, and deletions in logical path order.
 */
export function diffWorkspaceTrees(base: ImmutableTree, result: ImmutableTree): readonly ChangeSetOperation[] {
  /** Maps exact base paths without changing canonical source order. */
  const before = new Map(base.files.map((entry) => [entry.path, entry]));
  /** Maps exact result paths for symmetric comparison. */
  const after = new Map(result.files.map((entry) => [entry.path, entry]));
  /** Union sorting makes output independent of map insertion order. */
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareLogicalPaths);
  /** Accumulates only logical differences; equal entries produce no operation. */
  const operations: ChangeSetOperation[] = [];
  /** Every path in either tree contributes at most one review operation. */
  for (const path of paths) {
    /** Reads the exact base entry for this canonical path. */
    const prior = before.get(path);
    /** Reads the exact result entry for this canonical path. */
    const next = after.get(path);
    if (prior === undefined && next !== undefined) {
      operations.push(Object.freeze({ type: 'add', path, after: next.blob, afterMode: next.mode }));
      continue;
    }
    if (prior !== undefined && next === undefined) {
      operations.push(Object.freeze({ type: 'delete', path, before: prior.blob, beforeMode: prior.mode }));
      continue;
    }
    if (
      prior !== undefined &&
      next !== undefined &&
      (!equalBlobRef(prior.blob, next.blob) || prior.mode !== next.mode)
    ) {
      operations.push(
        Object.freeze({
          type: 'modify',
          path,
          before: prior.blob,
          after: next.blob,
          beforeMode: prior.mode,
          afterMode: next.mode,
        }),
      );
    }
  }
  return Object.freeze(operations);
}

/**
 * Encodes one operation through an explicit field order for ChangeSet evidence.
 * @param operation - Review operation already derived from immutable trees.
 * @returns Stable NUL-delimited text independent of object enumeration order.
 */
function operationEvidence(operation: ChangeSetOperation): string {
  switch (operation.type) {
    case 'add':
      return [
        'add',
        operation.path,
        operation.after.digest,
        operation.after.byteLength,
        String(operation.afterMode),
      ].join('\0');
    case 'modify':
      return [
        'modify',
        operation.path,
        operation.before.digest,
        operation.before.byteLength,
        operation.after.digest,
        operation.after.byteLength,
        String(operation.beforeMode),
        String(operation.afterMode),
      ].join('\0');
    case 'rename':
      return [
        'rename',
        operation.from,
        operation.to,
        operation.blob.digest,
        operation.blob.byteLength,
        String(operation.mode),
      ].join('\0');
    case 'delete':
      return [
        'delete',
        operation.path,
        operation.before.digest,
        operation.before.byteLength,
        String(operation.beforeMode),
      ].join('\0');
  }
}

/**
 * Constructs one validated immutable private proposal from current lineage.
 * @param input - Proposal identity, trusted creation time, and acknowledged aggregate.
 * @returns ChangeSet whose base and result remain authoritative over its review list.
 */
export function createChangeSetValue(input: CreateChangeSetInput): ChangeSet {
  /** Deterministic review projection never infers rename intent from equal blobs. */
  const operations = diffWorkspaceTrees(input.aggregate.base, input.aggregate.head);
  /** Explicit field order binds evidence without adopting JSON as a protocol. */
  const canonical = [
    'archer-change-set-v1',
    input.id,
    input.aggregate.workspaceId,
    input.aggregate.lineageId,
    input.aggregate.base.ref.digest,
    input.aggregate.base.ref.byteLength,
    input.aggregate.head.ref.digest,
    input.aggregate.head.ref.byteLength,
    String(input.aggregate.generation),
    input.createdAt,
    ...operations.map(operationEvidence),
  ].join('\0');
  /** SHA-256 evidence binds review metadata without becoming promotion authority. */
  const evidenceDigest = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
  return ChangeSetSchema.parse({
    id: input.id,
    object: 'change-set',
    createdAt: input.createdAt,
    workspaceId: input.aggregate.workspaceId,
    lineageId: input.aggregate.lineageId,
    base: input.aggregate.base.ref,
    result: input.aggregate.head.ref,
    generation: input.aggregate.generation,
    operations,
    evidenceDigest,
  });
}

/**
 * Advances acknowledged lineage only after a complete immutable tree exists.
 * @param aggregate - Current Workspace value that remains untouched.
 * @param head - Newly published complete immutable tree.
 * @param snapshotId - Stable identity allocated before settlement.
 * @param createdAt - Trusted settlement instant.
 * @returns Fresh aggregate with one new generation and snapshot.
 */
export function advanceWorkspace(
  aggregate: WorkspaceAggregate,
  head: ImmutableTree,
  snapshotId: WorkspaceSnapshotId,
  createdAt: Timestamp,
): WorkspaceAggregate {
  /** Safe-integer guard prevents silent generation precision loss. */
  if (aggregate.generation >= Number.MAX_SAFE_INTEGER) throw new RangeError('Workspace generation exhausted');
  /** Next generation is derived once and shared by aggregate and snapshot. */
  const generation = aggregate.generation + 1;
  /** Snapshot construction validates the complete earned state. */
  const snapshot = createWorkspaceSnapshot({
    id: snapshotId,
    workspaceId: aggregate.workspaceId,
    lineageId: aggregate.lineageId,
    tree: head.ref,
    generation,
    createdAt,
  });
  return Object.freeze({ ...aggregate, head, generation, snapshot });
}

/** Portable readable mode used when add commands omit explicit intent. */
export const DEFAULT_WORKSPACE_FILE_MODE = FileMode.readable;
