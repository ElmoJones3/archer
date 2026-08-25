/**
 * @file Proves the embedded SQLite CellHost acknowledges, replays, restores, and fences real Cells.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { embeddedSqliteCells } from '../src/cells/embedded-sqlite/index.js';
import { createLiveOperation } from '../src/stream/index.js';
import {
  CELL_COMMAND_KEY,
  CELL_CREATE_KEY,
  CELL_ID,
  CELL_SUBJECT,
  cellHostOptions,
  createCellAuthorityFixture,
  createCounterProtocol,
  createDeliveryProtocol,
  type DeliveryEffect,
  type DeliveryEvent,
} from './support/cell-fixture.js';

/** Temporary directories owned and removed by this test file only. */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  /** Removes only unique fixture paths created by the current process. */
  await Promise.all(
    temporaryDirectories.splice(0).map(
      /**
       * Removes one test-owned unique directory recursively.
       * @param directory - Absolute fixture directory created by databasePath.
       * @returns Filesystem removal settlement.
       */
      (directory) => rm(directory, { recursive: true, force: true }),
    ),
  );
});

/**
 * Returns a fixed trusted instant after fixture grants were issued.
 * @returns Stable fixture clock read.
 */
function fixedClock(): Date {
  return new Date('2026-08-24T00:00:01.000Z');
}

/**
 * Prevents timers from changing deterministic lease and wake fixtures.
 * @returns No-op cancellation capability.
 */
function inertSchedule(): () => void {
  return () => undefined;
}

/** Presentation-only progress emitted by the delivery effect fixture. */
type DeliveryProgress = Readonly<{
  /** Human-readable adapter stage. */
  stage: string;
}>;

/** SQLite aggregate row used only to inspect post-release observation count. */
type ObservationCountRow = Readonly<{
  /** Exact number of durable observations retained by the fixture Cell. */
  count: number;
}>;

/**
 * Creates one unique SQLite file path without opening or deleting unrelated files.
 * @returns Absolute fixture database path.
 */
async function databasePath(): Promise<string> {
  /** Unique test-owned directory prevents cross-case SQLite state. */
  const directory = await mkdtemp(resolve(tmpdir(), 'archer-cell-sqlite-'));
  temporaryDirectories.push(directory);
  return resolve(directory, 'cells.sqlite');
}

