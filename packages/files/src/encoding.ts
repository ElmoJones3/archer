/**
 * @file Defines the versioned canonical directory-node values and byte encoding.
 *
 * The grammar is deliberately small enough to specify and reimplement without
 * allowing a general serializer to change durable identity during an upgrade.
 */

import { createHash } from 'node:crypto';

import {
  CanonicalDecimalSchema,
  Result,
  Sha256DigestSchema,
  type CanonicalDecimal,
  type Sha256Digest,
} from '@archer/core';
import * as z from 'zod';

import { FilesError } from './errors.js';
import { LogicalNameSchema, compareLogicalNames, type LogicalName } from './path.js';

/** Self-identifying ASCII prefix that domain-separates tree nodes from blobs. */
const TREE_MAGIC = Uint8Array.from([0x41, 0x52, 0x43, 0x48, 0x45, 0x52, 0x00, 0x54, 0x52, 0x45, 0x45, 0x00]);

/** Numeric version encoded immediately after the stable magic prefix. */
const TREE_VERSION = 1;

/** Fixed bytes preceding every sequence of direct directory entries. */
const TREE_HEADER_BYTES = TREE_MAGIC.byteLength + 1 + 4;

/** Binary discriminator for one direct regular-file child. */
const FILE_ENTRY_KIND = 0;

/** Binary discriminator for one direct directory child. */
const DIRECTORY_ENTRY_KIND = 1;

/** Binary mode value for a readable non-executable regular file. */
const READABLE_MODE = 0;

/** Binary mode value for a readable executable regular file. */
const EXECUTABLE_MODE = 1;

/** Largest exact byte length admitted by the unsigned 64-bit wire field. */
const MAX_UINT64 = (1n << 64n) - 1n;

/** Fatal UTF-8 decoder prevents malformed bytes from collapsing to replacement text. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 encoder used only after logical-name normalization has succeeded. */
const UTF8_ENCODER = new TextEncoder();

/** Stable discriminator carried by every v1 directory node and `TreeRef`. */
export const TREE_FORMAT = 'archer-tree-v1' as const;

/** The two portable regular-file modes admitted by the v1 logical model. */
export const FileMode = Object.freeze({
  /** Materializes as a readable regular file without executable intent. */
  readable: 0o644,

  /** Materializes as a readable regular file with executable intent. */
  executable: 0o755,
});

/** One portable regular-file mode without claiming complete POSIX metadata. */
export type FileMode = (typeof FileMode)[keyof typeof FileMode];

/** Exact content identity for raw file bytes. */
export type BlobRef = Readonly<{
  /** SHA-256 of the raw file bytes without an Archer object header. */
  digest: Sha256Digest;

  /** Exact raw byte count retained as an unbounded canonical decimal. */
  byteLength: CanonicalDecimal;
}>;

/** Exact content identity for one encoded canonical directory node. */
export type TreeRef = Readonly<{
  /** Selects the decoder required before bytes can become a directory node. */
  format: typeof TREE_FORMAT;

  /** SHA-256 of the complete canonical directory-node bytes. */
  digest: Sha256Digest;

  /** Exact encoded node length used to reject truncation and substitution. */
  byteLength: CanonicalDecimal;
}>;

/** One direct regular-file child inside a canonical directory node. */
export type DirectoryFileEntry = Readonly<{
  /** Selects file-specific mode and blob fields. */
  kind: 'file';

  /** Names one direct child rather than a slash-separated descendant. */
  name: LogicalName;

  /** Preserves only portable readable or executable intent. */
  mode: FileMode;

  /** Identifies exact raw bytes independently of this directory. */
  blob: BlobRef;
}>;

/** One direct directory child inside a canonical directory node. */
export type DirectoryTreeEntry = Readonly<{
  /** Selects recursive child-tree identity. */
  kind: 'directory';

  /** Names one direct child rather than a slash-separated descendant. */
  name: LogicalName;

  /** Identifies the child's canonical directory node. */
  tree: TreeRef;
}>;

/** Every direct child kind admitted by the first canonical tree format. */
export type DirectoryEntry = DirectoryFileEntry | DirectoryTreeEntry;

/** One canonical directory node whose children are already bytewise sorted. */
export type DirectoryNode = Readonly<{
  /** Pins the byte grammar that determines this node's identity. */
  format: typeof TREE_FORMAT;

  /** Contains unique direct children in normalized UTF-8 byte order. */
  entries: readonly DirectoryEntry[];
}>;

