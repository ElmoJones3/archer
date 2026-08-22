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
