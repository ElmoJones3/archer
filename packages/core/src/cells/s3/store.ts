/**
 * @file Persists storage-neutral Cells as immutable revisions behind a CAS head.
 *
 * A lost head race may leave an immutable orphan, but it cannot acknowledge or
 * become reachable. Readers trust only the revision named by the current head.
 */

import type { ConditionalObjectStore, ObjectVersion } from '../object-store.js';
import { CellError } from '../contracts.js';
import type {
  CellStore,
  CellStoreCommitOutcome,
  CellStoreCreateOutcome,
  StoredCellObservation,
  StoredCellRecord,
  StoredCellVersion,
} from '../storage.js';

/** Small current pointer conditionally replaced after immutable publication. */
type S3CellHead = Readonly<{
  /** Names the only reachable current immutable revision. */
  revisionKey: string;

  /** Repeats the storage revision for operator inspection. */
  revision: string;

  /** Supports bounded wake discovery without reading state payloads. */
  wakeAt?: string;

  /** Supports ownership inspection without reading state payloads. */
  leaseExpiresAt: string;

  /** Signals acknowledged or stranded effects without exposing their payloads. */
  recoverableWork: boolean;
}>;

/** One immutable revision reachable through the head or a prior revision link. */
type S3CellRevision = Readonly<{
  /** Complete mutable Cell record at this exact commit. */
  record: StoredCellRecord;

  /** Observations atomically acknowledged by this commit. */
  observations: readonly StoredCellObservation[];

  /** Previous reachable revision used to restore durable history. */
  previous?: string;
}>;

/** Current head and decoded revision needed by CellStore CAS. */
type CurrentS3Cell = Readonly<{
  /** Opaque object-store version used as the CellStore token. */
  version: ObjectVersion;

  /** Decoded small current pointer. */
  head: S3CellHead;

  /** Decoded immutable current revision. */
  revision: S3CellRevision;
}>;

/** Options for the direct immutable-revision CellStore. */
export type S3CasCellStoreOptions = Readonly<{
  /** Conditional object protocol already proved against the live service. */
  store: ConditionalObjectStore;

  /** Normalized namespace below the configured bucket. */
  prefix: string;

  /** Maximum serialized mutable record bytes accepted before remote writes. */
  stateLimitBytes: number;

  /** Releases the underlying SDK client only when ownership transferred. */
  closeTransport(): Promise<void>;
}>;

/** UTF-8 codec shared by heads and immutable revision objects. */
const TEXT_ENCODER = new TextEncoder();

/** UTF-8 decoder rejects malformed object bytes rather than replacing them. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Normalizes a caller prefix without accepting root or traversal-like segments.
 * @param prefix - Caller-selected object namespace.
 * @returns Slash-trimmed non-empty prefix.
 */
function normalizePrefix(prefix: string): string {
  /** Slash-trimmed namespace is validated before any remote key is built. */
  const normalized = prefix.replace(/^\/+|\/+$/gu, '');
  if (
    normalized.length === 0 ||
    normalized.split('/').some(
      /**
       * Rejects segments whose filesystem meaning would mislead namespace review.
       * @param segment - One slash-delimited object-key segment.
       * @returns Whether the segment is traversal-like.
       */
      (segment) => segment === '.' || segment === '..',
    )
  ) {
    throw new RangeError('S3 Cell prefix must be non-empty and contain no traversal segments');
  }
  return normalized;
}

/**
 * Encodes one private JSON value with stable property insertion owned by Archer.
 * @param value - Head or revision assembled by this module.
 * @returns Fresh UTF-8 JSON bytes.
 */
function encodeJson(value: S3CellHead | S3CellRevision): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value));
}

/**
 * Decodes one private object as a head.
 * @param bytes - Fresh object-store bytes.
 * @returns Parsed private pointer shape.
 */
function decodeHead(bytes: Uint8Array): S3CellHead {
  return JSON.parse(TEXT_DECODER.decode(bytes)) as S3CellHead;
}

/**
 * Decodes one private object as an immutable revision.
 * @param bytes - Fresh object-store bytes.
 * @returns Parsed storage-neutral revision shape.
 */
function decodeRevision(bytes: Uint8Array): S3CellRevision {
  return JSON.parse(TEXT_DECODER.decode(bytes)) as S3CellRevision;
}

/**
 * Names revisions from fields that every non-noop runtime commit must advance.
 * Exact safe retries reuse the same key and must reproduce identical revision
 * bytes; publication rejects any violated runtime invariant as a key collision.
 * @param record - Complete next Cell record.
 * @returns Stable key suffix unique to event and storage-only commits.
 */
function revisionIdentity(record: StoredCellRecord): string {
  /** Lease, sequence, and observation position make renewal-only commits distinct. */
  return [record.sequence, record.observationCount, record.lease.fence, Date.parse(record.lease.expiresAt)].join('-');
}

/** Direct conditional-object implementation of the private CellStore protocol. */
export class S3CasCellStore implements CellStore {
  /** Live conditional object protocol selected by the S3 adapter. */
  readonly #store: ConditionalObjectStore;

