/**
 * @file Runs the core example as a deterministic terminal application.
 *
 * Terminal output is a presentation subscriber over public Archer contracts.
 * The job itself records operational context only through Diagnostics.
 */

import { createReactiveJobRun, type JobStep, type JobStepContext } from './job.js';
import type { JobState } from './domain.js';

/** Prefixes each JSON value with its public observation plane. */
type OutputChannel = 'state' | 'event' | 'update' | 'diagnostic' | 'result' | 'close';

/**
 * Writes one newline-delimited presentation value without acting as domain logging.
 * @param channel - Public observation plane that produced the value.
 * @param value - Immutable public data safe for JSON presentation.
 */
function writeLine(channel: OutputChannel, value: unknown): void {
  process.stdout.write(`${channel} ${JSON.stringify(value)}\n`);
}

/**
 * Drains a public stream until its owner closes and presents every delivery.
 * @param channel - Output label identifying the observed stream.
 * @param stream - Independent bounded subscription owned by this CLI.
 */
async function presentStream(
  channel: 'event' | 'update' | 'diagnostic',
  stream: AsyncIterable<unknown>,
): Promise<void> {
  /** Preserves source delivery order while keeping terminal rendering outside domain work. */
  for await (const delivery of stream) writeLine(channel, delivery);
}

/** Two deterministic effect implementations used by the copy-paste example. */
const steps: readonly JobStep[] = Object.freeze([
  Object.freeze({
    name: 'inspect',
    /**
     * Reads two synthetic inputs and reports progress without I/O or delay.
     * @param context - Operation-owned abort and presentation capabilities.
     * @returns A promise settled after both synthetic inputs are inspected.
     */
    async execute(context: JobStepContext) {
      context.report({ message: 'reading input one', completedUnits: 1, totalUnits: 2 });
      await Promise.resolve();
      context.report({ message: 'reading input two', completedUnits: 2, totalUnits: 2 });
    },
  }),
  Object.freeze({
    name: 'compile',
    /**
     * Emits one synthetic output after yielding to the existing operation graph.
     * @param context - Operation-owned abort and presentation capabilities.
     * @returns A promise settled after the output progress is published.
     */
    async execute(context: JobStepContext) {
      await Promise.resolve();
      context.report({ message: 'emitting output', completedUnits: 1, totalUnits: 1 });
    },
  }),
]);

/** Starts one hot job immediately and retains it until explicit cleanup. */
const run = createReactiveJobRun({ steps });
writeLine('state', run.state.getSnapshot());

/** Presents future current-state replacements without acquiring publication authority. */
const unsubscribeState = run.state.subscribe(
  /**
   * Presents each deferred current snapshot produced by the shared hot graph.
   * @param state - Latest immutable job snapshot.
   * @returns Nothing after writing one presentation line.
   */
  (state: JobState) => writeLine('state', state),
);
/** Attaches durable history before the first microtask admits job start. */
const eventSubscription = run.events.subscribe({ capacityItems: 32 });
/** Attaches transient progress before the first effect begins. */
const updateSubscription = run.updates.subscribe({ capacityItems: 32 });
/** Attaches diagnostic observation before the first step span settles. */
const diagnosticSubscription = run.diagnostics.subscribe({ capacityItems: 32 });
/** Drains accepted facts independently of result settlement. */
const presentingEvents = presentStream('event', eventSubscription);
/** Drains presentation progress, including any explicit gap evidence. */
const presentingUpdates = presentStream('update', updateSubscription);
/** Drains terminal wide records, including any explicit gap evidence. */
const presentingDiagnostics = presentStream('diagnostic', diagnosticSubscription);

/** Waits for the tagged result without reducing the running owner to a Promise API. */
const outcome = await run.result;
writeLine('result', outcome);
/** Releases every source only after the active job has already settled. */
const closeEvidence = await run.close();
/** Waits for each accepted value to drain after its source completes. */
await Promise.all([presentingEvents, presentingUpdates, presentingDiagnostics]);
unsubscribeState();
writeLine('close', closeEvidence);
