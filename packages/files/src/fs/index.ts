/**
 * @file Implements durable local content-addressed storage for Archer files.
 *
 * Host paths select storage locations only. All object names derive from
 * validated content references, while the root package remains the sole owner
 * of logical paths, canonical bytes, hashing rules, and immutable tree shape.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CanonicalDecimalSchema, Result, Sha256DigestSchema, type Result as ResultValue } from '@archer/core';

import {
  BlobRefSchema,
  TreeRefSchema,
  decodeDirectoryNode,
  encodeDirectoryNode,
  treeRefForBytes,
  type BlobRef,
  type DirectoryNode,
  type TreeRef,
} from '../encoding.js';
import { FilesError } from '../errors.js';
import type { BlobRead, BlobSource, BlobStore, FileStore, FileStoreCloseEvidence, TreeStore } from '../store.js';

/** Host configuration for one retained filesystem-store attachment. */
export type FileTreeStoreOptions = Readonly<{
  /** Directory beneath which Archer may create its private CAS layout. */
  root: string;
}>;

/** Resolved adapter-owned locations beneath one caller-selected root. */
type StorePaths = Readonly<{
  /** Absolute root used only for physical persistence. */
  root: string;

  /** Private staging directory kept on the same filesystem as final objects. */
  staging: string;
}>;

/** One staged raw object and the exact identity computed while writing it. */
type StagedBlob = Readonly<{
  /** Temporary file containing the complete producer output. */
  path: string;

  /** Raw digest and exact length computed over those staged bytes. */
  ref: BlobRef;
}>;

/** Shared immutable evidence returned by every successful attachment close. */
const CLOSED_EVIDENCE = Object.freeze({ kind: 'closed' } as const);

/**
 * Reports whether a caught value carries a conventional Node filesystem code.
 * @param error - Unknown native failure crossing an adapter boundary.
 * @returns Whether code-based local recovery can be attempted safely.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Builds one bounded invalid configuration or reference failure.
 * @param cause - Local parser or runtime failure retained for diagnosis.
 * @returns Stable adapter-owned public failure.
 */
function invalidInput(cause: unknown): FilesError {
  return new FilesError('files_invalid_input', 'Invalid filesystem file-store input', { cause });
}

/**
 * Builds the stable rejection returned after attachment closure begins.
 * @returns Operation-local Error without mutable lifecycle state.
 */
function storeClosed(): FilesError {
  return new FilesError('files_store_closed', 'The filesystem file store is closed');
}

/**
 * Converts one validated SHA-256 digest into safe physical shard components.
 * @param digest - Algorithm-qualified lowercase digest admitted by core.
 * @returns Hex text whose characters cannot introduce path traversal.
 */
function digestHex(digest: BlobRef['digest'] | TreeRef['digest']): string {
  return digest.slice('sha256:'.length);
}

/**
 * Resolves one raw blob location entirely from its validated digest.
 * @param paths - Adapter-owned physical root.
 * @param ref - Exact raw-content identity.
 * @returns Absolute path under the blob namespace.
 */
function blobObjectPath(paths: StorePaths, ref: BlobRef): string {
  /** Validated hexadecimal digest supplies both bounded shard components. */
  const hex = digestHex(ref.digest);
  return join(paths.root, 'blobs', 'sha256', hex.slice(0, 2), hex.slice(2));
}

/**
 * Resolves one canonical directory-node location from its version and digest.
 * @param paths - Adapter-owned physical root.
 * @param ref - Exact versioned tree identity.
 * @returns Absolute path under the v1 tree namespace.
 */
function treeObjectPath(paths: StorePaths, ref: TreeRef): string {
  /** Validated hexadecimal digest supplies both bounded shard components. */
  const hex = digestHex(ref.digest);
  return join(paths.root, 'trees', ref.format, 'sha256', hex.slice(0, 2), hex.slice(2));
}

/**
 * Writes a complete chunk even when the operating system accepts a partial write.
 * @param handle - Exclusive staging file owned by the current operation.
 * @param chunk - Producer bytes copied before this call.
 */
async function writeChunk(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  /** Tracks the first byte not yet persisted to the staging file. */
  let offset = 0;
  /** Repeats only until every exact input byte has been accepted. */
  while (offset < chunk.byteLength) {
    /** Writes from the current slice without supplying a shared file position. */
    const written = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (written.bytesWritten <= 0) throw new Error('Filesystem write made no progress');
    offset += written.bytesWritten;
  }
}

/**
 * Removes one operation-owned staging file while tolerating prior cleanup.
 * @param path - Exact random staging path created by this operation.
 */
