/**
 * @file Demonstrates durable local persistence through the optional filesystem
 * adapter while the root package retains all immutable identity semantics.
 */

import { blobRefForBytes, publishTree, restoreTree, type BlobRead } from '@archer/files';
import { fileTreeStore } from '@archer/files/fs';

/** UTF-8 codec keeps the example's recognizable content boundary explicit. */
const TEXT_DECODER = new TextDecoder();

/** Portable evidence returned by one local-store demonstration. */
export type LocalStoreDemoResult = Readonly<{
  /** Confirms a second attachment restored the first attachment's exact root. */
  persisted: boolean;

  /** File text read through the verification-bearing stream. */
  content: string;

  /** Stable missing-content category from a valid absent reference. */
  missingCode: string;

  /** Confirms both retained attachments closed normally. */
  closed: boolean;
}>;

/** Minimal Result shape consumed without importing a later layer or hidden helper. */
type ExampleResult<Value> =
  | Readonly<{
      /** Selects the successful branch. */
      ok: true;

      /** Carries the exact successful public value. */
      value: Value;
    }>
  | Readonly<{
      /** Selects the failed branch. */
      ok: false;

      /** Preserves the exact public Error instance. */
      error: Error;
    }>;

/**
 * Requires a successful Result while preserving the exact Error on failure.
 * @param result - Public operation outcome.
 * @returns Exact successful payload.
 */
function expectOk<Value>(result: ExampleResult<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Drains one verified read into UTF-8 example text.
 * @param read - Public blob read whose terminal iteration proves identity.
 * @returns Decoded complete content.
 */
async function readText(read: BlobRead): Promise<string> {
  /** Retains copied stream chunks until terminal verification succeeds. */
  const chunks: Uint8Array[] = [];
  /** Counts exact output bytes for a contiguous example projection. */
  let length = 0;
  /** Consumes every byte through the adapter's public stream. */
  for await (const chunk of read.content) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  /** Owns final bytes independently of adapter buffers. */
  const bytes = new Uint8Array(length);
  /** Tracks the next output offset in stream order. */
  let offset = 0;
  /** Flattens chunks only after successful stream completion. */
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return TEXT_DECODER.decode(bytes);
}

/**
 * Runs durable publication and reopen against a caller-owned directory.
 * @param root - Physical adapter root prepared and cleaned by the caller.
 * @returns Persistence, verified content, failure, and cleanup evidence.
 */
export async function localStoreDemo(root: string): Promise<LocalStoreDemoResult> {
  /** First attachment owns publication lifecycle but not durable object lifetime. */
  const first = expectOk(await fileTreeStore({ root }));
  /** Publishes identity through root contracts over the selected physical adapter. */
  const published = expectOk(await publishTree(first, [{ path: 'message.txt', content: 'survives close' }]));
  /** Closing detaches without deleting content-addressed objects. */
  const firstClose = await first.close();

  /** Independent attachment proves persistence is not retained JavaScript state. */
  const second = expectOk(await fileTreeStore({ root }));
  /** Recursively verifies canonical nodes and blob reachability on restore. */
  const restored = expectOk(await restoreTree(second, published.ref));
  /** Selects the one published file without assuming external storage layout. */
  const file = restored.files[0];
  if (file === undefined) throw new Error('Missing restored file');
  /** Opens a terminal-verification stream for the exact restored identity. */
  const content = await readText(expectOk(await second.blobs.read(file.blob)));
  /** A valid reference to absent bytes earns the stable missing-content outcome. */
  const absentRef = blobRefForBytes(new TextEncoder().encode('not stored'));
  /** Reads through the ordinary public failure boundary. */
  const missing = await second.blobs.read(absentRef);
  /** Releases only the second attachment after all evidence is observed. */
  const secondClose = await second.close();
  return Object.freeze({
    persisted: restored.ref.digest === published.ref.digest,
    content,
    missingCode: missing.ok ? 'unexpected-success' : missing.error.code,
    closed: firstClose.kind === 'closed' && secondClose.kind === 'closed',
  });
}
