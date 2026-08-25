/**
 * @file Publishes executable CellHost behavior every durability adapter must pass.
 *
 * The suite owns its Program, commands, and assertions. A target supplies only
 * fresh shared storage, real grants, deterministic lease expiry, and cleanup.
 */

import * as z from 'zod';

import { fromZod } from '../codec.js';
import { toPublicError, IdempotencyKeySchema, type PublicError } from '../protocol.js';
import { programDecision } from '../program.js';
import type { GrantRef, PrincipalId } from '../authority/contracts.js';
import {
  CellIdSchema,
  CellProtocolRevisionSchema,
  ProgramRevisionSchema,
  StateProjectionRevisionSchema,
  type CellAttachAction,
  type CellCreateAction,
  type CellDispatchAction,
  type CellHost,
  type CellProtocol,
  type CellReadAction,
} from './contracts.js';
import { jsonCellCodec } from './model.js';

/** Current immutable CellHost behavior catalogue version. */
export const CELL_HOST_CONFORMANCE_VERSION = 1 as const;

/** Stable identities for every required v1 CellHost behavior. */
export type CellHostConformanceCaseId =
  | 'create.generation-zero'
  | 'create.idempotency-no-duplicate'
  | 'dispatch.hot-after-acknowledgement'
  | 'dispatch.replay-and-conflict'
  | 'restore.revision-binding'
  | 'restore.restart-replay'
  | 'ownership.expired-lease-fences-stale-owner'
  | 'lifecycle.retained-close';

/** Stable identity and maintained claim for one required CellHost behavior. */
export type CellHostConformanceCase = Readonly<{
  /** Machine identity retained in reports and promotion evidence. */
  id: CellHostConformanceCaseId;

  /** Human-readable behavior proved by the corresponding executable case. */
  claim: string;
}>;

/** Ordered required catalogue that prevents partial execution from posing as proof. */
export const CELL_HOST_CONFORMANCE_CASES: readonly CellHostConformanceCase[] = Object.freeze([
  Object.freeze({
    id: 'create.generation-zero',
    claim: 'Create returns one hot generation-zero Cell after durable storage.',
  }),
  Object.freeze({
    id: 'create.idempotency-no-duplicate',
    claim: 'An exact create retry cannot create a second Cell lineage.',
  }),
  Object.freeze({
    id: 'dispatch.hot-after-acknowledgement',
    claim: 'Dispatch advances hot state only after storage acknowledgement.',
  }),
  Object.freeze({
    id: 'dispatch.replay-and-conflict',
    claim: 'Exact command replay advances once and conflicting key reuse preserves state.',
  }),
  Object.freeze({
    id: 'restore.revision-binding',
    claim: 'Attach refuses an incompatible Program revision before returning a handle.',
  }),
  Object.freeze({
    id: 'restore.restart-replay',
    claim: 'A replacement host restores state and durable observations after restart.',
  }),
  Object.freeze({
    id: 'ownership.expired-lease-fences-stale-owner',
    claim: 'A replacement fence prevents the stale owner from committing.',
  }),
  Object.freeze({
    id: 'lifecycle.retained-close',
    claim: 'Close is idempotent and releases rather than deletes durable Cell state.',
  }),
]);

/** Exact grants required by the suite's protected operations. */
export type CellHostConformanceGrants = Readonly<{
  /** Host-wide or fixture-Cell creation permission. */
  create: GrantRef<CellCreateAction>;

  /** Host-wide or fixture-Cell attachment permission. */
  attach: GrantRef<CellAttachAction>;

  /** Host-wide or fixture-Cell read permission. */
  read: GrantRef<CellReadAction>;

  /** Host-wide or fixture-Cell dispatch permission. */
  dispatch: GrantRef<CellDispatchAction>;
}>;

