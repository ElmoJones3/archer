/**
 * @file Implements Archer's cooperative local-directory Materializer reference.
 *
 * The adapter writes ordinary host paths for existing tools, keeps Resources and
 * Scratchpads outside the Workspace ingestion root, and rebuilds immutable
 * identity only after a caller explicitly acknowledges cooperative quiescence.
 */

import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  CanonicalDecimalSchema,
  IdempotencyKeySchema,
  Result,
  TimestampSchema,
  UuidV4Schema,
  toPublicError,
  type DiagnosticHub,
  type DiagnosticSpan,
  type DiagnosticSpanAttributes,
  type JsonObject,
  type PublicError,
  type Result as ResultValue,
} from '@archer/core';
import { PrincipalIdSchema, type GrantRef } from '@archer/core/authority';
import { createLiveOperation, type OperationSettlement } from '@archer/core/stream';

import { FileMode, TreeRefSchema, type FileMode as FileModeValue, type TreeRef } from '../encoding.js';
import { FilesError } from '../errors.js';
import { physicalIngestionReceiptEvidence } from '../ingestion.js';
import { LogicalPathSchema, compareLogicalPaths, type LogicalPath } from '../path.js';
import { publishTree, restoreTree, type FileStore, type ImmutableTree, type TreeFileSource } from '../store.js';
import {
  IngestionReceiptIdSchema,
  MaterializedViewIdSchema,
  MaterializerIdSchema,
  ScratchpadIdSchema,
  type MaterializerId,
} from '../work-values.js';
import {
  DIRECTORY_MAPPING_VERSION,
  DIRECTORY_MATERIALIZER_ADAPTER_ID,
  MATERIALIZER_PROTOCOL_VERSION,
  DirectoryCooperativeQuiescenceSchema,
  DirectoryIngestionInputSchema,
  IngestionReceiptSchema,
  type CreateDirectoryMaterializerOptions,
  type DirectoryIngestionResult,
  type DirectoryIngestionOperation,
  type DirectoryIngestionRefusalReason,
  type DirectoryIngestionInput,
  type DirectoryMaterializationInput,
  type DirectoryMaterializationOperation,
  type DirectoryMaterializationRefusalReason,
  type DirectoryMaterializationResult,
  type DirectoryMaterializedView,
  type DirectoryMaterializedViewCloseEvidence,
  type DirectoryMaterializer,
  type DirectoryMaterializerCloseEvidence,
  type DirectoryViewPaths,
  type FilesIngestAction,
  type FilesMaterializeAction,
  type IngestionEvent,
  type IngestionOperationCloseEvidence,
  type IngestionStartOutcome,
  type MaterializationEvent,
  type MaterializationOperationCloseEvidence,
  type MaterializationStartOutcome,
  type ReadonlyTreeMount,
  type ScratchpadMount,
} from './contracts.js';

/** UTF-8 byte accounting binds progress encoding to one documented projection. */
const TEXT_ENCODER = new TextEncoder();

/** Fixed physical child containing only Workspace bytes eligible for ingestion. */
const WORKSPACE_DIRECTORY = 'workspace';

/** Fixed physical child containing immutable Resource mounts excluded from ingestion. */
const RESOURCES_DIRECTORY = 'resources';

/** Fixed physical child containing private Scratchpads excluded from ingestion. */
const SCRATCHPADS_DIRECTORY = 'scratchpads';

/** Local refusal used internally to preserve expected materialization outcomes. */
class MaterializationRefusal extends Error {
  /** Exact public refusal category selected by the failed precondition. */
  readonly reason: DirectoryMaterializationRefusalReason;

  /**
   * Constructs one process-local control-flow refusal.
   * @param reason - Stable public reason returned without native path details.
   */
  constructor(reason: DirectoryMaterializationRefusalReason) {
    super(reason);
    this.name = 'MaterializationRefusal';
    this.reason = reason;
  }
}

/** Local refusal used internally to preserve expected ingestion outcomes. */
class IngestionRefusal extends Error {
  /** Exact public refusal category selected by the failed verification rule. */
  readonly reason: DirectoryIngestionRefusalReason;

  /**
   * Constructs one process-local control-flow refusal.
   * @param reason - Stable public reason returned without native path details.
   */
  constructor(reason: DirectoryIngestionRefusalReason) {
    super(reason);
    this.name = 'IngestionRefusal';
    this.reason = reason;
  }
}

/** Complete admitted mount whose logical path cannot traverse its fixed root. */
type AdmittedReadonlyTreeMount = Omit<ReadonlyTreeMount, 'mountPath'> &
  Readonly<{
    /** Retains the mount below the fixed Resource root after traversal-safe admission. */
    mountPath: LogicalPath;
  }>;

/** Complete admitted Scratchpad mount whose identity and path are normalized. */
type AdmittedScratchpadMount = Omit<ScratchpadMount, 'mountPath'> &
  Readonly<{
    /** Retains the mount below the fixed Scratchpad root after traversal-safe admission. */
    mountPath: LogicalPath;
  }>;

/** Complete copied materialization command safe to retain for idempotency. */
type AdmittedMaterializationInput = Omit<DirectoryMaterializationInput, 'resources' | 'scratchpads'> &
  Readonly<{
    /** Owns normalized Resource mounts in canonical mount-path order. */
    resources: readonly AdmittedReadonlyTreeMount[];
    /** Owns normalized Scratchpad mounts in canonical mount-path order. */
    scratchpads: readonly AdmittedScratchpadMount[];
  }>;

/** Retains one start command fingerprint with its exact hot operation identity. */
type MaterializationReplay = Readonly<{
  /** Detects conflicting semantic input under one idempotency key. */
  fingerprint: string;
  /** Reuses the already-running or terminal finite attempt. */
  operation: DirectoryMaterializationOperation;
}>;

/** Retains one ingestion command fingerprint with its exact hot operation identity. */
type IngestionReplay = Readonly<{
  /** Detects conflicting semantic input under one idempotency key. */
  fingerprint: string;
  /** Reuses the already-running or terminal finite attempt. */
  operation: DirectoryIngestionOperation;
}>;

/** Minimum bounded structure shared by both directory progress protocols. */
type DirectoryProgressEvent = Readonly<{
  /** Selects the adapter-defined coarse operation phase. */
  phase: string;
  /** Counts regular files fully handled before the event was emitted. */
  filesCompleted: number;
}>;

/** Immutable physical file signature used to detect non-cooperative changes. */
type PhysicalFileSignature = Readonly<{
  /** Retains exact byte length observed before source publication. */
  size: bigint;
  /** Retains nanosecond modification time when the platform exposes it. */
  modified: bigint;
  /** Retains device identity to expose replacement across mounted filesystems. */
  device: bigint;
  /** Retains inode identity to expose path replacement during verification. */
  inode: bigint;
  /** Retains the admitted portable executable projection. */
  mode: FileModeValue;
}>;

