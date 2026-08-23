/**
 * @file Defines immutable blob and tree storage ports plus managed publication.
 *
 * Pure admission and hierarchy construction happen before storage effects. The
 * retained stores own only byte persistence and verification, never tree identity.
 */

import { Result, type OwnedHandle, type Result as ResultValue } from '@archer/core';

import {
  BlobRefSchema,
  FileMode,
  FileModeSchema,
  TreeRefSchema,
  blobRefForBytes,
  createDirectoryNode,
  decodeDirectoryNode,
  encodeDirectoryNode,
  treeRefForBytes,
  type BlobRef,
  type DirectoryEntry,
  type DirectoryNode,
  type FileMode as FileModeValue,
  type TreeRef,
} from './encoding.js';
import { FilesError } from './errors.js';
import {
  LogicalNameSchema,
  LogicalPathSchema,
  compareLogicalPaths,
  type LogicalName,
  type LogicalPath,
} from './path.js';

/** Raw content accepted from memory or a caller-owned asynchronous producer. */
export type BlobSource = Uint8Array | AsyncIterable<Uint8Array>;

/** One verified-on-completion streaming read for an exact blob reference. */
export type BlobRead = Readonly<{
  /** Repeats the requested identity beside the content stream. */
  ref: BlobRef;

  /** Yields copied chunks and throws a `FilesError` if terminal verification fails. */
  content: AsyncIterable<Uint8Array>;
}>;

/** Product-neutral content-addressed raw byte storage. */
export interface BlobStore {
  /** Stores one complete source and returns its raw SHA-256 identity. */
  put(source: BlobSource): Promise<ResultValue<BlobRef, FilesError>>;

  /** Opens one stream whose successful completion proves digest and byte length. */
  read(ref: BlobRef): Promise<ResultValue<BlobRead, FilesError>>;

  /** Reports whether storage contains an object at the exact digest and length. */
  has(ref: BlobRef): Promise<ResultValue<boolean, FilesError>>;
}

/** Product-neutral content-addressed canonical directory-node storage. */
export interface TreeStore {
  /** Encodes and stores one canonical node under its resulting `TreeRef`. */
  put(node: DirectoryNode): Promise<ResultValue<TreeRef, FilesError>>;

  /** Restores one node only after encoded length, digest, and canonical bytes match. */
  get(ref: TreeRef): Promise<ResultValue<DirectoryNode, FilesError>>;

  /** Reports whether storage contains an object at the exact digest and length. */
  has(ref: TreeRef): Promise<ResultValue<boolean, FilesError>>;
}

/** Immutable evidence shared by memory and filesystem store closure. */
export type FileStoreCloseEvidence = Readonly<{
  /** Confirms this retained attachment rejects every later operation. */
  kind: 'closed';
}>;

/** Retained owner that groups compatible blob and tree storage lifecycles. */
export interface FileStore extends OwnedHandle<FileStoreCloseEvidence> {
  /** Stores and verifies raw regular-file bytes. */
  readonly blobs: BlobStore;

  /** Stores and verifies canonical directory-node bytes. */
  readonly trees: TreeStore;
}

/** One logical file whose bytes already have immutable content identity. */
export type TreeFileEntry = Readonly<{
  /** Names the file independently of host path rules. */
  path: LogicalPath;

  /** Preserves portable readable or executable intent. */
  mode: FileModeValue;

  /** Identifies exact raw bytes retained by the paired blob store. */
  blob: BlobRef;
}>;

/** Ergonomic publication input that lets the store derive each `BlobRef`. */
export type TreeFileSource = Readonly<{
  /** Accepts untrusted text so publication can normalize and validate it once. */
  path: string;

  /** Accepts UTF-8 text sugar, in-memory bytes, or a streaming byte source. */
  content: string | BlobSource;

  /** Defaults to portable readable mode when executable intent is absent. */
  mode?: FileModeValue;
}>;