/** Fresh shared-storage fixture supplied for one required case. */
export type CellHostConformanceFixture = Readonly<{
  /** Initial candidate host owned by the suite until case cleanup. */
  host: CellHost;

  /** Principal bound into every current fixture grant. */
  subject: PrincipalId;

  /** Exact action-specific current grants. */
  grants: CellHostConformanceGrants;

  /** Advances the trusted host clock beyond its configured lease. */
  expireLease(): void;

  /** Opens another host against the same storage while preserving the first. */
  openPeer(): Promise<CellHost>;

  /** Opens a replacement host against the same storage after orderly close. */
  restart(): Promise<CellHost>;

  /** Releases all candidate dependencies and uniquely owned fixture storage. */
  dispose(): Promise<void>;
}>;

/** Construction boundary implemented by one candidate CellHost adapter. */
export type CellHostConformanceTarget = Readonly<{
  /** Human-readable implementation identity retained in reports. */
  name: string;

  /** Opens one fresh, isolated, production-reachable shared-storage fixture. */
  open(): Promise<CellHostConformanceFixture>;
}>;

/** Successful result for one required behavior. */
export type PassedCellHostConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: CellHostConformanceCaseId;

  /** Confirms every assertion in this case passed. */
  status: 'passed';
}>;

/** Failed result with redacted portable evidence. */
export type FailedCellHostConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: CellHostConformanceCaseId;

  /** Confirms this exact required case ran and failed. */
  status: 'failed';

  /** Bounded public failure without candidate storage state. */
  failure: PublicError;
}>;

/** Complete result of one required behavior. */
export type CellHostConformanceCaseResult = PassedCellHostConformanceCase | FailedCellHostConformanceCase;

/** Complete portable execution report. */
export type CellHostConformanceReport = Readonly<{
  /** Pins interpretation to one immutable catalogue. */
  version: typeof CELL_HOST_CONFORMANCE_VERSION;

  /** Identifies the candidate implementation. */
  implementation: string;

  /** Passes only when every required case ran successfully. */
  status: 'passed' | 'failed';

  /** Makes skipped or filtered execution visible. */
  execution: Readonly<{
    /** Number of behaviors in the pinned catalogue. */
    required: number;

    /** Number of behaviors whose executor actually settled. */
    executed: number;

    /** Number of required behaviors omitted from execution. */
    skipped: number;
  }>;

  /** Contains exactly one ordered result per required case. */
  cases: readonly CellHostConformanceCaseResult[];
}>;

/** State type admitted by the suite-owned codec. */
type ConformanceState = Readonly<{
  /** Non-negative acknowledged counter value. */
  count: number;
}>;

/** Event type admitted by the suite-owned codec. */
type ConformanceEvent = Readonly<{
  /** Positive increment applied by the suite Program. */
  amount: number;
}>;

/**
 * Copies and freezes state after Zod establishes the counter invariant.
 * @param value - Validated non-negative counter state.
 * @param value.count - Validated counter value.
 * @returns Immutable state owned by the suite codec.
 */
function admitConformanceState(value: ConformanceState): ConformanceState {
  return Object.freeze(value);
}

/**
 * Copies and freezes an event after Zod establishes its positive increment.
 * @param value - Validated positive counter event.
 * @param value.amount - Validated increment amount.
 * @returns Immutable event owned by the suite codec.
 */
function admitConformanceEvent(value: ConformanceEvent): ConformanceEvent {
  return Object.freeze(value);
}

/** Suite-owned counter state. */
const StateSchema = z
  .strictObject({ count: z.number().int().nonnegative() })
  .transform(admitConformanceState)
  .readonly();

/** Suite-owned counter event. */
const EventSchema = z.strictObject({ amount: z.number().int().positive() }).transform(admitConformanceEvent).readonly();

/** Canonical counter state codec shared by compatible protocol revisions. */
const stateCodec = jsonCellCodec({ revision: 'cell-conformance-state/1', value: fromZod(StateSchema) });

/** Canonical counter event codec shared by compatible protocol revisions. */
const eventCodec = jsonCellCodec({ revision: 'cell-conformance-event/1', value: fromZod(EventSchema) });

/** No-effect codec proves a Program may remain useful without an adapter. */
const noEffectCodec = jsonCellCodec({ revision: 'cell-conformance-no-effect/1', value: fromZod(z.never()) });

