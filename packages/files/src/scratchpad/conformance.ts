/**
 * @file Publishes the versioned behavior suite every Scratchpad adapter must pass.
 *
 * The suite owns commands, retention selection, and assertions. A target only
 * opens fresh empty handles with real current grants and releases dependencies
 * those handles deliberately borrowed.
 */

import { IdempotencyKeySchema, toPublicError, type PublicError } from '@archer/core';
import type { GrantRef } from '@archer/core/authority';

import { FilesError } from '../errors.js';
import type {
  MemoryScratchpadRetention,
  ScratchpadCheckpointAction,
  ScratchpadHandle,
  ScratchpadReadAction,
  ScratchpadWriteAction,
} from './contracts.js';

/** Current immutable Scratchpad behavior catalogue. */
export const SCRATCHPAD_CONFORMANCE_VERSION = 1 as const;

/** Stable identity and maintained claim for one required Scratchpad behavior. */
export type ScratchpadConformanceCase = Readonly<{
  /** Stable machine identity retained in reports and failure evidence. */
  id: ScratchpadConformanceCaseId;
  /** Human-readable protocol claim maintained beside executable proof. */
  claim: string;
}>;

/** Stable identities for every required v1 process-local Scratchpad behavior. */
export type ScratchpadConformanceCaseId =
  | 'retention.discriminator-changes-surface'
  | 'updates.hot-after-acknowledgement'
  | 'checkpoint.explicit-and-replayable'
  | 'mutation.refusal-preserves-state'
  | 'lifecycle.close-states-recoverability';

/** Ordered public catalogue that prevents partial execution from posing as proof. */
export const SCRATCHPAD_CONFORMANCE_CASES: readonly ScratchpadConformanceCase[] = Object.freeze([
  Object.freeze({
    id: 'retention.discriminator-changes-surface',
    claim: 'Ephemeral handles omit checkpoint APIs while checkpointed handles expose command and replay.',
  }),
  Object.freeze({
    id: 'updates.hot-after-acknowledgement',
    claim: 'Acknowledged mutations update current state before publishing gap-aware transient feedback.',
  }),
  Object.freeze({
    id: 'checkpoint.explicit-and-replayable',
    claim: 'Only an explicit current-generation checkpoint creates one immutable replayable fact.',
  }),
  Object.freeze({
    id: 'mutation.refusal-preserves-state',
    claim: 'A stale checkpoint returns exact current generation and preserves current state identity.',
  }),
  Object.freeze({
    id: 'lifecycle.close-states-recoverability',
    claim: 'Close is retained and states recoverability without claiming shared content deletion.',
  }),
]);

/** Fresh production-reachable Scratchpad attachment supplied for one case. */
export type ScratchpadConformanceFixture = Readonly<{
  /** Empty generation-zero Scratchpad with the retention requested by the suite. */
  scratchpad: ScratchpadHandle;
  /** Current whole-Scratchpad read permission for suite operations. */
  readGrant: GrantRef<ScratchpadReadAction>;
  /** Current whole-Scratchpad write permission for suite operations. */
  writeGrant: GrantRef<ScratchpadWriteAction>;
  /** Current broad checkpoint permission for retained suite operations. */
  checkpointGrant: GrantRef<ScratchpadCheckpointAction>;
  /** Releases dependencies deliberately borrowed by the candidate handle. */
  dispose(): Promise<void>;
}>;

/** Construction boundary implemented by one candidate process-local adapter. */
export type ScratchpadConformanceTarget = Readonly<{
  /** Human-readable implementation identity retained in the report. */
  name: string;
  /** Opens one empty handle in the exact honest retention selected by the suite. */
  open(retention: MemoryScratchpadRetention): Promise<ScratchpadConformanceFixture>;
}>;

/** Successful execution evidence for one required Scratchpad behavior. */
export type PassedScratchpadConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: ScratchpadConformanceCaseId;
  /** Confirms every assertion in this exact case passed. */
  status: 'passed';
}>;

