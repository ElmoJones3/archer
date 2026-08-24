/**
 * @file Compiles positive and negative examples of Archer's public type contract.
 *
 * This file is included by TypeScript but not Vitest. `@ts-expect-error` lines
 * prove identities, discriminators, and Result failures cannot be interchanged.
 */

import {
  Result,
  UuidV4Schema,
  archerObjectSchema,
  type ArcherObject,
  type Timestamp,
  type UuidV4,
} from '../src/index.js';
import {
  liveOperation,
  type ReplayableEventStream,
  type StreamCursor,
  type TransientEventStream,
} from '../src/stream/index.js';
import type {
  AuthorityBroker,
  AuthorityCheck,
  GrantRef,
  PrincipalId,
  ProtectedAction,
} from '../src/authority/index.js';

/** Distinguishes Thread identities in compile-only assignments. */
declare const threadIdBrand: unique symbol;

/** Distinguishes Workspace identities in compile-only assignments. */
declare const workspaceIdBrand: unique symbol;

/** A UUIDv4 narrowed to Thread ownership. */
type ThreadId = UuidV4 & {
  /** Makes Thread identity structurally incompatible with other branded IDs. */
  readonly [threadIdBrand]: true;
};

/** A UUIDv4 narrowed to Workspace ownership. */
type WorkspaceId = UuidV4 & {
  /** Makes Workspace identity structurally incompatible with other branded IDs. */
  readonly [workspaceIdBrand]: true;
};

/** Supplies a valid Thread identity without adding runtime fixture code. */
declare const threadId: ThreadId;

/** Supplies the wrong aggregate identity for a negative assignment proof. */
declare const workspaceId: WorkspaceId;

/** Supplies a previously normalized creation instant for the object fixture. */
declare const createdAt: Timestamp;

/** Supplies one cursor admitted specifically by a task observation source. */
declare const taskCursor: StreamCursor<'task'>;

/** Supplies one cursor admitted specifically by a Thread observation source. */
declare const threadCursor: StreamCursor<'thread'>;

/** Representative durable task observation used by compile-only cursor proofs. */
type TaskObservation = Readonly<{
  /** Discriminates the representative durable event. */
  kind: 'task-event';
}>;

/** Representative finite-operation progress used by staged inference proof. */
type OperationProgress = Readonly<{
  /** Carries typed progress through the staged builder. */
  step: number;
}>;

/** Representative read scope owned by one protected package boundary. */
type ReportReadScope = Readonly<{
  /** Selects the exact scope codec in compile-only proofs. */
  kind: 'report-read';

  /** Names the report being read. */
  reportId: string;
}>;

/** Couples report-read authority to its complete package-owned scope. */
type ReportReadAction = ProtectedAction<'report-read', ReportReadScope>;

/** Representative deployment scope intentionally incompatible with report reads. */
type DeployScope = Readonly<{
  /** Selects the deployment scope codec in compile-only proofs. */
  kind: 'deploy';

  /** Names the environment receiving a deployment. */
  environment: string;
}>;

/** Couples deployment authority to a different action and target shape. */
type DeployAction = ProtectedAction<'deploy', DeployScope>;

/** Supplies a report-specific forgeable lookup reference. */
declare const reportGrant: GrantRef<ReportReadAction>;

/** Supplies a Principal for exact broker-check construction. */
declare const authorityPrincipal: PrincipalId;

/** Supplies a broker whose permitted type family remains action-discriminated. */
declare const authorityBroker: AuthorityBroker<ReportReadAction | DeployAction>;

/** Proves one exact reference, subject, and scope compose at the verification boundary. */
const reportCheck: AuthorityCheck<ReportReadAction> = {
  grant: reportGrant,
  subject: authorityPrincipal,
  scope: { kind: 'report-read', reportId: 'report-1' },
};

void authorityBroker.verify(reportCheck);

/** Must remain rejected so an action-specific reference cannot cross categories. */
// @ts-expect-error A report-read reference cannot pose as deployment authority.
const wrongAuthorityReference: GrantRef<DeployAction> = reportGrant;

