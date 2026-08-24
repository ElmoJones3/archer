/**
 * @file Declares the living job contract assembled from public core entry points.
 *
 * The application shell executes only effect intents emitted by the pure job
 * Program. Core owns sharing, bounded delivery, abort, and diagnostic lifetime.
 */

import {
  ProtocolFailureSchema,
  PublicErrorSchema,
  createUuidV4,
  toPublicError,
  type DiagnosticRecord,
  type DiagnosticsCloseEvidence,
  type OwnedHandle,
  type ProtocolFailure,
  type UuidV4,
} from '@archer/core';
import { createDiagnostics } from '@archer/core/diagnostics';
import {
  asLiveState,
  asReplayableEventStream,
  createLiveState,
  liveOperation,
  replayableEventSource,
  type AttemptAbortCommand,
  type AttemptAbortDisposition,
  type AttemptAbortEvidence,
  type EventEncoding,
  type LiveState,
  type OperationSettlement,
  type ReplayableEventStream,
  type StreamCursor,
  type TransientEventStream,
} from '@archer/core/stream';

import {
  createJobDefinition,
  type AbortedJobState,
  type CompletedJobState,
  type FailedJobState,
  type JobEffect,
  type JobEvent,
  type JobState,
  type RunningJobState,
} from './domain.js';

/** One executor-owned progress observation with explicit units. */
export type JobStepReport = Readonly<{
  /** Describes useful current work for a human observer. */
  message: string;

  /** Counts finished units in the executor's chosen scale. */
  completedUnits: number;

  /** Counts total units in the same scale as `completedUnits`. */
  totalUnits: number;
}>;

/** Capabilities supplied to one configured step without exposing Archer publishers. */
export type JobStepContext = Readonly<{
  /** Carries explicit active termination from the living job. */
  signal: AbortSignal;

  /** Emits bounded presentation progress and enriches the active diagnostic span. */
  report(update: JobStepReport): void;
}>;

/** One application-owned effect implementation selected by the pure Program. */
export type JobStep = Readonly<{
  /** Matches one stable step identity in the job plan. */
  name: string;

  /** Executes only after the Program emits this step's effect intent. */
  execute(context: JobStepContext): Promise<void>;
}>;

/** Non-authoritative updates that may gap for a slow presentation subscriber. */
export type JobProgress =
  | Readonly<{
      /** Announces that the selected effect has begun executing. */
      kind: 'step.started';

      /** Names the active step. */
      step: string;

      /** Gives the one-based position in the immutable plan. */
      position: number;

      /** Gives the total number of configured steps. */
      totalSteps: number;
    }>
  | Readonly<{
      /** Carries executor-owned presentation progress. */
      kind: 'step.progress';

      /** Names the active step. */
      step: string;

      /** Describes useful current work for a human observer. */
      message: string;

      /** Counts finished units in the executor's chosen scale. */
      completedUnits: number;

      /** Counts total units in the same scale as `completedUnits`. */
      totalUnits: number;
    }>
  | Readonly<{
      /** Announces ordinary settlement of one configured step. */
      kind: 'step.completed';

      /** Names the completed step. */
      step: string;

      /** Gives the one-based position in the immutable plan. */
      position: number;

      /** Gives the total number of configured steps. */
      totalSteps: number;
    }>
  | Readonly<{
      /** Announces bounded failure of one configured step. */
      kind: 'step.failed';

      /** Names the failed step. */
      step: string;

      /** Carries the stable public failure category only. */
      code: string;
    }>
  | Readonly<{
      /** Announces that the active effect observed explicit abort. */
      kind: 'job.aborted';

      /** Names the step active at abort observation. */
      step: string;
    }>;

/** The one tagged terminal domain result of a living job. */
export type JobOutcome =
  | Readonly<{
      /** Confirms every planned step completed in order. */
      kind: 'completed';

      /** Retains terminal success by identity for later reads. */
      state: CompletedJobState;
    }>
  | Readonly<{
      /** Confirms one active step returned a bounded failure. */
      kind: 'failed';

      /** Retains terminal failure by identity for later reads. */
      state: FailedJobState;
    }>
  | Readonly<{
      /** Confirms the active effect observed explicit abort. */
      kind: 'aborted';

      /** Retains terminal abort by identity for later reads. */
      state: AbortedJobState;
    }>;