/** Failed execution evidence with bounded public identity. */
export type FailedScratchpadConformanceCase = Readonly<{
  /** Stable required behavior identity. */
  id: ScratchpadConformanceCaseId;
  /** Confirms this exact required case ran and failed. */
  status: 'failed';
  /** Redacted portable failure suitable for CI serialization. */
  failure: PublicError;
}>;

/** Complete result of one required Scratchpad behavior. */
export type ScratchpadConformanceCaseResult = PassedScratchpadConformanceCase | FailedScratchpadConformanceCase;

/** Exact execution accounting that cannot hide an unexecuted required case. */
export type ScratchpadConformanceExecution = Readonly<{
  /** Published required case count for this suite version. */
  required: number;
  /** Number of required cases that produced a result. */
  executed: number;
  /** Required cases not executed for any reason. */
  skipped: number;
}>;

/** Portable complete report returned by the v1 Scratchpad runner. */
export type ScratchpadConformanceReport = Readonly<{
  /** Pins interpretation to one immutable required-case catalogue. */
  version: typeof SCRATCHPAD_CONFORMANCE_VERSION;
  /** Identifies the candidate implementation supplied by its author. */
  implementation: string;
  /** Passes only when every required case executed successfully. */
  status: 'passed' | 'failed';
  /** Proves the runner neither skipped nor silently filtered a required case. */
  execution: ScratchpadConformanceExecution;
  /** Contains exactly one ordered result per required case. */
  cases: readonly ScratchpadConformanceCaseResult[];
}>;

