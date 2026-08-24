/**
 * @file Proves the executable example exposes one hot job across success,
 * bounded failure, abort, terminal observation, and idempotent cleanup.
 */

import { describe, expect, it } from 'vitest';

import { UuidV4Schema, createIdempotencyKey } from '@archer/core';

import { createReactiveJobRun, type JobStep, type JobStepContext, type ReactiveJobRun } from '../src/job.js';

/** Stable source identity used by every live example proof. */
const RUN_ID = UuidV4Schema.parse('00000000-0000-4000-8000-000000000201');

/** A manually controlled promise with no wall-clock scheduling. */
type Deferred<Value> = Readonly<{
  /** Promise observed by the behavior under test. */
  promise: Promise<Value>;

  /** Settles the promise through its one captured native resolver. */
  resolve(value: Value): void;
}>;

/**
 * Creates deterministic coordination without timers or polling.
 * @returns A retained promise and its exact settlement capability.
 */
function deferred<Value>(): Deferred<Value> {
  /** Captures the native resolver during promise construction. */
  let settle: ((value: Value) => void) | undefined;
  /** Retains settlement for the behavior or assertion that awaits it. */
  const promise = new Promise<Value>((resolve) => {
    settle = resolve;
  });
  return Object.freeze({
    promise,
    /**
     * Settles the retained promise once through native Promise semantics.
     * @param value - Exact value observed by waiters.
     */
    resolve(value) {
      settle?.(value);
    },
  });
}

/**
 * Drains one subscription after its source closes naturally.
 * @param source - Async values owned by a public Archer subscription.
 * @returns Every delivered value in exact iteration order.
 */
async function collect<Value>(source: AsyncIterable<Value>): Promise<readonly Value[]> {
  /** Accumulates only values yielded by the public async iterator. */
  const values: Value[] = [];
  /** Preserves the source's delivery order without introducing scheduling. */
  for await (const value of source) values.push(value);
  return Object.freeze(values);
}

/**
 * Returns successful steps that emit one recognizable progress update each.
 * @param executed - Mutable test-owned list that records real effect activation.
 * @returns Two production-reachable step implementations.
 */
function successfulSteps(executed: string[]): readonly JobStep[] {
  return Object.freeze([
    Object.freeze({
      name: 'inspect',
      /**
       * Executes the first effect and reports progress through its supplied capability.
       * @param context - Operation-owned abort and presentation capabilities.
       * @returns A promise settled after the synthetic report is accepted.
       */
      async execute(context: JobStepContext) {
        executed.push('inspect');
        context.report({ message: 'reading inputs', completedUnits: 1, totalUnits: 1 });
      },
    }),
    Object.freeze({
      name: 'compile',
      /**
       * Executes the successor only after the Program records inspect completion.
       * @param context - Operation-owned abort and presentation capabilities.
       * @returns A promise settled after the synthetic report is accepted.
       */
      async execute(context: JobStepContext) {
        executed.push('compile');
        context.report({ message: 'emitting output', completedUnits: 1, totalUnits: 1 });
      },
    }),
  ]);
}

/**
 * Attaches collectors before the immediately active run crosses its first microtask.
 * @param run - Living job whose public streams are under test.
 * @returns Retained collection promises for every ordered event plane.
 */
function observe(run: ReactiveJobRun) {
  /** Attaches durable replay before the first accepted fact. */
  const events = collect(run.events.subscribe({ capacityItems: 32 }));
  /** Attaches presentation delivery before the first progress update. */
  const updates = collect(run.updates.subscribe({ capacityItems: 32 }));
  /** Attaches diagnostics before the first terminal step span settles. */
  const diagnostics = collect(run.diagnostics.subscribe({ capacityItems: 32 }));
  return Object.freeze({ events, updates, diagnostics });
}