/** Transferable immutable tree value restored independently of physical storage. */
export type ImmutableTree = Readonly<{
  /** Identifies the canonical root directory node and every descendant. */
  ref: TreeRef;

  /** Lists exact logical files in normalized UTF-8 path order. */
  files: readonly TreeFileEntry[];
}>;

/** One admitted source whose path and metadata can no longer change. */
type AdmittedTreeFileSource = Readonly<{
  /** Canonical logical path used by hierarchy construction. */
  path: LogicalPath;

  /** Caller source retained only after all sibling definitions validate. */
  content: BlobSource;

  /** Portable mode copied before any content effect begins. */
  mode: FileModeValue;
}>;

/** Mutable construction-only directory that never crosses the public boundary. */
interface TreeDraft {
  /** Direct children indexed by already-normalized logical name. */
  children: Map<LogicalName, TreeDraftChild>;
}

/** Minimal path-bearing value shared by source and referenced-entry admission. */
interface PathBearing {
  /** Canonical logical path used for duplicate and ancestor proof. */
  readonly path: LogicalPath;
}

/** Construction-only child selected by one normalized path segment. */
type TreeDraftChild =
  | Readonly<{
      /** Selects a regular-file leaf. */
      kind: 'file';

      /** Exact immutable file value retained at this leaf. */
      file: TreeFileEntry;
    }>
  | Readonly<{
      /** Selects a recursively published directory. */
      kind: 'directory';

      /** Mutable draft used only until bottom-up publication completes. */
      node: TreeDraft;
    }>;

/** UTF-8 encoder that gives text publication one explicit byte convention. */
const UTF8_ENCODER = new TextEncoder();

/** Shared immutable evidence returned by every successful store close. */
const CLOSED_EVIDENCE = Object.freeze({ kind: 'closed' } as const);

/**
 * Builds one bounded invalid-input failure while retaining a local cause.
 * @param cause - Schema or runtime value that could not enter the file domain.
 * @returns Stable public failure without leaking validator text into control flow.
 */
function invalidInput(cause: unknown): FilesError {
  return new FilesError('files_invalid_input', 'Invalid immutable file input', { cause });
}

/**
 * Builds the stable failure returned after a retained store starts closing.
 * @returns One operation-local Error suitable for ordinary Result handling.
 */
function storeClosed(): FilesError {
  return new FilesError('files_store_closed', 'The file store is closed');
}

/**
 * Reports whether a runtime value supplies the asynchronous iterable protocol.
 * @param value - Proposed streaming source from an untrusted JavaScript caller.
 * @returns Whether publication can request an asynchronous iterator later.
 */
function isAsyncByteSource(value: unknown): value is AsyncIterable<Uint8Array> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof (value as Partial<AsyncIterable<Uint8Array>>)[Symbol.asyncIterator] === 'function';
}

/**
 * Copies and freezes one already-referenced file proposal.
 * @param entry - Caller-owned value crossing the public publication boundary.
 * @returns Admitted immutable entry or one stable validation failure.
 */
function admitTreeFileEntry(entry: TreeFileEntry): ResultValue<TreeFileEntry, FilesError> {
  try {
    /** Normalizes the full path before duplicate and prefix comparisons occur. */
    const path = LogicalPathSchema.parse(entry.path);
    /** Restricts metadata to the two portable v1 file modes. */
    const mode = FileModeSchema.parse(entry.mode);
    /** Copies the nested identity so caller mutation cannot rewrite the tree. */
    const blob = BlobRefSchema.parse(entry.blob);
    return Result.ok(Object.freeze({ path, mode, blob }));
  } catch (error) {
    return Result.error(invalidInput(error));
  }
}

/**
 * Copies and freezes one content-bearing publication proposal without reading it.
 * @param source - Caller definition whose siblings must all validate first.
 * @returns Admitted source or one stable validation failure.
 */