/** Stable command identities used only inside independent conformance fixtures. */
const COMMAND_KEYS = Object.freeze({
  /** Drives the transient update case. */
  update: IdempotencyKeySchema.parse('63000000-0000-4000-8000-000000000001'),
  /** Drives content creation before checkpoint proof. */
  checkpointMutation: IdempotencyKeySchema.parse('63000000-0000-4000-8000-000000000002'),
  /** Drives exact checkpoint replay. */
  checkpoint: IdempotencyKeySchema.parse('63000000-0000-4000-8000-000000000003'),
  /** Drives the stale checkpoint refusal. */
  refusal: IdempotencyKeySchema.parse('63000000-0000-4000-8000-000000000004'),
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
 * Opens, validates, and unconditionally releases one suite-selected fixture.
 * @param target - Candidate factory under test.
 * @param retention - Honest memory retention mode required by this case.
 * @param work - Suite-owned assertions executed against the fresh fixture.
 */
async function withFixture(
  target: ScratchpadConformanceTarget,
  retention: MemoryScratchpadRetention,
  work: (fixture: ScratchpadConformanceFixture) => Promise<void>,
): Promise<void> {
  /** Fresh attachment isolates state and lifecycle between required cases. */
  const fixture = await target.open(retention);
  try {
    requireClaim(fixture.scratchpad.getSnapshot().generation === 0, 'Scratchpad target did not open generation zero');
    requireClaim(
      fixture.scratchpad.getSnapshot().quota.usedFiles === 0,
      'Scratchpad target did not open the required empty base',
    );
    requireClaim(fixture.scratchpad.retention === retention, 'Scratchpad target returned the wrong retention');
    await work(fixture);
  } finally {
    await fixture.scratchpad.close().catch(() => undefined);
    await fixture.dispose().catch(() => undefined);
  }
}

/**
 * Proves the retention discriminator changes the actual runtime method family.
 * @param target - Candidate factory under test.
 */
async function retentionCase(target: ScratchpadConformanceTarget): Promise<void> {
  await withFixture(target, 'ephemeral', async (fixture) => {
    requireClaim(!('checkpoint' in fixture.scratchpad), 'Ephemeral Scratchpad exposed checkpoint command');
    requireClaim(!('checkpointEvents' in fixture.scratchpad), 'Ephemeral Scratchpad exposed checkpoint replay');
  });
  await withFixture(target, 'checkpointed', async (fixture) => {
    requireClaim('checkpoint' in fixture.scratchpad, 'Checkpointed Scratchpad omitted checkpoint command');
    requireClaim('checkpointEvents' in fixture.scratchpad, 'Checkpointed Scratchpad omitted checkpoint replay');
  });
}

/**
 * Proves hot state acknowledgement precedes transient update delivery.
 * @param target - Candidate factory under test.
 */
async function updateCase(target: ScratchpadConformanceTarget): Promise<void> {
  await withFixture(target, 'ephemeral', async (fixture) => {
    /** Subscription attaches before the command to prove live delivery. */
    const subscription = fixture.scratchpad.updates.subscribe();
    /** Pending read controls the exact first transient event boundary. */
    const next = subscription[Symbol.asyncIterator]().next();
    /** Canonical add earns one acknowledged private generation. */
    const outcome = await fixture.scratchpad.apply(
      {
        type: 'add',
        path: 'notes.txt',
        content: 'update',
        precondition: { kind: 'absent' },
        idempotencyKey: COMMAND_KEYS.update,
      },
      fixture.writeGrant,
    );
    requireClaim(outcome.kind === 'applied', 'Scratchpad did not apply the canonical update mutation');
    requireClaim(fixture.scratchpad.getSnapshot().generation === 1, 'Scratchpad state did not acknowledge mutation');
    /** Delivered update must name the already-current generation. */
    const delivered = await next;
    requireClaim(!delivered.done, 'Scratchpad transient subscription ended before update delivery');
    requireClaim(delivered.value.kind === 'event', 'Scratchpad update delivery used the wrong transient branch');
    requireClaim(delivered.value.value.generation === 1, 'Scratchpad update did not match current generation');
    await subscription.close();
  });
}

/**
 * Proves explicit checkpoint acknowledgement, durable publication, and exact replay.
 * @param target - Candidate factory under test.
 */
async function checkpointCase(target: ScratchpadConformanceTarget): Promise<void> {
  await withFixture(target, 'checkpointed', async (fixture) => {
    requireClaim('checkpoint' in fixture.scratchpad, 'Checkpoint case received an ephemeral handle');
    /** Private mutation establishes one non-zero generation to checkpoint. */
    const mutation = await fixture.scratchpad.apply(
      {
        type: 'add',
        path: 'notes.txt',
        content: 'checkpoint',
        precondition: { kind: 'absent' },
        idempotencyKey: COMMAND_KEYS.checkpointMutation,
      },
      fixture.writeGrant,
    );
    requireClaim(mutation.kind === 'applied', 'Scratchpad did not establish checkpoint content');
    /** Durable subscription attaches before explicit checkpoint acknowledgement. */
    const subscription = fixture.scratchpad.checkpointEvents.subscribe();
    /** Pending read controls the exact retained publication boundary. */
    const next = subscription[Symbol.asyncIterator]().next();
    /** Exact command is reused to prove stable checkpoint identity. */
    const command = Object.freeze({ expectedGeneration: 1, idempotencyKey: COMMAND_KEYS.checkpoint });
    /** First command earns one immutable checkpoint fact. */
    const first = await fixture.scratchpad.checkpoint(command, fixture.checkpointGrant);
    /** Exact retry must return the same checkpoint identity without another generation. */
    const replay = await fixture.scratchpad.checkpoint(command, fixture.checkpointGrant);
    requireClaim(first.kind === 'created' && !first.replayed, 'Scratchpad first checkpoint did not create evidence');
    requireClaim(replay.kind === 'created' && replay.replayed, 'Scratchpad checkpoint retry did not report replay');
    requireClaim(
      first.kind === 'created' && replay.kind === 'created' && first.checkpoint === replay.checkpoint,
      'Scratchpad checkpoint replay changed immutable identity',
    );
    /** Retained event must carry the exact acknowledged checkpoint object. */
    const delivered = await next;
    requireClaim(!delivered.done, 'Scratchpad checkpoint stream ended before retained delivery');
    requireClaim(
      delivered.value.value.checkpoint === first.checkpoint,
      'Scratchpad retained the wrong checkpoint fact',
    );
    await subscription.close();
  });
}

/**
 * Proves a stale checkpoint preserves exact hot state identity.
 * @param target - Candidate factory under test.
 */
async function refusalCase(target: ScratchpadConformanceTarget): Promise<void> {
  await withFixture(target, 'checkpointed', async (fixture) => {
    requireClaim('checkpoint' in fixture.scratchpad, 'Refusal case received an ephemeral handle');
    /** Object identity makes preservation stronger than generation equality alone. */
    const before = fixture.scratchpad.getSnapshot();
    /** Expected generation one is deliberately stale against empty generation zero. */
    const outcome = await fixture.scratchpad.checkpoint(
      { expectedGeneration: 1, idempotencyKey: COMMAND_KEYS.refusal },
      fixture.checkpointGrant,
    );
    requireClaim(
      outcome.kind === 'stale-generation' && outcome.actualGeneration === 0,
      'Scratchpad stale checkpoint used the wrong settlement',
    );
    requireClaim(fixture.scratchpad.getSnapshot() === before, 'Scratchpad stale checkpoint replaced current state');
  });
}

/**
 * Proves retained close identity and honest ephemeral recovery evidence.
 * @param target - Candidate factory under test.
 */
async function lifecycleCase(target: ScratchpadConformanceTarget): Promise<void> {
  await withFixture(target, 'ephemeral', async (fixture) => {
    /** Both calls are captured before awaiting to prove exact promise identity. */
    const first = fixture.scratchpad.close();
    /** Second close must not schedule another cleanup path. */
    const second = fixture.scratchpad.close();
    requireClaim(
      first === second && first === fixture.scratchpad.closed,
      'Scratchpad close did not retain one settlement',
    );
    /** Evidence states logical release without claiming shared byte deletion. */
    const evidence = await first;
    requireClaim(evidence.disposition === 'ephemeral-released', 'Scratchpad close overstated recoverability');
  });
}

/** Executable case selected exhaustively by stable catalogue identity. */
type ScratchpadCase = (target: ScratchpadConformanceTarget) => Promise<void>;

/** Required behavior implementation map checked exhaustively by TypeScript. */
const CASES = Object.freeze({
  'retention.discriminator-changes-surface': retentionCase,
  'updates.hot-after-acknowledgement': updateCase,
  'checkpoint.explicit-and-replayable': checkpointCase,
  'mutation.refusal-preserves-state': refusalCase,
  'lifecycle.close-states-recoverability': lifecycleCase,
} satisfies Record<ScratchpadConformanceCaseId, ScratchpadCase>);

/**
 * Executes every required Scratchpad behavior against independent fresh attachments.
 * @param target - Named candidate factory supplying empty process-local fixtures.
 * @returns Complete ordered report whose passing state requires zero skipped cases.
 */
export async function runScratchpadConformance(
  target: ScratchpadConformanceTarget,
): Promise<ScratchpadConformanceReport> {
  if (target.name.length === 0) throw new RangeError('A Scratchpad conformance implementation name is required');
  /** Receives exactly one result for every required case in catalogue order. */
  const results: ScratchpadConformanceCaseResult[] = [];
  /** Each executable case owns fresh fixtures and unconditional cleanup. */
  for (const definition of SCRATCHPAD_CONFORMANCE_CASES) {
    try {
      await CASES[definition.id](target);
      results.push(Object.freeze({ id: definition.id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id: definition.id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'scratchpad_conformance_failed',
            message: 'Scratchpad conformance case failed',
          }),
        }),
      );
    }
  }
  /** Passing requires one successful result for every immutable required definition. */
  const passed =
    results.length === SCRATCHPAD_CONFORMANCE_CASES.length && results.every((item) => item.status === 'passed');
  return Object.freeze({
    version: SCRATCHPAD_CONFORMANCE_VERSION,
    implementation: target.name,
    status: passed ? 'passed' : 'failed',
    execution: Object.freeze({
      required: SCRATCHPAD_CONFORMANCE_CASES.length,
      executed: results.length,
      skipped: SCRATCHPAD_CONFORMANCE_CASES.length - results.length,
    }),
    cases: Object.freeze(results),
  });
}
