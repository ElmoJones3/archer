/**
 * @file Owns Archer's platform-independent logical name and path values.
 *
 * Logical paths become durable content identity, so this module cannot inherit
 * host separators, locale collation, or a filesystem adapter's normalization.
 */

import * as z from 'zod';

/** UTF-8 encoder shared by canonical ordering without locale or host collation. */
const UTF8_ENCODER = new TextEncoder();

/** Prevents an arbitrary string from posing as one admitted logical name. */
declare const logicalNameBrand: unique symbol;

/** Prevents an arbitrary string from posing as one admitted logical path. */
declare const logicalPathBrand: unique symbol;

/** One normalized path segment with no separator or traversal meaning. */
export type LogicalName = string & {
  /** Carries compile-time evidence that the logical-name schema admitted the string. */
  readonly [logicalNameBrand]: true;
};

/** One normalized relative file path independent of a host filesystem. */
export type LogicalPath = string & {
  /** Carries compile-time evidence that the logical-path schema admitted the string. */
  readonly [logicalPathBrand]: true;
};

/**
 * Rejects JavaScript strings that UTF-8 would otherwise repair with a replacement
 * character, which could collapse distinct invalid inputs into one path.
 * @param value - Proposed path or segment before normalization.
 * @returns Whether every UTF-16 code unit belongs to a valid Unicode scalar.
 */
function hasOnlyUnicodeScalars(value: string): boolean {
  /** Advances by one code unit except when a valid surrogate pair consumes two. */
  for (let index = 0; index < value.length; index += 1) {
    /** Reads the current UTF-16 unit without applying replacement behavior. */
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit > 0xdbff || index + 1 >= value.length) return false;
    /** Requires a low surrogate immediately after every high surrogate. */
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) return false;
    index += 1;
  }
  return true;
}

/** Validates scalar text before NFC can establish one canonical byte representation. */
const NormalizedUnicodeSchema = z
  .string()
  .refine(hasOnlyUnicodeScalars, { message: 'Logical file names require valid Unicode scalar values' })
  .transform((value) => value.normalize('NFC'));

/**
 * Reports whether one normalized segment has no traversal or separator meaning.
 * @param value - NFC segment proposed for one directory position.
 * @returns Whether the segment is portable within Archer's logical model.
 */
function isLogicalName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

/** Admits one portable NFC segment while retaining its case-sensitive spelling. */
export const LogicalNameSchema = NormalizedUnicodeSchema.pipe(
  z
    .string()
    .refine(isLogicalName, { message: 'Logical names must be non-empty portable path segments' })
    .transform((value) => value as LogicalName),
);

/**
 * Reports whether a normalized path is relative, portable, and outside Archer's
 * reserved top-level control root.
 * @param value - NFC slash-separated path proposed for durable identity.
 * @returns Whether every path segment belongs to the logical model.
 */
function isLogicalPath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.endsWith('/')) return false;
  /** Retains the proposed hierarchy without consulting a host path library. */
  const segments = value.split('/');
  if (segments[0] === '.archer') return false;
  return segments.every(isLogicalName);
}

/** Admits one relative NFC path and reserves `.archer` only at the logical root. */
export const LogicalPathSchema = NormalizedUnicodeSchema.pipe(
  z
    .string()
    .refine(isLogicalPath, { message: 'Logical paths must be portable relative paths outside .archer' })
    .transform((value) => value as LogicalPath),
);

/**
 * Orders names by their admitted UTF-8 bytes rather than JavaScript UTF-16 units.
 * @param left - First normalized logical name.
 * @param right - Second normalized logical name.
 * @returns Negative, zero, or positive according to bytewise lexical order.
 */
function compareUtf8(left: string, right: string): number {
  /** Encodes each already-normalized name once for a locale-independent comparison. */
  const leftBytes = UTF8_ENCODER.encode(left);
  /** Keeps the second encoding separate so no caller-owned buffer enters comparison. */
  const rightBytes = UTF8_ENCODER.encode(right);
  /** Compares only the common prefix before length resolves a prefix match. */
  const commonLength = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  /** Inspects bytes in order because UTF-8 preserves Unicode scalar ordering. */
  for (let index = 0; index < commonLength; index += 1) {
    /** Reads a proven in-bounds byte from the left encoding. */
    const leftByte = leftBytes[index] as number;
    /** Reads the corresponding proven in-bounds byte from the right encoding. */
    const rightByte = rightBytes[index] as number;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

/**
 * Orders direct names by their admitted UTF-8 bytes rather than JavaScript UTF-16 units.
 * @param left - First normalized logical name.
 * @param right - Second normalized logical name.
 * @returns Negative, zero, or positive according to bytewise lexical order.
 */
export function compareLogicalNames(left: LogicalName, right: LogicalName): number {
  return compareUtf8(left, right);
}

/**
 * Orders complete logical paths by normalized UTF-8 bytes without locale state.
 * @param left - First normalized logical path.
 * @param right - Second normalized logical path.
 * @returns Negative, zero, or positive according to bytewise lexical order.
 */
export function compareLogicalPaths(left: LogicalPath, right: LogicalPath): number {
  return compareUtf8(left, right);
}
