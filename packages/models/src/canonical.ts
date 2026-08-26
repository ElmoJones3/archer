/** @file Computes deterministic identities for JSON-safe model facts. */

import { createHash } from 'node:crypto';

import { JsonValueSchema, Sha256DigestSchema, type JsonValue, type Sha256Digest } from '@archer/core';

/**
 * Serializes admitted JSON with object keys in byte-independent lexical order.
 * @param value - JSON-safe value whose property insertion order is irrelevant.
 * @returns Canonical text used only within the declared Archer protocol.
 */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  /** Array narrowing above leaves only the string-keyed JSON object branch. */
  const object = value as Readonly<Record<string, JsonValue>>;
  /** Stable key order prevents caller construction order from changing identity. */
  const fields = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`);
  return `{${fields.join(',')}}`;
}

/**
 * Hashes one protocol-labelled JSON value without retaining caller-owned data.
 * @param protocol - Versioned domain rule that gives the digest meaning.
 * @param value - JSON-safe payload admitted before hashing.
 * @returns Algorithm-qualified SHA-256 digest.
 */
export function digestJson(protocol: string, value: unknown): Sha256Digest {
  /** Deep admission also copies mutable arrays and objects before traversal. */
  const admitted = JsonValueSchema.parse(value);
  /** Protocol prefix prevents identical JSON in another domain from sharing identity. */
  const hash = createHash('sha256').update(protocol).update('\0').update(canonicalJson(admitted)).digest('hex');
  return Sha256DigestSchema.parse(`sha256:${hash}`);
}
