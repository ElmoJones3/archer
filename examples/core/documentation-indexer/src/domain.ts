/**
 * @file Defines the example job's pure state machine and effect intents.
 *
 * The domain knows step names and accepted facts. Functions that execute a step,
 * clocks, diagnostics, streams, and cancellation stay in the application shell.
 */

import {
  ArcherError,
  programDecision,
  type EffectIntent,
  type Program,
  type PublicError,
  type UuidV4,
} from '@archer/core';

/** Stable construction and transition failure categories for this example domain. */
export type JobDomainErrorCode = 'job_definition_invalid' | 'job_transition_invalid';

/** Reports invalid configuration or an event sequence the application should never admit. */
export class JobDomainError extends ArcherError {
  /**
   * Preserves a stable failure code without coupling the example to presentation text.
   * @param code - Construction or transition category owned by the job domain.
   * @param message - Focused explanation safe for the example caller.
   */
  constructor(code: JobDomainErrorCode, message: string) {
    super(message, { code });
  }
}

/** State before the application admits the first start fact. */
export type QueuedJobState = Readonly<{
  /** Correlates every state, event, progress update, and diagnostic for this run. */
  runId: UuidV4;

  /** Selects the only state that may accept `job.started`. */
  status: 'queued';

  /** Retains the immutable non-empty step order chosen at construction. */
  steps: readonly string[];

  /** Proves no step can complete before the job starts. */
  completedSteps: readonly [];
}>;

/** State while exactly one planned step owns the next effect intent. */
export type RunningJobState = Readonly<{
  /** Correlates every state, event, progress update, and diagnostic for this run. */
  runId: UuidV4;

  /** Selects the only state that may accept a step terminal fact. */
  status: 'running';

  /** Retains the immutable non-empty step order chosen at construction. */
  steps: readonly string[];

  /** Lists the exact completed prefix without mutating prior snapshots. */
  completedSteps: readonly string[];

  /** Names the one step whose effect may currently execute. */
  activeStep: string;
}>;

/** State after every planned step has completed in order. */
export type CompletedJobState = Readonly<{
  /** Correlates every state, event, progress update, and diagnostic for this run. */
  runId: UuidV4;

  /** Prevents any later event from rewriting terminal success. */
  status: 'completed';

  /** Retains the immutable non-empty step order chosen at construction. */
  steps: readonly string[];

  /** Equals the planned step order when completion is earned. */
  completedSteps: readonly string[];
}>;

/** State after one active step returns a bounded failure. */
export type FailedJobState = Readonly<{
  /** Correlates every state, event, progress update, and diagnostic for this run. */
  runId: UuidV4;

  /** Prevents a failed run from activating another effect. */
  status: 'failed';

  /** Retains the immutable non-empty step order chosen at construction. */
  steps: readonly string[];

  /** Preserves the successful prefix before the failed step. */
  completedSteps: readonly string[];

  /** Names the active step that failed without marking it completed. */
  failedStep: string;

  /** Carries bounded public evidence rather than the executor's native Error. */
  failure: PublicError;
}>;

/** State after the active operation observes an explicit abort signal. */
export type AbortedJobState = Readonly<{
  /** Correlates every state, event, progress update, and diagnostic for this run. */
  runId: UuidV4;

  /** Prevents an aborted run from manufacturing ordinary completion. */
  status: 'aborted';

  /** Retains the immutable non-empty step order chosen at construction. */
  steps: readonly string[];

  /** Preserves the successful prefix before abort observation. */
  completedSteps: readonly string[];

  /** Names the step active when the operation observed abort. */
  activeStep: string;

  /** Retains bounded operator context separately from domain failure. */
  reason: string;
}>;

/** Every legal immutable snapshot exposed by the running example. */
export type JobState = QueuedJobState | RunningJobState | CompletedJobState | FailedJobState | AbortedJobState;

/** Accepted facts that advance the pure job state machine. */
export type JobEvent =
  | Readonly<{
      /** Begins the one configured job run. */
      type: 'job.started';
    }>
  | Readonly<{
      /** Records successful settlement of the current step. */
      type: 'job.step.completed';

      /** Must equal the active step in acknowledged state. */
      step: string;
    }>
  | Readonly<{
      /** Records failed settlement of the current step. */
      type: 'job.step.failed';

      /** Must equal the active step in acknowledged state. */
      step: string;

      /** Carries adapter-redacted failure evidence. */
      failure: PublicError;
    }>
  | Readonly<{
      /** Records that the active step observed explicit abort. */
      type: 'job.aborted';

      /** Must equal the active step in acknowledged state. */
      step: string;

      /** Retains the accepted abort reason. */
      reason: string;
    }>;