  /** Normalized object namespace. */
  readonly #prefix: string;

  /** Maximum complete mutable record bytes. */
  readonly #stateLimitBytes: number;

  /** Explicit owned-client cleanup. */
  readonly #closeTransport: () => Promise<void>;

  /** Prevents duplicate transport cleanup. */
  #closed = false;

  /**
   * Constructs direct CAS persistence after the live probe passes.
   * @param options - Store, namespace, bound, and lifecycle callback.
   */
  constructor(options: S3CasCellStoreOptions) {
    if (!Number.isSafeInteger(options.stateLimitBytes) || options.stateLimitBytes < 1) {
      throw new RangeError('stateLimitBytes must be a positive safe integer');
    }
    this.#store = options.store;
    this.#prefix = normalizePrefix(options.prefix);
    this.#stateLimitBytes = options.stateLimitBytes;
    this.#closeTransport = options.closeTransport;
  }

  /**
   * Reads one current head and its reachable immutable revision.
   * @param cellId - Durable Cell identity below the configured namespace.
   * @returns Current record/version pair or absence.
   */
  async read(cellId: string): Promise<StoredCellVersion | undefined> {
    /** Head traversal is centralized so reads and commits share reachability rules. */
    const current = await this.#readCurrent(cellId);
    return current === undefined
      ? undefined
      : Object.freeze({ token: current.version, record: current.revision.record });
  }

  /**
   * Publishes generation zero immutably before conditionally creating its head.
   * @param record - Complete generation-zero Cell record.
   * @returns Created record or current winning lineage.
   */
  async create(record: StoredCellRecord): Promise<CellStoreCreateOutcome> {
    this.#assertRecordBound(record);
    /** Immutable generation-zero key is derived from exact record ordering fields. */
    const revisionKey = this.#revisionKey(record.cellId, record);
    /** First immutable revision has no prior link or observations. */
    const revision: S3CellRevision = Object.freeze({ record, observations: Object.freeze([]) });
    await this.#publishImmutable(revisionKey, encodeJson(revision));
    /** Small mutable head makes the immutable revision reachable. */
    const head = this.#head(revisionKey, '1', record);
    /** Conditional create is the only generation-zero acknowledgement boundary. */
    const created = await this.#store.create(this.#headKey(record.cellId), encodeJson(head));
    if (created.kind === 'written') {
      return Object.freeze({
        kind: 'created',
        current: Object.freeze({ token: created.version, record }),
      });
    }
    /** Conflicting head owner must be readable before reporting an existing lineage. */
    const winner = await this.read(record.cellId);
    if (winner === undefined) throw new Error('S3 Cell head conflicted but no winner was readable');
    return Object.freeze({ kind: 'already-exists', current: winner });
  }

  /**
   * Publishes an immutable successor, then acknowledges only after head replacement.
   * @param cellId - Durable Cell identity below the configured namespace.
   * @param expectedToken - Exact opaque current head version.
   * @param record - Complete successor Cell record.
   * @param observations - Ordered evidence acknowledged by this successor.
   * @returns Committed successor or current conflict winner.
   */
  async commit(
    cellId: string,
    expectedToken: string,
    record: StoredCellRecord,
    observations: readonly StoredCellObservation[],
  ): Promise<CellStoreCommitOutcome> {
    this.#assertRecordBound(record);
    /** Current reachable revision establishes both token and prior link. */
    const current = await this.#readCurrent(cellId);
    if (current === undefined) throw new Error('S3 Cell disappeared during commit');
    if (current.version !== expectedToken) {
      return Object.freeze({
        kind: 'conflict',
        current: Object.freeze({ token: current.version, record: current.revision.record }),
      });
    }
    /** Successor key is stable across safe retry after uncertain transport outcome. */
    const revisionKey = this.#revisionKey(cellId, record);
    /** Immutable successor links to the previously reachable revision. */
    const revision: S3CellRevision = Object.freeze({
      record,
      observations: Object.freeze([...observations]),
      previous: current.head.revisionKey,
    });
    await this.#publishImmutable(revisionKey, encodeJson(revision));
    /** Advances without narrowing a long-lived Cell revision through Number precision. */
    const nextRevision = (BigInt(current.head.revision) + 1n).toString();
    /** Head replacement is the only acknowledgement boundary. */
    const replaced = await this.#store.replace(
      this.#headKey(cellId),
      current.version,
      encodeJson(this.#head(revisionKey, nextRevision, record)),
    );
    if (replaced.kind === 'written') {
      return Object.freeze({
        kind: 'committed',
        current: Object.freeze({ token: replaced.version, record }),
      });
    }
    /** Lost-race winner is resolved through the now-current head. */
    const winner = await this.read(cellId);
    if (winner === undefined) throw new Error('S3 Cell head replacement conflicted without a readable winner');
    return Object.freeze({ kind: 'conflict', current: winner });
  }