async function removeStaging(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

/**
 * Hashes an existing physical file without loading it into one allocation.
 * @param path - Digest-derived object path beneath the selected store root.
 * @returns Exact raw SHA-256 identity observed from disk.
 */
async function refForFile(path: string): Promise<BlobRef> {
  /** Incremental hash mirrors the direct blob identity rule in the root package. */
  const hash = createHash('sha256');
  /** Uses bigint so verification never rounds a durable byte count. */
  let length = 0n;
  /** Reads through Node's real filesystem stream boundary. */
  for await (const value of createReadStream(path)) {
    /** Node file streams yield Buffer values, which are Uint8Array instances. */
    const chunk = value as Uint8Array;
    hash.update(chunk);
    length += BigInt(chunk.byteLength);
  }
  return BlobRefSchema.parse({
    digest: Sha256DigestSchema.parse(`sha256:${hash.digest('hex')}`),
    byteLength: CanonicalDecimalSchema.parse(length.toString()),
  });
}

/**
 * Reports whether a physical file exactly matches one expected blob identity.
 * @param path - Existing digest-derived object path.
 * @param expected - Reference that selected the path.
 * @returns Whether both raw digest and byte length match.
 */
async function fileMatchesBlob(path: string, expected: BlobRef): Promise<boolean> {
  try {
    /** Rehashes existing content before accepting a concurrent deduplication race. */
    const actual = await refForFile(path);
    return actual.digest === expected.digest && actual.byteLength === expected.byteLength;
  } catch {
    return false;
  }
}

/**
 * Atomically links one complete staging file into an immutable object location.
 * @param staging - Exact temporary file containing complete bytes.
 * @param target - Digest-derived final path on the same filesystem.
 * @param matches - Verifies an object that won a concurrent publication race.
 * @returns Success after durable visibility or one stable integrity/I/O failure.
 */
async function commitStaging(
  staging: string,
  target: string,
  matches: () => Promise<boolean>,
): Promise<ResultValue<void, FilesError>> {
  try {
    await mkdir(dirname(target), { recursive: true });
    try {
      /** Hard linking is atomic and refuses to overwrite an existing immutable object. */
      await link(staging, target);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      if (!(await matches())) {
        return Result.error(
          new FilesError('files_integrity_failed', 'An existing content-addressed object has unexpected bytes'),
        );
      }
    }
    return Result.ok(undefined);
  } catch (error) {
    return Result.error(
      new FilesError('files_io_failed', 'Could not commit a content-addressed object', { cause: error }),
    );
  } finally {
    try {
      await removeStaging(staging);
    } catch {
      /** A later attachment can remove an orphan; the committed object remains valid. */
    }
  }
}

/**
 * Writes one raw source to a private file while deriving exact identity in one pass.
 * @param paths - Adapter-owned locations under the selected root.
 * @param source - In-memory bytes or caller-owned asynchronous producer.
 * @returns Complete staged object or a source/I/O failure with no final object.
 */
async function stageBlob(paths: StorePaths, source: BlobSource): Promise<ResultValue<StagedBlob, FilesError>> {
  /** UUID v4 keeps concurrent staging names independent without defining identity. */
  const path = join(paths.staging, `${randomUUID()}.blob`);
  try {
    await mkdir(paths.staging, { recursive: true });
    /** Exclusive creation prevents an impossible random collision from overwriting work. */
    const handle = await open(path, 'wx', 0o600);
    /** Incremental raw hash follows Archer's blob identity rule. */
    const hash = createHash('sha256');
    /** Uses bigint so byte-count identity never rounds. */
    let length = 0n;
    try {
      if (source instanceof Uint8Array) {
        /** Copies caller bytes before the first asynchronous filesystem write. */
        const chunk = Uint8Array.from(source);
        hash.update(chunk);
        length += BigInt(chunk.byteLength);
        await writeChunk(handle, chunk);
      } else {
        /** Retains the iterator so source failures remain distinct from I/O failures. */
        const iterator = source[Symbol.asyncIterator]();
        /** Records natural completion so abnormal storage failure can release the producer. */
        let completed = false;
        try {
          /** Pulls and writes in producer order without buffering the complete object. */
          while (true) {
            /** Requests the next chunk through an isolated source-failure boundary. */
            let step: IteratorResult<Uint8Array>;
            try {
              step = await iterator.next();
            } catch (error) {
              throw new FilesError('files_source_failed', 'The blob source failed before completion', { cause: error });
            }
            if (step.done) {
              completed = true;
              break;
            }
            if (!(step.value instanceof Uint8Array)) {
              throw new FilesError('files_source_failed', 'The blob source yielded a non-byte chunk');
            }
            /** Copies before a producer can reuse its buffer after the next pull. */
            const chunk = Uint8Array.from(step.value);
            hash.update(chunk);
            length += BigInt(chunk.byteLength);
            await writeChunk(handle, chunk);
          }
        } finally {
          if (!completed && iterator.return !== undefined) {
            try {
              await iterator.return();
            } catch {
              /** The original source or I/O failure remains the public outcome. */
            }
          }
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    /** Constructs the same public raw identity as every other FileStore. */
    const ref = BlobRefSchema.parse({
      digest: Sha256DigestSchema.parse(`sha256:${hash.digest('hex')}`),
      byteLength: CanonicalDecimalSchema.parse(length.toString()),
    });
    return Result.ok(Object.freeze({ path, ref }));
  } catch (error) {
    try {
      await removeStaging(path);
    } catch {
      /** The original failure remains the meaningful public outcome. */
    }
    if (error instanceof FilesError) return Result.error(error);
    return Result.error(new FilesError('files_io_failed', 'Could not stage blob content', { cause: error }));
  }
}

/**
 * Writes small canonical tree bytes to an exclusive staging file.
 * @param paths - Adapter-owned locations under the selected root.
 * @param bytes - Complete canonical directory-node encoding.
 * @returns Exact staging path or a stable I/O failure.
 */
async function stageTree(paths: StorePaths, bytes: Uint8Array): Promise<ResultValue<string, FilesError>> {
  /** UUID v4 prevents concurrent canonical-node staging collisions. */
  const path = join(paths.staging, `${randomUUID()}.tree`);
  try {
    await mkdir(paths.staging, { recursive: true });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return Result.ok(path);
  } catch (error) {
    return Result.error(new FilesError('files_io_failed', 'Could not stage canonical tree bytes', { cause: error }));
  }
}

/**
 * Opens one real file stream whose normal completion proves raw identity.
 * @param path - Exact digest-derived physical object location.
 * @param expected - Reference requested by the public caller.
 * @returns Copied chunks followed by terminal digest and length verification.
 * @yields {Uint8Array} Independently copied file chunks in physical byte order.
 */
async function* verifiedBlobContent(path: string, expected: BlobRef): AsyncGenerator<Uint8Array> {
  /** Incremental verifier observes the exact bytes yielded to the caller. */
  const hash = createHash('sha256');
  /** Counts yielded bytes without numeric precision loss. */
  let length = 0n;
  try {
    /** Node owns file descriptor cleanup when iteration completes or is cancelled. */
    for await (const value of createReadStream(path)) {
      /** Copies adapter buffers before exposing them to caller mutation. */
      const chunk = Uint8Array.from(value as Uint8Array);
      hash.update(chunk);
      length += BigInt(chunk.byteLength);
      yield chunk;
    }
  } catch (error) {
    throw new FilesError('files_io_failed', 'Could not read retained blob content', { cause: error });
  }
  /** Computes identity only after every byte has reached the consumer. */
  const actualDigest = Sha256DigestSchema.parse(`sha256:${hash.digest('hex')}`);
  /** Compares both identity fields because neither alone proves the complete reference. */
  if (actualDigest !== expected.digest || length.toString() !== expected.byteLength) {
    throw new FilesError('files_integrity_failed', 'Retained blob bytes do not match their content reference', {
      details: { digest: expected.digest },
    });
  }
}

/**
 * Validates one caller-provided blob reference without retaining its object identity.
 * @param proposed - Untrusted reference value at an adapter operation boundary.
 * @returns Frozen admitted reference or a stable validation failure.
 */
function admitBlobRef(proposed: BlobRef): ResultValue<BlobRef, FilesError> {
  try {
    return Result.ok(BlobRefSchema.parse(proposed));
  } catch (error) {
    return Result.error(invalidInput(error));
  }
}

/**
 * Validates one caller-provided tree reference without retaining its object identity.
 * @param proposed - Untrusted reference value at an adapter operation boundary.
 * @returns Frozen admitted reference or a stable validation failure.
 */
function admitTreeRef(proposed: TreeRef): ResultValue<TreeRef, FilesError> {
  try {
    return Result.ok(TreeRefSchema.parse(proposed));
  } catch (error) {
    return Result.error(invalidInput(error));
  }
}

/**
 * Creates one retained local filesystem attachment after preparing its root.
 * @param options - Caller-selected physical storage directory.
 * @returns Open FileStore or a stable configuration/I/O failure.
 */
export async function fileTreeStore(options: FileTreeStoreOptions): Promise<ResultValue<FileStore, FilesError>> {
  /** Resolves configuration synchronously before creating any adapter directory. */
  let paths: StorePaths;
  try {
    if (typeof options?.root !== 'string' || options.root.length === 0) {
      throw new TypeError('A non-empty filesystem store root is required');
    }
    /** Absolute resolution belongs only to the physical adapter boundary. */
    const root = resolve(options.root);
    paths = Object.freeze({ root, staging: join(root, '.tmp') });
  } catch (error) {
    return Result.error(invalidInput(error));
  }
  try {
    await mkdir(paths.staging, { recursive: true });
  } catch (error) {
    return Result.error(
      new FilesError('files_io_failed', 'Could not open the filesystem file store', { cause: error }),
    );
  }

  /** Settles only when this attachment begins its one close transition. */
  const closeSettlement = Promise.withResolvers<FileStoreCloseEvidence>();
  /** Guards every operation without deleting durable objects during closure. */
  let isClosed = false;
  /** Exact shared promise required by the retained ownership contract. */
  const closed = closeSettlement.promise;

  /** Raw content-addressed operations backed by real filesystem objects. */
  const blobs: BlobStore = Object.freeze({
    /**
     * Streams one complete source into staging before atomic publication.
     * @param source - Raw bytes or asynchronous byte producer.
     * @returns Exact stored content identity or a stable failure.
     */
    async put(source: BlobSource) {
      if (isClosed) return Result.error(storeClosed());
      /** Computes identity while producing one private complete file. */
      const staged = await stageBlob(paths, source);
      if (!staged.ok) return staged;
      if (isClosed) {
        try {
          await removeStaging(staged.value.path);
        } catch {
          /** Closure remains the stable operation outcome. */
        }
        return Result.error(storeClosed());
      }
      /** Final path derives only from the computed validated digest. */
      const target = blobObjectPath(paths, staged.value.ref);
      /** Accepts a concurrent winner only after rehashing its complete bytes. */
      const committed = await commitStaging(staged.value.path, target, () => fileMatchesBlob(target, staged.value.ref));
      return committed.ok ? Result.ok(staged.value.ref) : committed;
    },

    /**
     * Opens a verification-bearing stream for one exact raw reference.
     * @param proposedRef - Exact raw identity requested by the caller.
     * @returns Streaming read handle or a stable failure.
     */
    async read(proposedRef: BlobRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Copies and validates identity before deriving a host path. */
      const admitted = admitBlobRef(proposedRef);
      if (!admitted.ok) return admitted;
      /** Physical location contains no logical path or caller-controlled separator. */
      const path = blobObjectPath(paths, admitted.value);
      try {
        /** Length mismatch is a false reference, while equal-length corruption remains a stream concern. */
        const metadata = await stat(path);
        if (!metadata.isFile() || BigInt(metadata.size).toString() !== admitted.value.byteLength) {
          return Result.error(
            new FilesError('files_reference_mismatch', 'The requested blob reference does not match retained bytes', {
              details: { digest: admitted.value.digest },
            }),
          );
        }
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return Result.error(
            new FilesError('files_content_missing', 'The requested blob is not retained', {
              details: { digest: admitted.value.digest },
            }),
          );
        }
        return Result.error(
          new FilesError('files_io_failed', 'Could not inspect retained blob content', { cause: error }),
        );
      }
      /** Integrity intentionally settles only when the caller consumes the stream. */
      const read: BlobRead = Object.freeze({
        ref: admitted.value,
        content: verifiedBlobContent(path, admitted.value),
      });
      return Result.ok(read);
    },

    /**
     * Checks digest-addressed presence and exact byte length without reading content.
     * @param proposedRef - Exact raw identity requested by the caller.
     * @returns Whether a matching physical object is present, or a stable failure.
     */
    async has(proposedRef: BlobRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Copies and validates identity before deriving a host path. */
      const admitted = admitBlobRef(proposedRef);
      if (!admitted.ok) return admitted;
      try {
        /** Stat is sufficient for cheap reachability; reads perform full hash verification. */
        const metadata = await stat(blobObjectPath(paths, admitted.value));
        return Result.ok(metadata.isFile() && BigInt(metadata.size).toString() === admitted.value.byteLength);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return Result.ok(false);
        return Result.error(
          new FilesError('files_io_failed', 'Could not inspect retained blob content', { cause: error }),
        );
      }
    },
  });

  /** Canonical directory-node operations backed by versioned filesystem objects. */
  const trees: TreeStore = Object.freeze({
    /**
     * Encodes through the root package before atomically publishing bytes.
     * @param node - Canonical directory value to persist.
     * @returns Exact stored tree identity or a stable failure.
     */
    async put(node: DirectoryNode) {
      if (isClosed) return Result.error(storeClosed());
      /** Canonical encoding and identity remain independent of this adapter. */
      let bytes: Uint8Array;
      /** Exact reference derived from the same immutable byte sequence. */
      let ref: TreeRef;
      try {
        bytes = encodeDirectoryNode(node);
        ref = treeRefForBytes(bytes);
      } catch (error) {
        return Result.error(error instanceof FilesError ? error : invalidInput(error));
      }
      /** Writes the small complete node to private staging before visibility. */
      const staged = await stageTree(paths, bytes);
      if (!staged.ok) return staged;
      if (isClosed) {
        try {
          await removeStaging(staged.value);
        } catch {
          /** Closure remains the stable operation outcome. */
        }
        return Result.error(storeClosed());
      }
      /** Final path includes the canonical format discriminator and digest. */
      const target = treeObjectPath(paths, ref);
      /** Existing nodes must reproduce the exact expected reference. */
      const committed = await commitStaging(staged.value, target, async () => {
        try {
          /** Strict decoder-backed identity rejects malformed concurrent content. */
          const existing = treeRefForBytes(await readFile(target));
          return (
            existing.format === ref.format && existing.digest === ref.digest && existing.byteLength === ref.byteLength
          );
        } catch {
          return false;
        }
      });
      return committed.ok ? Result.ok(ref) : committed;
    },

    /**
     * Loads and verifies complete canonical bytes before returning a node value.
     * @param proposedRef - Exact encoded-directory identity requested by the caller.
     * @returns Immutable canonical node or a stable failure.
     */
    async get(proposedRef: TreeRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Copies and validates identity before deriving a host path. */
      const admitted = admitTreeRef(proposedRef);
      if (!admitted.ok) return admitted;
      /** Reads one bounded directory node because tree bytes never inline file content. */
      let bytes: Uint8Array;
      try {
        bytes = await readFile(treeObjectPath(paths, admitted.value));
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return Result.error(
            new FilesError('files_content_missing', 'The requested directory node is not retained', {
              details: { digest: admitted.value.digest },
            }),
          );
        }
        return Result.error(
          new FilesError('files_io_failed', 'Could not read retained directory bytes', { cause: error }),
        );
      }
      try {
        /** Strict reference reconstruction proves digest, length, and canonical form. */
        const actual = treeRefForBytes(bytes);
        if (
          actual.format !== admitted.value.format ||
          actual.digest !== admitted.value.digest ||
          actual.byteLength !== admitted.value.byteLength
        ) {
          return Result.error(
            new FilesError('files_reference_mismatch', 'Retained directory bytes do not match their tree reference', {
              details: { digest: admitted.value.digest },
            }),
          );
        }
        /** Decoder returns the immutable public value after exact byte proof. */
        const decoded = decodeDirectoryNode(bytes);
        return decoded.ok ? Result.ok(decoded.value) : decoded;
      } catch (error) {
        return Result.error(
          new FilesError('files_integrity_failed', 'Retained directory bytes failed verification', { cause: error }),
        );
      }
    },

    /**
     * Checks versioned digest-addressed presence and exact encoded length cheaply.
     * @param proposedRef - Exact encoded-directory identity requested by the caller.
     * @returns Whether a matching physical object is present, or a stable failure.
     */
    async has(proposedRef: TreeRef) {
      if (isClosed) return Result.error(storeClosed());
      /** Copies and validates identity before deriving a host path. */
      const admitted = admitTreeRef(proposedRef);
      if (!admitted.ok) return admitted;
      try {
        /** Full canonical verification remains the responsibility of `get`. */
        const metadata = await stat(treeObjectPath(paths, admitted.value));
        return Result.ok(metadata.isFile() && BigInt(metadata.size).toString() === admitted.value.byteLength);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return Result.ok(false);
        return Result.error(
          new FilesError('files_io_failed', 'Could not inspect retained directory bytes', { cause: error }),
        );
      }
    },
  });

  /** Retained aggregate whose closure detaches without deleting durable content. */
  const store: FileStore = Object.freeze({
    blobs,
    trees,
    closed,
    /**
     * Closes this attachment exactly once while preserving persisted objects.
     * @returns Exact shared close promise.
     */
    close() {
      if (!isClosed) {
        isClosed = true;
        closeSettlement.resolve(CLOSED_EVIDENCE);
      }
      return closed;
    },
    /**
     * Makes explicit resource management equivalent to ordinary closure.
     * @returns Nothing after attachment closure settles.
     */
    async [Symbol.asyncDispose]() {
      await store.close();
    },
  });
  return Result.ok(store);
}
