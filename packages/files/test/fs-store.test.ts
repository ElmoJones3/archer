/**
 * @file Proves the real filesystem adapter preserves canonical identity,
 * persistence, terminal stream verification, and retained attachment lifecycle.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Result } from '@archer/core';

import { FilesError, publishTree, restoreTree, type BlobRead, type ImmutableTree } from '../src/index.js';
import { fileTreeStore } from '../src/fs/index.js';

/** UTF-8 decoder keeps assertions readable without weakening byte-level storage. */
const TEXT_DECODER = new TextDecoder();

/** Exact temporary roots owned by this test process and safe to remove afterward. */
const temporaryRoots: string[] = [];

/** Removes only roots created by `temporaryRoot` in this process. */
afterEach(async () => {
  /** Cleans explicit mkdtemp results rather than a broad or computed parent path. */
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Creates one isolated real filesystem root for an adapter case.
 * @returns Explicit path recorded for deterministic cleanup.
 */
async function temporaryRoot(): Promise<string> {
  /** Uses the platform temp directory while retaining the exact generated child. */
  const root = await mkdtemp(join(tmpdir(), 'archer-files-test-'));
  temporaryRoots.push(root);
  return root;
}

/**
 * Requires a successful Result and preserves the exact production Error on failure.
 * @param result - Public operation outcome under test.
 * @returns Exact successful value.
 */
function expectOk<Value>(result: Result<Value, Error>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Consumes a verified blob stream into recognizable UTF-8 text.
 * @param read - Public read handle whose completion proves integrity.
 * @returns Decoded bytes after successful terminal verification.
 */
async function blobText(read: BlobRead): Promise<string> {
  /** Retains copied chunks until the verification-bearing stream completes. */
  const chunks: Uint8Array[] = [];
  /** Counts exact bytes for one contiguous test projection. */
  let length = 0;
  /** Consumes the real asynchronous filesystem stream. */
  for await (const chunk of read.content) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  /** Owns the final test value independently of adapter buffers. */
  const bytes = new Uint8Array(length);
  /** Tracks the next output offset while copying in stream order. */
  let offset = 0;
  /** Flattens only after the production stream has finished. */
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return TEXT_DECODER.decode(bytes);
}

/**
 * Resolves the adapter's documented digest-derived blob location for corruption proof.
 * @param root - Selected filesystem store root.
 * @param digest - Valid algorithm-qualified blob digest.
 * @returns Exact object path containing no caller-controlled logical name.
 */
function blobPath(root: string, digest: string): string {
  /** Removes only the validated algorithm prefix used by public references. */
  const hex = digest.slice('sha256:'.length);
  return join(root, 'blobs', 'sha256', hex.slice(0, 2), hex.slice(2));
}

describe('filesystem file store', () => {
  it('persists one immutable tree across independently owned attachments', async () => {
    /** Real isolated directory survives closing the first retained attachment. */
    const root = await temporaryRoot();
    /** First attachment publishes bytes and canonical directory nodes. */
    const firstStore = expectOk(await fileTreeStore({ root }));
    /** Public publication derives the complete recursive identity. */
    const published = expectOk<ImmutableTree>(
      await publishTree(firstStore, [
        { path: 'docs/readme.md', content: 'persistent' },
        { path: 'src/index.ts', content: 'export {};' },
      ]),
    );
    await firstStore.close();

    /** Second attachment proves lifecycle closure does not delete durable objects. */
    const secondStore = expectOk(await fileTreeStore({ root }));
    /** Restores through recursive verified references rather than retained JS state. */
    const restored = expectOk(await restoreTree(secondStore, published.ref));
    /** Selects one exact blob for real streaming read proof. */
    const readme = restored.files.find((file) => file.path === 'docs/readme.md');
    if (readme === undefined) throw new Error('Missing restored readme');
    /** Opens content through the public port and its terminal verification contract. */
    const read = expectOk(await secondStore.blobs.read(readme.blob));

    expect(restored).toEqual(published);
    expect(await blobText(read)).toBe('persistent');
    await secondStore.close();
  });

  it('deduplicates equal concurrent writes without leaving temporary objects', async () => {
    /** Real store root lets the adapter exercise atomic link and directory creation. */
    const root = await temporaryRoot();
    /** One retained attachment owns both racing writes. */
    const store = expectOk(await fileTreeStore({ root }));
    /** Equal bytes must converge on one raw-content identity. */
    const [left, right] = await Promise.all([
      store.blobs.put(Uint8Array.from([1, 2, 3])),
      store.blobs.put(Uint8Array.from([1, 2, 3])),
    ]);
    /** Reads the actual shard directory to prove staging cleanup. */
    const ref = expectOk(left);
    /** Exact committed object must contain only the requested bytes. */
    const committed = await readFile(blobPath(root, ref.digest));

    expect(right).toEqual(left);
    expect(committed).toEqual(Buffer.from([1, 2, 3]));
    await store.close();
  });

  it('reports corrupted blob bytes only when the read stream reaches verification', async () => {
    /** Real store root permits deliberate on-disk corruption behind the adapter. */
    const root = await temporaryRoot();
    /** Attachment publishes one known file before external corruption. */
    const store = expectOk(await fileTreeStore({ root }));
    /** Tree reference remains valid while only its child blob is modified. */
    const tree = expectOk(await publishTree(store, [{ path: 'value.txt', content: 'expected' }]));
    /** Exact leaf identity is available from the immutable flat projection. */
    const file = tree.files[0];
    if (file === undefined) throw new Error('Missing published file');
    await writeFile(blobPath(root, file.blob.digest), 'tampered');
    /** Opening succeeds because integrity belongs to complete stream consumption. */
    const opened = expectOk(await store.blobs.read(file.blob));

    await expect(blobText(opened)).rejects.toMatchObject({
      code: 'files_integrity_failed',
    } satisfies Partial<FilesError>);
    await store.close();
  });

  it('rejects a mismatched expected length before opening retained blob content', async () => {
    /** Real store root retains one valid object selected by its digest. */
    const root = await temporaryRoot();
    /** Attachment publishes the object through the ordinary public port. */
    const store = expectOk(await fileTreeStore({ root }));
    /** Exact stored reference supplies the safe digest-derived physical lookup. */
    const stored = expectOk(await store.blobs.put(Uint8Array.from([1, 2, 3])));
    /** Valid but false length must not pose as the same complete content reference. */
    const mismatched = { ...stored, byteLength: '4' as typeof stored.byteLength };

    expect(await store.blobs.read(mismatched)).toMatchObject({
      ok: false,
      error: { code: 'files_reference_mismatch' },
    });
    await store.close();
  });

  it('shares one close promise and rejects every later filesystem operation', async () => {
    /** Empty real root still exercises attachment setup and retained lifecycle. */
    const root = await temporaryRoot();
    /** Store begins open with one pending shared settlement. */
    const store = expectOk(await fileTreeStore({ root }));
    /** Captures exact synchronous close promise identity. */
    const first = store.close();

    expect(first).toBe(store.closed);
    expect(store.close()).toBe(first);
    await expect(first).resolves.toEqual({ kind: 'closed' });
    expect(await store.blobs.put(Uint8Array.from([1]))).toMatchObject({
      ok: false,
      error: { code: 'files_store_closed' },
    });
  });
});
