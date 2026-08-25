/**
 * @file Defines and probes the conditional object semantics required by S3 CAS Cells.
 *
 * Tokens are opaque storage evidence, never assumed to be content digests. A
 * live probe proves behavior because TypeScript cannot prove a bucket service.
 */

import type { Result } from '../result.js';

/** Prevents arbitrary response metadata from becoming a CAS precondition. */
declare const objectVersionBrand: unique symbol;

/** Opaque current-object token returned and consumed by one store implementation. */
export type ObjectVersion = string & {
  /** Carries compile-time evidence that the token came from object storage. */
  readonly [objectVersionBrand]: true;
};

/** One immutable read result with copied bytes and its exact current token. */
export type VersionedObject = Readonly<{
  /** Exact normalized object key selected by the caller. */
  key: string;

  /** Fresh payload bytes that do not alias an SDK body buffer. */
  bytes: Uint8Array;

  /** Opaque token valid only while this object remains current. */
  version: ObjectVersion;
}>;

/** Ordinary conditional-write outcome rather than an exception-based race. */
export type ConditionalObjectWriteOutcome =
  | Readonly<{
      /** Confirms the exact precondition and new payload became current. */
      kind: 'written';

      /** Carries the newly current token. */
      version: ObjectVersion;
    }>
  | Readonly<{
      /** Confirms the supplied absence or version precondition lost. */
      kind: 'conflict';
    }>;

/** One bounded page of keys without assuming a provider's continuation token shape. */
export type ConditionalObjectListPage = Readonly<{
  /** Keys in provider order, each below the requested prefix. */
  keys: readonly string[];

  /** Opaque continuation supplied only when another page exists. */
  cursor?: string;
}>;

/** Storage product port required by direct object-store Cell revisions. */
export interface ConditionalObjectStore {
  /** Reads one current object or ordinary absence. */
  read(key: string): Promise<VersionedObject | undefined>;

  /** Creates one object only while its key is absent. */
  create(key: string, bytes: Uint8Array): Promise<ConditionalObjectWriteOutcome>;

  /** Replaces one object only while its opaque token remains current. */
  replace(key: string, version: ObjectVersion, bytes: Uint8Array): Promise<ConditionalObjectWriteOutcome>;

  /** Lists a bounded key page for wake discovery and operator inspection. */
  list(prefix: string, limit: number, cursor?: string): Promise<ConditionalObjectListPage>;
}

/** Stable live-probe failure categories used by deployment policy. */
export type ConditionalObjectProbeErrorCode =
  'conditional-create-violated' | 'conditional-update-violated' | 'retired-token-accepted' | 'immutable-read-violated';

/** Exact result of proving conditional semantics against a live service. */
export type ConditionalObjectProbeEvidence = Readonly<{
  /** Identifies the fixed conformance sequence. */
  protocol: 'archer-conditional-object-probe/1';

  /** Names the isolated probe object for lifecycle cleanup or inspection. */
  key: string;

  /** Confirms all four required semantic facts. */
  guarantees: Readonly<{
    /** A second absence-preconditioned create was refused. */
    conditionalCreate: true;

    /** Replacement under the current token succeeded. */
    conditionalUpdate: true;

    /** Replacement under the retired token was refused. */
    retiredTokenRejected: true;

    /** The successful payload was readable by exact bytes. */
    immutableRead: true;
  }>;
}>;

/**
 * Proves the four object semantics required before an S3 CellHost serves.
 * @param store - Live conditional store selected by deployment configuration.
 * @param key - Isolated probe key whose retention is explicit to the caller.
 * @returns Passing evidence or exact proved semantic violation.
 */
export async function probeConditionalObjectStore(
  store: ConditionalObjectStore,
  key: string,
): Promise<Result<ConditionalObjectProbeEvidence, Error>> {
  if (key.trim().length === 0)
    return Object.freeze({ ok: false, error: new RangeError('probe key must not be empty') });
  /** Distinct byte values expose ignored preconditions and stale reads. */
  const first = new TextEncoder().encode('archer-probe:first');
  /** Replacement bytes must remain distinct from the conditional create payload. */
  const second = new TextEncoder().encode('archer-probe:second');
  /** First conditional create establishes the current object version. */
  const created = await store.create(key, first);
  if (created.kind !== 'written') {
    return Object.freeze({ ok: false, error: new Error('conditional-create-violated') });
  }
  /** Duplicate create must conflict rather than overwrite existing bytes. */
  const duplicate = await store.create(key, second);
  if (duplicate.kind !== 'conflict') {
    return Object.freeze({ ok: false, error: new Error('conditional-create-violated') });
  }
  /** Current-version replacement proves optimistic compare-and-swap. */
  const replaced = await store.replace(key, created.version, second);
  if (replaced.kind !== 'written') {
    return Object.freeze({ ok: false, error: new Error('conditional-update-violated') });
  }
  /** Reusing the retired token must fail after a successful replacement. */
  const retired = await store.replace(key, created.version, first);
  if (retired.kind !== 'conflict') {
    return Object.freeze({ ok: false, error: new Error('retired-token-accepted') });
  }
  /** Final read proves the successful replacement bytes remained exact. */
  const restored = await store.read(key);
  if (restored === undefined || !Buffer.from(restored.bytes).equals(Buffer.from(second))) {
    return Object.freeze({ ok: false, error: new Error('immutable-read-violated') });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      protocol: 'archer-conditional-object-probe/1',
      key,
      guarantees: Object.freeze({
        conditionalCreate: true,
        conditionalUpdate: true,
        retiredTokenRejected: true,
        immutableRead: true,
      }),
    }),
  });
}
