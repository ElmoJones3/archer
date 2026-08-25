/** @file Proves the live conditional-object probe detects every required semantic violation. */

import { describe, expect, it } from 'vitest';

import {
  probeConditionalObjectStore,
  type ConditionalObjectListPage,
  type ConditionalObjectStore,
  type ConditionalObjectWriteOutcome,
  type ObjectVersion,
  type VersionedObject,
} from '../src/cells/index.js';

/** In-memory object state whose numeric revision acts only as an opaque fixture token. */
type MemoryObject = Readonly<{
  /** Source-owned payload bytes. */
  bytes: Uint8Array;

  /** Monotonic fixture token exposed only through an opaque string cast. */
  revision: number;
}>;

/** Production-shaped conditional store used to prove probe mechanics without network timing. */
class MemoryConditionalObjectStore implements ConditionalObjectStore {
  /** Retains exact current objects by normalized fixture key. */
  readonly #objects = new Map<string, MemoryObject>();

  /** When true, deliberately accepts one retired token to prove probe rejection. */
  readonly #acceptRetired: boolean;

  /**
   * Constructs either conforming or deliberately broken semantics.
   * @param acceptRetired - Whether stale replacement preconditions are ignored.
   */
  constructor(acceptRetired = false) {
    this.#acceptRetired = acceptRetired;
  }

  /**
   * Reads one fresh byte copy and current opaque token.
   * @param key - Exact fixture object key.
   * @returns Current copied object or absence.
   */
  async read(key: string): Promise<VersionedObject | undefined> {
    /** Current internal object remains source-owned. */
    const current = this.#objects.get(key);
    return current === undefined
      ? undefined
      : Object.freeze({
          key,
          bytes: Uint8Array.from(current.bytes),
          version: String(current.revision) as ObjectVersion,
        });
  }

  /**
   * Creates only while absent and copies caller bytes.
   * @param key - Exact fixture object key.
   * @param bytes - Caller-owned payload copied into fixture storage.
   * @returns Written opaque token or ordinary conflict.
   */
  async create(key: string, bytes: Uint8Array): Promise<ConditionalObjectWriteOutcome> {
    if (this.#objects.has(key)) return Object.freeze({ kind: 'conflict' });
    this.#objects.set(key, Object.freeze({ bytes: Uint8Array.from(bytes), revision: 1 }));
    return Object.freeze({ kind: 'written', version: '1' as ObjectVersion });
  }

  /**
   * Replaces only under current revision unless this fixture is deliberately broken.
   * @param key - Exact fixture object key.
   * @param version - Opaque expected current token.
   * @param bytes - Caller-owned replacement payload.
   * @returns Written successor token or ordinary conflict.
   */
  async replace(key: string, version: ObjectVersion, bytes: Uint8Array): Promise<ConditionalObjectWriteOutcome> {
    /** Current object supplies both bytes and fixture revision. */
    const current = this.#objects.get(key);
    if (current === undefined || (!this.#acceptRetired && version !== String(current.revision))) {
      return Object.freeze({ kind: 'conflict' });
    }
    /** Successful replacement retires the prior fixture token. */
    const revision = current.revision + 1;
    this.#objects.set(key, Object.freeze({ bytes: Uint8Array.from(bytes), revision }));
    return Object.freeze({ kind: 'written', version: String(revision) as ObjectVersion });
  }

  /**
   * Returns the bounded key set needed by the complete port.
   * @param prefix - Exact key prefix selected by the caller.
   * @param limit - Maximum keys returned by the fixture.
   * @returns Frozen bounded matching-key page.
   */
  async list(prefix: string, limit: number): Promise<ConditionalObjectListPage> {
    return Object.freeze({
      keys: Object.freeze(
        [...this.#objects.keys()]
          .filter(
            /**
             * Selects only keys within the requested namespace.
             * @param key - One retained fixture object key.
             * @returns Whether the key begins with the requested prefix.
             */
            (key) => key.startsWith(prefix),
          )
          .slice(0, limit),
      ),
    });
  }
}

describe('conditional object-store probe', () => {
  it('returns explicit passing evidence for current-token CAS semantics', async () => {
    /** Passing probe result contains the exact mechanics proved live. */
    const evidence = await probeConditionalObjectStore(new MemoryConditionalObjectStore(), 'probe/one');

    expect(evidence).toEqual({
      ok: true,
      value: {
        protocol: 'archer-conditional-object-probe/1',
        key: 'probe/one',
        guarantees: {
          conditionalCreate: true,
          conditionalUpdate: true,
          retiredTokenRejected: true,
          immutableRead: true,
        },
      },
    });
  });

  it('refuses a store that accepts a retired replacement token', async () => {
    /** Deliberately broken store isolates stale-token rejection. */
    const evidence = await probeConditionalObjectStore(new MemoryConditionalObjectStore(true), 'probe/broken');

    expect(evidence.ok).toBe(false);
    if (evidence.ok) throw new Error('Broken object semantics unexpectedly passed');
    expect(evidence.error.message).toBe('retired-token-accepted');
  });
});
