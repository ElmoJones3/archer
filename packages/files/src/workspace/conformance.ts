/**
 * @file Publishes the versioned behavior suite every Workspace adapter must pass.
 *
 * The suite owns all commands and assertions. A target supplies only fresh
 * generation-zero handles, real current grants, and dependency cleanup, so an
 * implementation cannot replace the protocol claims with adapter-specific tests.
 */

import { IdempotencyKeySchema, toPublicError, type PublicError } from '@archer/core';
import type { GrantRef } from '@archer/core/authority';

import { FilesError } from '../errors.js';
import type { WorkspaceHandle, WorkspaceReadAction, WorkspaceWriteAction } from './contracts.js';

/** Current immutable Workspace behavior catalogue. */
export const WORKSPACE_CONFORMANCE_VERSION = 1 as const;

/** Stable identity and maintained claim for one required Workspace behavior. */
export type WorkspaceConformanceCase = Readonly<{
  /** Stable machine identity retained in reports and failure evidence. */
  id: WorkspaceConformanceCaseId;
  /** Human-readable protocol claim maintained beside executable proof. */
  claim: string;
}>;

/** Stable identities for every required v1 Workspace behavior. */
export type WorkspaceConformanceCaseId =
  | 'state.hot-acknowledged-generation'
  | 'mutation.refusal-preserves-state'
  | 'commands.idempotency-preserves-lineage'
  | 'events.after-acknowledgement'
  | 'lifecycle.retained-close';

/** Ordered public catalogue that prevents a partial run from posing as proof. */
export const WORKSPACE_CONFORMANCE_CASES: readonly WorkspaceConformanceCase[] = Object.freeze([
  Object.freeze({
    id: 'state.hot-acknowledged-generation',
    claim: 'Current state advances synchronously and hot subscribers observe the acknowledged generation.',
  }),
  Object.freeze({
    id: 'mutation.refusal-preserves-state',
    claim: 'A stale optimistic precondition returns an exact refusal and preserves current state identity.',
  }),
  Object.freeze({
    id: 'commands.idempotency-preserves-lineage',
    claim: 'Exact mutation replay advances once and conflicting key reuse cannot change lineage.',
  }),
  Object.freeze({
    id: 'events.after-acknowledgement',
    claim: 'A durable mutation fact is published only after the matching state generation is acknowledged.',
  }),
  Object.freeze({
    id: 'lifecycle.retained-close',
    claim: 'Close is idempotent, retains one settlement, and prevents later private reads.',
  }),
]);

/** Fresh production-reachable attachment supplied for one required case. */
export type WorkspaceConformanceFixture = Readonly<{
  /** Empty generation-zero Workspace owned by the suite until close. */
  workspace: WorkspaceHandle;
  /** Current whole-Workspace read permission for suite operations. */
  readGrant: GrantRef<WorkspaceReadAction>;
  /** Current whole-Workspace write permission for suite operations. */
  writeGrant: GrantRef<WorkspaceWriteAction>;
  /** Releases dependencies the Workspace deliberately borrowed from the target. */
  dispose(): Promise<void>;
}>;

/** Construction boundary implemented by one candidate Workspace adapter. */
export type WorkspaceConformanceTarget = Readonly<{
  /** Human-readable implementation identity retained in the report. */
  name: string;
  /** Opens one empty generation-zero attachment with current grants for each case. */
  open(): Promise<WorkspaceConformanceFixture>;
}>;

/** Successful execution evidence for one required Workspace behavior. */
export type PassedWorkspaceConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: WorkspaceConformanceCaseId;
  /** Confirms every assertion in this exact case passed. */
  status: 'passed';
}>;

/** Failed execution evidence with bounded public identity. */
export type FailedWorkspaceConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: WorkspaceConformanceCaseId;
  /** Confirms this exact required case ran and failed. */
  status: 'failed';
  /** Redacted portable failure suitable for CI serialization. */
  failure: PublicError;
}>;

/** Complete result of one required Workspace behavior. */
export type WorkspaceConformanceCaseResult = PassedWorkspaceConformanceCase | FailedWorkspaceConformanceCase;

/** Exact execution accounting that cannot hide an unexecuted required case. */
export type WorkspaceConformanceExecution = Readonly<{
  /** Published required case count for this suite version. */
  required: number;
  /** Number of required cases that produced a result. */
  executed: number;
  /** Required cases not executed for any reason. */
  skipped: number;
}>;

/** Portable complete report returned by the v1 Workspace runner. */
export type WorkspaceConformanceReport = Readonly<{
  /** Pins interpretation to one immutable required-case catalogue. */
  version: typeof WORKSPACE_CONFORMANCE_VERSION;
  /** Identifies the candidate implementation supplied by its author. */
  implementation: string;
  /** Passes only when every required case executed successfully. */
  status: 'passed' | 'failed';
  /** Proves the runner neither skipped nor silently filtered a required case. */
  execution: WorkspaceConformanceExecution;
  /** Contains exactly one ordered result per required case. */
  cases: readonly WorkspaceConformanceCaseResult[];
}>;

