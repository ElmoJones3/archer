/**
 * @file Implements a tiny named snapshot cache over Archer's local file store.
 *
 * The application owns mutable aliases. Archer owns immutable object identity,
 * persistence, canonical trees, and verified reads beneath each alias.
 */

import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  FileMode,
  TreeRefSchema,
  publishTree,
  restoreTree,
  type BlobRead,
  type TreeFileSource,
  type TreeRef,
} from '@archer/files';
import { fileTreeStore } from '@archer/files/fs';

/** Input shared by commands that reopen one named snapshot. */
export type NamedSnapshotInput = Readonly<{
  /** Directory retaining application aliases and Archer content-addressed objects. */
  cacheRoot: string;
  /** Stable caller-selected alias that never contains path separators. */
  name: string;
}>;

/** Input that publishes a real host directory under a new immutable alias. */
export type SaveSnapshotInput = NamedSnapshotInput &
  Readonly<{
    /** Mutable host directory captured at command time. */
    sourceDirectory: string;
  }>;

/** Input that reads one logical file from a previously named snapshot. */
export type ReadSnapshotFileInput = NamedSnapshotInput &
  Readonly<{
    /** Logical path inside the immutable snapshot. */
    path: string;
  }>;

/** Application receipt returned after a new named snapshot becomes reopenable. */
export type SavedSnapshot = Readonly<{
  /** Stable caller-selected alias written by the application. */
  name: string;
  /** Canonical immutable tree retained by Archer's local store. */
  root: TreeRef;
  /** Canonical logical paths captured from the source directory. */
  files: readonly string[];
}>;

/** The alias grammar prevents user input from escaping the application refs directory. */
const SNAPSHOT_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

/** Physical namespaces separating immutable content from mutable application aliases. */
type CachePaths = Readonly<{
  /** Directory Archer owns as a content-addressed filesystem store. */
  objects: string;
  /** Directory this application owns as create-only named references. */
  refs: string;
}>;

/**
 * Admits one alias before it becomes part of a host path.
 * @param name - Caller-selected snapshot name.
 * @returns The unchanged safe alias.
 */
function snapshotName(name: string): string {
  if (!SNAPSHOT_NAME.test(name)) {
    throw new RangeError('Snapshot names use 1-128 lowercase letters, numbers, dots, underscores, or hyphens');
  }
  return name;
}

/**
 * Resolves the two physical namespaces the application keeps deliberately separate.
 * @param cacheRoot - Caller-owned cache directory.
 * @returns Archer object storage and application alias locations.
 */
function cachePaths(cacheRoot: string): CachePaths {
  /** One absolute root prevents process working-directory changes from splitting a command. */
  const root = resolve(cacheRoot);
  return Object.freeze({ objects: join(root, 'objects'), refs: join(root, 'refs') });
}

/**
 * Reads regular files from a host directory for immutable publication.
 * @param physicalRoot - Absolute source root selected by the caller.
 * @param segments - Relative path segments already traversed.
 * @returns Complete publication inputs below the current directory.
 */
async function collectFiles(
  physicalRoot: string,
  segments: readonly string[] = [],
): Promise<readonly TreeFileSource[]> {
  /** Sorted traversal keeps failures stable even though tree publication canonicalizes input order. */
  const entries = (await readdir(join(physicalRoot, ...segments), { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  /** Files accumulate only after each host entry is classified. */
  const files: TreeFileSource[] = [];
  /** Every entry is admitted as a directory or regular file before content is read. */
  for (const entry of entries) {
    /** Relative segments remain separate until they cross into logical path syntax. */
    const childSegments = [...segments, entry.name];
    /** Absolute path is used only for host inspection and reading. */
    const child = join(physicalRoot, ...childSegments);
    /** `lstat` ensures an observed symbolic link is not silently followed. */
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Snapshots reject symbolic links: ${childSegments.join('/')}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectFiles(physicalRoot, childSegments)));
      continue;
    }
    if (!metadata.isFile()) throw new Error(`Snapshots accept regular files only: ${childSegments.join('/')}`);
    files.push(
      Object.freeze({
        path: childSegments.join('/'),
        content: await readFile(child),
        mode: (metadata.mode & 0o111) === 0 ? FileMode.readable : FileMode.executable,
      }),
    );
  }
  return Object.freeze(files);
}

/**
 * Loads and validates one application alias before Archer sees its tree identity.
 * @param refs - Absolute application reference directory.
 * @param name - Already-admitted snapshot alias.
 * @returns Exact immutable root stored under that alias.
 */
async function readNamedRef(refs: string, name: string): Promise<TreeRef> {
  /** JSON is an application indexing format and never participates in Archer identity. */
  const encoded = await readFile(join(refs, `${name}.json`), 'utf8');
  return TreeRefSchema.parse(JSON.parse(encoded));
}

