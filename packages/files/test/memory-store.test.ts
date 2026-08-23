/**
 * @file Proves managed immutable-tree publication, structural sharing, verified
 * streaming reads, validation-before-effects, and retained memory-store cleanup.
 */

import { describe, expect, it } from 'vitest';

import type { Result } from '@archer/core';

import {
  FileMode,
  LogicalPathSchema,
  blobRefForBytes,
  memoryFileStore,
  publishTree,
  restoreTree,
  type BlobRead,
  type FileStore,
  type ImmutableTree,
} from '../src/index.js';

/** Shared UTF-8 boundary for recognizable example file content. */
const TEXT_ENCODER = new TextEncoder();

/**
 * Requires one successful Result without hiding the action or expected value.
 * @param result - Result returned by the production path under test.
 * @returns Exact success payload.
 */
function expectOk<Value>(result: Result<Value, Error>): Value {
  if (!result.ok) throw result.error;
  return result.value as Value;
}

/**
 * Consumes a production blob stream through normal iteration to earn verification.
 * @param read - Read handle returned by the selected BlobStore.
 * @returns Concatenated copied bytes after terminal digest verification.
 */
async function collectBlob(read: BlobRead): Promise<Uint8Array> {
  /** Retains copied chunks until the verified stream reaches completion. */
  const chunks: Uint8Array[] = [];
  /** Counts exact output bytes without trusting the declared reference. */
  let length = 0;
  /** Consumes through the public asynchronous content boundary. */
  for await (const chunk of read.content) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  /** Owns the final contiguous value independently of yielded chunk storage. */
  const output = new Uint8Array(length);
  /** Tracks the next output position while preserving source chunk order. */
  let offset = 0;
  /** Copies every verified chunk into its exact final position. */
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Looks up one direct child directory from a restored canonical root node.
 * @param store - Store that owns the root node bytes.
 * @param tree - Published immutable tree whose root must exist.
 * @param name - Direct directory name selected for structural-sharing proof.
 * @returns Child tree digest under the named root entry.
 */
async function childDigest(store: FileStore, tree: ImmutableTree, name: string): Promise<string> {
  /** Loads through the public tree store so digest verification remains in scope. */
  const loaded = await store.trees.get(tree.ref);
  if (!loaded.ok) throw loaded.error;
  /** Finds the recognizable child without assuming its array offset. */
  const child = loaded.value.entries.find((entry) => entry.kind === 'directory' && entry.name === name);
  if (child?.kind !== 'directory') throw new Error(`Missing directory child: ${name}`);
  return child.tree.digest;
}

describe('memory file store', () => {
  it('publishes and restores normalized files independent of caller order', async () => {
    /** Retained store owns all bytes written by this case. */
    const store = memoryFileStore();
    /** Keeps caller-owned binary content recognizable after a later mutation. */
    const binary = Uint8Array.from([0, 1, 2, 255]);
    /** Publishes deliberately reversed and decomposed logical input. */
    const first = expectOk<ImmutableTree>(
      await publishTree(store, [
        { path: 'src/tool.sh', content: '#!/bin/sh\n', mode: FileMode.executable },
        { path: 'docs/e\u0301.txt', content: binary },
      ]),
    );
    binary.fill(9);
    /** Publishes the same logical files in another order to prove identity convergence. */
    const second = expectOk<ImmutableTree>(
      await publishTree(store, [
        { path: 'docs/é.txt', content: Uint8Array.from([0, 1, 2, 255]) },
        { path: 'src/tool.sh', content: '#!/bin/sh\n', mode: FileMode.executable },
      ]),
    );
    /** Restores the first root through recursive canonical references. */
    const restoredResult = await restoreTree(store, first.ref);
    if (!restoredResult.ok) throw restoredResult.error;
    /** Reads the binary entry through terminal hash verification. */
    const binaryEntry = restoredResult.value.files.find((entry) => entry.path === 'docs/é.txt');
    if (binaryEntry === undefined) throw new Error('Missing restored binary entry');
    /** Opens only the exact restored reference. */
    const readResult = await store.blobs.read(binaryEntry.blob);
    if (!readResult.ok) throw readResult.error;

    expect(second.ref).toEqual(first.ref);
    expect(restoredResult.value).toEqual(first);
    expect(restoredResult.value.files.map((entry) => entry.path)).toEqual(['docs/é.txt', 'src/tool.sh']);
    expect(restoredResult.value.files[1]?.mode).toBe(FileMode.executable);
    expect(await collectBlob(readResult.value)).toEqual(Uint8Array.from([0, 1, 2, 255]));
    await store.close();
  });

  it('retains unchanged subtrees when one file changes', async () => {
    /** Store deduplicates exact blobs and directory nodes across both publications. */
    const store = memoryFileStore();
    /** Establishes two independent directory branches through production publication. */
    const before = expectOk<ImmutableTree>(
      await publishTree(store, [
        { path: 'docs/readme.md', content: 'stable' },
        { path: 'src/index.ts', content: 'before' },
      ]),
    );
    /** Changes only the source branch while republishing the same docs bytes. */
    const after = expectOk<ImmutableTree>(
      await publishTree(store, [
        { path: 'src/index.ts', content: 'after' },
        { path: 'docs/readme.md', content: 'stable' },
      ]),
    );

    expect(after.ref.digest).not.toBe(before.ref.digest);
    expect(await childDigest(store, after, 'docs')).toBe(await childDigest(store, before, 'docs'));
    expect(await childDigest(store, after, 'src')).not.toBe(await childDigest(store, before, 'src'));
    await store.close();
  });

  it('rejects duplicate and file-parent paths before consuming any source', async () => {
    /** Store remains available after both pure admission failures. */
    const store = memoryFileStore();
    /** Counts generator activation so validation-before-effects is directly observable. */
    let consumed = 0;
    /** Source would reveal an ordering bug if publication reads before path admission. */
    const content: AsyncIterable<Uint8Array> = {
      /**
       * Produces content only if publication incorrectly reaches the effect boundary.
       * @yields {Uint8Array} Recognizable bytes that must remain unconsumed.
       */
      async *[Symbol.asyncIterator]() {
        consumed += 1;
        yield TEXT_ENCODER.encode('should not be consumed');
      },
    };
    /** Uses canonical equivalents to reach duplicate detection after normalization. */
    const duplicate = await publishTree(store, [
      { path: 'e\u0301.txt', content },
      { path: 'é.txt', content: 'duplicate' },
    ]);
    /** Uses a regular file as the parent of another proposed regular file. */
    const conflict = await publishTree(store, [
      { path: 'src', content },
      { path: 'src/index.ts', content: 'child' },
    ]);
    /** References the content that would exist only if the rejected source ran. */
    const absent = await store.blobs.has(blobRefForBytes(TEXT_ENCODER.encode('should not be consumed')));

    expect(duplicate).toMatchObject({ ok: false, error: { code: 'files_duplicate_path' } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'files_path_conflict' } });
    expect(consumed).toBe(0);
    expect(absent).toEqual({ ok: true, value: false });
    await store.close();
  });

  it('rejects a file parent even when another sorted path separates its child', async () => {
    /** Store exposes whether a non-adjacent prefix escaped pure path-set admission. */
    const store = memoryFileStore();
    /** `src-a` sorts between `src` and `src/index.ts` in UTF-8 byte order. */
    const conflict = await publishTree(store, [
      { path: 'src', content: 'file parent' },
      { path: 'src-a', content: 'sorting separator' },
      { path: 'src/index.ts', content: 'impossible child' },
    ]);

    expect(conflict).toMatchObject({ ok: false, error: { code: 'files_path_conflict' } });
    await store.close();
  });

  it('shares one idempotent close and rejects later operations', async () => {
    /** Store begins open with a pending shared close settlement. */
    const store = memoryFileStore();
    /** Captures both calls before either can be mistaken for separate cleanup. */
    const firstClose = store.close();
    /** Repeated close must return the exact shared Promise. */
    const secondClose = store.close();

    expect(firstClose).toBe(store.closed);
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toEqual({ kind: 'closed' });
    expect(await store.blobs.has(blobRefForBytes(TEXT_ENCODER.encode('late')))).toMatchObject({
      ok: false,
      error: { code: 'files_store_closed' },
    });
    expect(await publishTree(store, [{ path: LogicalPathSchema.parse('late.txt'), content: 'late' }])).toMatchObject({
      ok: false,
      error: { code: 'files_store_closed' },
    });
  });
});
