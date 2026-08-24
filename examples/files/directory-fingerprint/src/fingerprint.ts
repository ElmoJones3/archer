/**
 * @file Turns a host directory into one reproducible content fingerprint.
 *
 * Host traversal belongs to this application. Archer receives regular files
 * with logical paths and owns their portable mode, blob, and Merkle identities.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  FileMode,
  memoryFileStore,
  publishTree,
  type ImmutableTree,
  type TreeFileSource,
  type TreeRef,
} from '@archer/files';

/** Application result that identifies the exact logical contents of one host directory. */
export type DirectoryFingerprint = Readonly<{
  /** Canonical root identity suitable for cache keys and change detection. */
  root: TreeRef;
  /** Canonical files retain content identities for file-level comparisons. */
  files: ImmutableTree['files'];
  /** Exact aggregate source byte count avoids JavaScript number rounding. */
  totalBytes: string;
}>;

/**
 * Collects regular files without allowing host-specific links into logical identity.
 * @param physicalRoot - Absolute directory chosen by the application caller.
 * @param segments - Relative path segments already traversed beneath that root.
 * @returns Complete file sources below the current directory.
 */
async function collectFiles(
  physicalRoot: string,
  segments: readonly string[] = [],
): Promise<readonly TreeFileSource[]> {
  /** Resolves only from caller-owned segments, never from a logical path supplied by a model. */
  const directory = join(physicalRoot, ...segments);
  /** Sorting keeps filesystem reads and failures stable even though Archer canonicalizes publication. */
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  /** Accumulates immutable publication inputs while preserving directory traversal order. */
  const files: TreeFileSource[] = [];

  /** Every directory entry is classified before any host bytes become logical file content. */
  for (const entry of entries) {
    /** Relative segments become forward-slash logical paths only after host traversal succeeds. */
    const childSegments = [...segments, entry.name];
    /** Absolute paths remain private to this ingestion function. */
    const child = join(physicalRoot, ...childSegments);
    /** `lstat` prevents an observed link from being followed as ordinary file content. */
    const metadata = await lstat(child);

    if (metadata.isSymbolicLink()) {
      throw new Error(`Directory fingerprints reject symbolic links: ${childSegments.join('/')}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectFiles(physicalRoot, childSegments)));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Directory fingerprints accept regular files only: ${childSegments.join('/')}`);
    }

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
 * Fingerprints a real host directory through Archer's canonical tree grammar.
 * @param root - Host directory whose regular files define the application input.
 * @returns Canonical directory identity and file-level content identities.
 */
export async function fingerprintDirectory(root: string): Promise<DirectoryFingerprint> {
  /** Resolving once keeps recursive joins anchored to the caller's selected directory. */
  const physicalRoot = resolve(root);
  /** The memory store is sufficient because the application keeps only derived identities. */
  const store = memoryFileStore();
  try {
    /** Real host bytes cross into Archer only after the application has classified every entry. */
    const sources = await collectFiles(physicalRoot);
    /** Publication owns path admission, hashing, canonical hierarchy, and ordering. */
    const published = await publishTree(store, sources);
    if (!published.ok) throw published.error;
    /** Exact decimal lengths remain precise even when a directory exceeds safe integer range. */
    const totalBytes = published.value.files.reduce((total, file) => total + BigInt(file.blob.byteLength), 0n);
    return Object.freeze({
      root: published.value.ref,
      files: published.value.files,
      totalBytes: totalBytes.toString(),
    });
  } finally {
    await store.close();
  }
}