function admitTreeFileSource(source: TreeFileSource): ResultValue<AdmittedTreeFileSource, FilesError> {
  try {
    /** Normalizes the logical path before any source iterator can activate. */
    const path = LogicalPathSchema.parse(source.path);
    /** Applies the documented readable default at the pure boundary. */
    const mode = FileModeSchema.parse(source.mode ?? FileMode.readable);
    /** Converts string sugar now and copies byte arrays before later awaits. */
    let content: BlobSource;
    if (typeof source.content === 'string') content = UTF8_ENCODER.encode(source.content);
    else if (source.content instanceof Uint8Array) content = Uint8Array.from(source.content);
    else if (isAsyncByteSource(source.content)) content = source.content;
    else throw new TypeError('File content must be text, bytes, or an asynchronous byte source');
    return Result.ok(Object.freeze({ path, mode, content }));
  } catch (error) {
    return Result.error(invalidInput(error));
  }
}

/**
 * Proves sorted paths are unique and no regular file is another file's parent.
 * @param files - Admitted files in canonical complete-path order.
 * @returns The same array or one exact path-domain rejection.
 */
function provePathSet<Value extends PathBearing>(files: readonly Value[]): ResultValue<readonly Value[], FilesError> {
  /** Indexes complete normalized paths independently of their canonical order. */
  const paths = new Set<LogicalPath>();
  /** Detects exact or NFC-collapsed duplicates before prefix analysis. */
  for (const file of files) {
    if (paths.has(file.path)) {
      return Result.error(
        new FilesError('files_duplicate_path', 'Tree contains duplicate normalized file paths', {
          details: { path: file.path },
        }),
      );
    }
    paths.add(file.path);
  }
  /** Checks every proper ancestor because unrelated names may sort between a parent and child. */
  for (const file of files) {
    /** Splits only after LogicalPath admission fixed separator semantics. */
    const segments = file.path.split('/');
    /** Builds each proper prefix without consulting a host path implementation. */
    for (let length = 1; length < segments.length; length += 1) {
      /** Ancestor segments are already normalized constituents of an admitted path. */
      const parent = segments.slice(0, length).join('/') as LogicalPath;
      if (paths.has(parent)) {
        return Result.error(
          new FilesError('files_path_conflict', 'A regular file cannot contain another logical file', {
            details: { parent, child: file.path },
          }),
        );
      }
    }
  }
  return Result.ok(files);
}

/**
 * Admits and canonicalizes all referenced file entries before storage is touched.
 * @param entries - Caller-owned proposals in arbitrary order.
 * @returns Frozen normalized files in bytewise complete-path order.
 */
function admitTreeFileEntries(entries: readonly TreeFileEntry[]): ResultValue<readonly TreeFileEntry[], FilesError> {
  try {
    /** Prevents a non-array iterable or missing argument from producing partial work. */
    if (!Array.isArray(entries)) throw new TypeError('Tree entries must be an array');
    /** Holds copied values until the complete input proves valid. */
    const admitted: TreeFileEntry[] = [];
    /** Validates each element without invoking storage. */
    for (const entry of entries) {
      /** Preserves the first exact validation failure. */
      const result = admitTreeFileEntry(entry);
      if (!result.ok) return result;
      admitted.push(result.value);
    }
    admitted.sort((left, right) => compareLogicalPaths(left.path, right.path));
    /** Freezes collection identity before it can be retained by a published tree. */
    const frozen = Object.freeze([...admitted]);
    return provePathSet(frozen);
  } catch (error) {
    return Result.error(invalidInput(error));
  }
}

/**
 * Admits and canonicalizes all content-bearing definitions before reading any source.
 * @param sources - Caller-owned proposals in arbitrary order.
 * @returns Frozen normalized sources in bytewise complete-path order.
 */