/** Evidence retained after the job and every source it owns have closed. */
export type JobRunCloseEvidence = Readonly<{
  /** Confirms the example released all process-local ownership. */
  kind: 'closed';

  /** Names the terminal operation result or an unexpected protocol failure. */
  outcome: JobOutcome['kind'] | 'protocol-failed';

  /** Carries bounded failure only when the operation violated its tagged-result contract. */
  failure?: ProtocolFailure;

  /** Proves the owned diagnostic hub finished its own shutdown. */
  diagnostics: DiagnosticsCloseEvidence;
}>;

/** A process-local living owner assembled only from public core contracts. */
export interface ReactiveJobRun extends OwnedHandle<JobRunCloseEvidence> {
  /** Correlates every public observation belonging to this run. */
  readonly runId: UuidV4;

  /** Exposes the latest immutable state without publication authority. */
  readonly state: LiveState<JobState>;

  /** Replays accepted process-local facts through source-branded cursors. */
  readonly events: ReplayableEventStream<JobEvent, StreamCursor<'example-job'>>;

  /** Exposes bounded transient presentation without starting another run. */
  readonly updates: TransientEventStream<JobProgress>;

  /** Exposes terminal wide records and point diagnostics as a separate plane. */
  readonly diagnostics: TransientEventStream<DiagnosticRecord>;

  /** Settles once after progress acceptance stops. */
  readonly result: Promise<JobOutcome>;

  /** Requests active termination without aliasing observation or owner close. */
  abort(command: AttemptAbortCommand): Promise<AttemptAbortEvidence>;
}

/** Construction input for one immediately active process-local job. */
export type ReactiveJobRunOptions = Readonly<{
  /** Supplies the immutable ordered plan and each effect implementation. */
  steps: readonly JobStep[];

  /** Overrides source identity for deterministic examples and tests. */
  runId?: UuidV4;
}>;

/** The operation-only evidence wrapped by whole-job cleanup evidence. */
type JobOperationCloseEvidence =
  | Readonly<{
      /** Confirms the application returned one tagged job outcome. */
      kind: 'operation-settled';

      /** Retains only the terminal outcome category for cleanup reporting. */
      outcome: JobOutcome['kind'];
    }>
  | Readonly<{
      /** Reports that the application violated the tagged-result protocol. */
      kind: 'operation-failed';

      /** Carries bounded protocol evidence without native Error identity. */
      failure: ProtocolFailure;
    }>;

/** UTF-8 encoder shared by source-owned canonical JSON measurement. */
const JSON_ENCODER = new TextEncoder();

/**
 * Measures one already-normalized JSON-compatible event.
 * @param event - Frozen job fact or progress record owned by its source.
 * @returns Safe integer UTF-8 bytes charged to queue and retention limits.
 */
function measureEvent(event: JobEvent | JobProgress): number {
  return JSON_ENCODER.encode(JSON.stringify(event)).byteLength;
}

/**
 * Copies one accepted job fact before replay retention owns it.
 * @param event - Domain fact published by the application shell.
 * @returns A frozen event with separately normalized public failure data.
 */
function normalizeJobEvent(event: JobEvent): JobEvent {
  if (event.type === 'job.started') return Object.freeze({ type: 'job.started' });
  if (event.type === 'job.step.completed') {
    return Object.freeze({ type: 'job.step.completed', step: event.step });
  }
  if (event.type === 'job.step.failed') {
    return Object.freeze({
      type: 'job.step.failed',
      step: event.step,
      failure: PublicErrorSchema.parse(event.failure),
    });
  }
  return Object.freeze({ type: 'job.aborted', step: event.step, reason: event.reason });
}

/**
 * Copies one presentation update so a step cannot mutate queued observations.
 * @param update - Progress proposed by the application shell.
 * @returns A frozen source-owned update preserving its discriminated shape.
 */