/** Validates the two mode values whose meaning survives every v1 Materializer. */
export const FileModeSchema = z.union([z.literal(FileMode.readable), z.literal(FileMode.executable)]);

/** Copies one admitted reference so later caller mutation cannot rewrite identity. */
export const BlobRefSchema = z
  .strictObject({ digest: Sha256DigestSchema, byteLength: CanonicalDecimalSchema })
  .transform((value) => Object.freeze({ ...value }) as BlobRef);

/** Validates a tree reference and rejects lengths smaller than the v1 header. */
export const TreeRefSchema = z
  .strictObject({
    format: z.literal(TREE_FORMAT),
    digest: Sha256DigestSchema,
    byteLength: CanonicalDecimalSchema,
  })
  .refine((value) => BigInt(value.byteLength) >= BigInt(TREE_HEADER_BYTES), {
    message: 'A tree reference cannot be shorter than the canonical header',
  })
  .transform((value) => Object.freeze({ ...value }) as TreeRef);

/** Copies one direct file child through every nested reference validator. */
const DirectoryFileEntrySchema = z
  .strictObject({
    kind: z.literal('file'),
    name: LogicalNameSchema,
    mode: FileModeSchema,
    blob: BlobRefSchema,
  })
  .transform((value) => Object.freeze({ ...value }) as DirectoryFileEntry);

/** Copies one direct directory child through every nested reference validator. */
const DirectoryTreeEntrySchema = z
  .strictObject({
    kind: z.literal('directory'),
    name: LogicalNameSchema,
    tree: TreeRefSchema,
  })
  .transform((value) => Object.freeze({ ...value }) as DirectoryTreeEntry);

/** Validates exactly the two direct child forms admitted by the v1 grammar. */
const DirectoryEntrySchema = z.discriminatedUnion('kind', [DirectoryFileEntrySchema, DirectoryTreeEntrySchema]);

/**
 * Reports whether direct children are unique and already in canonical byte order.
 * @param entries - Validated direct children in their proposed encoded order.
 * @returns Whether encoding the order can produce canonical identity.
 */
function entriesAreCanonical(entries: readonly DirectoryEntry[]): boolean {
  /** Starts after the first child because each check compares one adjacent pair. */
  for (let index = 1; index < entries.length; index += 1) {
    /** Previous child is in bounds because the loop begins at one. */
    const previous = entries[index - 1] as DirectoryEntry;
    /** Current child is in bounds because the loop condition checks the length. */
    const current = entries[index] as DirectoryEntry;
    if (compareLogicalNames(previous.name, current.name) >= 0) return false;
  }
  return true;
}

/** Validates a complete canonical node and freezes its copied child collection. */
export const DirectoryNodeSchema = z
  .strictObject({
    format: z.literal(TREE_FORMAT),
    entries: z.array(DirectoryEntrySchema),
  })
  .refine((value) => entriesAreCanonical(value.entries), {
    message: 'Directory entries must be unique and sorted by normalized UTF-8 name bytes',
  })
  .transform(
    (value) =>
      Object.freeze({
        format: value.format,
        entries: Object.freeze([...value.entries]),
      }) as DirectoryNode,
  );

/**
 * Converts a schema or caller failure into one bounded construction Error.
 * @param error - Local cause retained for process diagnosis only.
 * @returns Stable file-domain rejection for the public construction boundary.
 */
function invalidInput(error: unknown): FilesError {
  return new FilesError('files_invalid_input', 'Invalid canonical file input', { cause: error });
}

/**
 * Produces an algorithm-qualified SHA-256 digest for one exact byte sequence.
 * @param bytes - Bytes whose current contents determine identity synchronously.
 * @returns Canonical lowercase digest text admitted by core.
 */
function sha256(bytes: Uint8Array): Sha256Digest {
  /** Hashes before returning so later caller mutation cannot change this result. */
  const hex = createHash('sha256').update(bytes).digest('hex');
  return Sha256DigestSchema.parse(`sha256:${hex}`);
}

/**
 * Converts a safe or bigint byte length into Archer's exact decimal boundary.
 * @param value - Non-negative encoded or content byte count.
 * @returns Canonical decimal text with no precision loss.
 */
function byteLength(value: number | bigint): CanonicalDecimal {
  return CanonicalDecimalSchema.parse(value.toString());
}

/**
 * Parses an exact decimal into the unsigned length admitted by the v1 grammar.
 * @param value - Validated canonical byte length from a content reference.
 * @returns Unsigned 64-bit value written to canonical bytes.
 */
