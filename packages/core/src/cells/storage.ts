/**
 * @file Defines the private storage protocol shared by first-party Cell hosts.
 *
 * Values are JSON-safe and byte payloads are base64 text so SQLite workers and
 * object-store revisions persist the same storage-neutral aggregate.
 */

import type { JsonObject, Timestamp } from '../values.js';
import type { CellProtocolBinding } from './model.js';

/** Durable activation ownership retained with every mutable Cell record. */
export type StoredCellLease = Readonly<{
  /** Names the process activation that may currently advance the Cell. */
  ownerId: string;

  /** Monotonic decimal fencing every claim and acknowledgement. */
  fence: string;

  /** Permits another activation to acquire ownership after this instant. */
  expiresAt: Timestamp;
}>;

/** Durable deduplication evidence for one accepted external command. */
export type StoredCellReceipt = Readonly<{
  /** Caller-selected UUIDv4 idempotency identity. */
  key: string;

  /** Hash of subject and exact admitted event bytes. */
  fingerprint: string;

  /** Program-event sequence committed for the command. */
  sequence: string;

  /** Durable observation offset committed for the command. */
  cursorOffset: string;

  /** Fence under which the original command settled. */
  fence: string;

  /** Digest of the resulting canonical state bytes. */
  stateDigest: string;
}>;

/** One recoverable external effect intent and its latest attempt state. */
export type StoredCellEffect = Readonly<{
  /** Deterministic SHA-256 identity derived from cause and position. */
  id: string;

  /** Program-event sequence that requested the effect. */
  causedBy: string;

  /** Zero-based position in the causing Program decision. */
  position: number;

  /** Canonical effect bytes encoded as base64 text. */
  bytes: string;

  /** Controls redrive without treating progress as durable state. */
  status: 'pending' | 'claimed' | 'failed' | 'completed';

  /** Counts admitted attempts beginning at zero before the first claim. */
  attempt: number;

  /** Fence of the current or latest attempt when one exists. */
  fence?: string;
}>;

/** One future event derived from acknowledged Program state. */
export type StoredCellWake = Readonly<{
  /** Canonical due instant used by live timers and recovery scans. */
  at: Timestamp;

  /** Canonical event bytes encoded as base64 text. */
  event: string;
}>;

/** Complete mutable record replaced atomically by a CellStore commit. */
export type StoredCellRecord = Readonly<{
  /** Names this persisted record independently from store keys. */
  cellId: string;

  /** Binds every behavior and byte contract needed for restoration. */
  binding: CellProtocolBinding;

  /** Detects exact create retries without retaining initial state plaintext. */
  creation: Readonly<{
    /** UUIDv4 idempotency identity supplied at creation. */
    idempotencyKey: string;

    /** Hash of subject, binding, and canonical initial-state bytes. */
    fingerprint: string;
  }>;

  /** Orders acknowledged Program events. */
  sequence: string;

  /** Counts every durable observation, including effect attempts. */
  observationCount: string;

  /** Canonical Program state bytes encoded as base64 text. */
  state: string;

  /** Current single-writer ownership and lease boundary. */
  lease: StoredCellLease;

  /** Bounded command receipts used for exact retries and conflict detection. */
  receipts: readonly StoredCellReceipt[];

  /** Acknowledged effects retained through completion for diagnosis and identity. */
  effects: readonly StoredCellEffect[];

  /** Optional recoverable wake derived from the acknowledged state. */
  wake?: StoredCellWake;
}>;

/** Storage representation of one durable public Cell observation. */
export type StoredCellObservation =
  | Readonly<{
      /** Identifies an acknowledged Program event. */
      kind: 'event-acknowledged';

      /** Durable observation offset used by replay cursors. */
      offset: string;

      /** Program-event order after this decision. */
      sequence: string;

      /** Fence under which the decision committed. */
      fence: string;

      /** Canonical event bytes encoded as base64 text. */
      event: string;

      /** Ordered deterministic effect identities created by the decision. */
      effects: readonly string[];

      /** Trusted storage acknowledgement instant. */
      at: Timestamp;
    }>
  | Readonly<{
      /** Identifies one durably admitted external attempt. */
      kind: 'effect-attempt-claimed';

      /** Durable observation offset used by replay cursors. */
      offset: string;

      /** Deterministic effect identity. */
      effectId: string;

      /** Attempt count beginning at one. */
      attempt: number;

      /** Fence under which live work may settle. */
      fence: string;

      /** Trusted claim instant. */
      at: Timestamp;
    }>
  | Readonly<{
      /** Identifies one retained attempt failure eligible for later redrive. */
      kind: 'effect-attempt-failed';

      /** Durable observation offset used by replay cursors. */
      offset: string;

      /** Deterministic effect identity. */
      effectId: string;

      /** Exact failed attempt count. */
      attempt: number;

      /** Redacted failure with no adapter or credential object. */
      failure: JsonObject;

      /** Trusted terminal failure instant. */
      at: Timestamp;
    }>;

/** One current record paired with its opaque compare-and-swap token. */
export type StoredCellVersion = Readonly<{
  /** Opaque token meaningful only to the selected store. */
  token: string;

  /** Complete record at that exact token. */
  record: StoredCellRecord;
}>;

/** Expected create outcome that never overwrites an existing identity. */
export type CellStoreCreateOutcome =
  | Readonly<{
      /** Confirms generation zero became the current durable lineage. */
      kind: 'created';

      /** Carries the newly current record and store token. */
      current: StoredCellVersion;
    }>
  | Readonly<{
      /** Reports that another lineage already owns the Cell identity. */
      kind: 'already-exists';

      /** Carries the current winning record and store token. */
      current: StoredCellVersion;
    }>;

/** Expected replacement outcome that exposes the winning current record. */
export type CellStoreCommitOutcome =
  | Readonly<{
      /** Confirms the successor record became current. */
      kind: 'committed';

      /** Carries the committed successor and new store token. */
      current: StoredCellVersion;
    }>
  | Readonly<{
      /** Reports that expected-token replacement lost its race. */
      kind: 'conflict';

      /** Carries the current winning record and store token. */
      current: StoredCellVersion;
    }>;

/** Private atomic persistence port implemented by SQLite and S3 CAS. */
export interface CellStore {
  /** Reads one current Cell record or ordinary absence. */
  read(cellId: string): Promise<StoredCellVersion | undefined>;

  /** Creates one Cell record only while its identity is absent. */
  create(record: StoredCellRecord): Promise<CellStoreCreateOutcome>;

  /** Replaces one exact version and appends its observations atomically. */
  commit(
    cellId: string,
    expectedToken: string,
    record: StoredCellRecord,
    observations: readonly StoredCellObservation[],
  ): Promise<CellStoreCommitOutcome>;

  /** Restores all retained observations in ascending offset order. */
  observations(cellId: string): Promise<readonly StoredCellObservation[]>;

  /** Releases transport or worker resources idempotently. */
  close(): Promise<void>;
}
