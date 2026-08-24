/**
 * @file Runs the documentation indexer and presents its living public streams.
 *
 * Stream rendering belongs to this CLI. The job reports operational context
 * through its diagnostics plane and never writes presentation lines itself.
 */

import { resolve } from 'node:path';

import type { DiagnosticRecord } from '@archer/core';

import { createDocumentationIndexRun } from './indexer.js';
import type { JobProgress } from './job.js';

/** Nested pnpm scripts may preserve their conventional argument separator. */
const cliArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
/** Relative paths belong to the shell that invoked pnpm, not the filtered package directory. */
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
/** The first positional argument selects a real documentation directory. */
const sourceArgument = cliArguments[0];
/** The second positional argument selects the generated JSON file. */
const outputArgument = cliArguments[1];
if (sourceArgument === undefined || outputArgument === undefined) {
  throw new TypeError('Usage: pnpm example:core -- <documentation-directory> <output-file>');
}
/** Both physical paths retain the caller's original working-directory meaning. */
const sourceDirectory = resolve(invocationDirectory, sourceArgument);
/** Output resolution follows the same rule as source traversal. */
const outputFile = resolve(invocationDirectory, outputArgument);

/** The hot run begins immediately and remains inspectable until explicit cleanup. */
const run = createDocumentationIndexRun({ sourceDirectory, outputFile });
/** Progress subscription keeps slow presentation isolated from application state. */
const progress = run.updates.subscribe({ capacityItems: 64 });
/** Diagnostics remain a distinct operational plane even in this small CLI. */
const diagnostics = run.diagnostics.subscribe({ capacityItems: 64 });

/** Presents bounded progress on stderr while stdout remains available to shell consumers. */
const presentingProgress = (async () => {
  /** The CLI renders both ordinary progress and explicit loss evidence from its bounded subscriber. */
  for await (const delivery of progress) {
    if (delivery.kind === 'gap') {
      process.stderr.write(`progress gap: ${delivery.lostItems} updates lost\n`);
      continue;
    }
    /** The example controls presentation text, not the underlying job contract. */
    const update: JobProgress = delivery.value;
    if (update.kind === 'step.progress') process.stderr.write(`${update.message}\n`);
  }
})();
/** Presents terminal wide records without creating a second logging path inside the job. */
const presentingDiagnostics = (async () => {
  /** Operational presentation never mistakes a delivery gap for a diagnostic record. */
  for await (const delivery of diagnostics) {
    if (delivery.kind === 'gap') {
      process.stderr.write(`diagnostic gap: ${delivery.lostItems} records lost\n`);
      continue;
    }
    /** The CLI chooses compact JSON while retained records stay product-neutral. */
    const record: DiagnosticRecord = delivery.value;
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }
})();

/** Terminal result determines process success while the run remains a living object. */
const outcome = await run.result;
await run.close();
await Promise.all([presentingProgress, presentingDiagnostics]);

if (outcome.kind === 'completed') {
  process.stdout.write(`${outputFile}\n`);
} else {
  process.stderr.write(`${outcome.state.status}\n`);
  process.exitCode = 1;
}