/**
 * Builds the suite Program with one selectable behavior revision.
 * @param revision - Program revision used to prove restore refusal.
 * @returns Exact counter protocol owned by the suite.
 */
function protocol(
  revision = 'cell-conformance-program/1',
): CellProtocol<ConformanceState, ConformanceState, ConformanceEvent, never> {
  return Object.freeze({
    protocolRevision: CellProtocolRevisionSchema.parse('cell-conformance/1'),
    programRevision: ProgramRevisionSchema.parse(revision),
    projectionRevision: StateProjectionRevisionSchema.parse('cell-conformance-projection/1'),
    durability: Object.freeze({ type: 'same-filesystem' as const }),
    program: Object.freeze({
      /**
       * Returns a fresh next counter value and no effects.
       * @param state - Previously acknowledged counter state.
       * @param event - Positive increment admitted by the event codec.
       * @returns Pure next-state decision with no external work.
       */
      reduce(state: Readonly<ConformanceState>, event: Readonly<ConformanceEvent>) {
        return programDecision<ConformanceState, never>(Object.freeze({ count: state.count + event.amount }));
      },
    }),
    /**
     * Copies acknowledged state into the public projection.
     * @param state - Current acknowledged counter state.
     * @returns Fresh immutable public state view.
     */
    projectState(state: Readonly<ConformanceState>) {
      return Object.freeze({ ...state });
    },
    codecs: Object.freeze({ state: stateCodec, stateView: stateCodec, event: eventCodec, effect: noEffectCodec }),
  });
}

/** Suite-owned durable Cell identity reused only across isolated fixtures. */
const CELL_ID = CellIdSchema.parse('72000000-0000-4000-8000-000000000001');

/** Suite-owned create retry identity. */
const CREATE_KEY = IdempotencyKeySchema.parse('72000000-0000-4000-8000-000000000002');

/** Suite-owned dispatch retry identity. */
const DISPATCH_KEY = IdempotencyKeySchema.parse('72000000-0000-4000-8000-000000000003');

/**
 * Raises one suite-owned assertion failure.
 * @param condition - Claim that must hold for promotion evidence.
 * @param message - Stable diagnostic when the claim fails.
 */