function admitTreeFileSources(
  sources: readonly TreeFileSource[],
): ResultValue<readonly AdmittedTreeFileSource[], FilesError> {
  try {
    /** Prevents a non-array iterable or missing argument from activating unexpectedly. */
    if (!Array.isArray(sources)) throw new TypeError('Tree sources must be an array');
    /** Holds admitted definitions while all siblings remain effect-free. */
    const admitted: AdmittedTreeFileSource[] = [];
    /** Validates every definition without iterating content. */
    for (const source of sources) {
      /** Preserves the first exact validation failure. */
      const result = admitTreeFileSource(source);
      if (!result.ok) return result;
      admitted.push(result.value);
    }
    admitted.sort((left, right) => compareLogicalPaths(left.path, right.path));
    /** Freezes collection identity before source consumption begins. */
    const frozen = Object.freeze([...admitted]);
    return provePathSet(frozen);
  } catch (error) {
    return Result.error(invalidInput(error));
  }
}

/**
 * Collects one byte source privately so failed producers never create an object.
 * @param source - In-memory bytes or caller-owned asynchronous byte producer.
 * @returns One contiguous store-owned byte sequence.
 */
async function collectSource(source: BlobSource): Promise<ResultValue<Uint8Array, FilesError>> {
  if (source instanceof Uint8Array) return Result.ok(Uint8Array.from(source));
  try {
    /** Retains independent chunks until the producer completes successfully. */
    const chunks: Uint8Array[] = [];
    /** Counts output length while guarding JavaScript allocation bounds. */
    let length = 0;
    /** Pulls in producer order because raw byte identity is order-sensitive. */
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('Blob sources must yield Uint8Array chunks');
      /** Copies before the producer can reuse or mutate its buffer. */
      const copy = Uint8Array.from(chunk);
      length += copy.byteLength;
      if (!Number.isSafeInteger(length)) throw new RangeError('Blob source exceeds safe allocation length');
      chunks.push(copy);
    }
    /** Owns the exact contiguous bytes committed only after producer success. */
    const output = new Uint8Array(length);
    /** Tracks the next unwritten position in the contiguous result. */
    let offset = 0;
    /** Preserves exact chunk order while flattening the complete source. */
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Result.ok(output);
  } catch (error) {
    return Result.error(
      new FilesError('files_source_failed', 'The blob source failed before completion', { cause: error }),
    );
  }
}

/**
 * Compares exact immutable references without trusting object identity.
 * @param left - First raw-content reference.
 * @param right - Second raw-content reference.
 * @returns Whether both digest and exact byte length match.
 */
function blobRefsEqual(left: BlobRef, right: BlobRef): boolean {
  return left.digest === right.digest && left.byteLength === right.byteLength;
}

/**
 * Compares exact canonical tree references without trusting object identity.
 * @param left - First encoded-directory reference.
 * @param right - Second encoded-directory reference.
 * @returns Whether format, digest, and exact encoded byte length match.
 */
function treeRefsEqual(left: TreeRef, right: TreeRef): boolean {
  return left.format === right.format && left.digest === right.digest && left.byteLength === right.byteLength;
}

/**
 * Yields one already-verified memory value from independently owned bytes.
 * @param bytes - Store-owned bytes copied again before this stream is created.
 * @returns One copied chunk suitable for ordinary asynchronous consumption.
 * @yields {Uint8Array} A single store-independent copy of the verified bytes.
 */
async function* memoryBlobContent(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield Uint8Array.from(bytes);
}

/**
 * Creates one retained, content-addressed in-memory store.
 * @returns Open blob and tree ports sharing one idempotent lifecycle.
 */
