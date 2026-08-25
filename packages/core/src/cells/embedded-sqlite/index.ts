/**
 * @file Implements same-filesystem Cells with Node's built-in SQLite runtime.
 *
 * A transaction replaces the complete mutable record and appends observations;
 * no acknowledgement is published before that transaction commits.
 */

import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import type { CellHost, CellHostBaseOptions } from '../contracts.js';
import { createCellHostRuntime } from '../runtime.js';
import type {
  CellStore,
  CellStoreCommitOutcome,
  CellStoreCreateOutcome,
  StoredCellObservation,
  StoredCellRecord,
  StoredCellVersion,
} from '../storage.js';

/** Construction for the built-in same-filesystem SQLite CellHost. */
export type EmbeddedSqliteCellHostOptions = CellHostBaseOptions &
  Readonly<{
    /** Selects a SQLite file or the explicit `:memory:` development database. */
    databasePath: string;

    /** Uses a worker by default so synchronous SQLite never blocks the application loop. */
    execution?: 'worker' | 'inline';
  }>;

/** Database row shape returned by the private current-record query. */
type CellRow = Readonly<{
  /** Monotonic SQLite compare-and-swap revision. */
  version: number;

  /** JSON serialization of the storage-neutral Cell record. */
  record: string;
}>;

/** Database row shape returned by ordered observation restoration. */
type ObservationRow = Readonly<{
  /** JSON serialization of one storage-neutral observation. */
  observation: string;
}>;

