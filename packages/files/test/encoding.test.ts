/**
 * @file Pins the exact v1 directory bytes and proves canonical construction,
 * strict restoration, content identity, and non-mutation.
 */

import { describe, expect, it } from 'vitest';

import {
  BlobRefSchema,
  FileMode,
  LogicalNameSchema,
  TREE_FORMAT,
  blobRefForBytes,
  createDirectoryNode,
  decodeDirectoryNode,
  encodeDirectoryNode,
  treeRefForBytes,
  type DirectoryEntry,
} from '../src/index.js';

/** Encodes readable ASCII test content without Buffer-specific behavior. */
const TEXT_ENCODER = new TextEncoder();

/**
 * Renders exact binary evidence for stable golden-vector assertions.
 * @param bytes - Canonical bytes produced by the encoder.
 * @returns Lowercase hexadecimal with two characters per byte.
 */
function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('canonical directory encoding', () => {
  it('pins empty-tree bytes and identity as a permanent v1 golden vector', () => {
    /** Creates the canonical root value through the ordinary public constructor. */
    const node = createDirectoryNode([]);
    /** Encodes once so both bytes and identity derive from the same production value. */
    const bytes = encodeDirectoryNode(node);

    expect(node).toEqual({ format: TREE_FORMAT, entries: [] });
    expect(toHex(bytes)).toBe('4152434845520054524545000100000000');
    expect(treeRefForBytes(bytes)).toEqual({
      format: TREE_FORMAT,
      digest: 'sha256:e2a7c08d80c72c01f7c0f193238889fc7ac3c2ffd205bcbe0f3ffc64f871a772',
      byteLength: '17',
    });
  });

  it('pins a readable file entry and raw blob identity without mutating input', () => {
    /** Keeps recognizable caller-owned bytes for the raw SHA-256 vector. */
    const content = TEXT_ENCODER.encode('one');
    /** Retains the original byte sequence so mutation would be visible. */
    const before = Uint8Array.from(content);
    /** Produces ordinary raw-content identity before constructing its parent node. */
    const blob = blobRefForBytes(content);
    /** Keeps the entry array caller-owned to prove construction copies it. */
    const entries: DirectoryEntry[] = [
      {
        kind: 'file',
        name: LogicalNameSchema.parse('a.txt'),
        mode: FileMode.readable,
        blob,
      },
    ];
    /** Compiles caller entries into one frozen canonical node. */
    const node = createDirectoryNode(entries);
    /** Encodes the exact node for its permanent byte vector. */
    const bytes = encodeDirectoryNode(node);

    expect(blob).toEqual({
      digest: 'sha256:7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed',
      byteLength: '3',
    });
    expect(BlobRefSchema.safeParse(blob).success).toBe(true);
    expect(toHex(bytes)).toBe(
      '41524348455200545245450001000000010000000005612e747874000000000000000003' +
        '7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed',
    );
    expect(treeRefForBytes(bytes).digest).toBe(
      'sha256:5c4464d83a9fe7a0d4097a5774af8304cd541a69123581b736ace3b84a041b2f',
    );
    expect(content).toEqual(before);
    expect(entries).toHaveLength(1);
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.entries)).toBe(true);
  });

  it('sorts entries before encoding and restores the exact canonical value', () => {
    /** Uses distinct raw content so file ordering cannot hide a swapped reference. */
    const alpha = blobRefForBytes(TEXT_ENCODER.encode('alpha'));
    /** Supplies a child tree reference to exercise both entry kinds. */
    const child = treeRefForBytes(encodeDirectoryNode(createDirectoryNode([])));
    /** Deliberately reverses canonical byte order at the construction boundary. */
    const node = createDirectoryNode([
      { kind: 'directory', name: LogicalNameSchema.parse('src'), tree: child },
      { kind: 'file', name: LogicalNameSchema.parse('a.txt'), mode: FileMode.executable, blob: alpha },
    ]);
    /** Restores from only the canonical encoded bytes. */
    const restored = decodeDirectoryNode(encodeDirectoryNode(node));

    expect(node.entries.map((entry) => entry.name)).toEqual(['a.txt', 'src']);
    expect(restored).toEqual({ ok: true, value: node });
  });

  it('rejects duplicate normalized names without changing caller entries', () => {
    /** Uses canonically equivalent spellings to reach duplicate detection after NFC. */
    const entries = [
      {
        kind: 'file' as const,
        name: LogicalNameSchema.parse('é.txt'),
        mode: FileMode.readable,
        blob: blobRefForBytes(TEXT_ENCODER.encode('first')),
      },
      {
        kind: 'file' as const,
        name: LogicalNameSchema.parse('e\u0301.txt'),
        mode: FileMode.readable,
        blob: blobRefForBytes(TEXT_ENCODER.encode('second')),
      },
    ];

    expect(() => createDirectoryNode(entries)).toThrow(expect.objectContaining({ code: 'files_duplicate_path' }));
    expect(entries).toHaveLength(2);
  });

  it.each([
    ['bad magic', '0052434845520054524545000100000000'],
    ['unsupported version', '4152434845520054524545000200000000'],
    ['truncated count', '41524348455200545245450001000000'],
    ['trailing bytes', '415243484552005452454500010000000000'],
  ])('rejects %s with the exact noncanonical failure', (_label, hex) => {
    /** Converts malformed fixture bytes without asking production to create invalid state. */
    const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
    /** Exercises the untrusted restoration boundary that owns corruption refusal. */
    const result = decodeDirectoryNode(bytes);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'files_noncanonical_encoding' },
    });
  });
});