describe('reactive job runner', () => {
  it('keeps one hot run visible through completion and retained cleanup', async () => {
    /** Records exact application effect order independently of emitted facts. */
    const executed: string[] = [];
    /** Starts one admitted job during construction. */
    const run = createReactiveJobRun({ runId: RUN_ID, steps: successfulSteps(executed) });
    expect(run.state.getSnapshot()).toEqual({
      runId: RUN_ID,
      status: 'queued',
      steps: ['inspect', 'compile'],
      completedSteps: [],
    });
    expect('publish' in run.state).toBe(false);
    /** Observes each stream without creating another operation. */
    const observed = observe(run);

    expect(await run.result).toEqual({
      kind: 'completed',
      state: {
        runId: RUN_ID,
        status: 'completed',
        steps: ['inspect', 'compile'],
        completedSteps: ['inspect', 'compile'],
      },
    });
    expect(executed).toEqual(['inspect', 'compile']);
    expect(run.state.getSnapshot().status).toBe('completed');

    /** Starts cleanup once and proves retries share the retained promise. */
    const firstClose = run.close();
    expect(run.close()).toBe(firstClose);
    /** Retains exact cleanup evidence through both lifecycle access paths. */
    const closeEvidence = await firstClose;
    expect(await run.closed).toBe(closeEvidence);
    expect(closeEvidence).toMatchObject({ kind: 'closed', outcome: 'completed' });

    expect(await observed.events).toMatchObject([
      { value: { type: 'job.started' } },
      { value: { type: 'job.step.completed', step: 'inspect' } },
      { value: { type: 'job.step.completed', step: 'compile' } },
    ]);
    expect(await observed.updates).toEqual([
      { kind: 'event', value: { kind: 'step.started', step: 'inspect', position: 1, totalSteps: 2 } },
      {
        kind: 'event',
        value: {
          kind: 'step.progress',
          step: 'inspect',
          message: 'reading inputs',
          completedUnits: 1,
          totalUnits: 1,
        },
      },
      { kind: 'event', value: { kind: 'step.completed', step: 'inspect', position: 1, totalSteps: 2 } },
      { kind: 'event', value: { kind: 'step.started', step: 'compile', position: 2, totalSteps: 2 } },
      {
        kind: 'event',
        value: {
          kind: 'step.progress',
          step: 'compile',
          message: 'emitting output',
          completedUnits: 1,
          totalUnits: 1,
        },
      },
      { kind: 'event', value: { kind: 'step.completed', step: 'compile', position: 2, totalSteps: 2 } },
    ]);
    /** Narrows delivered diagnostics to ordinary records because no gap is expected. */
    const diagnostics = (await observed.diagnostics).map((delivery) => {
      if (delivery.kind !== 'event') throw new Error('Unexpected diagnostic gap');
      return {
        name: delivery.value.name,
        kind: delivery.value.kind,
        settlement: delivery.value.kind === 'span' ? delivery.value.settlement : undefined,
      };
    });
    expect(diagnostics).toEqual([
      {
        name: 'example.job.step',
        kind: 'span',
        settlement: { kind: 'completed', outcome: 'completed' },
      },
      {
        name: 'example.job.step',
        kind: 'span',
        settlement: { kind: 'completed', outcome: 'completed' },
      },
      {
        name: 'example.job.run',
        kind: 'span',
        settlement: { kind: 'completed', outcome: 'completed' },
      },
    ]);
  });

  it('turns one native step rejection into terminal public failure and skips later work', async () => {
    /** Records which real effect implementations obtained execution authority. */
    const executed: string[] = [];
    /** Supplies a valid first step, one failing step, and a successor that must not run. */
    const steps: readonly JobStep[] = Object.freeze([
      Object.freeze({
        name: 'inspect',
        /** Completes normally so the failure case reaches the intended second step. */
        async execute() {
          executed.push('inspect');
        },
      }),
      Object.freeze({
        name: 'compile',
        /** Rejects with private text that must not enter state or progress. */
        async execute() {
          executed.push('compile');
          throw new Error('private compiler path');
        },
      }),
      Object.freeze({
        name: 'verify',
        /** Would expose an orchestration defect if failure activated a successor. */
        async execute() {
          executed.push('verify');
        },
      }),
    ]);
    /** Starts one run whose second effect returns expected bounded failure. */
    const run = createReactiveJobRun({ runId: RUN_ID, steps });
    /** Observes failure facts and progress before the immediately active run advances. */
    const observed = observe(run);
    /** Settles with a tagged domain outcome rather than rejecting the result Promise. */
    const outcome = await run.result;

    expect(outcome).toMatchObject({
      kind: 'failed',
      state: {
        status: 'failed',
        completedSteps: ['inspect'],
        failedStep: 'compile',
        failure: {
          code: 'example_job_step_failed',
          message: 'The job step failed',
          retryable: false,
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('private');
    expect(executed).toEqual(['inspect', 'compile']);
    await run.close();
    expect(await observed.events).toMatchObject([
      { value: { type: 'job.started' } },
      { value: { type: 'job.step.completed', step: 'inspect' } },
      { value: { type: 'job.step.failed', step: 'compile' } },
    ]);
    expect(await observed.updates).toMatchObject([
      { value: { kind: 'step.started', step: 'inspect' } },
      { value: { kind: 'step.completed', step: 'inspect' } },
      { value: { kind: 'step.started', step: 'compile' } },
      { value: { kind: 'step.failed', step: 'compile', code: 'example_job_step_failed' } },
    ]);
    expect(JSON.stringify(await observed.diagnostics)).not.toContain('private');
  });

  it('keeps close passive and settles an idempotent abort only after the step observes it', async () => {
    /** Proves the effect obtained execution before the test sends abort. */
    const started = deferred<void>();
    /** Settles only when the injected AbortSignal fires. */
    const abortObserved = deferred<void>();
    /** Captures the real operation signal for close-versus-abort assertions. */
    let operationSignal: AbortSignal | undefined;
    /** Waits on explicit abort without a timer or scheduler race. */
    const step: JobStep = Object.freeze({
      name: 'wait-for-abort',
      /**
       * Blocks until the operation signal proves active termination was requested.
       * @param context - Operation-owned abort and presentation capabilities.
       * @returns A promise settled only after the real AbortSignal fires.
       */
      async execute(context: JobStepContext) {
        /** Captures the exact signal supplied to this admitted attempt. */
        const signal = context.signal;
        operationSignal = signal;
        /** Resolves the test barrier after signal ownership is installed. */
        started.resolve(undefined);
        if (signal.aborted) return;
        /** Resolves the step's deterministic wait from the native abort event. */
        function onAbort(): void {
          abortObserved.resolve(undefined);
        }
        signal.addEventListener('abort', onAbort, { once: true });
        await abortObserved.promise;
      },
    });
    /** Starts one operation that remains pending until explicit abort. */
    const run = createReactiveJobRun({ runId: RUN_ID, steps: [step] });
    /** Observes terminal progress before allowing the source to close. */
    const observed = observe(run);
    await started.promise;

    /** Requests passive ownership release while the active step is still running. */
    const close = run.close();
    await Promise.resolve();
    expect(operationSignal?.aborted).toBe(false);

    /** Sends one command and retries it by the same UUIDv4 identity. */
    const command = Object.freeze({ reason: 'operator stopped the example', idempotencyKey: createIdempotencyKey() });
    /** Retains terminal acknowledgement rather than signal-delivery timing. */
    const firstAbort = run.abort(command);
    expect(run.abort(command)).toBe(firstAbort);
    expect(operationSignal?.aborted).toBe(true);
    expect(await firstAbort).toEqual({
      kind: 'attempt-settled',
      outcome: 'aborted',
      idempotencyKey: command.idempotencyKey,
    });
    expect(await run.result).toMatchObject({
      kind: 'aborted',
      state: {
        status: 'aborted',
        activeStep: 'wait-for-abort',
        reason: 'operator stopped the example',
      },
    });
    expect(await close).toMatchObject({ kind: 'closed', outcome: 'aborted' });
    expect(await observed.events).toMatchObject([
      { value: { type: 'job.started' } },
      {
        value: {
          type: 'job.aborted',
          step: 'wait-for-abort',
          reason: 'operator stopped the example',
        },
      },
    ]);
    expect(await observed.updates).toMatchObject([
      { value: { kind: 'step.started', step: 'wait-for-abort' } },
      { value: { kind: 'job.aborted', step: 'wait-for-abort' } },
    ]);
  });
});