export function memoryFileStore(): FileStore {
  /** Retains raw bytes by digest while exact lengths remain verified on access. */
  const blobs = new Map<string, Uint8Array>();
  /** Retains canonical encoded nodes rather than mutable decoded objects. */
  const trees = new Map<string, Uint8Array>();
  /** Settles only when the attachment begins its one close transition. */
  const closeSettlement = Promise.withResolvers<FileStoreCloseEvidence>();
  /** Guards every operation and the one destructive in-memory close transition. */
  let isClosed = false;
  /** Exact shared promise required by the retained ownership contract. */
  const closed = closeSettlement.promise;

  /** Product-neutral raw byte operations over the private memory map. */
  const blobStore: BlobStore = Object.freeze({
    /**
     * Stores complete bytes only after a source succeeds.
     * @param source - Raw bytes or asynchronous byte producer.
     * @returns Exact stored content identity or a stable failure.
     */
    async put(source: BlobSource) {
      if (isClosed) return Result.error(storeClosed());
      /** Collects privately before either hashing or mutating retained state. */
      const collected = await collectSource(source);
      if (!collected.ok) return collected;
      if (isClosed) return Result.error(storeClosed());
      /** Computes identity from the exact committed byte sequence. */
      const ref = blobRefForBytes(collected.value);
      if (!blobs.has(ref.digest)) blobs.set(ref.digest, Uint8Array.from(collected.value));
      return Result.ok(ref);
    },

    /**
     * Opens an independently copied stream only after reference verification.
     * @param proposedRef - Exact raw identity requested by the caller.
     * @returns Verified read handle or a stable failure.
     */
    async read(proposedRef: BlobRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Rejects malformed or caller-mutable reference values at the boundary. */
      let ref: BlobRef;
      try {
        ref = BlobRefSchema.parse(proposedRef);
      } catch (error) {
        return Result.error(invalidInput(error));
      }
      /** Selects by digest before checking the caller's exact expected length. */
      const stored = blobs.get(ref.digest);
      if (stored === undefined) {
        return Result.error(
          new FilesError('files_content_missing', 'The requested blob is not retained', {
            details: { digest: ref.digest },
          }),
        );
      }
      /** Recomputes identity so internal corruption cannot escape as trusted bytes. */
      const actual = blobRefForBytes(stored);
      if (!blobRefsEqual(actual, ref)) {
        return Result.error(
          new FilesError('files_reference_mismatch', 'The requested blob reference does not match retained bytes', {
            details: { digest: ref.digest },
          }),
        );
      }
      /** Copies now so a later store close cannot affect an opened read. */
      const contentBytes = Uint8Array.from(stored);
      return Result.ok(Object.freeze({ ref, content: memoryBlobContent(contentBytes) }));
    },

    /**
     * Checks exact retained identity without exposing bytes.
     * @param proposedRef - Exact raw identity requested by the caller.
     * @returns Whether complete matching content is retained, or a stable failure.
     */
    async has(proposedRef: BlobRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Validates and copies the expected identity before lookup. */
      let ref: BlobRef;
      try {
        ref = BlobRefSchema.parse(proposedRef);
      } catch (error) {
        return Result.error(invalidInput(error));
      }
      /** A digest collision with a different length is not the requested object. */
      const stored = blobs.get(ref.digest);
      return Result.ok(stored !== undefined && blobRefsEqual(blobRefForBytes(stored), ref));
    },
  });

  /** Product-neutral canonical node operations over the private memory map. */
  const treeStore: TreeStore = Object.freeze({
    /**
     * Stores the unique v1 encoding derived from one admitted node.
     * @param node - Canonical directory value to encode and retain.
     * @returns Exact stored tree identity or a stable failure.
     */
    async put(node: DirectoryNode) {
      if (isClosed) return Result.error(storeClosed());
      try {
        /** Encoding revalidates canonical order and all nested references. */
        const bytes = encodeDirectoryNode(node);
        /** Decoder-backed reference construction proves those bytes are canonical. */
        const ref = treeRefForBytes(bytes);
        if (!trees.has(ref.digest)) trees.set(ref.digest, Uint8Array.from(bytes));
        return Result.ok(ref);
      } catch (error) {
        return Result.error(error instanceof FilesError ? error : invalidInput(error));
      }
    },

    /**
     * Restores one node only after exact reference and canonical-byte verification.
     * @param proposedRef - Exact encoded-directory identity requested by the caller.
     * @returns Immutable canonical node or a stable failure.
     */
    async get(proposedRef: TreeRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Validates and copies the expected identity before lookup. */
      let ref: TreeRef;
      try {
        ref = TreeRefSchema.parse(proposedRef);
      } catch (error) {
        return Result.error(invalidInput(error));
      }
      /** Selects by digest while retaining a distinct missing-content outcome. */
      const stored = trees.get(ref.digest);
      if (stored === undefined) {
        return Result.error(
          new FilesError('files_content_missing', 'The requested directory node is not retained', {
            details: { digest: ref.digest },
          }),
        );
      }
      try {
        /** Reconstructs actual identity from strict canonical bytes. */
        const actual = treeRefForBytes(stored);
        if (!treeRefsEqual(actual, ref)) {
          return Result.error(
            new FilesError('files_reference_mismatch', 'The requested tree reference does not match retained bytes', {
              details: { digest: ref.digest },
            }),
          );
        }
        /** Returns only the validated decoded value, never the retained byte array. */
        const decoded = decodeDirectoryNode(stored);
        return decoded.ok ? Result.ok(decoded.value) : decoded;
      } catch (error) {
        return Result.error(
          new FilesError('files_integrity_failed', 'Retained directory bytes failed verification', { cause: error }),
        );
      }
    },

    /**
     * Checks exact retained canonical identity without decoding into caller state.
     * @param proposedRef - Exact encoded-directory identity requested by the caller.
     * @returns Whether complete matching tree bytes are retained, or a stable failure.
     */
    async has(proposedRef: TreeRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Validates and copies the expected identity before lookup. */
      let ref: TreeRef;
      try {
        ref = TreeRefSchema.parse(proposedRef);
      } catch (error) {
        return Result.error(invalidInput(error));
      }
      /** Malformed retained bytes cannot satisfy an existence claim. */
      const stored = trees.get(ref.digest);
      if (stored === undefined) return Result.ok(false);
      try {
        return Result.ok(treeRefsEqual(treeRefForBytes(stored), ref));
      } catch {
        return Result.ok(false);
      }
    },
  });

  /** Retained aggregate whose closure releases both private maps together. */
  const store: FileStore = Object.freeze({
    blobs: blobStore,
    trees: treeStore,
    closed,
    /**
     * Clears retained memory exactly once and returns the canonical settlement.
     * @returns Exact shared close promise.
     */
    close() {
      if (!isClosed) {
        isClosed = true;
        blobs.clear();
        trees.clear();
        closeSettlement.resolve(CLOSED_EVIDENCE);
      }
      return closed;
    },
    /**
     * Makes explicit resource management equivalent to ordinary closure.
     * @returns Nothing after retained closure settles.
     */
    async [Symbol.asyncDispose]() {
      await store.close();
    },
  });
  return store;
}