function normalizeJobProgress(update: JobProgress): JobProgress {
  if (update.kind === 'step.started' || update.kind === 'step.completed') {
    return Object.freeze({
      kind: update.kind,
      step: update.step,
      position: update.position,
      totalSteps: update.totalSteps,
    });
  }
  if (update.kind === 'step.progress') {
    return Object.freeze({
      kind: update.kind,
      step: update.step,
      message: update.message,
      completedUnits: update.completedUnits,
      totalUnits: update.totalUnits,
    });
  }
  if (update.kind === 'step.failed') {
    return Object.freeze({ kind: update.kind, step: update.step, code: update.code });
  }
  return Object.freeze({ kind: update.kind, step: update.step });
}

/** Replay retention and cursor identity bind to this exact job-event revision. */
const JOB_EVENT_ENCODING: EventEncoding<JobEvent> = Object.freeze({
  revision: 'example-job-event/1',
  normalize: normalizeJobEvent,
  measure: measureEvent,
});

/** Transient progress queues bind byte accounting to this exact revision. */
const JOB_PROGRESS_ENCODING: EventEncoding<JobProgress> = Object.freeze({
  revision: 'example-job-progress/1',
  normalize: normalizeJobProgress,
  measure: measureEvent,
});

/**
 * Rejects malformed progress before it can fail diagnostic or queue accounting.
 * @param report - Progress supplied by one configured effect implementation.
 * @returns A frozen progress payload safe for diagnostics and presentation.
 */
function admitStepReport(report: JobStepReport): JobStepReport {
  if (report.message.length === 0 || report.message.length > 256) {
    throw new RangeError('Job progress messages must contain 1 to 256 characters');
  }
  if (
    !Number.isSafeInteger(report.completedUnits) ||
    !Number.isSafeInteger(report.totalUnits) ||
    report.completedUnits < 0 ||
    report.totalUnits <= 0 ||
    report.completedUnits > report.totalUnits
  ) {
    throw new RangeError('Job progress units must be safe integers within a positive total');
  }
  return Object.freeze({ ...report });
}

/**
 * Converts the operation signal's untrusted reason into bounded domain context.
 * @param signal - Active operation signal after abort observation.
 * @returns A non-empty reason no longer than the diagnostic contract permits.
 */
function abortReason(signal: AbortSignal): string {
  /** Preserves string command context while rejecting arbitrary native values. */
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : '';
  return reason.length === 0 ? 'abort requested' : reason.slice(0, 256);
}

/**
 * Maps terminal job settlement into the abort command's required evidence.
 * @param settlement - Tagged job result or unexpected operation rejection.
 * @returns Terminal abort classification without observing signal timing alone.
 */
function classifyAbort(settlement: OperationSettlement<JobOutcome>): AttemptAbortDisposition {
  if (settlement.kind === 'failed') {
    return Object.freeze({ kind: 'cleanup-unproved', failure: settlement.error });
  }
  return Object.freeze({
    kind: 'attempt-settled',
    outcome: settlement.value.kind === 'aborted' ? 'aborted' : 'completed',
  });
}

/**
 * Maps one operation settlement into retained evidence for the composing owner.
 * @param settlement - Tagged domain result or redacted operation rejection.
 * @returns Immutable operation-only evidence used during whole-run close.
 */
function jobOperationCloseEvidence(settlement: OperationSettlement<JobOutcome>): JobOperationCloseEvidence {
  if (settlement.kind === 'result') {
    return Object.freeze({ kind: 'operation-settled', outcome: settlement.value.kind });
  }
  return Object.freeze({
    kind: 'operation-failed',
    failure: ProtocolFailureSchema.parse({ kind: 'protocol-failure', ...settlement.error }),
  });
}

/**
 * Copies effect implementations and rejects a plan that cannot match the Program.
 * @param steps - Caller-owned ordered effect implementations.
 * @returns Frozen step objects and array retaining the original functions.
 */
function admitStepImplementations(steps: readonly JobStep[]): readonly JobStep[] {
  /** Copies each declaration so later property mutation cannot redirect execution. */
  const admitted: JobStep[] = [];
  /** Retains declared order because the Program uses the same names as its plan. */
  for (const step of steps) admitted.push(Object.freeze({ name: step.name, execute: step.execute }));
  return Object.freeze(admitted);
}

