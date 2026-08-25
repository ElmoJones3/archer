/**
 * @file Owns synchronous Node SQLite work for the embedded CellHost worker.
 *
 * Messages contain only the storage-neutral JSON record protocol. Native
 * DatabaseSync values and errors never enter the public Cell API.
 */

import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import type {
  CellStoreCommitOutcome,
  CellStoreCreateOutcome,
  StoredCellObservation,
  StoredCellRecord,
  StoredCellVersion,
} from '../storage.js';

/** Trusted worker construction data supplied by the parent adapter. */
type WorkerData = Readonly<{
  /** File path or explicit in-memory database selected by the parent. */
  databasePath: string;
}>;

/** Parent request that reads one current Cell record. */
type WorkerRead = Readonly<{
  /** Selects current-record lookup. */
  type: 'read';

  /** Names the durable Cell to read. */
  cellId: string;
}>;

/** Parent request that creates one absent Cell record. */
type WorkerCreate = Readonly<{
  /** Selects atomic generation-zero creation. */
  type: 'create';

  /** Carries the complete storage-neutral initial record. */
  record: StoredCellRecord;
}>;

/** Parent request that conditionally replaces one Cell record. */
type WorkerCommit = Readonly<{
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

/** Parent request that restores durable observation history. */
type WorkerObservations = Readonly<{
  /** Selects ordered observation lookup. */
  type: 'observations';

  /** Names the durable Cell whose history is restored. */
  cellId: string;
}>;

/** Parent request that closes native SQLite and its message channel. */
type WorkerClose = Readonly<{
  /** Selects terminal worker cleanup. */
  type: 'close';
}>;

/** Request operations accepted from the parent CellStore proxy. */
type WorkerOperation = WorkerRead | WorkerCreate | WorkerCommit | WorkerObservations | WorkerClose;

/** Correlated parent request. */
type WorkerRequest = Readonly<{
  /** Process-local correlation identity echoed in the response. */
  id: number;

  /** Exact storage operation and JSON-safe arguments. */
  operation: WorkerOperation;
}>;

/** Current-record row returned by SQLite. */
type CellRow = Readonly<{
  /** Monotonic SQLite compare-and-swap revision. */
  version: number;

  /** JSON serialization of the storage-neutral Cell record. */
  record: string;
}>;

/** Observation row returned by SQLite. */
type ObservationRow = Readonly<{
  /** JSON serialization of one storage-neutral observation. */
  observation: string;
}>;

/** Complete private schema installed before the first parent request runs. */
const SCHEMA = `
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

/** Parent channel must exist because this module is never a main-thread entry. */
if (parentPort === null) throw new Error('Embedded SQLite worker requires a parent port');
/** Non-null parent channel narrowed once for callback closures. */
const channel = parentPort;

/** Admits the one explicit database path before opening native state. */
const databasePath = (workerData as WorkerData).databasePath;
if (typeof databasePath !== 'string' || databasePath.trim().length === 0) {
  throw new RangeError('Embedded SQLite worker databasePath must not be empty');
}

/** Native synchronous connection isolated to this worker thread. */
const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
database.exec('PRAGMA busy_timeout = 5000');
if (databasePath !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
database.exec(SCHEMA);

/**
 * Reads one current record without opening its own transaction.
 * @param cellId - Durable Cell identity used as the primary key.
 * @returns Current record/version pair or absence.
 */
function read(cellId: string): StoredCellVersion | undefined {
  /** Uses the worker-owned connection for one current-record query. */
  const row = database.prepare('SELECT version, record FROM archer_cells WHERE cell_id = ?').get(cellId) as
    CellRow | undefined;
  return row === undefined
    ? undefined
    : Object.freeze({ token: String(row.version), record: JSON.parse(row.record) as StoredCellRecord });
}

/**
 * Creates one absent record in a single immediate transaction.
 * @param record - Complete generation-zero Cell record.
 * @returns Created record or current winning lineage.
 */
function create(record: StoredCellRecord): CellStoreCreateOutcome {
  database.exec('BEGIN IMMEDIATE');
  try {
    /** Detects an existing lineage while holding the immediate transaction lock. */
    const existing = read(record.cellId);
    if (existing !== undefined) {
      database.exec('COMMIT');
      return Object.freeze({ kind: 'already-exists', current: existing });
    }
    database
      .prepare('INSERT INTO archer_cells (cell_id, version, record) VALUES (?, 1, ?)')
      .run(record.cellId, JSON.stringify(record));
    database.exec('COMMIT');
    return Object.freeze({ kind: 'created', current: Object.freeze({ token: '1', record }) });
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Replaces one exact record and appends its observations atomically.
 * @param operation - Exact expected revision, successor record, and observations.
 * @returns Committed successor or current conflict winner.
 */
function commit(operation: WorkerCommit): CellStoreCommitOutcome {
  database.exec('BEGIN IMMEDIATE');
  try {
    /** Reads the current revision under the immediate transaction lock. */
    const current = read(operation.cellId);
    if (current === undefined) throw new Error('Cell disappeared during SQLite worker commit');
    if (current.token !== operation.expectedToken) {
      database.exec('COMMIT');
      return Object.freeze({ kind: 'conflict', current });
    }
    /** SQLite integer revision advances exactly once per committed record. */
    const nextVersion = Number(operation.expectedToken) + 1;
    database
      .prepare('UPDATE archer_cells SET version = ?, record = ? WHERE cell_id = ? AND version = ?')
      .run(nextVersion, JSON.stringify(operation.record), operation.cellId, Number(operation.expectedToken));
    /** Reused statement appends all observations within the same transaction. */
    const insert = database.prepare(
      'INSERT INTO archer_cell_observations (cell_id, offset, observation) VALUES (?, ?, ?)',
    );
    /** Appends observations in parent order before transaction acknowledgement. */
    for (const observation of operation.observations) {
      insert.run(operation.cellId, Number(observation.offset), JSON.stringify(observation));
    }
    database.exec('COMMIT');
    return Object.freeze({
      kind: 'committed',
      current: Object.freeze({ token: String(nextVersion), record: operation.record }),
    });
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Restores all retained observations in ascending offset order.
 * @param cellId - Durable Cell identity owning the observation stream.
 * @returns Fresh ordered observation values.
 */
function observations(cellId: string): readonly StoredCellObservation[] {
  /** Database rows arrive in cursor order by explicit SQL ordering. */
  const rows = database
    .prepare('SELECT observation FROM archer_cell_observations WHERE cell_id = ? ORDER BY offset ASC')
    .all(cellId) as unknown as readonly ObservationRow[];
  return Object.freeze(
    rows.map(
      /**
       * Parses each private JSON row into its storage-neutral representation.
       * @param row - SQLite observation row.
       * @returns Fresh stored observation value.
       */
      (row) => JSON.parse(row.observation) as StoredCellObservation,
    ),
  );
}

/** Executes one request without allowing native Error detail across the thread boundary. */
channel.on(
  'message',
  /**
   * Routes one correlated command and returns only JSON-safe result data.
   * @param request - Exact worker operation and process-local correlation identity.
   */
  (request: WorkerRequest) => {
    try {
      /** Holds the selected branch result until one correlated response is posted. */
      let value: unknown;
      switch (request.operation.type) {
        case 'read':
          value = read(request.operation.cellId);
          break;
        case 'create':
          value = create(request.operation.record);
          break;
        case 'commit':
          value = commit(request.operation);
          break;
        case 'observations':
          value = observations(request.operation.cellId);
          break;
        case 'close':
          database.close();
          value = undefined;
          break;
      }
      channel.postMessage({ id: request.id, ok: true, value });
      if (request.operation.type === 'close') channel.close();
    } catch {
      channel.postMessage({ id: request.id, ok: false, message: 'Embedded SQLite worker operation failed' });
    }
  },
);