/** One scanned file source paired with pre-publication physical evidence. */
type ScannedWorkspace = Readonly<{
  /** Contains streaming sources in canonical logical path order. */
  sources: readonly TreeFileSource[];
  /** Retains pre-publication signatures by normalized logical path. */
  signatures: ReadonlyMap<LogicalPath, PhysicalFileSignature>;
}>;

/** One admitted Resource mount paired with its fully verified immutable tree. */
type RestoredReadonlyTreeMount = Readonly<{
  /** Preserves normalized placement and logical identity for physical realization. */
  mount: AdmittedReadonlyTreeMount;
  /** Contains the complete immutable entries restored from the mounted tree reference. */
  tree: ImmutableTree;
}>;

/** One admitted Scratchpad mount paired with its fully verified immutable tree. */
type RestoredScratchpadMount = Readonly<{
  /** Preserves Scratchpad identity, retention, and normalized physical placement. */
  mount: AdmittedScratchpadMount;
  /** Contains the complete immutable entries restored from the mounted tree reference. */
  tree: ImmutableTree;
}>;

/** Complete verified logical inputs ready for physical realization. */
type RestoredMaterializationInputs = Readonly<{
  /** Supplies the writable Workspace tree placed under the ingestion root. */
  workspace: ImmutableTree;
  /** Supplies immutable Resource trees placed under their read-only root. */
  resources: readonly RestoredReadonlyTreeMount[];
  /** Supplies private Scratchpad trees placed outside Workspace ingestion. */
  scratchpads: readonly RestoredScratchpadMount[];
}>;

/**
 * Reports whether a native failure carries one exact Node error code.
 * @param error - Unknown implementation failure caught at an I/O boundary.
 * @param code - Stable Node error code being selected.
 * @returns Whether the value is an Error-like object with that code.
 */
function hasNodeCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

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
 * Normalizes one trusted clock read into Archer's canonical timestamp.
 * @param now - Injected or system clock capability.
 * @returns Canonical immutable UTC text.
 */
function timestamp(now: () => Date) {
  return TimestampSchema.parse(now().toISOString());
}

/**
 * Compares immutable tree identities without trusting object identity.
 * @param left - First exact logical tree reference.
 * @param right - Second exact logical tree reference.
 * @returns Whether format, digest, and encoded byte length match.
 */
function equalTree(left: TreeRef, right: TreeRef): boolean {
  return left.format === right.format && left.digest === right.digest && left.byteLength === right.byteLength;
}

/**
 * Converts arbitrary values into deterministic SHA-256 idempotency identity.
 * @param value - Explicitly ordered JSON-safe semantic command projection.
 * @returns Lowercase SHA-256 hex without retaining host paths in replay maps.
 */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Creates one bounded public failure without native messages or physical paths.
 * @param error - Local cause retained only through Error identity and stack.
 * @param code - Stable adapter-owned category.
 * @param message - Archer-authored bounded explanation.
 * @returns Portable redacted failure for a tagged operation result.
 */
function directoryFailure(error: unknown, code: string, message: string): PublicError {
  return toPublicError(error, { code, message });
}

/**
 * Progress encoding shared by materialization and ingestion finite operations.
 * @param revision - Stable public encoding revision for subscriber accounting.
 * @returns Immutable normalization and byte-measurement functions for one progress protocol.
 */
function progressEncoding<Event extends DirectoryProgressEvent>(revision: string) {
  return Object.freeze({
    revision,
    /**
     * Copies one bounded progress value before transient fan-out.
     * @param event - Adapter-owned current phase and complete-file count.
     * @returns Frozen progress value independent from caller mutation.
     */
    normalize(event: Event): Event {
      return Object.freeze({ ...event }) as Event;
    },
    /**
     * Measures the exact JSON projection used by this local protocol revision.
     * @param event - Normalized bounded progress value.
     * @returns UTF-8 bytes charged to each independent subscriber.
     */
    measure(event: Event): number {
      return TEXT_ENCODER.encode(JSON.stringify(event)).byteLength;
    },
  });
}

/** Materialization progress codec retained by every local attempt. */
const MATERIALIZATION_PROGRESS = progressEncoding<MaterializationEvent>('archer-directory-materialization/1');

/** Ingestion progress codec retained by every local attempt. */
const INGESTION_PROGRESS = progressEncoding<IngestionEvent>('archer-directory-ingestion/1');

/**
 * Begins a best-effort wide span without physical paths or file names.
 * @param diagnostics - Optional borrowed diagnostic capability.
 * @param name - Stable operation name.
 * @param materializerId - Safe adapter correlation identity.
 * @param attributes - Bounded context accumulated before terminal settlement.
 * @returns Open span or absence when diagnostics are unavailable or defective.
 */