function uint64(value: CanonicalDecimal): bigint {
  /** Uses bigint because a durable byte length may exceed JavaScript safe integers. */
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) throw invalidInput(new RangeError('Byte length exceeds uint64'));
  return parsed;
}

/**
 * Converts one algorithm-qualified digest into its fixed 32 raw bytes.
 * @param digest - Validated lowercase SHA-256 reference.
 * @returns New byte storage suitable for canonical encoding.
 */
function digestBytes(digest: Sha256Digest): Uint8Array {
  return Uint8Array.from(Buffer.from(digest.slice('sha256:'.length), 'hex'));
}

/**
 * Converts fixed raw digest bytes into Archer's algorithm-qualified text form.
 * @param bytes - Exactly 32 bytes read from a canonical child reference.
 * @returns Validated lowercase SHA-256 identity.
 */
function digestText(bytes: Uint8Array): Sha256Digest {
  return Sha256DigestSchema.parse(`sha256:${Buffer.from(bytes).toString('hex')}`);
}

/**
 * Copies, validates, sorts, and freezes direct children before identity exists.
 * @param entries - Caller-owned direct child proposals in any order.
 * @returns One canonical directory value with unique normalized names.
 * @throws {FilesError} When a child is invalid or names collide after normalization.
 */
export function createDirectoryNode(entries: readonly DirectoryEntry[]): DirectoryNode {
  /** Admits each child separately before sorting can hide malformed input. */
  let admitted: readonly DirectoryEntry[];
  try {
    admitted = entries.map((entry) => DirectoryEntrySchema.parse(entry));
  } catch (error) {
    throw invalidInput(error);
  }
  /** Sorts a fresh array so canonical construction cannot mutate caller order. */
  const sorted = [...admitted].sort((left, right) => compareLogicalNames(left.name, right.name));
  /** Compares adjacent names after normalization to catch exact and canonical duplicates. */
  for (let index = 1; index < sorted.length; index += 1) {
    /** Previous child is proven in bounds by the loop starting at one. */
    const previous = sorted[index - 1] as DirectoryEntry;
    /** Current child is proven in bounds by the loop condition. */
    const current = sorted[index] as DirectoryEntry;
    if (previous.name === current.name) {
      throw new FilesError('files_duplicate_path', 'Directory contains duplicate normalized child names', {
        details: { name: current.name },
      });
    }
  }
  try {
    return DirectoryNodeSchema.parse({ format: TREE_FORMAT, entries: sorted });
  } catch (error) {
    throw invalidInput(error);
  }
}

/**
 * Computes ordinary raw-content identity without adding an Archer object header.
 * @param bytes - Exact caller bytes observed synchronously without mutation.
 * @returns Frozen SHA-256 and byte-length reference.
 */
export function blobRefForBytes(bytes: Uint8Array): BlobRef {
  return BlobRefSchema.parse({ digest: sha256(bytes), byteLength: byteLength(bytes.byteLength) });
}

/**
 * Computes identity only after proving the supplied bytes are one canonical node.
 * @param bytes - Proposed complete v1 directory-node encoding.
 * @returns Frozen format, digest, and exact encoded length.
 * @throws {FilesError} When bytes do not decode canonically.
 */
export function treeRefForBytes(bytes: Uint8Array): TreeRef {
  /** Uses the strict decoder so malformed bytes can never receive a public TreeRef. */
  const decoded = decodeDirectoryNode(bytes);
  if (!decoded.ok) throw decoded.error;
  return TreeRefSchema.parse({
    format: TREE_FORMAT,
    digest: sha256(bytes),
    byteLength: byteLength(bytes.byteLength),
  });
}

/**
 * Measures one direct child before allocating the exact canonical node buffer.
 * @param entry - Validated canonical child.
 * @returns Exact encoded bytes including kind, name, metadata, and digest.
 */
function encodedEntryLength(entry: DirectoryEntry): number {
  /** Encodes the direct name once to count bytes rather than UTF-16 units. */
  const nameLength = UTF8_ENCODER.encode(entry.name).byteLength;
  /** File entries carry one extra mode byte beyond the shared uint64 and digest. */
  const metadataLength = entry.kind === 'file' ? 1 + 8 + 32 : 8 + 32;
  return 1 + 4 + nameLength + metadataLength;
}

/**
 * Encodes one already-canonical directory value into the permanent v1 grammar.
 * @param node - Canonical node normally returned by `createDirectoryNode`.
 * @returns Fresh bytes whose SHA-256 determines `TreeRef` identity.
 * @throws {FilesError} When the value is invalid or exceeds wire bounds.
 */
