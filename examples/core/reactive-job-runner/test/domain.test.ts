/**
 * @file Proves the example Program earns each job state, preserves effect order,
 * rejects impossible accepted-event sequences, and never mutates prior state.
 */

import { describe, expect, it } from 'vitest';

import { PublicErrorSchema, UuidV4Schema } from '@archer/core';

import { JobDomainError, createJobDefinition, type JobState, type RunningJobState } from '../src/domain.js';

/** Stable UUIDv4 identity shared by every pure transition proof. */
const RUN_ID = UuidV4Schema.parse('00000000-0000-4000-8000-000000000101');

/** Immutable two-step plan that makes effect order and terminal completion visible. */
const STEPS = Object.freeze(['inspect', 'compile']);

/** Public failure used to prove failed state retains redacted evidence exactly. */
const STEP_FAILURE = PublicErrorSchema.parse({
  code: 'example_step_failed',
  message: 'The example step failed',
  retryable: false,
});

/**
 * Narrows a state after the assertion has proved its discriminant.
 * @param state - State returned by the pure Program.
 * @returns The same state after a runtime running-state assertion.
 */
function expectRunning(state: JobState): RunningJobState {
  expect(state.status).toBe('running');
  if (state.status !== 'running') throw new Error('Expected the job to be running');
  return state;
}

describe('job Program', () => {
  it('starts, advances steps in order, and earns terminal completion without mutation', () => {
    /** Owns the validated plan and the Program under test. */
    const definition = createJobDefinition(RUN_ID, STEPS);
    /** Retains the queued snapshot so later assertions can detect mutation. */
    const queued = definition.initialState;
    /** Starts the job and requests only the first configured effect. */
    const started = definition.program.reduce(queued, { type: 'job.started' });
    /** Narrows the first running snapshot for its exact active-step assertion. */
    const inspecting = expectRunning(started.state);
    /** Completes the first step and requests only its successor. */
    const inspected = definition.program.reduce(inspecting, {
      type: 'job.step.completed',
      step: 'inspect',
    });
    /** Narrows the second running snapshot for its exact successful prefix. */
    const compiling = expectRunning(inspected.state);
    /** Completes the final step and must produce no later effect. */
    const completed = definition.program.reduce(compiling, {
      type: 'job.step.completed',
      step: 'compile',
    });

    expect(started).toEqual({
      state: {
        runId: RUN_ID,
        status: 'running',
        steps: STEPS,
        completedSteps: [],
        activeStep: 'inspect',
      },
      effects: [{ kind: 'run-job-step', payload: { step: 'inspect' } }],
    });
    expect(inspected).toEqual({
      state: {
        runId: RUN_ID,
        status: 'running',
        steps: STEPS,
        completedSteps: ['inspect'],
        activeStep: 'compile',
      },
      effects: [{ kind: 'run-job-step', payload: { step: 'compile' } }],
    });
    expect(completed).toEqual({
      state: {
        runId: RUN_ID,
        status: 'completed',
        steps: STEPS,
        completedSteps: STEPS,
      },
      effects: [],
    });
    expect(queued).toEqual({
      runId: RUN_ID,
      status: 'queued',
      steps: STEPS,
      completedSteps: [],
    });
    expect(compiling.completedSteps).toEqual(['inspect']);
  });

  it('earns failed state without activating another step', () => {
    /** Owns the validated plan and the Program under test. */
    const definition = createJobDefinition(RUN_ID, STEPS);
    /** Produces the only running state allowed to accept an inspect failure. */
    const running = expectRunning(definition.program.reduce(definition.initialState, { type: 'job.started' }).state);
    /** Records the active step failure through the ordinary Program entry point. */
    const failed = definition.program.reduce(running, {
      type: 'job.step.failed',
      step: 'inspect',
      failure: STEP_FAILURE,
    });

    expect(failed).toEqual({
      state: {
        runId: RUN_ID,
        status: 'failed',
        steps: STEPS,
        completedSteps: [],
        failedStep: 'inspect',
        failure: STEP_FAILURE,
      },
      effects: [],
    });
    expect(running.status).toBe('running');
  });

  it('rejects an out-of-order terminal fact and preserves current state', () => {
    /** Owns the validated plan and the Program under test. */
    const definition = createJobDefinition(RUN_ID, STEPS);
    /** Produces a valid running state whose active step is inspect. */
    const running = expectRunning(definition.program.reduce(definition.initialState, { type: 'job.started' }).state);

    /** Captures the exact domain Error rather than accepting any thrown guard. */
    let failure: unknown;
    try {
      definition.program.reduce(running, {
        type: 'job.step.completed',
        step: 'compile',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(JobDomainError);
    if (!(failure instanceof JobDomainError)) throw new Error('Expected a JobDomainError');
    expect(failure.code).toBe('job_transition_invalid');
    expect(running).toEqual({
      runId: RUN_ID,
      status: 'running',
      steps: STEPS,
      completedSteps: [],
      activeStep: 'inspect',
    });
  });
});
