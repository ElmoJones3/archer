/**
 * @file Publishes the versioned behavior suite every FileStore must pass.
 *
 * The runner exercises only public ports and owns each attachment it opens. It
 * therefore applies unchanged to first-party and independent implementations.
 */

import { toPublicError, type PublicError, type Result as ResultValue } from '@archer/core';

import { blobRefForBytes } from './encoding.js';
import { FilesError } from './errors.js';
import { publishTree, restoreTree, type BlobRead, type FileStore } from './store.js';

/** Current required FileStore behavior catalogue. */
export const FILE_STORE_CONFORMANCE_VERSION = 1 as const;

/** Stable identities for every required v1 FileStore behavior. */
export type FileStoreConformanceCaseId =
  'blob-round-trip' | 'source-failure-atomicity' | 'tree-round-trip' | 'missing-content' | 'retained-lifecycle';

/** Ordered required cases published as part of the adapter protocol. */
export const FILE_STORE_CONFORMANCE_CASES: readonly FileStoreConformanceCaseId[] = Object.freeze([
  'blob-round-trip',
  'source-failure-atomicity',
  'tree-round-trip',
  'missing-content',
  'retained-lifecycle',
]);

/** Construction boundary supplied by one candidate FileStore implementation. */
export type FileStoreConformanceTarget = Readonly<{
  /** Human-readable implementation name retained in the report. */
  name: string;

  /** Opens one independent retained attachment for each required case. */
  open(): Promise<ResultValue<FileStore, FilesError>>;
}>;

/** Successful execution evidence for one required behavior. */
export type PassedFileStoreConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: FileStoreConformanceCaseId;

  /** Confirms this exact case completed without a failed claim. */
  status: 'passed';
}>;

/** Failed execution evidence with bounded public identity. */
export type FailedFileStoreConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: FileStoreConformanceCaseId;

  /** Confirms the runner executed this exact case and observed failure. */
  status: 'failed';

  /** Redacted portable failure suitable for CI report serialization. */
  failure: PublicError;
}>;

/** Complete result of one required FileStore behavior. */
export type FileStoreConformanceCaseResult = PassedFileStoreConformanceCase | FailedFileStoreConformanceCase;

/** Exact execution accounting that cannot hide an unexecuted required case. */
export type FileStoreConformanceExecution = Readonly<{
  /** Published required case count for this suite version. */
  required: number;

  /** Number of required cases that produced a result. */
  executed: number;

  /** Required cases not executed for any reason. */
  skipped: number;
}>;

/** Portable complete report returned by the v1 conformance runner. */
export type FileStoreConformanceReport = Readonly<{
  /** Pins interpretation to one immutable required-case catalogue. */
  version: typeof FILE_STORE_CONFORMANCE_VERSION;

  /** Identifies the candidate implementation supplied by its author. */
  implementation: string;

  /** Passes only when every required case executed and passed. */
  status: 'passed' | 'failed';

  /** Prevents a partial run from posing as passing evidence. */
  execution: FileStoreConformanceExecution;

  /** Contains exactly one ordered result per executed required case. */
  cases: readonly FileStoreConformanceCaseResult[];
}>;

/** UTF-8 encoder supplies recognizable raw bytes to every implementation. */
const TEXT_ENCODER = new TextEncoder();

/**
 * Raises one Archer-owned conformance failure when a behavioral claim is false.
 * @param condition - Exact production observation under evaluation.
 * @param message - Catalogue-owned explanation with no adapter data.
 */
function requireClaim(condition: boolean, message: string): asserts condition {
  if (!condition) throw new FilesError('files_integrity_failed', message);
}

/**
 * Consumes one public read through its terminal verification boundary.
 * @param read - Blob stream opened by the candidate implementation.
 * @returns Complete copied bytes after successful terminal verification.
 */