describe('embedded SQLite Cells', () => {
  it('acknowledges one decision, replays exact retries, and restores hot state after restart', async () => {
    /** Real Authority fixture verifies each protected method at the fixed instant. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Unique persistent SQLite file survives only this test's host restart. */
    const path = await databasePath();
    /** Pure counter protocol owns deterministic transition and codecs. */
    const protocol = createCounterProtocol();
    /** Initial real worker-backed SQLite host. */
    const host = await embeddedSqliteCells({ ...cellHostOptions(authority, fixedClock), databasePath: path });

    /** Generation-zero outcome must transfer the hot handle. */
    const created = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected the Cell to open');

    /** Original command acknowledgement advances Program sequence once. */
    const first = await created.handle.dispatch(
      { subject: CELL_SUBJECT, event: { type: 'increment', amount: 2 }, idempotencyKey: CELL_COMMAND_KEY },
      authority.grants.dispatch,
    );
    /** Exact retry must return the retained acknowledgement. */
    const replay = await created.handle.dispatch(
      { subject: CELL_SUBJECT, event: { type: 'increment', amount: 2 }, idempotencyKey: CELL_COMMAND_KEY },
      authority.grants.dispatch,
    );
    /** Conflicting payload under the same key must preserve state. */
    const conflict = await created.handle.dispatch(
      { subject: CELL_SUBJECT, event: { type: 'increment', amount: 9 }, idempotencyKey: CELL_COMMAND_KEY },
      authority.grants.dispatch,
    );

    expect(first).toMatchObject({ kind: 'acknowledged', acknowledgement: { sequence: '1', replayed: false } });
    expect(replay).toMatchObject({ kind: 'acknowledged', acknowledgement: { sequence: '1', replayed: true } });
    expect(conflict).toEqual({ kind: 'refused', reason: 'idempotency-conflict' });
    expect(created.handle.getSnapshot().acknowledged.state).toEqual({ count: 2 });

    await host.close();
    /** Replacement host owns a new worker over the same durable SQLite file. */
    const restarted = await embeddedSqliteCells({ ...cellHostOptions(authority, fixedClock), databasePath: path });
    /** Compatible attach restores the acknowledged state and observation history. */
    const attached = await restarted.attach(
      { cellId: CELL_ID, subject: CELL_SUBJECT, protocol },
      authority.grants.attach,
    );
    expect(attached.kind).toBe('opened');
    if (attached.kind !== 'opened') throw new Error('Expected restored Cell to open');
    expect(attached.handle.getSnapshot().acknowledged.state).toEqual({ count: 2 });

    /** Replay subscription begins immediately before the only durable event. */
    const events = attached.handle.durableEvents.subscribe({
      after: attached.handle.getSnapshot().acknowledged.cursor.replace(/:1$/u, ':0') as never,
    });
    /** First replayed observation proves history hydration, not just current state. */
    const observation = await events[Symbol.asyncIterator]().next();
    expect(observation).toMatchObject({
      done: false,
      value: { value: { kind: 'event-acknowledged', sequence: '1', event: { type: 'increment', amount: 2 } } },
    });
    await events.close();
    await restarted.close();
    await authority.ledger.close();
  });

  it('recovers an overdue durable wake when a replacement activation attaches', async () => {
    /** Mutable trusted clock advances only at the explicit recovery boundary. */
    let instant = Date.parse('2026-08-24T00:00:01.000Z');
    /**
     * Reads the explicitly controlled wake-recovery instant.
     * @returns Current deterministic fixture time.
     */
    const now = () => new Date(instant);
    /** Real Authority fixture verifies each protected method at the mutable instant. */
    const authority = createCellAuthorityFixture(now);
    /** Unique SQLite file survives the replacement-host boundary. */
    const path = await databasePath();
    /** Wake becomes due after the original host has released. */
    const wakeAt = '2026-08-24T00:00:01.050Z';
    /** Counter protocol projects the recoverable wake into durable state. */
    const protocol = createCounterProtocol(wakeAt);
    /** Initial host persists generation zero and its wake before closure. */
    const firstHost = await embeddedSqliteCells({
      ...cellHostOptions(authority, now, inertSchedule),
      databasePath: path,
    });
    /** Generation-zero create makes the projected wake durable. */
    const created = await firstHost.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    await firstHost.close();

    /** Crosses both the wake and released lease boundaries before replacement starts. */
    instant += 100;
    /** Replacement host owns a new worker after both wake and lease become due. */
    const replacement = await embeddedSqliteCells({
      ...cellHostOptions(authority, now, inertSchedule),
      databasePath: path,
    });
    /** Attach waits for the startup barrier that acknowledges the overdue wake. */
    const attached = await replacement.attach(
      { cellId: CELL_ID, subject: CELL_SUBJECT, protocol },
      authority.grants.attach,
    );
    expect(attached.kind).toBe('opened');
    if (attached.kind !== 'opened') throw new Error('Expected overdue Cell to restore');

    /** Constructor recovery is asynchronous but driven only by deterministic microtasks and SQLite replies. */
    for (
      let attempts = 0;
      attempts < 20 && attached.handle.getSnapshot().acknowledged.state.count !== 10;
      attempts += 1
    ) {
      await new Promise<void>(
        /**
         * Yields only to deterministic worker replies and queued microtasks.
         * @param resolveImmediate - Native Promise resolver scheduled on setImmediate.
         * @returns Native immediate handle ignored by Promise construction.
         */
        (resolveImmediate) => setImmediate(resolveImmediate),
      );
    }
    expect(attached.handle.getSnapshot()).toMatchObject({
      acknowledged: { sequence: '1', state: { count: 10 } },
      lifecycle: { status: 'active' },
    });

    await replacement.close();
    await authority.ledger.close();
  });

  it('fences a stale owner after another host acquires the expired lease', async () => {
    /** Mutable time advances without allowing either inert scheduler to renew. */
    let instant = Date.parse('2026-08-24T00:00:01.000Z');
    /**
     * Reads the explicitly controlled lease instant.
     * @returns Current deterministic fixture time.
     */
    const now = () => new Date(instant);
    /** Real Authority fixture verifies both competing hosts. */
    const authority = createCellAuthorityFixture(now);
    /** Shared SQLite file supplies one durable lease race. */
    const path = await databasePath();
    /** Counter behavior isolates ownership from domain complexity. */
    const protocol = createCounterProtocol();
    /** Original host retains the handle after its inert lease expires. */
    const first = await embeddedSqliteCells({ ...cellHostOptions(authority, now, inertSchedule), databasePath: path });
    /** Initial activation owns fence one. */
    const created = await first.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected first owner to open');

    instant += 200;
    /** Replacement host uses a distinct deterministic owner identity. */
    const second = await embeddedSqliteCells({
      ...cellHostOptions(authority, now, inertSchedule),
      databasePath: path,
      /**
       * Supplies the replacement's distinct UUIDv4 owner.
       * @returns Valid deterministic UUIDv4 text.
       */
      createId: () => '10000000-0000-4000-8000-000000000021',
    });
    /** Replacement attach must acquire fence two. */
    const acquired = await second.attach({ cellId: CELL_ID, subject: CELL_SUBJECT, protocol }, authority.grants.attach);
    expect(acquired.kind).toBe('opened');
    if (acquired.kind !== 'opened') throw new Error('Expected replacement owner to acquire');

    /** Stale fence-one handle attempts a state-changing dispatch. */
    const stale = await created.handle.dispatch(
      { subject: CELL_SUBJECT, event: { type: 'increment', amount: 7 }, idempotencyKey: CELL_COMMAND_KEY },
      authority.grants.dispatch,
    );
    expect(stale).toEqual({ kind: 'refused', reason: 'fenced' });
    expect(created.handle.getSnapshot().lifecycle).toMatchObject({ status: 'fenced' });
    expect(acquired.handle.getSnapshot().acknowledged).toMatchObject({
      sequence: '0',
      state: { count: 0 },
      fence: '2',
    });

    await first.close();
    await second.close();
    await authority.ledger.close();
  });

  it('reacquires an expired lease before reopening an exact create retry', async () => {
    /** Mutable time crosses the lease boundary without firing a renewal callback. */
    let instant = Date.parse('2026-08-24T00:00:01.000Z');
    /**
     * Reads the explicitly controlled create-retry instant.
     * @returns Current deterministic fixture time.
     */
    const now = () => new Date(instant);
    /** Real Authority fixture verifies both create attempts. */
    const authority = createCellAuthorityFixture(now);
    /** Shared SQLite file supplies one durable creation lineage. */
    const path = await databasePath();
    /** Counter behavior isolates exact create retry mechanics. */
    const protocol = createCounterProtocol();
    /** Original host owns the generation-zero fence. */
    const first = await embeddedSqliteCells({ ...cellHostOptions(authority, now, inertSchedule), databasePath: path });
    /** Initial exact creation retains fence one after expiry. */
    const created = await first.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected first exact creation to open');

    instant += 200;
    /** Second host repeats the exact creation intent under a new owner. */
    const second = await embeddedSqliteCells({
      ...cellHostOptions(authority, now, inertSchedule),
      databasePath: path,
      /**
       * Supplies the retrying host's distinct UUIDv4 owner.
       * @returns Valid deterministic UUIDv4 text.
       */
      createId: () => '10000000-0000-4000-8000-000000000022',
    });
    /** Exact retry must acquire a new fence before returning opened. */
    const retried = await second.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );

    expect(retried.kind).toBe('opened');
    if (retried.kind !== 'opened') throw new Error('Expected exact retry to reopen');
    expect(retried.handle.getSnapshot().acknowledged.fence).toBe('2');
    expect(
      await created.handle.dispatch(
        { subject: CELL_SUBJECT, event: { type: 'increment', amount: 1 }, idempotencyKey: CELL_COMMAND_KEY },
        authority.grants.dispatch,
      ),
    ).toEqual({ kind: 'refused', reason: 'fenced' });

    await first.close();
    await second.close();
    await authority.ledger.close();
  });

  it('does not replace its own registered activation when an exact create retry observes an expired lease', async () => {
    /** Mutable time crosses the lease boundary while the original handle remains registered. */
    let instant = Date.parse('2026-08-24T00:00:01.000Z');
    /**
     * Reads the explicitly controlled same-host retry instant.
     * @returns Current deterministic fixture time.
     */
    const now = () => new Date(instant);
    /** Real Authority fixture verifies both same-host create calls. */
    const authority = createCellAuthorityFixture(now);
    /** Unique SQLite file keeps the registration claim independent from other cases. */
    const path = await databasePath();
    /** Counter behavior isolates process-local activation ownership. */
    const protocol = createCounterProtocol();
    /** One host retains the generation-zero handle without timer renewal. */
    const host = await embeddedSqliteCells({ ...cellHostOptions(authority, now, inertSchedule), databasePath: path });
    /** First creation installs the only process-local activation for this Cell. */
    const created = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');

    /** Storage lease expires, but the host must not manufacture a second local owner. */
    instant += 200;
    /** Exact same-host retry exercises the registry guard before durable reacquisition. */
    const retry = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );

    expect(retry).toEqual({ kind: 'already-exists', cellId: CELL_ID });

    await host.close();
    await authority.ledger.close();
  });

  it('claims acknowledged effects once and makes only the result event durable', async () => {
    /** Real Authority fixture verifies creation, dispatch, and state read. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Unique SQLite file owns the complete effect attempt history. */
    const path = await databasePath();
    /** Delivery protocol turns one event into durable external intent. */
    const protocol = createDeliveryProtocol();
    /** Counts starts at the external-work boundary rather than subscription. */
    let starts = 0;
    /** Production-shaped adapter executes only durably claimed delivery effects. */
    const effects: import('../src/cells/index.js').CellEffectAdapter<DeliveryEffect, DeliveryEvent, DeliveryProgress> =
      Object.freeze({
        /**
         * Constructs one already-running finite attempt after durable claim.
         * @param attempt - Acknowledged delivery intent and stable causality.
         * @returns Hot finite operation that proposes one result event.
         */
        async start(attempt: import('../src/cells/index.js').AcknowledgedEffectAttempt<DeliveryEffect>) {
          starts += 1;
          return createLiveOperation<
            DeliveryProgress,
            import('../src/cells/index.js').CellEffectResult<DeliveryEvent>,
            import('../src/cells/index.js').CellEffectAttemptCloseEvidence
          >({
            source: 'delivery-progress',
            epoch: `${attempt.effectId}:${attempt.attempt}`,
            eventEncoding: {
              revision: 'delivery-progress/1',
              /**
               * Copies adapter progress before transient publication.
               * @param event - Adapter-owned progress value.
               * @returns Fresh frozen progress value.
               */
              normalize(event) {
                return Object.freeze({ ...event });
              },
              /**
               * Measures progress bytes for bounded transient delivery.
               * @param event - Source-owned progress value.
               * @returns Exact JSON byte length.
               */
              measure(event) {
                return new TextEncoder().encode(JSON.stringify(event)).byteLength;
              },
            },
            /**
             * Emits one presentation update before returning the proposed Program event.
             * @param context - Live operation progress emission capability.
             * @returns Successful delivery result event.
             */
            async start(context) {
              context.emit(Object.freeze({ stage: 'sent' }));
              return Object.freeze({ kind: 'event' as const, event: Object.freeze({ type: 'delivered' as const }) });
            },
            /**
             * Returns retained attempt closure evidence without changing domain state.
             * @returns Stable effect-attempt closure evidence.
             */
            closeEvidence() {
              return Object.freeze({
                kind: 'effect-attempt-closed' as const,
                effectId: attempt.effectId,
                attempt: attempt.attempt,
              });
            },
            /**
             * Classifies abort after this synchronous fixture result as already completed.
             * @returns Terminal completed-attempt evidence.
             */
            classifyAbort() {
              return Object.freeze({ kind: 'attempt-settled' as const, outcome: 'completed' as const });
            },
          });
        },
      });
    /** Worker-backed host owns storage while borrowing the effect adapter and Authority. */
    const host = await embeddedSqliteCells({ ...cellHostOptions(authority, fixedClock), databasePath: path });
    /** Generation-zero effect Cell starts idle without invoking the adapter. */
    const created = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { status: 'idle' },
        protocol,
        activation: { effects },
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected effect Cell to open');

    /** Resolves from the hot acknowledged state contract rather than polling worker timing. */
    let stopDeliveredObservation: (() => void) | undefined;
    /** Hot-state settlement proves the result event reached durable acknowledgement. */
    const delivered = new Promise<void>(
      /**
       * Captures a resolver tied to the public reactive state contract.
       * @param resolveDelivered - Native Promise resolver for acknowledged delivery state.
       */
      (resolveDelivered) => {
        stopDeliveredObservation = created.handle.subscribe(
          /**
           * Resolves only after acknowledged state reaches delivered.
           * @param snapshot - Current immutable Cell handle snapshot.
           */
          (snapshot) => {
            if (snapshot.acknowledged.state.status === 'delivered') resolveDelivered();
          },
        );
      },
    );

    /** User request acknowledgement persists the effect before adapter start. */
    const outcome = await created.handle.dispatch(
      { subject: CELL_SUBJECT, event: { type: 'request' }, idempotencyKey: CELL_COMMAND_KEY },
      authority.grants.dispatch,
    );
    expect(outcome).toMatchObject({ kind: 'acknowledged', acknowledgement: { sequence: '1' } });
    await delivered;
    stopDeliveredObservation?.();

    expect(starts).toBe(1);
    expect(created.handle.getSnapshot()).toMatchObject({
      acknowledged: { sequence: '2', state: { status: 'delivered' } },
    });
    /** Canonical read confirms result state exists outside the hot handle. */
    const state = await host.readState(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        protocolRevision: protocol.protocolRevision,
        stateCodec: protocol.codecs.state,
      },
      authority.grants.read,
    );
    expect(state).toMatchObject({ kind: 'found', sequence: '2', state: { status: 'delivered' } });

    await host.close();
    await authority.ledger.close();
  });

  it('does not record an aborted effect failure after activation release', async () => {
    /** Real Authority fixture verifies the request that creates acknowledged effect work. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Unique SQLite file permits a direct post-close persistence-boundary assertion. */
    const path = await databasePath();
    /** Delivery protocol produces one external attempt that remains live until release. */
    const protocol = createDeliveryProtocol();
    /** Pending adapter exposes the exact moment external work has started. */
    let settleStarted: (() => void) | undefined;
    /** Resolves after the acknowledged effect enters its real operation boundary. */
    const started = new Promise<void>(
      /**
       * Captures the one adapter-start resolver without scheduling work.
       * @param resolveStarted - Native resolver invoked by the effect operation.
       */
      (resolveStarted) => {
        settleStarted = resolveStarted;
      },
    );
    /** Adapter rejection after abort must not mutate a released activation. */
    const effects: import('../src/cells/index.js').CellEffectAdapter<DeliveryEffect, DeliveryEvent, DeliveryProgress> =
      Object.freeze({
        /**
         * Starts one operation that rejects only after the Cell releases it.
         * @param attempt - Acknowledged delivery intent and stable attempt identity.
         * @returns Hot pending operation owned by the activation.
         */
        async start(attempt: import('../src/cells/index.js').AcknowledgedEffectAttempt<DeliveryEffect>) {
          return createLiveOperation<
            DeliveryProgress,
            import('../src/cells/index.js').CellEffectResult<DeliveryEvent>,
            import('../src/cells/index.js').CellEffectAttemptCloseEvidence
          >({
            source: 'abort-on-release',
            epoch: `${attempt.effectId}:${attempt.attempt}`,
            eventEncoding: {
              revision: 'abort-on-release-progress/1',
              /**
               * Copies fixture progress before transient publication.
               * @param event - Adapter-owned progress value.
               * @returns Fresh frozen progress value.
               */
              normalize(event) {
                return Object.freeze({ ...event });
              },
              /**
               * Measures progress through its exact JSON representation.
               * @param event - Source-owned progress value.
               * @returns Exact encoded byte length.
               */
              measure(event) {
                return new TextEncoder().encode(JSON.stringify(event)).byteLength;
              },
            },
            /**
             * Waits for the activation's abort signal, then rejects as an aborted transport would.
             * @param context - Finite operation signal owned by the Cell activation.
             * @returns A Promise that never succeeds in this fixture.
             */
            async start(context) {
              settleStarted?.();
              return new Promise(
                /**
                 * Rejects only from the real abort event rather than fixture timing.
                 * @param _resolve - Unused success resolver because this attempt cannot complete.
                 * @param reject - Native rejection used when release aborts the operation.
                 */
                (_resolve, reject) => {
                  context.signal.addEventListener(
                    'abort',
                    /**
                     * Converts the real abort signal into the adapter's terminal rejection.
                     * @returns Native Promise rejector result.
                     */
                    () => reject(new Error('fixture effect aborted')),
                    { once: true },
                  );
                },
              );
            },
            /**
             * Retains exact attempt identity after process-local cleanup.
             * @returns Stable effect-attempt closure evidence.
             */
            closeEvidence() {
              return Object.freeze({
                kind: 'effect-attempt-closed' as const,
                effectId: attempt.effectId,
                attempt: attempt.attempt,
              });
            },
            /**
             * Confirms the fixture abort reached terminal adapter settlement.
             * @returns Aborted attempt evidence.
             */
            classifyAbort() {
              return Object.freeze({ kind: 'attempt-settled' as const, outcome: 'aborted' as const });
            },
          });
        },
      });
    /** Worker-backed host owns the persistence and pending attempt lifecycles. */
    const host = await embeddedSqliteCells({ ...cellHostOptions(authority, fixedClock), databasePath: path });
    /** Generation-zero Cell receives the pending effect adapter. */
    const created = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { status: 'idle' },
        protocol,
        activation: { effects },
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected pending effect Cell to open');

    /** Request acknowledgement durably claims the attempt before release begins. */
    const outcome = await created.handle.dispatch(
      { subject: CELL_SUBJECT, event: { type: 'request' }, idempotencyKey: CELL_COMMAND_KEY },
      authority.grants.dispatch,
    );
    expect(outcome.kind).toBe('acknowledged');
    await started;

    /** Host release aborts the attempt and closes SQLite before inspection. */
    await host.close();
    /** Real SQLite query distinguishes two pre-release observations from a late failure write. */
    const database = new DatabaseSync(path, { readOnly: true });
    /** Aggregate row count comes from the exact durable observation table. */
    const row = database.prepare('SELECT COUNT(*) AS count FROM archer_cell_observations').get() as ObservationCountRow;
    database.close();
    expect(row.count).toBe(2);

    await authority.ledger.close();
  });
});