/** Private SQL schema deliberately contains no application-specific columns. */
const CELL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS archer_cells (
    cell_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS archer_cell_observations (
    cell_id TEXT NOT NULL,
    offset INTEGER NOT NULL,
    observation TEXT NOT NULL,
    PRIMARY KEY (cell_id, offset),
    FOREIGN KEY (cell_id) REFERENCES archer_cells(cell_id)
  ) STRICT;
`;

/**
 * Parses one private JSON record and gives structural faults an adapter boundary.
 * @param value - JSON text read from SQLite.
 * @returns Restored storage-neutral record.
 */
function parseRecord(value: string): StoredCellRecord {
  return JSON.parse(value) as StoredCellRecord;
}

/**
 * Parses one private JSON observation and gives corruption an adapter boundary.
 * @param value - JSON text read from SQLite.
 * @returns Restored storage-neutral observation.
 */
function parseObservation(value: string): StoredCellObservation {
  return JSON.parse(value) as StoredCellObservation;
}

/** Executes SQLite transactions behind the storage-neutral CellStore protocol. */
class InlineSqliteCellStore implements CellStore {
  /** Owns one SQLite connection and its transaction scope. */
  readonly #database: DatabaseSync;

  /** Prevents operations after idempotent connection closure. */
  #closed = false;

  /**
   * Opens and migrates one explicit SQLite database.
   * @param databasePath - File path or `:memory:` selected by the caller.
   */
  constructor(databasePath: string) {
    if (databasePath.trim().length === 0) throw new RangeError('databasePath must not be empty');
    this.#database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    this.#database.exec('PRAGMA busy_timeout = 5000');
    if (databasePath !== ':memory:') this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec(CELL_SCHEMA);
  }

  /**
   * Reads one current record and SQLite revision token.
   * @param cellId - Durable Cell identity used as the primary key.
   * @returns Current record/version pair or absence.
   */
  async read(cellId: string): Promise<StoredCellVersion | undefined> {
    this.#assertOpen();
    /** Uses a fresh statement because Node owns its native lifecycle with the connection. */
    const row = this.#database.prepare('SELECT version, record FROM archer_cells WHERE cell_id = ?').get(cellId) as
      CellRow | undefined;
    return row === undefined
      ? undefined
      : Object.freeze({ token: String(row.version), record: parseRecord(row.record) });
  }

  /**
   * Creates one record without overwriting a winner.
   * @param record - Complete generation-zero Cell record.
   * @returns Created record or current winning lineage.
   */
  async create(record: StoredCellRecord): Promise<CellStoreCreateOutcome> {
    this.#assertOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      /** Detects an existing lineage while holding the immediate transaction lock. */
      const existing = await this.read(record.cellId);
      if (existing !== undefined) {
        this.#database.exec('COMMIT');
        return Object.freeze({ kind: 'already-exists', current: existing });
      }
      this.#database
        .prepare('INSERT INTO archer_cells (cell_id, version, record) VALUES (?, 1, ?)')
        .run(record.cellId, JSON.stringify(record));
      this.#database.exec('COMMIT');
      return Object.freeze({ kind: 'created', current: Object.freeze({ token: '1', record }) });
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Replaces one exact record and appends observations in the same transaction.
   * @param cellId - Durable Cell identity used as the primary key.
   * @param expectedToken - Exact SQLite revision required for replacement.
   * @param record - Complete successor Cell record.
   * @param observations - Ordered operational evidence committed with the record.
   * @returns Committed successor or current conflict winner.
   */
  async commit(
    cellId: string,
    expectedToken: string,
    record: StoredCellRecord,
    observations: readonly StoredCellObservation[],
  ): Promise<CellStoreCommitOutcome> {
    this.#assertOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      /** Reads the current revision under the immediate transaction lock. */
      const current = await this.read(cellId);
      if (current === undefined) throw new Error('Cell disappeared during SQLite commit');
      if (current.token !== expectedToken) {
        this.#database.exec('COMMIT');
        return Object.freeze({ kind: 'conflict', current });
      }
      /** SQLite integer revision advances exactly once per committed record. */
      const nextVersion = Number(expectedToken) + 1;
      this.#database
        .prepare('UPDATE archer_cells SET version = ?, record = ? WHERE cell_id = ? AND version = ?')
        .run(nextVersion, JSON.stringify(record), cellId, Number(expectedToken));
      /** Reused statement appends all observations within the same transaction. */
      const insert = this.#database.prepare(
        'INSERT INTO archer_cell_observations (cell_id, offset, observation) VALUES (?, ?, ?)',
      );
      /** Appends observations in caller order before transaction acknowledgement. */
      for (const observation of observations) {
        insert.run(cellId, Number(observation.offset), JSON.stringify(observation));
      }
      this.#database.exec('COMMIT');
      return Object.freeze({
        kind: 'committed',
        current: Object.freeze({ token: String(nextVersion), record }),
      });
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Restores durable observations in exact ascending cursor order.
   * @param cellId - Durable Cell identity owning the observation stream.
   * @returns Fresh ordered observation values.
   */
  async observations(cellId: string): Promise<readonly StoredCellObservation[]> {
    this.#assertOpen();
    /** Database rows arrive in cursor order by explicit SQL ordering. */
    const rows = this.#database
      .prepare('SELECT observation FROM archer_cell_observations WHERE cell_id = ? ORDER BY offset ASC')
      .all(cellId) as unknown as readonly ObservationRow[];
    return Object.freeze(
      rows.map(
        /**
         * Parses each private JSON row into its storage-neutral representation.
         * @param row - SQLite observation row.
         * @returns Fresh stored observation value.
         */
        (row) => parseObservation(row.observation),
      ),
    );
  }

  /** Closes the owned SQLite connection idempotently. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  /** Rejects calls that would otherwise enter a closed native connection. */
  #assertOpen(): void {
    if (this.#closed) throw new Error('Embedded SQLite CellStore is closed');
  }
}

/** Worker request that reads one current Cell record. */
type SqliteWorkerRead = Readonly<{
  /** Selects current-record lookup. */
  type: 'read';

  /** Names the durable Cell to read. */
  cellId: string;
}>;

/** Worker request that creates one absent Cell record. */
type SqliteWorkerCreate = Readonly<{
  /** Selects atomic generation-zero creation. */
  type: 'create';

  /** Carries the complete storage-neutral initial record. */
  record: StoredCellRecord;
}>;

/** Worker request that conditionally replaces one Cell record. */
type SqliteWorkerCommit = Readonly<{
  /** Selects transactional compare-and-swap. */
  type: 'commit';

  /** Names the durable Cell to replace. */
  cellId: string;

  /** Requires this exact current SQLite revision. */
  expectedToken: string;

  /** Carries the complete storage-neutral successor record. */
  record: StoredCellRecord;

  /** Carries ordered observations appended in the same transaction. */
  observations: readonly StoredCellObservation[];
}>;

/** Worker request that restores one Cell's durable observation history. */
type SqliteWorkerObservations = Readonly<{
  /** Selects ordered observation lookup. */
  type: 'observations';

  /** Names the durable Cell whose history is restored. */
  cellId: string;
}>;

/** Worker request that closes its owned SQLite connection. */
type SqliteWorkerClose = Readonly<{
  /** Selects terminal worker cleanup. */
  type: 'close';
}>;

/** Request commands understood by the isolated SQLite worker. */
type SqliteWorkerOperation =
  SqliteWorkerRead | SqliteWorkerCreate | SqliteWorkerCommit | SqliteWorkerObservations | SqliteWorkerClose;

/** One correlated command sent to the isolated worker. */
type SqliteWorkerRequest = Readonly<{
  /** Monotonic process-local correlation identity. */
  id: number;

  /** Exact storage operation and JSON-safe arguments. */
  operation: SqliteWorkerOperation;
}>;

/** Successful correlated worker response. */
type SuccessfulSqliteWorkerResponse = Readonly<{
  /** Echoes the process-local request correlation identity. */
  id: number;

  /** Selects the successful response branch. */
  ok: true;

  /** Carries the JSON-safe storage operation result. */
  value: unknown;
}>;

/** Redacted failed correlated worker response. */
type FailedSqliteWorkerResponse = Readonly<{
  /** Echoes the process-local request correlation identity. */
  id: number;

  /** Selects the failed response branch. */
  ok: false;

  /** Stable message excludes SQL and durable record contents. */
  message: string;
}>;

/** One successful or redacted failed worker response. */
type SqliteWorkerResponse = SuccessfulSqliteWorkerResponse | FailedSqliteWorkerResponse;

/** Pending response callbacks retained only until one worker reply arrives. */
type PendingWorkerRequest = Readonly<{
  /** Resolves the exact JSON-safe storage result. */
  resolve(value: unknown): void;

  /** Rejects worker failure without exposing SQL or database contents. */
  reject(error: Error): void;
}>;

/** CellStore proxy that keeps every synchronous SQLite call off the application loop. */
class WorkerSqliteCellStore implements CellStore {
  /** Owns the one worker and its native SQLite connection. */
  readonly #worker: Worker;

  /** Correlates in-flight asynchronous host operations to worker replies. */
  readonly #pending = new Map<number, PendingWorkerRequest>();

  /** Produces unique correlation identities without durable meaning. */
  #nextRequestId = 1;

  /** Retains one idempotent worker shutdown. */
  #closePromise: Promise<void> | undefined;

  /**
   * Starts an isolated Node worker with one explicit database path.
   * @param databasePath - File path or `:memory:` interpreted inside the worker.
   */
  constructor(databasePath: string) {
    if (databasePath.trim().length === 0) throw new RangeError('databasePath must not be empty');
    /** Node 26 can strip the erasable test-source TypeScript; builds use emitted JavaScript. */
    const workerModule = import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js';
    this.#worker = new Worker(new URL(workerModule, import.meta.url), { workerData: { databasePath } });
    this.#worker.on(
      'message',
      /**
       * Resolves only the request named by one correlated worker response.
       * @param response - Successful or redacted failed worker response.
       */
      (response: SqliteWorkerResponse) => {
        /** Pending resolver pair registered before the request was posted. */
        const pending = this.#pending.get(response.id);
        if (pending === undefined) return;
        this.#pending.delete(response.id);
        if (response.ok) pending.resolve(response.value);
        else pending.reject(new Error(response.message));
      },
    );
    this.#worker.on(
      'error',
      /**
       * Rejects every pending request after a terminal worker error.
       * @param error - Native worker error or unknown emitted failure.
       * @returns Nothing after rejecting pending work.
       */
      (error) => this.#rejectPending(error instanceof Error ? error : new Error('Embedded SQLite worker failed')),
    );
    this.#worker.on(
      'exit',
      /**
       * Rejects pending work only when the worker exits unexpectedly.
       * @param code - Native worker process exit code.
       */
      (code) => {
        if (code !== 0) this.#rejectPending(new Error('Embedded SQLite worker exited unexpectedly'));
      },
    );
  }

  /**
   * Reads one current record through the worker boundary.
   * @param cellId - Durable Cell identity used as the primary key.
   * @returns Current record/version pair or absence.
   */
  async read(cellId: string): Promise<StoredCellVersion | undefined> {
    return this.#request({ type: 'read', cellId }) as Promise<StoredCellVersion | undefined>;
  }

  /**
   * Creates one absent record through the worker boundary.
   * @param record - Complete generation-zero Cell record.
   * @returns Created record or current winning lineage.
   */
  async create(record: StoredCellRecord): Promise<CellStoreCreateOutcome> {
    return this.#request({ type: 'create', record }) as Promise<CellStoreCreateOutcome>;
  }

  /**
   * Replaces one exact record and appends observations through the worker boundary.
   * @param cellId - Durable Cell identity used as the primary key.
   * @param expectedToken - Exact SQLite revision required for replacement.
   * @param record - Complete successor Cell record.
   * @param observations - Ordered operational evidence committed with the record.
   * @returns Committed successor or current conflict winner.
   */
  async commit(
    cellId: string,
    expectedToken: string,
    record: StoredCellRecord,
    observations: readonly StoredCellObservation[],
  ): Promise<CellStoreCommitOutcome> {
    return this.#request({
      type: 'commit',
      cellId,
      expectedToken,
      record,
      observations,
    }) as Promise<CellStoreCommitOutcome>;
  }

  /**
   * Restores ordered observations through the worker boundary.
   * @param cellId - Durable Cell identity owning the observation stream.
   * @returns Fresh ordered observation values.
   */
  async observations(cellId: string): Promise<readonly StoredCellObservation[]> {
    return this.#request({ type: 'observations', cellId }) as Promise<readonly StoredCellObservation[]>;
  }

  /**
   * Closes the native database and worker idempotently.
   * @returns Shared worker shutdown settlement.
   */
  close(): Promise<void> {
    this.#closePromise ??= this.#request({ type: 'close' }).then(
      /** Terminates the worker only after native SQLite closure acknowledges. */
      async () => {
        await this.#worker.terminate();
      },
    );
    return this.#closePromise;
  }

  /**
   * Sends one correlated JSON-safe operation.
   * @param operation - Exact private CellStore command.
   * @returns Worker result settlement.
   */
  #request(operation: SqliteWorkerOperation): Promise<unknown> {
    /** Fresh request identity exists only for this parent/worker process pair. */
    const id = this.#nextRequestId++;
    return new Promise(
      /**
       * Retains resolvers before posting so an immediate reply cannot race registration.
       * @param resolve - Native resolver for the correlated worker result.
       * @param reject - Native rejector for terminal worker failure.
       */
      (resolve, reject) => {
        this.#pending.set(id, Object.freeze({ resolve, reject }));
        /** Correlated immutable request crosses the structured-clone boundary. */
        const request: SqliteWorkerRequest = Object.freeze({ id, operation });
        this.#worker.postMessage(request);
      },
    );
  }

  /**
   * Rejects every pending call after one terminal worker failure.
   * @param error - Stable terminal worker failure shared by pending requests.
   */
  #rejectPending(error: Error): void {
    /** Settles all outstanding requests before clearing correlation state. */
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/**
 * Opens the built-in embedded SQLite CellHost.
 * @param options - Database path, authority, lifecycle, clock, and diagnostics.
 * @returns Retained host acknowledging at one local SQLite transaction.
 */
export async function embeddedSqliteCells(options: EmbeddedSqliteCellHostOptions): Promise<CellHost> {
  /** SQLite storage is owned exclusively by the returned CellHost. */
  const store: CellStore =
    options.execution === 'inline'
      ? new InlineSqliteCellStore(options.databasePath)
      : new WorkerSqliteCellStore(options.databasePath);
  return createCellHostRuntime({
    base: options,
    durability: Object.freeze({
      type: 'embedded-sqlite',
      persistence: 'same-filesystem',
      acknowledgement: 'sqlite-transaction',
    }),
    store,
  });
}