function beginSpan(
  diagnostics: Pick<DiagnosticHub, 'beginSpan'> | undefined,
  name: string,
  materializerId: MaterializerId,
  attributes: DiagnosticSpanAttributes,
): DiagnosticSpan | undefined {
  try {
    return diagnostics?.beginSpan({
      name,
      component: 'files.materializer.directory',
      correlation: {},
      attributes: {
        ...attributes,
        materializer: { ...(attributes.materializer ?? {}), materializerId },
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * Completes a best-effort wide span without changing a file-domain result.
 * @param span - Optional open diagnostic span.
 * @param outcome - Stable terminal result discriminator.
 * @param attributes - Bounded terminal facts accumulated by the operation.
 */
function completeSpan(span: DiagnosticSpan | undefined, outcome: string, attributes: JsonObject): void {
  if (span === undefined) return;
  try {
    span.enrich('materializer.result', attributes);
    span.complete({ outcome });
  } catch {
    // Diagnostics have no authority over logical identity or physical cleanup.
  }
}

/**
 * Admits one mount list, rejects collisions, and owns canonical order.
 * @param mounts - Caller-owned mount records under one fixed physical root.
 * @param kind - Selects Resource or Scratchpad identity validation.
 * @returns Frozen normalized mounts with no path ancestry collisions.
 */
function admitMounts(
  mounts: readonly ReadonlyTreeMount[] | readonly ScratchpadMount[],
  kind: 'resource' | 'scratchpad',
): readonly AdmittedReadonlyTreeMount[] | readonly AdmittedScratchpadMount[] {
  /** Normalizes all path and tree values before collision evaluation. */
  const admitted = mounts.map((mount) => {
    /** A mount path is a logical subtree, never a host path fragment. */
    const mountPath = LogicalPathSchema.parse(mount.mountPath);
    /** Every mounted tree is re-admitted at the JavaScript boundary. */
    const tree = TreeRefSchema.parse(mount.tree);
    if (kind === 'resource') return Object.freeze({ mountPath, tree });
    /** Scratchpad identity and retention remain visible outside its physical tree. */
    const scratchpad = mount as ScratchpadMount;
    return Object.freeze({
      scratchpadId: ScratchpadIdSchema.parse(scratchpad.scratchpadId),
      mountPath,
      tree,
      retention: scratchpad.retention,
    });
  });
  /** Canonical order makes fingerprints and physical construction deterministic. */
  admitted.sort((left, right) => compareLogicalPaths(left.mountPath, right.mountPath));
  /** Adjacent canonical mounts are sufficient to detect duplicate or ancestral overlap. */
  for (let index = 1; index < admitted.length; index += 1) {
    /** Previous canonical mount is the only possible ancestor or duplicate. */
    const previous = admitted[index - 1];
    /** Current canonical mount cannot share or descend from another mount point. */
    const current = admitted[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (current.mountPath === previous.mountPath || current.mountPath.startsWith(`${previous.mountPath}/`))
    ) {
      throw new FilesError('files_path_conflict', 'Materializer mount paths must not overlap');
    }
  }
  return Object.freeze(admitted);
}

/**
 * Admits and copies one complete materialization command.
 * @param input - Caller-owned logical inputs, target, and idempotency identity.
 * @returns Frozen normalized input safe for asynchronous activation.
 */
function admitMaterializationInput(input: DirectoryMaterializationInput): AdmittedMaterializationInput {
  if (input.target.type !== 'directory') {
    throw new FilesError('files_invalid_input', 'Directory Materializer requires a directory target');
  }
  if (!isAbsolute(input.target.rootPath) || resolve(input.target.rootPath) === sep) {
    throw new FilesError('files_invalid_input', 'Directory target must be a non-root absolute path');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new FilesError('files_invalid_input', 'Workspace generation must be a non-negative safe integer');
  }
  /** Absolute normalization prevents alternate spellings from changing idempotency identity. */
  const rootPath = resolve(input.target.rootPath);
  /** Target discriminator choices are checked independently from TypeScript. */
  if (input.target.caseSensitivity !== 'sensitive' && input.target.caseSensitivity !== 'insensitive') {
    throw new FilesError('files_invalid_input', 'Directory target requires an explicit case-sensitivity mode');
  }
  if (input.target.cleanup !== 'remove' && input.target.cleanup !== 'preserve') {
    throw new FilesError('files_invalid_input', 'Directory target requires an explicit cleanup policy');
  }
  return Object.freeze({
    workspace: TreeRefSchema.parse(input.workspace),
    generation: input.generation,
    resources: admitMounts(input.resources, 'resource') as readonly AdmittedReadonlyTreeMount[],
    scratchpads: admitMounts(input.scratchpads, 'scratchpad') as readonly AdmittedScratchpadMount[],
    target: Object.freeze({
      type: 'directory' as const,
      rootPath,
      caseSensitivity: input.target.caseSensitivity,
      cleanup: input.target.cleanup,
    }),
    idempotencyKey: IdempotencyKeySchema.parse(input.idempotencyKey),
  });
}

/**
 * Produces one redaction-safe identity for a complete materialization command.
 * @param input - Admitted copied command excluding its idempotency key.
 * @returns SHA-256 identity that does not retain the host target path.
 */
function materializationFingerprint(input: AdmittedMaterializationInput): `sha256:${string}` {
  return `sha256:${fingerprint({
    workspace: input.workspace,
    generation: input.generation,
    resources: input.resources,
    scratchpads: input.scratchpads,
    target: input.target,
  })}`;
}

/**
 * Computes the exact attenuation identity used by directory materialization Authority.
 * @param input - Complete logical inputs, mounts, target, and ignored idempotency identity.
 * @returns SHA-256 digest over the normalized semantic input excluding its command key.
 */
export function directoryMaterializationInputDigest(input: DirectoryMaterializationInput): `sha256:${string}` {
  return materializationFingerprint(admitMaterializationInput(input));
}

/**
 * Tests whether one physical path exists without swallowing unrelated I/O failure.
 * @param path - Absolute caller-selected or adapter-owned physical path.
 * @returns Whether lstat found an entry of any supported or unsupported kind.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasNodeCode(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Throws the expected abort refusal at deterministic operation boundaries.
 * @param signal - Finite operation signal owned by core.
 * @param family - Selects the public refusal vocabulary.
 */
function proveNotAborted(signal: AbortSignal, family: 'materialization' | 'ingestion'): void {
  if (!signal.aborted) return;
  if (family === 'materialization') throw new MaterializationRefusal('aborted');
  throw new IngestionRefusal('aborted');
}

/**
 * Rejects case-fold collisions before touching an insensitive target.
 * @param trees - Complete restored logical trees sharing one physical namespace.
 */
function proveNoCaseCollisions(trees: readonly ImmutableTree[]): void {
  /** Each tree occupies an independent fixed or mount root, so checks are tree-local. */
  for (const tree of trees) {
    /** Folded path map preserves the first canonical spelling for comparison. */
    const folded = new Map<string, LogicalPath>();
    /** Every immutable entry must retain a unique spelling under target folding. */
    for (const entry of tree.files) {
      /** NFC paths are already canonical; lowercase approximates target collision semantics. */
      const key = entry.path.toLowerCase();
      /** An existing different spelling proves the target cannot represent both entries. */
      const prior = folded.get(key);
      if (prior !== undefined && prior !== entry.path) throw new MaterializationRefusal('case-collision');
      folded.set(key, entry.path);
    }
  }
}

/**
 * Writes one verified immutable tree below an adapter-owned empty directory.
 * @param store - Borrowed immutable source store.
 * @param tree - Restored complete tree whose blob reads verify terminal identity.
 * @param target - Empty or absent directory inside the staging root.
 * @param readOnly - Whether portable modes should remove write bits physically.
 * @param signal - Finite attempt abort signal checked between chunks and files.
 * @returns Number of regular files completely written.
 */
async function writeTree(
  store: FileStore,
  tree: ImmutableTree,
  target: string,
  readOnly: boolean,
  signal: AbortSignal,
): Promise<number> {
  await mkdir(target, { recursive: true, mode: 0o755 });
  /** Directory set is hardened bottom-up only after every child exists. */
  const directories = new Set<string>([target]);
  /** Canonical tree order determines physical write order and failure position. */
  for (const entry of tree.files) {
    proveNotAborted(signal, 'materialization');
    /** Logical validation guarantees segments cannot escape this target. */
    const physical = join(target, ...entry.path.split('/'));
    /** Parent creation occurs only inside the unique staging directory. */
    const parent = dirname(physical);
    await mkdir(parent, { recursive: true, mode: 0o755 });
    /** Every ancestor is remembered so read-only Resources can harden directories. */
    let current = parent;
    while (current.startsWith(target) && current !== dirname(current)) {
      directories.add(current);
      if (current === target) break;
      current = dirname(current);
    }
    /** Blob read proves immutable source identity at terminal iteration. */
    const read = await store.blobs.read(entry.blob);
    if (!read.ok) throw read.error;
    /** Exclusive create prevents one logical entry from replacing another. */
    const file = await open(physical, 'wx', 0o600);
    try {
      /** Immutable blob chunks are copied without assembling a whole file in memory. */
      for await (const chunk of read.value.content) {
        proveNotAborted(signal, 'materialization');
        /** FileHandle writes may settle a strict prefix, so advance until this chunk is complete. */
        let offset = 0;
        while (offset < chunk.byteLength) {
          /** One native write reports the exact prefix committed during this iteration. */
          const written = await file.write(chunk, offset, chunk.byteLength - offset, null);
          if (written.bytesWritten === 0) throw new FilesError('files_io_failed', 'Directory write made no progress');
          offset += written.bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    /** Physical modes preserve only portable readability and executable intent. */
    const mode = readOnly ? (entry.mode === FileMode.executable ? 0o555 : 0o444) : entry.mode;
    await chmod(physical, mode);
  }
  if (readOnly) {
    /** Deepest-first hardening makes the completed Resource tree non-writable by mode. */
    const ordered = [...directories].sort((left, right) => right.length - left.length);
    /** Each completed directory loses write permission only after its children settle. */
    for (const directory of ordered) await chmod(directory, 0o555);
  }
  return tree.files.length;
}

/**
 * Restores every input tree before any target filesystem mutation begins.
 * @param store - Immutable source store borrowed by the Materializer.
 * @param input - Admitted Workspace, Resource, and Scratchpad tree identities.
 * @returns Complete verified trees grouped in input order.
 */
async function restoreInputs(
  store: FileStore,
  input: AdmittedMaterializationInput,
): Promise<RestoredMaterializationInputs> {
  /** Workspace restoration proves the exact base before any physical write begins. */
  const workspace = await restoreTree(store, input.workspace);
  if (!workspace.ok) throw workspace.error;
  /** Resource restoration remains sequential to keep failure order deterministic. */
  const resources: RestoredReadonlyTreeMount[] = [];
  /** Every Resource tree must restore before any physical side effect begins. */
  for (const mount of input.resources) {
    /** Each mount is verified independently before entering the retained input set. */
    const restored = await restoreTree(store, mount.tree);
    if (!restored.ok) throw restored.error;
    resources.push(Object.freeze({ mount, tree: restored.value }));
  }
  /** Scratchpad restoration remains sequential for the same deterministic boundary. */
  const scratchpads: RestoredScratchpadMount[] = [];
  /** Every Scratchpad tree must restore before any physical side effect begins. */
  for (const mount of input.scratchpads) {
    /** Each private tree earns physical realization through exact immutable restoration. */
    const restored = await restoreTree(store, mount.tree);
    if (!restored.ok) throw restored.error;
    scratchpads.push(Object.freeze({ mount, tree: restored.value }));
  }
  return Object.freeze({
    workspace: workspace.value,
    resources: Object.freeze(resources),
    scratchpads: Object.freeze(scratchpads),
  });
}

/**
 * Converts native stat evidence into the portable logical mode and stability fields.
 * @param stat - Bigint lstat result for one physical regular file.
 * @returns Frozen comparison evidence independent from mutable Stats objects.
 */
function physicalSignature(stat: BigIntStats): PhysicalFileSignature {
  /** Any executable bit preserves portable executable intent; other mode bits are ignored. */
  const mode = (Number(stat.mode) & 0o111) === 0 ? FileMode.readable : FileMode.executable;
  return Object.freeze({
    size: BigInt(stat.size),
    modified: stat.mtimeNs,
    device: BigInt(stat.dev),
    inode: BigInt(stat.ino),
    mode,
  });
}

/**
 * Compares physical signatures around streaming publication.
 * @param left - Signature observed before reading.
 * @param right - Signature observed after reading or after full publication.
 * @returns Whether the cooperating writer preserved every inspected field.
 */
function equalPhysicalSignature(left: PhysicalFileSignature, right: PhysicalFileSignature): boolean {
  return (
    left.size === right.size &&
    left.modified === right.modified &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

/**
 * Creates a stable streaming source that detects ordinary concurrent replacement.
 * @param physical - Exact regular file inside the Workspace root.
 * @param expected - Signature captured during the complete path walk.
 * @param signal - Ingestion attempt signal checked between bounded reads.
 * @returns Async bytes that throw a stable refusal if the view changes.
 */
function stableFileSource(
  physical: string,
  expected: PhysicalFileSignature,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  return {
    /**
     * Streams copied bounded chunks and proves metadata remained stable.
     * @yields {Uint8Array} Independent file bytes in physical order.
     */
    async *[Symbol.asyncIterator]() {
      proveNotAborted(signal, 'ingestion');
      /** Read-only handle prevents this adapter from causing the mutation it detects. */
      const file = await open(physical, 'r');
      try {
        /** Open-handle stat proves the walked path still names the expected file. */
        const before = physicalSignature(await file.stat({ bigint: true }));
        if (!equalPhysicalSignature(expected, before)) throw new IngestionRefusal('unstable-view');
        /** Fixed chunks keep memory bounded independently from file length. */
        const buffer = new Uint8Array(64 * 1024);
        while (true) {
          proveNotAborted(signal, 'ingestion');
          /** Each read fills at most one bounded reusable buffer. */
          const read = await file.read(buffer, 0, buffer.byteLength, null);
          if (read.bytesRead === 0) break;
          yield Uint8Array.from(buffer.subarray(0, read.bytesRead));
        }
        /** Terminal stat rejects ordinary writes or replacement during hashing. */
        const after = physicalSignature(await file.stat({ bigint: true }));
        if (!equalPhysicalSignature(before, after)) throw new IngestionRefusal('unstable-view');
      } finally {
        await file.close();
      }
    },
  };
}

/**
 * Walks one Workspace root without following links or accepting special files.
 * @param root - Exact physical Workspace directory owned by one view.
 * @param caseSensitivity - Target collision policy fixed at materialization.
 * @param signal - Ingestion attempt signal checked during traversal.
 * @returns Canonical streaming sources and pre-publication stability evidence.
 */
async function scanWorkspace(
  root: string,
  caseSensitivity: 'sensitive' | 'insensitive',
  signal: AbortSignal,
): Promise<ScannedWorkspace> {
  /** Accumulates only regular-file sources; directories have no v1 identity. */
  const sources: TreeFileSource[] = [];
  /** Signature map supports a second complete verification after publication. */
  const signatures = new Map<LogicalPath, PhysicalFileSignature>();
  /** Case-fold map rejects collisions before canonical publication on insensitive targets. */
  const folded = new Map<string, LogicalPath>();

  /**
   * Recursively visits directory entries without following symbolic links.
   * @param directory - Current absolute directory below the fixed Workspace root.
   */
  async function visit(directory: string): Promise<void> {
    proveNotAborted(signal, 'ingestion');
    /** Dirent traversal sees entry kinds without resolving link targets. */
    const handle = await opendir(directory);
    try {
      /** Every direct entry is inspected with lstat before recursion or publication. */
      for await (const entry of handle) {
        proveNotAborted(signal, 'ingestion');
        /** Physical join remains below root because names come from one directory entry. */
        const physical = join(directory, entry.name);
        /** lstat refuses links by describing the link rather than its target. */
        const stat = await lstat(physical, { bigint: true });
        if (stat.isSymbolicLink()) throw new IngestionRefusal('unsupported-entry');
        if (stat.isDirectory()) {
          await visit(physical);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1n) throw new IngestionRefusal('unsupported-entry');
        /** Host separators are converted into Archer's platform-independent logical grammar. */
        const candidate = relative(root, physical).split(sep).join('/');
        /** Logical admission rejects traversal and non-canonical spellings. */
        const path = LogicalPathSchema.parse(candidate);
        if (caseSensitivity === 'insensitive') {
          /** Folded key models the configured target's path-equivalence rule. */
          const key = path.toLowerCase();
          /** Prior spelling exposes an ambiguity the immutable tree cannot preserve. */
          const prior = folded.get(key);
          if (prior !== undefined && prior !== path) throw new IngestionRefusal('unsupported-entry');
          folded.set(key, path);
        }
        /** Signature anchors the streamed source to the file observed during traversal. */
        const signature = physicalSignature(stat);
        signatures.set(path, signature);
        sources.push(
          Object.freeze({
            path,
            mode: signature.mode,
            content: stableFileSource(physical, signature, signal),
          }),
        );
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  await visit(root);
  /** Canonical source order keeps store effect order and receipt counts deterministic. */
  sources.sort((left, right) => compareLogicalPaths(left.path as LogicalPath, right.path as LogicalPath));
  return Object.freeze({ sources: Object.freeze(sources), signatures });
}

/**
 * Rechecks every published path and rejects additions, removals, or metadata changes.
 * @param root - Fixed physical Workspace root.
 * @param expected - Complete signature map captured before streaming publication.
 * @param caseSensitivity - Exact target collision policy.
 * @param signal - Ingestion abort signal.
 */
async function proveWorkspaceStable(
  root: string,
  expected: ReadonlyMap<LogicalPath, PhysicalFileSignature>,
  caseSensitivity: 'sensitive' | 'insensitive',
  signal: AbortSignal,
): Promise<void> {
  /** Second scan owns no consumed sources; only its path and stat evidence is compared. */
  const current = await scanWorkspace(root, caseSensitivity, signal);
  if (current.signatures.size !== expected.size) throw new IngestionRefusal('unstable-view');
  /** Every original path must retain its exact metadata after immutable publication. */
  for (const [path, signature] of expected) {
    /** Current evidence must still contain the same logical path. */
    const after = current.signatures.get(path);
    if (after === undefined || !equalPhysicalSignature(signature, after)) throw new IngestionRefusal('unstable-view');
  }
}

/**
 * Makes read-only Resource directories removable during owned view cleanup.
 * @param root - Fixed Resource root inside one adapter-owned physical view.
 */
async function makeResourceDirectoriesWritable(root: string): Promise<void> {
  if (!(await pathExists(root))) return;
  /**
   * Recursion changes directory mode only; immutable file content remains untouched.
   * @param directory - Current Resource directory being made removable.
   */
  async function visit(directory: string): Promise<void> {
    await chmod(directory, 0o755);
    /** Directory handle enumerates only descendants inside the fixed Resource root. */
    const handle = await opendir(directory);
    try {
      /** Child directories are relaxed recursively; regular-file modes need no change for removal. */
      for await (const entry of handle) {
        if (entry.isDirectory()) await visit(join(directory, entry.name));
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  await visit(root);
}

/**
 * Maps an operation settlement into stable materialization close evidence.
 * @param settlement - Tagged result or redacted unexpected operation failure.
 * @returns Frozen observation-release evidence without closing any physical view.
 */
function materializationCloseEvidence(
  settlement: OperationSettlement<DirectoryMaterializationResult>,
): MaterializationOperationCloseEvidence {
  return Object.freeze({
    kind: 'materialization-operation-closed',
    outcome: settlement.kind === 'failed' ? 'failed' : settlement.value.kind,
  });
}

/**
 * Maps an operation settlement into stable ingestion close evidence.
 * @param settlement - Tagged result or redacted unexpected operation failure.
 * @returns Frozen observation-release evidence without closing the physical view.
 */
function ingestionCloseEvidence(
  settlement: OperationSettlement<DirectoryIngestionResult>,
): IngestionOperationCloseEvidence {
  return Object.freeze({
    kind: 'ingestion-operation-closed',
    outcome: settlement.kind === 'failed' ? 'failed' : settlement.value.kind,
  });
}

/**
 * Opens one first-party cooperative directory Materializer.
 * @param options - Identity, current Authority, immutable store, ownership, and clocks.
 * @returns Frozen retained adapter or one ordinary invalid-construction Error.
 */
export function createDirectoryMaterializer(
  options: CreateDirectoryMaterializerOptions,
): ResultValue<DirectoryMaterializer, FilesError> {
  try {
    /** Re-admits JavaScript identities before any retained state exists. */
    const materializerId = MaterializerIdSchema.parse(options.materializerId);
    /** Every protected attempt is attributed to this admitted Principal. */
    const subject = PrincipalIdSchema.parse(options.subject);
    /** Component ownership remains explicit and transfers only on successful return. */
    const store = options.store.value;
    /** Current broker owns every materialize and ingest authorization decision. */
    const authority = options.authority.value;
    /** Injected identity generation makes view, receipt, and operation tests deterministic. */
    const createId = options.createId ?? systemIdFactory;
    /** Injected clock makes receipt and close evidence deterministic. */
    const now = options.now ?? systemClock;
    /** Materialization replay state belongs only to this retained attachment. */
    const replays = new Map<string, MaterializationReplay>();
    /** Completed views remain independently usable until they or the adapter close. */
    const views = new Set<DirectoryMaterializedView>();
    /** In-flight operations settle before adapter-owned view and dependency cleanup. */
    const activeResults = new Set<Promise<DirectoryMaterializationResult>>();
    /** Prevents new physical attempts after retained close begins. */
    let closed = false;
    /** Retains one shared close promise independently from close-call count. */
    let closePromise: Promise<DirectoryMaterializerCloseEvidence> | undefined;
    /** Makes lifecycle observation available before close activation. */
    let settleClosed: ((evidence: DirectoryMaterializerCloseEvidence) => void) | undefined;
    /** Mirrors cleanup failure through both close access paths. */
    let rejectClosed: ((error: unknown) => void) | undefined;
    /** Public retained settlement is allocated before the handle is exposed. */
    const closedSettlement = new Promise<DirectoryMaterializerCloseEvidence>((resolveClosed, rejectClose) => {
      settleClosed = resolveClosed;
      rejectClosed = rejectClose;
    });

    /**
     * Constructs one completed view and its independently retained ingestion runtime.
     * @param input - Admitted materialization command whose target now exists completely.
     * @param viewId - Stable physical-view identity allocated at publication.
     * @returns Frozen view handle owning its target cleanup policy.
     */
    function createView(
      input: AdmittedMaterializationInput,
      viewId: ReturnType<typeof MaterializedViewIdSchema.parse>,
    ) {
      /** Fixed paths make Workspace inclusion and exclusion obvious to ordinary tools. */
      const paths: DirectoryViewPaths = Object.freeze({
        root: input.target.rootPath,
        workspace: join(input.target.rootPath, WORKSPACE_DIRECTORY),
        resources: join(input.target.rootPath, RESOURCES_DIRECTORY),
        scratchpads: join(input.target.rootPath, SCRATCHPADS_DIRECTORY),
      });
      /** Ingestion idempotency belongs to the exact physical view generation. */
      const ingestionReplays = new Map<string, IngestionReplay>();
      /** View cleanup waits for each already-started scan to settle. */
      const activeIngestions = new Set<Promise<DirectoryIngestionResult>>();
      /** Stops later scans before physical cleanup begins. */
      let viewClosed = false;
      /** Retains one shared physical-view cleanup operation. */
      let viewClosePromise: Promise<DirectoryMaterializedViewCloseEvidence> | undefined;
      /** Exposes retained closure before cleanup activation. */
      let settleViewClosed: ((evidence: DirectoryMaterializedViewCloseEvidence) => void) | undefined;
      /** Mirrors cleanup rejection through `closed` and `close()`. */
      let rejectViewClosed: ((error: unknown) => void) | undefined;
      /** Public physical-view close settlement is created before handle exposure. */
      const viewClosedSettlement = new Promise<DirectoryMaterializedViewCloseEvidence>((resolveClosed, rejectClose) => {
        settleViewClosed = resolveClosed;
        rejectViewClosed = rejectClose;
      });

      /** Public view keeps physical state and later Workspace acceptance separate. */
      const view: DirectoryMaterializedView = Object.freeze({
        type: 'directory',
        materializedViewId: viewId,
        materializerId,
        protocolVersion: MATERIALIZER_PROTOCOL_VERSION,
        mappingVersion: DIRECTORY_MAPPING_VERSION,
        base: input.workspace,
        generation: input.generation,
        paths,
        closed: viewClosedSettlement,
        /**
         * Verifies current permission before constructing one already-running scan.
         * @param command - Cooperative quiescence claim and exact logical preconditions.
         * @param grant - Current ingestion permission presented for this exact physical view.
         * @returns Existing or newly started hot operation, an expected refusal, or Authority evidence.
         */
        async startIngestion(
          command: DirectoryIngestionInput,
          grant: GrantRef<FilesIngestAction>,
        ): Promise<IngestionStartOutcome> {
          if (viewClosed) return Object.freeze({ kind: 'refused', reason: 'view-closed' });
          /** Admission copies the cooperative claim and exact preconditions before awaits. */
          const admitted = DirectoryIngestionInputSchema.parse(command);
          /** Exact scope binds current permission to this view, base, generation, and weak quiescence class. */
          const scope = {
            kind: 'files-ingest' as const,
            materializerId,
            materializedViewId: viewId,
            base: input.workspace,
            generation: input.generation,
            quiescence: 'cooperative-directory' as const,
          };
          /** Authority is evaluated immediately before any physical scan can start. */
          const decision = await authority.verify<FilesIngestAction>({ grant, subject, scope });
          if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
          /** Exact semantic identity excludes the idempotency key and hashes attribution prose. */
          const commandFingerprint = fingerprint({
            quiescence: admitted.quiescence,
            expectedBase: admitted.expectedBase,
            expectedGeneration: admitted.expectedGeneration,
          });
          /** One key can replay only the exact semantic ingestion command first admitted. */
          const replay = ingestionReplays.get(admitted.idempotencyKey);
          if (replay !== undefined) {
            return replay.fingerprint === commandFingerprint
              ? Object.freeze({ kind: 'started', operation: replay.operation, replayed: true })
              : Object.freeze({ kind: 'refused', reason: 'idempotency-conflict' });
          }
          /** One operation epoch separates progress generations even on the same view. */
          const epoch = UuidV4Schema.parse(createId());
          /** Wide span accumulates identities and bounded counts without paths. */
          const span = beginSpan(options.diagnostics, 'files.ingestion', materializerId, {
            view: { materializedViewId: viewId, generation: input.generation },
          });
          /** Hot operation starts immediately and owns progress, cancellation, and retained settlement. */
          const operation = createLiveOperation<
            IngestionEvent,
            DirectoryIngestionResult,
            IngestionOperationCloseEvidence
          >({
            source: 'directory-ingestion',
            epoch,
            eventEncoding: INGESTION_PROGRESS,
            /**
             * Full scan begins immediately after current authorization.
             * @param context - Operation-owned abort signal and transient progress emitter.
             * @returns Complete verified ingestion, an expected refusal, or a redacted failure.
             */
            async start(context) {
              try {
                context.emit({ phase: 'checking-quiescence', filesCompleted: 0 });
                /** Runtime admission owns and normalizes the caller's quiescence assertion. */
                const quiescence = DirectoryCooperativeQuiescenceSchema.parse(admitted.quiescence);
                if (quiescence.materializedViewId !== viewId || quiescence.generation !== input.generation) {
                  throw new IngestionRefusal('quiescence-mismatch');
                }
                if (!equalTree(admitted.expectedBase, input.workspace)) throw new IngestionRefusal('base-mismatch');
                if (admitted.expectedGeneration !== input.generation) throw new IngestionRefusal('stale-generation');
                if (viewClosed) throw new IngestionRefusal('view-closed');
                proveNotAborted(context.signal, 'ingestion');
                context.emit({ phase: 'scanning-workspace', filesCompleted: 0 });
                /** Scan captures streaming sources and stability evidence without following links. */
                const scanned = await scanWorkspace(paths.workspace, input.target.caseSensitivity, context.signal);
                context.emit({ phase: 'publishing-tree', filesCompleted: scanned.sources.length });
                /** Immutable publication computes the candidate tree while sources verify their files. */
                const published = await publishTree(store, scanned.sources);
                if (!published.ok) throw published.error;
                await proveWorkspaceStable(
                  paths.workspace,
                  scanned.signatures,
                  input.target.caseSensitivity,
                  context.signal,
                );
                proveNotAborted(context.signal, 'ingestion');
                context.emit({ phase: 'creating-receipt', filesCompleted: published.value.files.length });
                /** Counts exact logical bytes from immutable blob identities, not filesystem estimates. */
                const byteCount = published.value.files.reduce(
                  (total, entry) => total + BigInt(entry.blob.byteLength),
                  0n,
                );
                /** Receipt identity is allocated only after complete publication and stability proof. */
                const receiptWithoutEvidence = Object.freeze({
                  id: IngestionReceiptIdSchema.parse(createId()),
                  object: 'ingestion-receipt' as const,
                  createdAt: timestamp(now),
                  materializerId,
                  materializedViewId: viewId,
                  adapterId: DIRECTORY_MATERIALIZER_ADAPTER_ID,
                  mappingVersion: DIRECTORY_MAPPING_VERSION,
                  base: input.workspace,
                  result: published.value.ref,
                  generation: input.generation,
                  excludedRoots: Object.freeze(['resources', 'scratchpads'] as const),
                  fileCount: published.value.files.length,
                  byteCount: CanonicalDecimalSchema.parse(byteCount.toString()),
                  status: 'complete' as const,
                });
                /** Schema admission freezes the final receipt and validates its evidence grammar. */
                const receipt = IngestionReceiptSchema.parse({
                  ...receiptWithoutEvidence,
                  evidenceDigest: physicalIngestionReceiptEvidence(receiptWithoutEvidence),
                });
                /** Only complete receipt construction can select the successful terminal branch. */
                const result = Object.freeze({ kind: 'ingested' as const, receipt, replayed: false });
                completeSpan(span, result.kind, {
                  ingestion: { fileCount: receipt.fileCount, byteCount: receipt.byteCount },
                });
                return result;
              } catch (error) {
                if (error instanceof IngestionRefusal) {
                  /** Expected environmental conflicts remain data, not thrown adapter failures. */
                  const result = Object.freeze({ kind: 'refused' as const, reason: error.reason });
                  completeSpan(span, result.kind, { ingestion: { reason: result.reason } });
                  return result;
                }
                /** Unexpected native failures are converted to a bounded public error. */
                const result = Object.freeze({
                  kind: 'failed' as const,
                  failure: directoryFailure(error, 'files_ingestion_failed', 'Directory ingestion failed'),
                });
                completeSpan(span, result.kind, { ingestion: { failureCode: result.failure.code } });
                return result;
              }
            },
            closeEvidence: ingestionCloseEvidence,
            /**
             * Abort is proved only when the adapter returned its explicit abort branch.
             * @param settlement - Terminal operation result or unexpected core failure.
             * @returns Retained cancellation classification for the public operation state.
             */
            classifyAbort(settlement) {
              return settlement.kind === 'result' &&
                settlement.value.kind === 'refused' &&
                settlement.value.reason === 'aborted'
                ? Object.freeze({ kind: 'attempt-settled', outcome: 'aborted' })
                : Object.freeze({ kind: 'attempt-settled', outcome: 'completed' });
            },
            failure: { code: 'files_ingestion_failed', message: 'Directory ingestion failed unexpectedly' },
          });
          ingestionReplays.set(admitted.idempotencyKey, Object.freeze({ fingerprint: commandFingerprint, operation }));
          activeIngestions.add(operation.result);
          void operation.result.finally(() => activeIngestions.delete(operation.result));
          return Object.freeze({ kind: 'started', operation, replayed: false });
        },
        /**
         * Waits for active scans and applies the caller-selected physical cleanup policy.
         * @returns Shared retained evidence describing whether the physical view was preserved or removed.
         */
        close() {
          if (viewClosePromise === undefined) {
            viewClosed = true;
            viewClosePromise = (async () => {
              await Promise.allSettled([...activeIngestions]);
              if (input.target.cleanup === 'remove' && (await pathExists(paths.root))) {
                await makeResourceDirectoriesWritable(paths.resources);
                await rm(paths.root, { recursive: true, force: false });
              }
              views.delete(view);
              /** Close evidence reports disposition without leaking the physical root path. */
              const evidence = Object.freeze({
                kind: 'directory-view-closed' as const,
                materializedViewId: viewId,
                disposition: input.target.cleanup === 'remove' ? ('removed' as const) : ('preserved' as const),
                closedAt: timestamp(now),
              });
              settleViewClosed?.(evidence);
              return evidence;
            })();
            void viewClosePromise.catch((error: unknown) => rejectViewClosed?.(error));
          }
          return viewClosedSettlement;
        },
        /** Delegates language disposal to the same non-ingesting close path. */
        async [Symbol.asyncDispose]() {
          await view.close();
        },
      });
      views.add(view);
      return view;
    }

    /** Public adapter performs current authorization before physical activation. */
    const materializer: DirectoryMaterializer = Object.freeze({
      materializerId,
      adapterId: DIRECTORY_MATERIALIZER_ADAPTER_ID,
      protocolVersion: MATERIALIZER_PROTOCOL_VERSION,
      closed: closedSettlement,
      /**
       * Starts one deduplicated hot materialization operation.
       * @param command - Complete logical inputs, target policy, and idempotency identity.
       * @param grant - Current materialization permission presented for this adapter attachment.
       * @returns Existing or newly started hot operation, an expected refusal, or Authority evidence.
       */
      async startMaterialization(
        command: DirectoryMaterializationInput,
        grant: GrantRef<FilesMaterializeAction>,
      ): Promise<MaterializationStartOutcome> {
        if (closed) return Object.freeze({ kind: 'refused', reason: 'materializer-closed' });
        /** Admission owns all command values before current Authority introduces an await. */
        const input = admitMaterializationInput(command);
        /** Complete input identity lets an attenuated grant pin mounts and host target without exposing either. */
        const commandFingerprint = materializationFingerprint(input);
        /** Authority is evaluated immediately before any physical construction can start. */
        const decision = await authority.verify<FilesMaterializeAction>({
          grant,
          subject,
          scope: {
            kind: 'files-materialize',
            materializerId,
            inputDigest: commandFingerprint,
          },
        });
        if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
        /** One key can replay only the exact semantic materialization command first admitted. */
        const replay = replays.get(input.idempotencyKey);
        if (replay !== undefined) {
          return replay.fingerprint === commandFingerprint
            ? Object.freeze({ kind: 'started', operation: replay.operation, replayed: true })
            : Object.freeze({ kind: 'refused', reason: 'idempotency-conflict' });
        }
        /** Operation identity is allocated before activation and never enters durable evidence. */
        const epoch = UuidV4Schema.parse(createId());
        /** One span accumulates bounded attempt context through terminal cleanup. */
        const span = beginSpan(options.diagnostics, 'files.materialization', materializerId, {
          materialization: {
            generation: input.generation,
            resourceMounts: input.resources.length,
            scratchpadMounts: input.scratchpads.length,
          },
        });
        /** Hot operation starts immediately and owns progress, cancellation, and retained settlement. */
        const operation = createLiveOperation<
          MaterializationEvent,
          DirectoryMaterializationResult,
          MaterializationOperationCloseEvidence
        >({
          source: 'directory-materialization',
          epoch,
          eventEncoding: MATERIALIZATION_PROGRESS,
          /**
           * Complete physical construction begins immediately after current authorization.
           * @param context - Operation-owned abort signal and transient progress emitter.
           * @returns Complete physical view, an expected refusal, or a redacted failure.
           */
          async start(context) {
            /** Staging is the only partial path and is never the requested final target. */
            let staging: string | undefined;
            try {
              context.emit({ phase: 'preparing-target', filesCompleted: 0 });
              proveNotAborted(context.signal, 'materialization');
              if (await pathExists(input.target.rootPath)) throw new MaterializationRefusal('target-exists');
              /** Restoring every tree first keeps invalid logical input from touching the target filesystem. */
              const restored = await restoreInputs(store, input);
              if (input.target.caseSensitivity === 'insensitive') {
                proveNoCaseCollisions([
                  restored.workspace,
                  ...restored.resources.map((item) => item.tree),
                  ...restored.scratchpads.map((item) => item.tree),
                ]);
              }
              proveNotAborted(context.signal, 'materialization');
              /** Parent must exist; the adapter creates only its unique staging child and selected target. */
              const parent = dirname(input.target.rootPath);
              /** Parent evidence prevents staging under a non-directory filesystem entry. */
              const parentStat = await lstat(parent);
              if (!parentStat.isDirectory())
                throw new FilesError('files_io_failed', 'Directory target parent is not a directory');
              staging = await mkdtemp(join(parent, '.archer-directory-'));
              context.emit({ phase: 'writing-workspace', filesCompleted: 0 });
              /** Progress count advances only after complete regular-file writes. */
              let filesCompleted = await writeTree(
                store,
                restored.workspace,
                join(staging, WORKSPACE_DIRECTORY),
                false,
                context.signal,
              );
              context.emit({ phase: 'writing-resources', filesCompleted });
              await mkdir(join(staging, RESOURCES_DIRECTORY), { recursive: true, mode: 0o755 });
              /** Resource mounts are realized read-only and remain excluded from later ingestion. */
              for (const item of restored.resources) {
                filesCompleted += await writeTree(
                  store,
                  item.tree,
                  join(staging, RESOURCES_DIRECTORY, ...item.mount.mountPath.split('/')),
                  true,
                  context.signal,
                );
              }
              context.emit({ phase: 'writing-scratchpads', filesCompleted });
              await mkdir(join(staging, SCRATCHPADS_DIRECTORY), { recursive: true, mode: 0o755 });
              /** Scratchpad mounts remain writable but independently rooted and excluded from ingestion. */
              for (const item of restored.scratchpads) {
                filesCompleted += await writeTree(
                  store,
                  item.tree,
                  join(staging, SCRATCHPADS_DIRECTORY, ...item.mount.mountPath.split('/')),
                  false,
                  context.signal,
                );
              }
              proveNotAborted(context.signal, 'materialization');
              context.emit({ phase: 'publishing-view', filesCompleted });
              /** Atomic directory rename prevents consumers from observing the staging prefix. */
              await rename(staging, input.target.rootPath);
              staging = undefined;
              /** View identity is earned only after complete physical publication. */
              const view = createView(input, MaterializedViewIdSchema.parse(createId()));
              /** Successful settlement transfers the independently owned physical-view handle. */
              const result = Object.freeze({ kind: 'materialized' as const, view });
              completeSpan(span, result.kind, { materialization: { filesCompleted } });
              return result;
            } catch (error) {
              if (staging !== undefined && (await pathExists(staging)))
                await rm(staging, { recursive: true, force: false });
              if (error instanceof MaterializationRefusal) {
                /** Expected target, case, and cancellation conflicts remain terminal data. */
                const result = Object.freeze({ kind: 'refused' as const, reason: error.reason });
                completeSpan(span, result.kind, { materialization: { reason: result.reason } });
                return result;
              }
              /** Unexpected native failures are converted to a bounded public error. */
              const result = Object.freeze({
                kind: 'failed' as const,
                failure: directoryFailure(error, 'files_materialization_failed', 'Directory materialization failed'),
              });
              completeSpan(span, result.kind, { materialization: { failureCode: result.failure.code } });
              return result;
            }
          },
          closeEvidence: materializationCloseEvidence,
          /**
           * Abort is proved only by the explicit terminal refusal branch.
           * @param settlement - Terminal operation result or unexpected core failure.
           * @returns Retained cancellation classification for the public operation state.
           */
          classifyAbort(settlement) {
            return settlement.kind === 'result' &&
              settlement.value.kind === 'refused' &&
              settlement.value.reason === 'aborted'
              ? Object.freeze({ kind: 'attempt-settled', outcome: 'aborted' })
              : Object.freeze({ kind: 'attempt-settled', outcome: 'completed' });
          },
          failure: { code: 'files_materialization_failed', message: 'Directory materialization failed unexpectedly' },
        });
        replays.set(input.idempotencyKey, Object.freeze({ fingerprint: commandFingerprint, operation }));
        activeResults.add(operation.result);
        void operation.result.finally(() => activeResults.delete(operation.result));
        return Object.freeze({ kind: 'started', operation, replayed: false });
      },
      /**
       * Stops new attempts, settles existing work, closes views, then owned dependencies.
       * @returns Shared retained evidence after the full owned lifecycle has settled.
       */
      close() {
        if (closePromise === undefined) {
          closed = true;
          closePromise = (async () => {
            await Promise.allSettled([...activeResults]);
            await Promise.all([...views].map((view) => view.close()));
            if (options.store.ownership === 'owned') await store.close();
            if (options.authority.ownership === 'owned') await authority.close();
            /** Adapter evidence settles only after owned children and dependencies close. */
            const evidence = Object.freeze({
              kind: 'directory-materializer-closed' as const,
              materializerId,
              closedAt: timestamp(now),
            });
            settleClosed?.(evidence);
            return evidence;
          })();
          void closePromise.catch((error: unknown) => rejectClosed?.(error));
        }
        return closedSettlement;
      },
      /** Delegates language disposal to the same retained adapter close path. */
      async [Symbol.asyncDispose]() {
        await materializer.close();
      },
    });

    return Result.ok(materializer);
  } catch (error) {
    return Result.error(
      error instanceof FilesError
        ? error
        : new FilesError('files_invalid_input', 'Invalid directory Materializer construction', { cause: error }),
    );
  }
}