/** Stable idempotency identities used only inside independent conformance fixtures. */
const COMMAND_KEYS = Object.freeze({
  /** Drives the hot current-state case. */
  state: IdempotencyKeySchema.parse('61000000-0000-4000-8000-000000000001'),
  /** Drives the stale-precondition preservation case. */
  refusal: IdempotencyKeySchema.parse('61000000-0000-4000-8000-000000000002'),
  /** Drives exact replay and conflicting reuse. */
  replay: IdempotencyKeySchema.parse('61000000-0000-4000-8000-000000000003'),
  /** Drives durable fact ordering. */
  event: IdempotencyKeySchema.parse('61000000-0000-4000-8000-000000000004'),
});

/**
 * Raises one Archer-owned failure when a required production observation is false.
 * @param condition - Exact public observation under evaluation.
 * @param message - Catalogue-owned explanation containing no adapter-private data.
 */
function requireClaim(condition: boolean, message: string): asserts condition {
  if (!condition) throw new FilesError('files_integrity_failed', message);
}

/**
 * Applies one canonical add used across independent Workspace cases.
 * @param fixture - Fresh candidate attachment and its current write grant.
 * @param key - Case-owned UUIDv4 idempotency identity.
 * @param content - Recognizable semantic input for replay and conflict proof.
 * @returns Exact public mutation settlement.
 */
async function addFile(
  fixture: WorkspaceConformanceFixture,
  key: (typeof COMMAND_KEYS)[keyof typeof COMMAND_KEYS],
  content: string,
) {
  return fixture.workspace.apply(
    {
      type: 'add',
      path: 'notes.txt',
      content,
      precondition: { kind: 'absent' },
      idempotencyKey: key,
    },
    fixture.writeGrant,
  );
}

/**
 * Proves living state is acknowledged before deferred callback delivery.
 * @param fixture - Fresh empty candidate Workspace and current grants.
 */
async function hotStateCase(fixture: WorkspaceConformanceFixture): Promise<void> {
  /** Callback observations begin empty and capture only published generations. */
  const observed: number[] = [];
  /** Subscription attaches before the mutation that must wake it. */
  const unsubscribe = fixture.workspace.subscribe((snapshot) => observed.push(snapshot.generation));
  /** Mutation settles one acknowledged generation through the public command. */
  const outcome = await addFile(fixture, COMMAND_KEYS.state, 'hot');
  requireClaim(outcome.kind === 'applied', 'Workspace did not apply the canonical state mutation');
  requireClaim(
    fixture.workspace.getSnapshot().generation === 1,
    'Workspace current state did not advance synchronously',
  );
  await Promise.resolve();
  requireClaim(
    observed.length === 1 && observed[0] === 1,
    'Workspace hot subscriber missed the acknowledged generation',
  );
  unsubscribe();
}

/**
 * Proves a stale command preserves exact current state.
 * @param fixture - Fresh empty candidate Workspace and current grants.
 */
async function refusalCase(fixture: WorkspaceConformanceFixture): Promise<void> {
  /** Object identity makes preserved state stronger than generation equality alone. */
  const before = fixture.workspace.getSnapshot();
  /** Deliberately stale generation cannot authorize an otherwise valid addition. */
  const outcome = await fixture.workspace.apply(
    {
      type: 'add',
      path: 'notes.txt',
      content: 'stale',
      precondition: { kind: 'generation', generation: 9 },
      idempotencyKey: COMMAND_KEYS.refusal,
    },
    fixture.writeGrant,
  );
  requireClaim(
    outcome.kind === 'refused' && outcome.reason === 'stale-generation',
    'Workspace stale generation used the wrong settlement',
  );
  requireClaim(fixture.workspace.getSnapshot() === before, 'Workspace refusal replaced current state identity');
}

/**
 * Proves exact replay and conflicting key reuse share one lineage settlement.
 * @param fixture - Fresh empty candidate Workspace and current grants.
 */
async function idempotencyCase(fixture: WorkspaceConformanceFixture): Promise<void> {
  /** First command earns generation one. */
  const first = await addFile(fixture, COMMAND_KEYS.replay, 'first');
  /** Exact retry must return replay evidence without another transition. */
  const replay = await addFile(fixture, COMMAND_KEYS.replay, 'first');
  /** Different semantic content under the same key must be refused. */
  const conflict = await addFile(fixture, COMMAND_KEYS.replay, 'different');
  requireClaim(first.kind === 'applied' && !first.replayed, 'Workspace first command did not apply exactly once');
  requireClaim(replay.kind === 'applied' && replay.replayed, 'Workspace exact retry did not report replay');
  requireClaim(
    conflict.kind === 'refused' && conflict.reason === 'idempotency-conflict',
    'Workspace conflicting key reuse used the wrong settlement',
  );
  requireClaim(
    fixture.workspace.getSnapshot().generation === 1,
    'Workspace idempotency changed lineage more than once',
  );
}