/**
 * Publishes content-bearing files after proving the complete definition is valid.
 * @param store - Retained destination whose lifecycle remains with the caller.
 * @param sources - Logical files in any order with text, byte, or streaming content.
 * @returns Immutable root and flat file projection, or the first exact failure.
 */
export async function publishTree(
  store: FileStore,
  sources: readonly TreeFileSource[],
): Promise<ResultValue<ImmutableTree, FilesError>> {
  /** Admission is deliberately complete before the first source or store effect. */
  const admitted = admitTreeFileSources(sources);
  if (!admitted.ok) return admitted;
  /** Retains derived identities in canonical order for hierarchy publication. */
  const entries: TreeFileEntry[] = [];
  /** Stores raw content sequentially so source observation order is deterministic. */
  for (const source of admitted.value) {
    /** Derives exact raw identity at the storage boundary. */
    const put = await store.blobs.put(source.content);
    if (!put.ok) return put;
    entries.push(Object.freeze({ path: source.path, mode: source.mode, blob: put.value }));
  }
  return publishTreeEntries(store, entries);
}

/**
 * Inserts one immutable file into a construction-only hierarchical draft.
 * @param root - Root draft shared by one complete publication.
 * @param file - Admitted file whose path cannot conflict with its siblings.
 */
function insertDraftFile(root: TreeDraft, file: TreeFileEntry): void {
  /** Splits only Archer's canonical separator after complete path validation. */
  const segments = file.path.split('/').map((segment) => LogicalNameSchema.parse(segment));
  /** Descends through mutable drafts until the final regular-file child. */
  let directory = root;
  /** Visits every admitted segment in hierarchy order. */
  for (let index = 0; index < segments.length; index += 1) {
    /** Segment is in bounds because the loop uses the exact array length. */
    const name = segments[index] as LogicalName;
    /** Identifies the final segment without interpreting host path behavior. */
    const isFile = index === segments.length - 1;
    if (isFile) {
      directory.children.set(name, Object.freeze({ kind: 'file', file }));
      continue;
    }
    /** Reuses the one directory draft shared by every descendant path. */
    const existing = directory.children.get(name);
    if (existing?.kind === 'directory') {
      directory = existing.node;
      continue;
    }
    /** Creates one intermediate directory absent from the flat public input. */
    const child: TreeDraft = { children: new Map() };
    directory.children.set(name, Object.freeze({ kind: 'directory', node: child }));
    directory = child;
  }
}