async function collect(read: BlobRead): Promise<Uint8Array> {
  /** Retains independent chunks only for this bounded conformance fixture. */
  const chunks: Uint8Array[] = [];
  /** Counts exact output length for final concatenation. */
  let length = 0;
  /** Consumes the ordinary public asynchronous iterator. */
  for await (const chunk of read.content) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  /** Owns final fixture bytes independently of adapter buffers. */
  const output = new Uint8Array(length);
  /** Tracks the next output position in stream order. */
  let offset = 0;
  /** Flattens only after terminal stream verification succeeds. */
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Proves raw identity, caller-buffer isolation, verified reading, and deduplication.
 * @param store - Fresh candidate attachment owned by this case.
 */
async function blobRoundTripCase(store: FileStore): Promise<void> {
  /** Caller-owned bytes are mutated after publication to expose aliasing. */
  const input = Uint8Array.from([0, 1, 2, 255]);
  /** First write derives the candidate's raw content identity. */
  const first = await store.blobs.put(input);
  if (!first.ok) throw first.error;
  input.fill(9);
  /** Equal independent bytes must deduplicate to the same public reference. */
  const second = await store.blobs.put(Uint8Array.from([0, 1, 2, 255]));
  if (!second.ok) throw second.error;
  /** Opens the exact first reference through the verification-bearing boundary. */
  const read = await store.blobs.read(first.value);
  if (!read.ok) throw read.error;
  requireClaim(first.value.digest === second.value.digest, 'Equal blob writes produced different identities');
  requireClaim(first.value.byteLength === second.value.byteLength, 'Equal blob writes produced different lengths');
  requireClaim(
    Buffer.from(await collect(read.value)).equals(Buffer.from([0, 1, 2, 255])),
    'Blob round trip changed bytes',
  );
}

/**
 * Proves a failing producer cannot publish its already-yielded prefix.
 * @param store - Fresh candidate attachment owned by this case.
 */
async function sourceFailureCase(store: FileStore): Promise<void> {
  /** Producer yields recognizable bytes before its intentional terminal failure. */
  const source: AsyncIterable<Uint8Array> = {
    /**
     * Produces one prefix that must not become a committed object.
     * @yields {Uint8Array} Recognizable prefix bytes before the intentional failure.
     */
    async *[Symbol.asyncIterator]() {
      yield TEXT_ENCODER.encode('prefix');
      throw new Error('private conformance source failure');
    },
  };
  /** Candidate must report the stable source category after consuming the producer. */
  const put = await store.blobs.put(source);
  /** Exact prefix reference would exist only if publication committed too early. */
  const prefix = blobRefForBytes(TEXT_ENCODER.encode('prefix'));
  /** Presence check observes final store state after the failed operation. */
  const present = await store.blobs.has(prefix);
  if (!present.ok) throw present.error;
  requireClaim(!put.ok && put.error.code === 'files_source_failed', 'Source failure used the wrong public category');
  requireClaim(!present.value, 'A failing source published its yielded prefix');
}

/**
 * Proves order-independent recursive publication, restoration, and structural sharing.
 * @param store - Fresh candidate attachment owned by this case.
 */
async function treeRoundTripCase(store: FileStore): Promise<void> {
  /** First tree establishes two independent directory branches. */
  const first = await publishTree(store, [
    { path: 'src/index.ts', content: 'before' },
    { path: 'docs/readme.md', content: 'stable' },
  ]);
  if (!first.ok) throw first.error;
  /** Reordered equivalent input must converge on the same root identity. */
  const reordered = await publishTree(store, [
    { path: 'docs/readme.md', content: 'stable' },
    { path: 'src/index.ts', content: 'before' },
  ]);
  if (!reordered.ok) throw reordered.error;
  /** Restoration must traverse persisted recursive references. */
  const restored = await restoreTree(store, first.value.ref);
  if (!restored.ok) throw restored.error;
  requireClaim(first.value.ref.digest === reordered.value.ref.digest, 'Tree identity depends on caller order');
  requireClaim(restored.value.files.length === 2, 'Tree restoration did not return every file');
  requireClaim(restored.value.files[0]?.path === 'docs/readme.md', 'Tree restoration order is not canonical');
}

/**
 * Proves a valid absent reference remains distinct from invalid input and I/O failure.
 * @param store - Fresh candidate attachment owned by this case.
 */
async function missingContentCase(store: FileStore): Promise<void> {
  /** Reference is valid and production-reachable but deliberately not stored. */
  const absent = blobRefForBytes(TEXT_ENCODER.encode('absent'));
  /** Read must preserve the stable missing-content category. */
  const read = await store.blobs.read(absent);
  requireClaim(
    !read.ok && read.error.code === 'files_content_missing',
    'Missing content used the wrong public category',
  );
}

/**
 * Proves retained close identity, settlement, and rejection of later operations.
 * @param store - Fresh candidate attachment whose closure is the behavior under test.
 */
async function retainedLifecycleCase(store: FileStore): Promise<void> {
  /** Captures both synchronous close calls before awaiting settlement. */
  const first = store.close();
  /** Exact identity matters because `closed` is the retained settlement. */
  const second = store.close();
  requireClaim(first === second && first === store.closed, 'FileStore close did not return one shared promise');
  /** Successful evidence must settle before later operation proof. */
  const evidence = await first;
  requireClaim(evidence.kind === 'closed', 'FileStore close did not return normal evidence');
  /** Later operation must fail through Result rather than mutate closed storage. */
  const late = await store.blobs.has(blobRefForBytes(TEXT_ENCODER.encode('late')));
  requireClaim(!late.ok && late.error.code === 'files_store_closed', 'Closed FileStore accepted a later operation');
}

/** One case implementation selected exhaustively by stable catalogue identity. */
type FileStoreConformanceCase = (store: FileStore) => Promise<void>;

/** Required behavior implementation map checked exhaustively by TypeScript. */
const CASES = Object.freeze({
  'blob-round-trip': blobRoundTripCase,
  'source-failure-atomicity': sourceFailureCase,
  'tree-round-trip': treeRoundTripCase,
  'missing-content': missingContentCase,
  'retained-lifecycle': retainedLifecycleCase,
} satisfies Record<FileStoreConformanceCaseId, FileStoreConformanceCase>);

/**
 * Executes every required v1 behavior against independent candidate attachments.
 * @param target - Named adapter factory supplied by an implementation author.
 * @returns Complete ordered report whose passing state requires zero skipped cases.
 */
export async function runFileStoreConformance(target: FileStoreConformanceTarget): Promise<FileStoreConformanceReport> {
  if (target.name.length === 0) throw new RangeError('A conformance implementation name is required');
  /** Receives exactly one result for every required case in catalogue order. */
  const results: FileStoreConformanceCaseResult[] = [];
  /** Executes each case independently so lifecycle proof cannot poison another case. */
  for (const id of FILE_STORE_CONFORMANCE_CASES) {
    /** Retains a successfully opened attachment for unconditional cleanup. */
    let store: FileStore | undefined;
    try {
      /** Candidate construction is itself part of every executable case boundary. */
      const opened = await target.open();
      if (!opened.ok) throw opened.error;
      store = opened.value;
      await CASES[id](store);
      results.push(Object.freeze({ id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'file_store_conformance_failed',
            message: 'A required FileStore conformance case failed',
          }),
        }),
      );
    } finally {
      if (store !== undefined) await store.close();
    }
  }
  /** Complete execution count equals the immutable catalogue by construction. */
  const execution = Object.freeze({
    required: FILE_STORE_CONFORMANCE_CASES.length,
    executed: results.length,
    skipped: FILE_STORE_CONFORMANCE_CASES.length - results.length,
  });
  /** Every case must both execute and pass for the aggregate status to pass. */
  const status = execution.skipped === 0 && results.every((result) => result.status === 'passed') ? 'passed' : 'failed';
  return Object.freeze({
    version: FILE_STORE_CONFORMANCE_VERSION,
    implementation: target.name,
    status,
    execution,
    cases: Object.freeze([...results]),
  });
}
