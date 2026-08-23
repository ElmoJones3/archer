/**
 * @file Proves canonical directory identity across generated caller orders and
 * arbitrary raw bytes with a fixed seed for deterministic failure replay.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FileMode,
  LogicalNameSchema,
  blobRefForBytes,
  createDirectoryNode,
  decodeDirectoryNode,
  encodeDirectoryNode,
  treeRefForBytes,
  type DirectoryFileEntry,
} from '../src/index.js';

/** Fixed seed makes every generated canonicalization failure exactly replayable. */
const PROPERTY_SEED = 0x0a_2c_4e_8f;

/** Bounded portable names isolate canonical ordering from path rejection cases. */
const logicalNameArbitrary = fc
  .string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), minLength: 1, maxLength: 12 })
  .map((name) => LogicalNameSchema.parse(name));

/** Raw file content includes empty, binary, and text-like byte sequences. */
const contentArbitrary = fc.uint8Array({ maxLength: 96 });

/**
 * Selects normalized direct-name identity for generated uniqueness.
 * @param entry - Generated production-reachable file child.
 * @returns Stable normalized logical name.
 */
function entryName(entry: DirectoryFileEntry): string {
  return entry.name;
}

/** One generated direct file whose content reference production can create. */
const fileEntryArbitrary = fc
  .tuple(logicalNameArbitrary, contentArbitrary, fc.boolean())
  .map(([name, content, executable]): DirectoryFileEntry =>
    Object.freeze({
      kind: 'file',
      name,
      mode: executable ? FileMode.executable : FileMode.readable,
      blob: blobRefForBytes(content),
    }),
  );

/** Unique direct names produce valid proposed directories in arbitrary order. */
const directoryEntriesArbitrary = fc.uniqueArray(fileEntryArbitrary, {
  selector: entryName,
  maxLength: 24,
});

describe('canonical tree properties', () => {
  it('converges caller permutations on one identity and exact decoded value', () => {
    fc.assert(
      fc.property(directoryEntriesArbitrary, (entries) => {
        /** Reversal supplies a deterministic distinct proposal order when possible. */
        const reversed = [...entries].reverse();
        /** Canonical construction must erase caller collection order only. */
        const forwardNode = createDirectoryNode(entries);
        /** Same values in another order must produce the exact same node. */
        const reverseNode = createDirectoryNode(reversed);
        /** Encoded bytes are the permanent identity-bearing projection. */
        const forwardBytes = encodeDirectoryNode(forwardNode);
        /** Independent encoding proves construction convergence, not object reuse. */
        const reverseBytes = encodeDirectoryNode(reverseNode);
        /** Strict decode must accept and reproduce every generated canonical value. */
        const decoded = decodeDirectoryNode(forwardBytes);

        expect(reverseBytes).toEqual(forwardBytes);
        expect(treeRefForBytes(reverseBytes)).toEqual(treeRefForBytes(forwardBytes));
        expect(decoded).toEqual({ ok: true, value: forwardNode });
      }),
      { seed: PROPERTY_SEED, numRuns: 250 },
    );
  });
});