  /**
   * Walks reachable immutable revisions and restores observations in ascending order.
   * @param cellId - Durable Cell identity owning the revision chain.
   * @returns Fresh ordered durable observations.
   */
  async observations(cellId: string): Promise<readonly StoredCellObservation[]> {
    /** Only the current head defines which immutable chain is acknowledged. */
    const current = await this.#readCurrent(cellId);
    if (current === undefined) return Object.freeze([]);
    /** Reverse chronological revision chain collected from current to genesis. */
    const revisions: S3CellRevision[] = [];
    /** Cursor follows explicit prior links and ignores unreachable orphan objects. */
    let revision: S3CellRevision | undefined = current.revision;
    /** Walks only the chain reachable from the current CAS head. */
    while (revision !== undefined) {
      revisions.push(revision);
      if (revision.previous === undefined) break;
      /** Previous immutable object must exist for history to be trustworthy. */
      const prior = await this.#store.read(revision.previous);
      if (prior === undefined) throw new Error('S3 Cell revision chain is incomplete');
      revision = decodeRevision(prior.bytes);
    }
    return Object.freeze(
      revisions
        .reverse()
        .flatMap(
          /**
           * Projects observations from one chronological immutable revision.
           * @param item - Reachable decoded revision.
           * @returns Observations atomically acknowledged by that revision.
           */
          (item) => item.observations,
        )
        .sort(
          /**
           * Orders arbitrary-precision cursor offsets without Number narrowing.
           * @param left - First durable observation.
           * @param right - Second durable observation.
           * @returns Ascending comparator result.
           */
          (left, right) => (BigInt(left.offset) < BigInt(right.offset) ? -1 : 1),
        ),
    );
  }

  /** Releases only transport lifecycle explicitly transferred to this store. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#closeTransport();
  }

  /**
   * Reads and decodes one reachable current Cell.
   * @param cellId - Durable Cell identity.
   * @returns Head token, pointer, and exact immutable revision.
   */
  async #readCurrent(cellId: string): Promise<CurrentS3Cell | undefined> {
    /** Small mutable head is the sole authority for current reachability. */
    const headObject = await this.#store.read(this.#headKey(cellId));
    if (headObject === undefined) return undefined;
    /** Decoded head carries the immutable revision pointer and scan metadata. */
    const head = decodeHead(headObject.bytes);
    /** Exact immutable object named by the head must be readable. */
    const revisionObject = await this.#store.read(head.revisionKey);
    if (revisionObject === undefined) throw new Error('S3 Cell head names a missing immutable revision');
    return Object.freeze({ version: headObject.version, head, revision: decodeRevision(revisionObject.bytes) });
  }

  /**
   * Publishes immutable bytes and accepts only an exact pre-existing copy.
   * @param key - Content-derived immutable revision key.
   * @param bytes - Exact revision bytes.
   */
  async #publishImmutable(key: string, bytes: Uint8Array): Promise<void> {
    /** Absence-conditioned write handles the ordinary first publication. */
    const created = await this.#store.create(key, bytes);
    if (created.kind === 'written') return;
    /** An existing immutable key is safe only when its bytes are identical. */
    const existing = await this.#store.read(key);
    if (existing === undefined || !Buffer.from(existing.bytes).equals(Buffer.from(bytes))) {
      throw new Error('S3 immutable Cell revision key collision');
    }
  }

  /**
   * Rejects an oversized mutable record before publishing an orphan revision.
   * @param record - Complete mutable Cell record proposed for publication.
   */
  #assertRecordBound(record: StoredCellRecord): void {
    if (TEXT_ENCODER.encode(JSON.stringify(record)).byteLength > this.#stateLimitBytes) {
      throw new CellError('cell_capacity_exceeded', 'S3 Cell mutable record exceeds stateLimitBytes');
    }
  }

  /**
   * Builds one small head from the mutable record's scan-relevant fields.
   * @param revisionKey - Exact reachable immutable revision key.
   * @param revision - Arbitrary-precision head revision text.
   * @param record - Complete current Cell record supplying scan metadata.
   * @returns Frozen small current pointer.
   */
  #head(revisionKey: string, revision: string, record: StoredCellRecord): S3CellHead {
    return Object.freeze({
      revisionKey,
      revision,
      leaseExpiresAt: record.lease.expiresAt,
      recoverableWork: record.effects.some(
        /**
         * Treats pending, failed, and claimed effects as recoverable work.
         * @param effect - Acknowledged durable effect record.
         * @returns Whether recovery may need to redrive this effect.
         */
        (effect) => effect.status !== 'completed',
      ),
      ...(record.wake === undefined ? {} : { wakeAt: record.wake.at }),
    });
  }

  /**
   * Returns the only mutable object key for one Cell.
   * @param cellId - Durable Cell identity below the configured namespace.
   * @returns Current head object key.
   */
  #headKey(cellId: string): string {
    return `${this.#prefix}/heads/${cellId}.json`;
  }

  /**
   * Returns one immutable revision key without relying on ETag digest semantics.
   * @param cellId - Durable Cell identity below the configured namespace.
   * @param record - Complete successor record supplying revision identity.
   * @returns Immutable revision object key.
   */
  #revisionKey(cellId: string, record: StoredCellRecord): string {
    return `${this.#prefix}/revisions/${cellId}/${revisionIdentity(record)}.json`;
  }
}