function requireClaim(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Creates the suite Cell and requires the only successful handle branch.
 * @param fixture - Fresh implementation fixture for one conformance case.
 * @returns Open generation-zero handle owned by the current case.
 */
async function createFixtureCell(fixture: CellHostConformanceFixture) {
  /** Opens the canonical suite Cell through the candidate public boundary. */
  const outcome = await fixture.host.create(
    {
      cellId: CELL_ID,
      subject: fixture.subject,
      initialState: { count: 0 },
      protocol: protocol(),
      idempotencyKey: CREATE_KEY,
    },
    fixture.grants.create,
  );
  requireClaim(outcome.kind === 'opened', 'CellHost did not open generation zero');
  return outcome.handle;
}

/** Executable proof for one required catalogue case. */
type CellHostCaseExecutor = (fixture: CellHostConformanceFixture) => Promise<void>;

/** Case implementations keyed by stable public identity. */
const EXECUTORS: Readonly<Record<CellHostConformanceCaseId, CellHostCaseExecutor>> = Object.freeze({
  /**
   * Proves a successful create returns the exact initial acknowledged snapshot.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'create.generation-zero': async (fixture) => {
    /** Generation-zero handle returned only after candidate persistence. */
    const handle = await createFixtureCell(fixture);
    requireClaim(handle.getSnapshot().acknowledged.sequence === '0', 'Generation zero used another sequence');
    requireClaim(handle.getSnapshot().acknowledged.state.count === 0, 'Generation zero changed initial state');
  },
  /**
   * Proves an exact create retry does not fork the durable Cell lineage.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'create.idempotency-no-duplicate': async (fixture) => {
    await createFixtureCell(fixture);
    /** Exact second request against the already active Cell identity. */
    const retry = await fixture.host.create(
      {
        cellId: CELL_ID,
        subject: fixture.subject,
        initialState: { count: 0 },
        protocol: protocol(),
        idempotencyKey: CREATE_KEY,
      },
      fixture.grants.create,
    );
    requireClaim(retry.kind === 'already-exists', 'Exact create retry created another active lineage');
  },
  /**
   * Proves the hot snapshot changes only after dispatch acknowledgement.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'dispatch.hot-after-acknowledgement': async (fixture) => {
    /** Active canonical Cell receiving the test event. */
    const handle = await createFixtureCell(fixture);
    /** Durable dispatch outcome that gates the hot-state assertion. */
    const outcome = await handle.dispatch(
      { subject: fixture.subject, event: { amount: 2 }, idempotencyKey: DISPATCH_KEY },
      fixture.grants.dispatch,
    );
    requireClaim(outcome.kind === 'acknowledged', 'Canonical dispatch was not acknowledged');
    requireClaim(handle.getSnapshot().acknowledged.state.count === 2, 'Hot state did not expose acknowledged state');
  },
  /**
   * Proves idempotency replay and conflicting-key refusal preserve state.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'dispatch.replay-and-conflict': async (fixture) => {
    /** Active canonical Cell receiving all three command variants. */
    const handle = await createFixtureCell(fixture);
    /** First use of the suite command identity. */
    const first = await handle.dispatch(
      { subject: fixture.subject, event: { amount: 2 }, idempotencyKey: DISPATCH_KEY },
      fixture.grants.dispatch,
    );
    /** Byte-equivalent retry of the acknowledged command. */
    const replay = await handle.dispatch(
      { subject: fixture.subject, event: { amount: 2 }, idempotencyKey: DISPATCH_KEY },
      fixture.grants.dispatch,
    );
    /** Different event attempting to reuse the acknowledged command identity. */
    const conflict = await handle.dispatch(
      { subject: fixture.subject, event: { amount: 9 }, idempotencyKey: DISPATCH_KEY },
      fixture.grants.dispatch,
    );
    requireClaim(first.kind === 'acknowledged' && !first.acknowledgement.replayed, 'First command was not original');
    requireClaim(replay.kind === 'acknowledged' && replay.acknowledgement.replayed, 'Exact retry did not replay');
    requireClaim(
      conflict.kind === 'refused' && conflict.reason === 'idempotency-conflict',
      'Conflicting reuse changed state',
    );
    requireClaim(handle.getSnapshot().acknowledged.state.count === 2, 'Replay or conflict advanced state twice');
  },
  /**
   * Proves replacement activation refuses incompatible Program semantics.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'restore.revision-binding': async (fixture) => {
    await createFixtureCell(fixture);
    await fixture.host.close();
    /** Replacement host sees the same persisted Cell after orderly release. */
    const replacement = await fixture.restart();
    /** Attach outcome for a deliberately different Program revision. */
    const attached = await replacement.attach(
      { cellId: CELL_ID, subject: fixture.subject, protocol: protocol('cell-conformance-program/2') },
      fixture.grants.attach,
    );
    requireClaim(
      attached.kind === 'restore-refused' && attached.refusal.reason === 'program-revision',
      'Replacement accepted an incompatible Program revision',
    );
  },
  /**
   * Proves restart restores both acknowledged state and durable observations.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'restore.restart-replay': async (fixture) => {
    /** Original activation whose acknowledged event must survive restart. */
    const handle = await createFixtureCell(fixture);
    await handle.dispatch(
      { subject: fixture.subject, event: { amount: 3 }, idempotencyKey: DISPATCH_KEY },
      fixture.grants.dispatch,
    );
    await fixture.host.close();
    /** Replacement host reads the same durable Cell lineage. */
    const replacement = await fixture.restart();
    /** Compatible replacement activation. */
    const attached = await replacement.attach(
      { cellId: CELL_ID, subject: fixture.subject, protocol: protocol() },
      fixture.grants.attach,
    );
    requireClaim(attached.kind === 'opened', 'Replacement did not restore compatible Cell state');
    requireClaim(attached.handle.getSnapshot().acknowledged.state.count === 3, 'Replacement restored wrong state');
    /** Cursor immediately before the only acknowledged event. */
    const afterZero = attached.handle.getSnapshot().acknowledged.cursor.replace(/:1$/u, ':0') as never;
    /** Bounded replay subscription beginning after generation zero. */
    const events = attached.handle.durableEvents.subscribe({ after: afterZero });
    /** First restored durable observation from the replacement handle. */
    const first = await events[Symbol.asyncIterator]().next();
    requireClaim(
      !first.done && first.value.value.kind === 'event-acknowledged',
      'Replacement did not replay durable event',
    );
    await events.close();
  },
  /**
   * Proves a newer fence rejects commits from an expired activation.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'ownership.expired-lease-fences-stale-owner': async (fixture) => {
    /** Original handle intentionally retained beyond its lease. */
    const stale = await createFixtureCell(fixture);
    fixture.expireLease();
    /** Concurrent host attempting to acquire the expired lease. */
    const peer = await fixture.openPeer();
    /** Replacement activation expected to own the next fence. */
    const acquired = await peer.attach(
      { cellId: CELL_ID, subject: fixture.subject, protocol: protocol() },
      fixture.grants.attach,
    );
    requireClaim(acquired.kind === 'opened', 'Replacement did not acquire expired lease');
    /** Dispatch attempted through the now-stale process-local handle. */
    const rejected = await stale.dispatch(
      { subject: fixture.subject, event: { amount: 5 }, idempotencyKey: DISPATCH_KEY },
      fixture.grants.dispatch,
    );
    requireClaim(
      rejected.kind === 'refused' && rejected.reason === 'fenced',
      'Stale owner committed after replacement',
    );
  },
  /**
   * Proves release is idempotent and never deletes durable state.
   * @param fixture - Fresh candidate host and grants for this isolated case.
   */
  'lifecycle.retained-close': async (fixture) => {
    /** Handle whose duplicate close callers must share retained evidence. */
    const handle = await createFixtureCell(fixture);
    /** Both retained close settlements returned by concurrent callers. */
    const [first, second] = await Promise.all([handle.close(), handle.close()]);
    requireClaim(first === second, 'Cell close did not retain one evidence identity');
    /** Canonical state read performed after activation release. */
    const state = await fixture.host.readState(
      {
        cellId: CELL_ID,
        subject: fixture.subject,
        protocolRevision: protocol().protocolRevision,
        stateCodec,
      },
      fixture.grants.read,
    );
    requireClaim(state.kind === 'found', 'Cell release deleted durable state');
  },
});