/**
 * Finds the implementation selected by one already-admitted effect intent.
 * @param steps - Frozen application implementations in plan order.
 * @param effect - Pure Program intent containing no executable callback.
 * @returns The exact matching implementation.
 */
function implementationFor(steps: readonly JobStep[], effect: JobEffect): JobStep {
  /** Searches a small declared plan without creating a second identity map. */
  for (const step of steps) if (step.name === effect.payload.step) return step;
  throw new Error(`The Program selected an unknown job step: ${effect.payload.step}`);
}

/**
 * Narrows current state to the running state that emitted one effect intent.
 * @param state - State published immediately before effect activation.
 * @param step - Step selected by the Program effect.
 * @returns Exact running state for step position and diagnostics.
 */
function activeState(state: JobState, step: string): RunningJobState {
  if (state.status !== 'running' || state.activeStep !== step) {
    throw new Error(`The Program emitted ${step} without matching running state`);
  }
  return state;
}

/**
 * Creates one immediately active process-local job from public core contracts.
 * @param options - Ordered effect implementations and optional deterministic ID.
 * @returns A hot retained owner whose close path never aliases active abort.
 */
export function createReactiveJobRun(options: ReactiveJobRunOptions): ReactiveJobRun {
  /** Copies callbacks before asynchronous activation can observe caller mutation. */
  const steps = admitStepImplementations(options.steps);
  /** Uses a caller-supplied UUIDv4 only when deterministic identity matters. */
  const runId = options.runId ?? createUuidV4();
  /** Validates names once and binds them to the pure transition owner. */
  const definition = createJobDefinition(
    runId,
    steps.map(
      /**
       * Extracts application step identity without retaining its object.
       * @param step - Frozen effect implementation admitted by the shell.
       * @returns Stable name shared with the pure job definition.
       */
      (step) => step.name,
    ),
  );
  /** Owns wide spans and the separately observable diagnostic plane. */
  const diagnosticHub = createDiagnostics();
  /** Owns the one hot current-state graph hidden behind a read-only facade. */
  const stateSource = createLiveState<JobState>(definition.initialState, {
    /**
     * Converts listener bugs into non-authoritative point diagnostics.
     * @param error - Isolated callback failure hidden from state publication.
     */
    onListenerError(error) {
      diagnosticHub.event({
        name: 'example.job.listener.failed',
        severity: 'error',
        component: 'examples.core.documentation-indexer',
        correlation: {},
        attributes: { runId },
        error: toPublicError(error, {
          code: 'example_job_listener_failed',
          message: 'A job state listener failed',
        }),
      });
    },
  });
  /** Owns bounded in-memory replay without claiming crash durability. */
  const eventSource = replayableEventSource<JobEvent>()({
    source: 'example-job',
    streamId: runId,
    scope: 'process-local-example',
    epoch: runId,
    retentionItems: 128,
    eventEncoding: JOB_EVENT_ENCODING,
  });
  /** Retains the latest state synchronously for pure Program reduction. */
  let currentState: JobState = definition.initialState;

  /**
   * Applies one accepted fact, publishes current state first, then records history.
   * @param event - Fact earned by observed application behavior.
   * @returns Ordered effect intents forced by the pure decision.
   */
  function admit(event: JobEvent): readonly JobEffect[] {
    /** Computes the complete decision before mutating either live source. */
    const decision = definition.program.reduce(currentState, event);
    currentState = decision.state;
    stateSource.publish(currentState);
    eventSource.publish(event);
    return decision.effects;
  }

  /** Owns the finite activation and its distinct progress, result, and abort contracts. */
  const operation = liveOperation<JobProgress>()({
    source: 'example-job-progress',
    epoch: runId,
    eventEncoding: JOB_PROGRESS_ENCODING,
    /**
     * Executes only Program-emitted effects and returns one tagged job outcome.
     * @param context - Core-owned progress publisher and active abort signal.
     * @returns Terminal state after success, bounded failure, or abort observation.
     */
    async start(context): Promise<JobOutcome> {
      /** Publishes bounded transient progress into the operation-owned graph. */
      const emit = context.emit;
      /** Carries active termination separately from retained handle close. */
      const signal = context.signal;
      /** Lets same-turn callers attach to the already-created hot owner. */
      await Promise.resolve();
      /** Accumulates run-wide context until one terminal outcome is known. */
      const runSpan = diagnosticHub.beginSpan({
        name: 'example.job.run',
        component: 'examples.core.documentation-indexer',
        correlation: {},
        attributes: { job: { runId, steps: definition.steps } },
      });
      /** Starts the job and obtains the first application effect. */
      let effects = admit(Object.freeze({ type: 'job.started' }));

      /** Executes each successor only after the preceding terminal fact is admitted. */
      while (effects.length > 0) {
        /** The Program emits exactly one active step effect in this domain. */
        const effect = effects[0];
        if (effect === undefined) throw new Error('The job Program emitted an empty effect batch');
        /** Selects the application callback named by replayable effect data. */
        const implementation = implementationFor(steps, effect);
        /** Captures position from already-published running state. */
        const running = activeState(currentState, implementation.name);
        /** Calculates stable one-based presentation position. */
        const position = running.completedSteps.length + 1;
        /** Observes one concrete effect from activation through terminal settlement. */
        const stepSpan = diagnosticHub.beginSpan({
          name: 'example.job.step',
          component: 'examples.core.documentation-indexer',
          parentSpanId: runSpan.spanId,
          correlation: {},
          attributes: {
            job: { runId },
            step: { name: implementation.name, position, totalSteps: steps.length },
          },
        });
        emit(
          Object.freeze({
            kind: 'step.started',
            step: implementation.name,
            position,
            totalSteps: steps.length,
          }),
        );

        try {
          await implementation.execute({
            signal,
            /**
             * Publishes presentation and retains only the latest step context.
             * @param proposed - Executor-owned message and units.
             */
            report(proposed) {
              /** Validates before diagnostics or queue admission can diverge. */
              const report = admitStepReport(proposed);
              stepSpan.enrich('progress', {
                message: report.message,
                completedUnits: report.completedUnits,
                totalUnits: report.totalUnits,
              });
              emit(
                Object.freeze({
                  kind: 'step.progress',
                  step: implementation.name,
                  ...report,
                }),
              );
            },
          });
        } catch (error) {
          if (signal.aborted) {
            /** Uses the accepted command reason only after active work observes abort. */
            const reason = abortReason(signal);
            stepSpan.abandon({ reason: 'abort observed' });
            runSpan.enrich('result', { status: 'aborted', activeStep: implementation.name });
            runSpan.abandon({ reason });
            admit(Object.freeze({ type: 'job.aborted', step: implementation.name, reason }));
            emit(Object.freeze({ kind: 'job.aborted', step: implementation.name }));
            if (currentState.status !== 'aborted') throw new Error('Abort fact did not earn terminal state');
            return Object.freeze({ kind: 'aborted', state: currentState });
          }
          /** Redacts native executor data before state, events, diagnostics, or progress. */
          const failure = toPublicError(error, {
            code: 'example_job_step_failed',
            message: 'The job step failed',
          });
          stepSpan.fail({ outcome: 'failed', error: failure });
          runSpan.enrich('result', { status: 'failed', failedStep: implementation.name });
          runSpan.fail({ outcome: 'failed', error: failure });
          admit(Object.freeze({ type: 'job.step.failed', step: implementation.name, failure }));
          emit(Object.freeze({ kind: 'step.failed', step: implementation.name, code: failure.code }));
          if (currentState.status !== 'failed') throw new Error('Failure fact did not earn terminal state');
          return Object.freeze({ kind: 'failed', state: currentState });
        }

        if (signal.aborted) {
          /** Uses the accepted command reason only after active work returns to the shell. */
          const reason = abortReason(signal);
          stepSpan.abandon({ reason: 'abort observed' });
          runSpan.enrich('result', { status: 'aborted', activeStep: implementation.name });
          runSpan.abandon({ reason });
          admit(Object.freeze({ type: 'job.aborted', step: implementation.name, reason }));
          emit(Object.freeze({ kind: 'job.aborted', step: implementation.name }));
          if (currentState.status !== 'aborted') throw new Error('Abort fact did not earn terminal state');
          return Object.freeze({ kind: 'aborted', state: currentState });
        }

        stepSpan.enrich('result', { status: 'completed' });
        stepSpan.complete({ outcome: 'completed' });
        effects = admit(Object.freeze({ type: 'job.step.completed', step: implementation.name }));
        emit(
          Object.freeze({
            kind: 'step.completed',
            step: implementation.name,
            position,
            totalSteps: steps.length,
          }),
        );
      }

      if (currentState.status !== 'completed') throw new Error('The job exhausted effects without terminal success');
      runSpan.enrich('result', { status: 'completed', completedSteps: currentState.completedSteps.length });
      runSpan.complete({ outcome: 'completed' });
      return Object.freeze({ kind: 'completed', state: currentState });
    },
    classifyAbort,
    closeEvidence: jobOperationCloseEvidence,
    failure: {
      code: 'example_job_protocol_failed',
      message: 'The reactive job violated its operation protocol',
    },
  });

  /** Retains one idempotent whole-owner close promise. */
  let closePromise: Promise<JobRunCloseEvidence> | undefined;
  /** Resolves the public `closed` observation after every owned source closes. */
  let settleClosed: ((evidence: JobRunCloseEvidence) => void) | undefined;
  /** Rejects the public `closed` observation with the exact cleanup failure. */
  let rejectClosed: ((error: unknown) => void) | undefined;
  /** Exposes lifecycle observation before caller-initiated close begins. */
  const closed = new Promise<JobRunCloseEvidence>((resolve, reject) => {
    settleClosed = resolve;
    rejectClosed = reject;
  });

  /** Constructs the living facade without source publication capabilities. */
  const run: ReactiveJobRun = {
    runId,
    state: asLiveState(stateSource),
    events: asReplayableEventStream(eventSource),
    updates: operation.events,
    diagnostics: diagnosticHub.events,
    result: operation.result,
    closed,
    /**
     * Delegates active termination to the finite operation unchanged.
     * @param command - Explicit reason and UUIDv4 idempotency identity.
     * @returns Terminal attempt evidence after work and cleanup settle.
     */
    abort(command) {
      return operation.abort(command);
    },
    /**
     * Waits for result without aborting, then closes every owned observation source.
     * @returns Shared whole-run cleanup evidence.
     */
    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        /** Waits for one operation result and obtains its redacted close mapping. */
        const operationEvidence = await operation.close();
        /** Completes replay before state so accepted facts can drain first. */
        await eventSource.close();
        /** Completes current-state observation at its terminal retained snapshot. */
        await stateSource.close();
        /** Flushes and closes diagnostics only after all work-owned spans settle. */
        const diagnostics = await diagnosticHub.close();
        return Object.freeze(
          operationEvidence.kind === 'operation-settled'
            ? { kind: 'closed', outcome: operationEvidence.outcome, diagnostics }
            : {
                kind: 'closed',
                outcome: 'protocol-failed',
                failure: operationEvidence.failure,
                diagnostics,
              },
        );
      })();
      /**
       * Settles the retained lifecycle with the exact shared evidence object.
       * @param evidence - Whole-run close evidence returned by the shared operation.
       */
      function resolveClosed(evidence: JobRunCloseEvidence): void {
        settleClosed?.(evidence);
      }
      /**
       * Retains the exact cleanup rejection for observers of `closed`.
       * @param error - Cleanup failure thrown by an owned component.
       */
      function refuseClosed(error: unknown): void {
        rejectClosed?.(error);
      }
      void closePromise.then(resolveClosed, refuseClosed);
      return closePromise;
    },
    /** Delegates language-level disposal to passive whole-run close. */
    async [Symbol.asyncDispose]() {
      await run.close();
    },
  };

  return Object.freeze(run);
}