/**
 * Publishes a draft bottom-up so every parent embeds exact child tree identity.
 * @param store - Destination for canonical directory nodes.
 * @param draft - Construction-only direct children for one logical directory.
 * @returns Exact reference to the published directory node.
 */
async function publishDraft(store: TreeStore, draft: TreeDraft): Promise<ResultValue<TreeRef, FilesError>> {
  /** Accumulates direct immutable children before canonical sorting and encoding. */
  const entries: DirectoryEntry[] = [];
  /** Resolves each child before its parent can receive a recursive reference. */
  for (const [name, child] of draft.children) {
    if (child.kind === 'file') {
      entries.push(Object.freeze({ kind: 'file', name, mode: child.file.mode, blob: child.file.blob }));
      continue;
    }
    /** Recursively publishes descendants before their direct directory entry. */
    const published = await publishDraft(store, child.node);
    if (!published.ok) return published;
    entries.push(Object.freeze({ kind: 'directory', name, tree: published.value }));
  }
  try {
    /** Canonical construction owns direct-child sorting and duplicate proof. */
    return store.put(createDirectoryNode(entries));
  } catch (error) {
    return Result.error(error instanceof FilesError ? error : invalidInput(error));
  }
}

/**
 * Publishes files whose raw content already exists in the paired blob store.
 * @param store - Retained destination whose lifecycle remains with the caller.
 * @param proposedEntries - Referenced logical files in any order.
 * @returns Immutable root and copied flat projection, or the first exact failure.
 */
export async function publishTreeEntries(
  store: FileStore,
  proposedEntries: readonly TreeFileEntry[],
): Promise<ResultValue<ImmutableTree, FilesError>> {
  /** Admits the complete path set before querying or writing storage. */
  const admitted = admitTreeFileEntries(proposedEntries);
  if (!admitted.ok) return admitted;
  /** Proves every referenced blob exists before the first directory-node write. */
  for (const file of admitted.value) {
    /** Checks the exact digest and byte length, not digest presence alone. */
    const present = await store.blobs.has(file.blob);
    if (!present.ok) return present;
    if (!present.value) {
      return Result.error(
        new FilesError('files_content_missing', 'A tree file references blob content that is not retained', {
          details: { path: file.path, digest: file.blob.digest },
        }),
      );
    }
  }
  /** Root draft starts empty so publishing zero files produces one valid empty tree. */
  const root: TreeDraft = { children: new Map() };
  /** Compiles the ergonomic flat projection into canonical hierarchical nodes. */
  for (const file of admitted.value) insertDraftFile(root, file);
  /** Publishes the complete hierarchy bottom-up under one immutable root identity. */
  const ref = await publishDraft(store.trees, root);
  if (!ref.ok) return ref;
  return Result.ok(Object.freeze({ ref: ref.value, files: admitted.value }));
}