export function encodeDirectoryNode(node: DirectoryNode): Uint8Array {
  /** Revalidates values restored from an untrusted or cast boundary before hashing. */
  let admitted: DirectoryNode;
  try {
    admitted = DirectoryNodeSchema.parse(node);
  } catch (error) {
    throw invalidInput(error);
  }
  if (admitted.entries.length > 0xffff_ffff) {
    throw invalidInput(new RangeError('Directory entry count exceeds uint32'));
  }
  /** Adds exact child lengths while rejecting impossible allocation overflow. */
  let totalLength = TREE_HEADER_BYTES;
  /** Measures each child before any partial output can escape. */
  for (const entry of admitted.entries) {
    totalLength += encodedEntryLength(entry);
    if (!Number.isSafeInteger(totalLength)) throw invalidInput(new RangeError('Directory encoding is too large'));
  }
  /** Owns the exact canonical output independently of every caller value. */
  const output = new Uint8Array(totalLength);
  /** Writes fixed-width integers directly over the output without host endianness. */
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  output.set(TREE_MAGIC, 0);
  /** Tracks the next unwritten byte through the one forward-only encoding pass. */
  let offset = TREE_MAGIC.byteLength;
  output[offset] = TREE_VERSION;
  offset += 1;
  view.setUint32(offset, admitted.entries.length, false);
  offset += 4;
  /** Emits children in the order already enforced by `DirectoryNodeSchema`. */
  for (const entry of admitted.entries) {
    /** Encodes the admitted direct name once for both length and content. */
    const name = UTF8_ENCODER.encode(entry.name);
    output[offset] = entry.kind === 'file' ? FILE_ENTRY_KIND : DIRECTORY_ENTRY_KIND;
    offset += 1;
    view.setUint32(offset, name.byteLength, false);
    offset += 4;
    output.set(name, offset);
    offset += name.byteLength;
    if (entry.kind === 'file') {
      output[offset] = entry.mode === FileMode.readable ? READABLE_MODE : EXECUTABLE_MODE;
      offset += 1;
      view.setBigUint64(offset, uint64(entry.blob.byteLength), false);
      offset += 8;
      output.set(digestBytes(entry.blob.digest), offset);
      offset += 32;
      continue;
    }
    view.setBigUint64(offset, uint64(entry.tree.byteLength), false);
    offset += 8;
    output.set(digestBytes(entry.tree.digest), offset);
    offset += 32;
  }
  return output;
}

/** Stateful reader that rejects every out-of-bounds request before slicing bytes. */
class CanonicalReader {
  /** Decoder-owned complete byte sequence copied from the caller. */
  readonly #bytes: Uint8Array;

  /** Byte view for fixed-width unsigned integer reads. */
  readonly #view: DataView;

  /** Next unread byte offset in the immutable copied input. */
  #offset = 0;

  /**
   * Retains one decoder-owned byte sequence for the complete parse.
   * @param bytes - Input copy that callers can no longer mutate.
   */
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /**
   * Number of bytes still available to the decoder.
   * @returns Exact unread byte count.
   */
  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  /**
   * Requires a complete field before any offset changes.
   * @param length - Exact bytes required by the next field.
   */
  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new RangeError('Canonical directory bytes are truncated');
    }
  }

  /**
   * Reads one unsigned byte.
   * @returns The next exact kind, mode, or version value.
   */
  readUint8(): number {
    this.#require(1);
    /** Reads only after the bounds check proved this offset exists. */
    const value = this.#bytes[this.#offset] as number;
    this.#offset += 1;
    return value;
  }

  /**
   * Reads one network-order unsigned 32-bit integer.
   * @returns Exact entry count or name length.
   */
  readUint32(): number {
    this.#require(4);
    /** Uses explicit big-endian order independent of host architecture. */
    const value = this.#view.getUint32(this.#offset, false);
    this.#offset += 4;
    return value;
  }

  /**
   * Reads one network-order unsigned 64-bit integer without precision loss.
   * @returns Exact referenced byte length.
   */
  readUint64(): bigint {
    this.#require(8);
    /** Keeps the wire value as bigint through decimal conversion. */
    const value = this.#view.getBigUint64(this.#offset, false);
    this.#offset += 8;
    return value;
  }

  /**
   * Reads and copies one exact byte field.
   * @param length - Required field size already read from canonical bytes.
   * @returns Decoder-owned bytes independent of the complete input buffer.
   */
  readBytes(length: number): Uint8Array {
    this.#require(length);
    /** Copies rather than returning an alias into the retained decoder input. */
    const value = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }
}