/** Replayable effect payload naming the step an application shell may execute. */
export type RunStepPayload = Readonly<{
  /** Selects one member of the immutable job plan. */
  step: string;
}>;

/** The only external work the pure job Program can request. */
export type JobEffect = EffectIntent<'run-job-step', RunStepPayload>;

/** Binds one validated plan to its legal initial state and pure Program. */
export type JobDefinition = Readonly<{
  /** Immutable non-empty step order shared by state and transition logic. */
  steps: readonly string[];

  /** The only application-facing construction path for queued state. */
  initialState: QueuedJobState;

  /** Pure decision owner for already-accepted job facts. */
  program: Program<JobState, JobEvent, JobEffect>;
}>;

/** Shared immutable empty prefix whose tuple type proves queued state has no work. */
const NO_COMPLETED_STEPS: readonly [] = Object.freeze([]);

/**
 * Rejects a definition or accepted-event sequence without exposing partial state.
 * @param code - Stable construction or transition failure category.
 * @param message - Explanation of the violated invariant.
 */
function reject(code: JobDomainErrorCode, message: string): never {
  throw new JobDomainError(code, message);
}

/**
 * Copies and validates the step order shared by every state snapshot.
 * @param steps - Caller-owned proposed step names.
 * @returns Frozen non-empty unique names in caller order.
 */
function admitSteps(steps: readonly string[]): readonly string[] {
  if (steps.length === 0) reject('job_definition_invalid', 'A job requires at least one step');
  /** Tracks exact names because step identity is case-sensitive. */
  const seen = new Set<string>();
  /** Accumulates a source-owned plan without retaining the caller's array. */
  const accepted: string[] = [];
  /** Validates every step before any definition can escape. */
  for (const step of steps) {
    if (step.length === 0 || step !== step.trim()) {
      reject('job_definition_invalid', 'Job step names must be non-empty and contain no surrounding whitespace');
    }
    if (seen.has(step)) reject('job_definition_invalid', `Job step names must be unique: ${step}`);
    seen.add(step);
    accepted.push(step);
  }
  return Object.freeze(accepted);
}

/**
 * Proves a state belongs to this definition before applying another fact.
 * @param state - Proposed acknowledged state supplied to the Program.
 * @param runId - Identity fixed when the definition was created.
 * @param steps - Plan fixed when the definition was created.
 */
function assertCompatibleState(state: Readonly<JobState>, runId: UuidV4, steps: readonly string[]): void {
  if (state.runId !== runId || state.steps.length !== steps.length) {
    reject('job_transition_invalid', 'Job state does not belong to this definition');
  }
  /** Compares plan and successful prefix without trusting caller aliases. */
  for (let index = 0; index < steps.length; index += 1) {
    if (state.steps[index] !== steps[index]) {
      reject('job_transition_invalid', 'Job state carries a different step plan');
    }
  }
  if (state.completedSteps.length > steps.length) {
    reject('job_transition_invalid', 'Job state completed more steps than its plan contains');
  }
  /** Proves successful work is always an exact prefix of the immutable plan. */
  for (let index = 0; index < state.completedSteps.length; index += 1) {
    if (state.completedSteps[index] !== steps[index]) {
      reject('job_transition_invalid', 'Job state completed steps out of plan order');
    }
  }
  /** Names the next planned step implied by the successful prefix. */
  const nextStep = steps[state.completedSteps.length];
  if (state.status === 'queued' && state.completedSteps.length !== 0) {
    reject('job_transition_invalid', 'Queued job state cannot contain completed steps');
  }
  if (state.status === 'running' && state.activeStep !== nextStep) {
    reject('job_transition_invalid', 'Running job state must identify the next planned step');
  }
  if (state.status === 'completed' && state.completedSteps.length !== steps.length) {
    reject('job_transition_invalid', 'Completed job state must contain the complete plan');
  }
  if (state.status === 'failed' && state.failedStep !== nextStep) {
    reject('job_transition_invalid', 'Failed job state must identify the next planned step');
  }
  if (state.status === 'aborted' && state.activeStep !== nextStep) {
    reject('job_transition_invalid', 'Aborted job state must identify the next planned step');
  }
}