/**
 * Collects a verification-bearing blob stream into caller-owned bytes.
 * @param read - Exact blob read opened by Archer's filesystem store.
 * @returns Complete bytes after terminal digest and length verification.
 */
async function collectBlob(read: BlobRead): Promise<Uint8Array> {
  /** Chunks are copied so the result cannot alias adapter buffers. */
  const chunks: Uint8Array[] = [];
  /** Exact byte count controls one final contiguous allocation. */
  let length = 0;
  /** Each verified stream chunk is copied before advancing the source iterator. */
  for await (const chunk of read.content) {
    /** Each copy remains valid after the stream advances. */
    const copied = Uint8Array.from(chunk);
    chunks.push(copied);
    length += copied.byteLength;
  }
  /** The returned value belongs entirely to the application caller. */
  const bytes = new Uint8Array(length);
  /** Offset preserves verified stream order during flattening. */
  let offset = 0;
  /** Copied chunks are concatenated in the exact order verified by the store. */
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Saves one immutable named snapshot without allowing an alias to move silently.
 * @param input - Cache location, new alias, and mutable source directory.
 * @returns Named root and canonical logical file list.
 */
export async function saveSnapshot(input: SaveSnapshotInput): Promise<SavedSnapshot> {
  /** Alias admission occurs before storage or host traversal effects. */
  const name = snapshotName(input.name);
  /** Physical namespaces stay stable throughout this save operation. */
  const paths = cachePaths(input.cacheRoot);
  /** Source bytes are captured before the store attachment gains ownership. */
  const sources = await collectFiles(resolve(input.sourceDirectory));
  /** The application owns this attachment and closes it after alias publication. */
  const opened = await fileTreeStore({ root: paths.objects });
  if (!opened.ok) throw opened.error;
  /** Retained store supplies durable verified objects for the named root. */
  const store = opened.value;
  try {
    /** Archer creates canonical objects independently from the mutable alias. */
    const published = await publishTree(store, sources);
    if (!published.ok) throw published.error;
    await mkdir(paths.refs, { recursive: true });
    /** Create-only aliasing prevents a familiar name from changing meaning accidentally. */
    await writeFile(join(paths.refs, `${name}.json`), `${JSON.stringify(published.value.ref)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return Object.freeze({
      name,
      root: published.value.ref,
      files: Object.freeze(published.value.files.map((file) => file.path)),
    });
  } finally {
    await store.close();
  }
}

/**
 * Lists logical files from one retained named snapshot.
 * @param input - Cache location and existing alias.
 * @returns Canonical logical paths in the immutable snapshot.
 */
export async function listSnapshot(input: NamedSnapshotInput): Promise<readonly string[]> {
  /** Both the alias and store attachment are reopened for this independent command. */
  const name = snapshotName(input.name);
  /** Application and object namespaces derive from one caller-selected cache. */
  const paths = cachePaths(input.cacheRoot);
  /** The alias is read before opening the object store because it carries no store authority. */
  const root = await readNamedRef(paths.refs, name);
  /** A new attachment proves listing does not rely on retained JavaScript state. */
  const opened = await fileTreeStore({ root: paths.objects });
  if (!opened.ok) throw opened.error;
  /** Store ownership is bounded to this one list command. */
  const store = opened.value;
  try {
    /** Restore verifies the named root and every referenced object. */
    const restored = await restoreTree(store, root);
    if (!restored.ok) throw restored.error;
    return Object.freeze(restored.value.files.map((file) => file.path));
  } finally {
    await store.close();
  }
}

/**
 * Reads exact bytes from one retained named snapshot.
 * @param input - Cache location, existing alias, and logical file path.
 * @returns Complete verified file bytes owned by the caller.
 */
export async function readSnapshotFile(input: ReadSnapshotFileInput): Promise<Uint8Array> {
  /** Alias admission prevents a name from redirecting the refs lookup. */
  const name = snapshotName(input.name);
  /** One physical cache selection remains fixed for alias and object reads. */
  const paths = cachePaths(input.cacheRoot);
  /** Validated tree identity selects immutable content, not the current source directory. */
  const root = await readNamedRef(paths.refs, name);
  /** An independent attachment owns all verification work for this command. */
  const opened = await fileTreeStore({ root: paths.objects });
  if (!opened.ok) throw opened.error;
  /** The command closes this handle after the requested bytes are fully collected. */
  const store = opened.value;
  try {
    /** Full restore verifies that the named snapshot is internally reachable. */
    const restored = await restoreTree(store, root);
    if (!restored.ok) throw restored.error;
    /** Logical lookup avoids depending on the store's private disk layout. */
    const file = restored.value.files.find((entry) => entry.path === input.path);
    if (file === undefined) throw new Error(`Snapshot file does not exist: ${input.path}`);
    /** Terminal stream consumption verifies bytes before they escape the command. */
    const read = await store.blobs.read(file.blob);
    if (!read.ok) throw read.error;
    return await collectBlob(read.value);
  } finally {
    await store.close();
  }
}