/** Must remain rejected so a valid action cannot carry another package's scope. */
const wrongAuthorityScope: AuthorityCheck<ReportReadAction> = {
  grant: reportGrant,
  subject: authorityPrincipal,
  // @ts-expect-error Report checks require report-read scope, not deployment scope.
  scope: { kind: 'deploy', environment: 'production' },
};

/** Receives only task-family cursor replay. */
declare const taskEvents: ReplayableEventStream<TaskObservation, StreamCursor<'task'>>;

taskEvents.subscribe({ after: taskCursor });

/** Must remain rejected so durable cursor families cannot cross source boundaries. */
// @ts-expect-error A Thread cursor cannot resume task history.
taskEvents.subscribe({ after: threadCursor });

/** Represents a valid compile-time Thread envelope. */
const thread: ArcherObject<'thread', ThreadId> = {
  id: threadId,
  object: 'thread',
  createdAt,
};

/** Proves aggregate code can derive a branded schema from the canonical UUID schema. */
const ThreadIdSchema = UuidV4Schema.transform((id) => id as ThreadId);

archerObjectSchema('thread', ThreadIdSchema).parse(thread);

/** Must remain rejected so aggregate identities cannot cross ownership boundaries. */
// @ts-expect-error A Workspace identity cannot replace a Thread identity.
const wrongIdentity: ArcherObject<'thread', ThreadId> = { ...thread, id: workspaceId };

/** Must remain rejected so object discriminators preserve exhaustive narrowing. */
// @ts-expect-error The object discriminator is exact.
const wrongObject: ArcherObject<'thread', ThreadId> = { ...thread, object: 'workspace' };

/** Proves a focused native Error subtype can narrow Result failure handling. */
const result: Result<number, TypeError> = Result.error(new TypeError('nope'));

/** Proves the default Result failure remains the ordinary Error base. */
const broadResult: Result<number> = Result.error(new Error('nope'));

/** Proves selecting only progress type preserves inferred result and close types. */
const inferredOperation = liveOperation<OperationProgress>()({
  source: 'type-proof',
  epoch: 'attempt-1',
  eventEncoding: {
    revision: 'operation-progress/1',
    /**
     * Copies the flat compile-only fixture into source-owned state.
     * @param event - Caller-owned progress fixture.
     * @returns A frozen source-owned progress value.
     */
    normalize: (event) => Object.freeze({ ...event }),
    /**
     * Measures the compile-only fixture through its integer payload.
     * @param event - Typed operation progress.
     * @returns A non-negative fixture size.
     */
    measure: (event) => event.step,
  },
  /**
   * Produces one inferred terminal result without emitting runtime progress.
   * @returns The representative completed result.
   */
  start: async () => Object.freeze({ kind: 'completed' as const }),
  /**
   * Maps any terminal settlement into inferred close evidence.
   * @returns The representative retained close record.
   */
  closeEvidence: () => Object.freeze({ kind: 'closed' as const }),
  /**
   * Classifies the completed fixture after a hypothetical abort request.
   * @returns Terminal completion evidence.
   */
  classifyAbort: () => Object.freeze({ kind: 'attempt-settled' as const, outcome: 'completed' as const }),
});

/** Rejects `unknown` progress inference by requiring the exact selected type. */
const inferredProgress: TransientEventStream<OperationProgress> = inferredOperation.events;

/** A structurally tempting substitute that lacks native Error behavior. */
type ErrorLike = Readonly<{
  /** A code alone cannot replace Error identity, stack, and causality. */
  code: string;
}>;

/** Must remain rejected because Result failures require actual Error instances. */
// @ts-expect-error Result failures must be Error instances.
type InvalidResult = Result<number, ErrorLike>;

/** Keeps the intentionally invalid alias live for unused-type linting. */
declare const invalidResult: InvalidResult;

void wrongIdentity;
void wrongObject;
void invalidResult;
void result;
void broadResult;
void inferredProgress;
void wrongAuthorityReference;
void wrongAuthorityScope;