/**
 * Executes every required case against an independent fresh fixture.
 * @param target - Candidate identity and fixture construction boundary.
 * @returns Complete ordered report with no implicit skips.
 */
export async function runCellHostConformance(target: CellHostConformanceTarget): Promise<CellHostConformanceReport> {
  /** Ordered case results accumulated without short-circuiting later proof. */
  const results: CellHostConformanceCaseResult[] = [];
  /** Executes each catalogue case in a fresh implementation-owned fixture. */
  for (const testCase of CELL_HOST_CONFORMANCE_CASES) {
    /** Current case fixture retained for unconditional cleanup. */
    let fixture: CellHostConformanceFixture | undefined;
    try {
      fixture = await target.open();
      await EXECUTORS[testCase.id](fixture);
      results.push(Object.freeze({ id: testCase.id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id: testCase.id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'cell_host_conformance_case_failed',
            message: 'A required CellHost conformance case failed',
          }),
        }),
      );
    } finally {
      await fixture?.dispose();
    }
  }
  return Object.freeze({
    version: CELL_HOST_CONFORMANCE_VERSION,
    implementation: target.name,
    /** Requires every recorded case, rather than aggregate counts alone, to pass. */
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    execution: Object.freeze({
      required: CELL_HOST_CONFORMANCE_CASES.length,
      executed: results.length,
      skipped: CELL_HOST_CONFORMANCE_CASES.length - results.length,
    }),
    cases: Object.freeze(results),
  });
}