/**
 * Creates the one deterministic effect owed when a step becomes active.
 * @param step - Exact step selected from the immutable plan.
 * @returns Frozen replayable effect intent with no executable callback.
 */
function runStepEffect(step: string): JobEffect {
  return Object.freeze({ kind: 'run-job-step', payload: Object.freeze({ step }) });
}

/**
 * Requires one running state and an event for its exact active step.
 * @param state - Current state supplied to the Program.
 * @param step - Step identity carried by the terminal event.
 * @returns The narrowed running state after exact identity verification.
 */
function requireActiveStep(state: Readonly<JobState>, step: string): Readonly<RunningJobState> {
  if (state.status !== 'running' || state.activeStep !== step) {
    reject('job_transition_invalid', `Step ${step} is not the active job step`);
  }
  return state;
}

/**
 * Creates one validated job definition and the only legal queued state.
 * @param runId - UUIDv4 identity supplied by the application boundary.
 * @param steps - Ordered non-empty unique step names.
 * @returns Immutable construction and pure transition capabilities.
 */
export function createJobDefinition(runId: UuidV4, steps: readonly string[]): JobDefinition {
  /** Copies and validates plan identity before initial state can escape. */
  const acceptedSteps = admitSteps(steps);
  /** Creates the only legal application-facing initial state. */
  const initialState: QueuedJobState = Object.freeze({
    runId,
    status: 'queued',
    steps: acceptedSteps,
    completedSteps: NO_COMPLETED_STEPS,
  });
  /** Owns every legal state transition for facts already accepted by the shell. */
  const program: Program<JobState, JobEvent, JobEffect> = {
    /**
     * Derives fresh state and the exact next effect without executing work.
     * @param state - Previously acknowledged state belonging to this definition.
     * @param event - One accepted fact emitted by the application shell.
     * @returns Fresh state and zero or one ordered step effect.
     */
    reduce(state, event) {
      assertCompatibleState(state, runId, acceptedSteps);
      if (event.type === 'job.started') {
        if (state.status !== 'queued') reject('job_transition_invalid', 'A job may start only from queued state');
        /** The non-empty definition guarantees a first active step. */
        const activeStep = acceptedSteps[0];
        if (activeStep === undefined) reject('job_transition_invalid', 'A job definition lost its first step');
        /** Fresh running state earns execution of only the first step. */
        const running: RunningJobState = Object.freeze({
          runId,
          status: 'running',
          steps: acceptedSteps,
          completedSteps: NO_COMPLETED_STEPS,
          activeStep,
        });
        return programDecision(running, [runStepEffect(activeStep)]);
      }

      /** Every remaining event terminates the currently active step. */
      const running = requireActiveStep(state, event.step);
      if (event.type === 'job.step.failed') {
        /** Failure preserves the successful prefix and activates no later work. */
        const failed: FailedJobState = Object.freeze({
          runId,
          status: 'failed',
          steps: acceptedSteps,
          completedSteps: running.completedSteps,
          failedStep: event.step,
          failure: event.failure,
        });
        return programDecision(failed, []);
      }
      if (event.type === 'job.aborted') {
        /** Abort preserves the successful prefix without claiming step completion. */
        const aborted: AbortedJobState = Object.freeze({
          runId,
          status: 'aborted',
          steps: acceptedSteps,
          completedSteps: running.completedSteps,
          activeStep: event.step,
          reason: event.reason,
        });
        return programDecision(aborted, []);
      }

      /** Copies the successful prefix before deciding whether another step exists. */
      const completedSteps = Object.freeze([...running.completedSteps, event.step]);
      /** Selects the next step strictly after the newly completed prefix. */
      const nextStep = acceptedSteps[completedSteps.length];
      if (nextStep === undefined) {
        /** Terminal success is earned only when the prefix equals the whole plan. */
        const completed: CompletedJobState = Object.freeze({
          runId,
          status: 'completed',
          steps: acceptedSteps,
          completedSteps,
        });
        return programDecision(completed, []);
      }
      /** Running state advances to exactly one successor and its effect intent. */
      const advanced: RunningJobState = Object.freeze({
        runId,
        status: 'running',
        steps: acceptedSteps,
        completedSteps,
        activeStep: nextStep,
      });
      return programDecision(advanced, [runStepEffect(nextStep)]);
    },
  };
  return Object.freeze({ steps: acceptedSteps, initialState, program });
}