/**
 * Restores every regular-file descendant under one canonical directory reference.
 * @param store - Source whose bytes and nodes must verify before use.
 * @param ref - Exact current directory identity.
 * @param prefix - Logical path segments preceding the current directory.
 * @param active - Ancestor digests used to reject a cyclic malicious graph.
 * @param files - Private flat projection populated only with verified leaves.
 * @returns Success after every descendant exists, or the first exact failure.
 */
async function restoreDirectory(
  store: FileStore,
  ref: TreeRef,
  prefix: readonly LogicalName[],
  active: Set<string>,
  files: TreeFileEntry[],
): Promise<ResultValue<void, FilesError>> {
  if (active.has(ref.digest)) {
    return Result.error(
      new FilesError('files_reference_mismatch', 'The directory graph contains a recursive reference', {
        details: { digest: ref.digest },
      }),
    );
  }
  active.add(ref.digest);
  try {
    /** Loads only through the verified tree-store boundary. */
    const loaded = await store.trees.get(ref);
    if (!loaded.ok) return loaded;
    /** Traverses canonical direct-child order to preserve deterministic projection. */
    for (const entry of loaded.value.entries) {
      /** Builds a product-neutral slash path from admitted direct names. */
      const pathSegments = [...prefix, entry.name];
      if (entry.kind === 'directory') {
        /** Keeps this digest active until all descendants finish verification. */
        const restored = await restoreDirectory(store, entry.tree, pathSegments, active, files);
        if (!restored.ok) return restored;
        continue;
      }
      /** Global path validation enforces the root `.archer` reservation on restore. */
      let path: LogicalPath;
      try {
        path = LogicalPathSchema.parse(pathSegments.join('/'));
      } catch (error) {
        return Result.error(
          new FilesError('files_reference_mismatch', 'A directory graph resolves to an invalid logical path', {
            cause: error,
          }),
        );
      }
      /** Proves the immutable tree is complete without eagerly reading file bytes. */
      const present = await store.blobs.has(entry.blob);
      if (!present.ok) return present;
      if (!present.value) {
        return Result.error(
          new FilesError('files_content_missing', 'A restored tree references blob content that is not retained', {
            details: { path, digest: entry.blob.digest },
          }),
        );
      }
      files.push(Object.freeze({ path, mode: entry.mode, blob: entry.blob }));
    }
    return Result.ok(undefined);
  } finally {
    active.delete(ref.digest);
  }
}

/**
 * Restores a flat immutable projection after verifying a complete tree graph.
 * @param store - Retained source whose lifecycle remains with the caller.
 * @param proposedRef - Exact root identity supplied by a caller or durable record.
 * @returns Verified immutable tree or the first exact graph/storage failure.
 */
export async function restoreTree(
  store: FileStore,
  proposedRef: TreeRef,
): Promise<ResultValue<ImmutableTree, FilesError>> {
  /** Copies the root identity before the first asynchronous operation. */
  let ref: TreeRef;
  try {
    ref = TreeRefSchema.parse(proposedRef);
  } catch (error) {
    return Result.error(invalidInput(error));
  }
  /** Receives verified leaves without exposing partial state on failure. */
  const files: TreeFileEntry[] = [];
  /** Tracks only active ancestors so legitimate structural sharing remains valid. */
  const restored = await restoreDirectory(store, ref, [], new Set(), files);
  if (!restored.ok) return restored;
  files.sort((left, right) => compareLogicalPaths(left.path, right.path));
  return Result.ok(Object.freeze({ ref, files: Object.freeze([...files]) }));
}