/**
 * Compares exact bytes without timing claims because identity values are public.
 * @param left - First byte sequence.
 * @param right - Second byte sequence.
 * @returns Whether lengths and every byte match.
 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  /** Checks every offset because no early semantic normalization is permitted. */
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Decodes one name and proves the original bytes already carried normalized text.
 * @param bytes - Exact UTF-8 field copied by the canonical reader.
 * @returns Admitted logical segment with its original canonical spelling.
 */
function decodeName(bytes: Uint8Array): LogicalName {
  /** Fatal decoding rejects malformed UTF-8 instead of repairing identity bytes. */
  const decoded = UTF8_DECODER.decode(bytes);
  if (decoded !== decoded.normalize('NFC')) throw new Error('Logical name bytes are not NFC');
  return LogicalNameSchema.parse(decoded);
}

/**
 * Restores a node only when every byte is the unique encoding of its value.
 * @param input - Untrusted complete directory-node bytes.
 * @returns Frozen node or one stable noncanonical encoding failure.
 */
export function decodeDirectoryNode(input: Uint8Array): Result<DirectoryNode, FilesError> {
  try {
    /** Copies before parsing so concurrent caller mutation cannot change validation. */
    const bytes = Uint8Array.from(input);
    /** Owns forward-only decoder position and fixed-width reads. */
    const reader = new CanonicalReader(bytes);
    /** Requires the exact domain-separating prefix before interpreting fields. */
    const magic = reader.readBytes(TREE_MAGIC.byteLength);
    if (!bytesEqual(magic, TREE_MAGIC)) throw new Error('Canonical tree magic does not match');
    if (reader.readUint8() !== TREE_VERSION) throw new Error('Canonical tree version is unsupported');
    /** Limits the only entry loop to the exact unsigned count on the wire. */
    const entryCount = reader.readUint32();
    /** Accumulates decoded children privately until the complete node validates. */
    const entries: DirectoryEntry[] = [];
    /** Decodes exactly the advertised number of direct children. */
    for (let index = 0; index < entryCount; index += 1) {
      /** Selects the only two entry layouts admitted by v1. */
      const kind = reader.readUint8();
      /** A name length must fit the remaining input before allocation or decoding. */
      const nameLength = reader.readUint32();
      /** Restores one normalized direct name from its exact byte field. */
      const name = decodeName(reader.readBytes(nameLength));
      if (kind === FILE_ENTRY_KIND) {
        /** Maps the one-byte mode without accepting other POSIX values. */
        const encodedMode = reader.readUint8();
        if (encodedMode !== READABLE_MODE && encodedMode !== EXECUTABLE_MODE) {
          throw new Error('Canonical file mode is unsupported');
        }
        /** Restores raw-content identity from fixed-width length and digest fields. */
        const blob = BlobRefSchema.parse({
          byteLength: byteLength(reader.readUint64()),
          digest: digestText(reader.readBytes(32)),
        });
        entries.push(
          Object.freeze({
            kind: 'file',
            name,
            mode: encodedMode === READABLE_MODE ? FileMode.readable : FileMode.executable,
            blob,
          }),
        );
        continue;
      }
      if (kind !== DIRECTORY_ENTRY_KIND) throw new Error('Canonical directory entry kind is unsupported');
      /** Restores recursive tree identity without reading the child node yet. */
      const tree = TreeRefSchema.parse({
        format: TREE_FORMAT,
        byteLength: byteLength(reader.readUint64()),
        digest: digestText(reader.readBytes(32)),
      });
      entries.push(Object.freeze({ kind: 'directory', name, tree }));
    }
    if (reader.remaining !== 0) throw new Error('Canonical directory bytes contain trailing data');
    /** Validates original order directly rather than letting construction sort it. */
    const node = DirectoryNodeSchema.parse({ format: TREE_FORMAT, entries });
    /** Catches any alternate field representation that happened to decode semantically. */
    if (!bytesEqual(encodeDirectoryNode(node), bytes)) {
      throw new Error('Directory bytes are not the unique canonical encoding');
    }
    return Result.ok(node);
  } catch (error) {
    return Result.error(
      new FilesError('files_noncanonical_encoding', 'Directory bytes are not canonical Archer tree data', {
        cause: error,
      }),
    );
  }
}