/**
 * Proves durable fact publication follows matching state acknowledgement.
 * @param fixture - Fresh empty candidate Workspace and current grants.
 */
async function eventOrderingCase(fixture: WorkspaceConformanceFixture): Promise<void> {
  /** Subscription is attached before the command so live publication is observed. */
  const subscription = fixture.workspace.durableEvents.subscribe();
  /** Pending iterator read controls the exact next durable delivery. */
  const next = subscription[Symbol.asyncIterator]().next();
  /** Public mutation must acknowledge state before publishing its fact. */
  const outcome = await addFile(fixture, COMMAND_KEYS.event, 'event');
  requireClaim(outcome.kind === 'applied', 'Workspace did not apply the event-ordering mutation');
  /** Delivery contains the acknowledged generation, never speculative input. */
  const delivered = await next;
  requireClaim(!delivered.done, 'Workspace durable subscription ended before mutation delivery');
  requireClaim(delivered.value.value.type === 'mutation-applied', 'Workspace published the wrong durable fact');
  requireClaim(
    delivered.value.value.snapshot.generation === fixture.workspace.getSnapshot().generation,
    'Workspace durable fact preceded matching current state',
  );
  await subscription.close();
}

/**
 * Proves retained lifecycle identity and refusal of later work.
 * @param fixture - Fresh empty candidate Workspace and current grants.
 */
async function lifecycleCase(fixture: WorkspaceConformanceFixture): Promise<void> {
  /** Both calls are captured before awaiting to prove exact retained promise identity. */
  const first = fixture.workspace.close();
  /** Second close must not schedule another cleanup path. */
  const second = fixture.workspace.close();
  requireClaim(first === second && first === fixture.workspace.closed, 'Workspace close did not retain one settlement');
  /** Normal evidence must settle before the late-operation assertion. */
  const evidence = await first;
  requireClaim(evidence.kind === 'workspace-closed', 'Workspace close returned the wrong evidence');
  /** Closed handles refuse private reads as data rather than touching dependencies. */
  const late = await fixture.workspace.read({ path: 'notes.txt' }, fixture.readGrant);
  requireClaim(late.kind === 'closed', 'Closed Workspace accepted a later read');
}

/** Executable case selected exhaustively by stable catalogue identity. */
type WorkspaceCase = (fixture: WorkspaceConformanceFixture) => Promise<void>;

/** Required behavior implementation map checked exhaustively by TypeScript. */
const CASES = Object.freeze({
  'state.hot-acknowledged-generation': hotStateCase,
  'mutation.refusal-preserves-state': refusalCase,
  'commands.idempotency-preserves-lineage': idempotencyCase,
  'events.after-acknowledgement': eventOrderingCase,
  'lifecycle.retained-close': lifecycleCase,
} satisfies Record<WorkspaceConformanceCaseId, WorkspaceCase>);

/**
 * Executes every required Workspace behavior against independent fresh attachments.
 * @param target - Named candidate factory supplying empty generation-zero fixtures.
 * @returns Complete ordered report whose passing state requires zero skipped cases.
 */
export async function runWorkspaceConformance(target: WorkspaceConformanceTarget): Promise<WorkspaceConformanceReport> {
  if (target.name.length === 0) throw new RangeError('A Workspace conformance implementation name is required');
  /** Receives exactly one result for every required case in catalogue order. */
  const results: WorkspaceConformanceCaseResult[] = [];
  /** Every case receives an independent attachment so lifecycle proof cannot poison another claim. */
  for (const definition of WORKSPACE_CONFORMANCE_CASES) {
    /** Retains an opened fixture for unconditional owner-first cleanup. */
    let fixture: WorkspaceConformanceFixture | undefined;
    try {
      fixture = await target.open();
      requireClaim(fixture.workspace.getSnapshot().generation === 0, 'Workspace target did not open generation zero');
      requireClaim(
        fixture.workspace.getSnapshot().quota.usedFiles === 0,
        'Workspace target did not open the required empty base',
      );
      await CASES[definition.id](fixture);
      results.push(Object.freeze({ id: definition.id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id: definition.id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'workspace_conformance_failed',
            message: 'Workspace conformance case failed',
          }),
        }),
      );
    } finally {
      if (fixture !== undefined) {
        await fixture.workspace.close().catch(() => undefined);
        await fixture.dispose().catch(() => undefined);
      }
    }
  }
  /** Passing requires one successful result for every immutable required definition. */
  const passed =
    results.length === WORKSPACE_CONFORMANCE_CASES.length && results.every((item) => item.status === 'passed');
  return Object.freeze({
    version: WORKSPACE_CONFORMANCE_VERSION,
    implementation: target.name,
    status: passed ? 'passed' : 'failed',
    execution: Object.freeze({
      required: WORKSPACE_CONFORMANCE_CASES.length,
      executed: results.length,
      skipped: WORKSPACE_CONFORMANCE_CASES.length - results.length,
    }),
    cases: Object.freeze(results),
  });
}
