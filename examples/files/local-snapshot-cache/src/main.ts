/** @file Provides save, list, and read commands for the local snapshot cache. */

import { resolve } from 'node:path';

import { listSnapshot, readSnapshotFile, saveSnapshot } from './cache.js';

/** Nested pnpm scripts may preserve their conventional argument separator. */
const cliArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
/** Host paths remain relative to the shell caller rather than the filtered package. */
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
/** The first positional argument selects one application command. */
const command = cliArguments[0];
/** The cache root keeps mutable names separate from immutable objects. */
const cacheArgument = cliArguments[1];
/** The snapshot alias selects one immutable root. */
const name = cliArguments[2];

if (cacheArgument === undefined || name === undefined) {
  throw new TypeError(
    'Usage: pnpm example:files:cache -- save <cache> <name> <directory> | list <cache> <name> | read <cache> <name> <path>',
  );
}
/** Every command addresses the same caller-relative cache location. */
const cacheRoot = resolve(invocationDirectory, cacheArgument);

if (command === 'save') {
  /** The final argument selects the mutable directory captured by this command. */
  const sourceArgument = cliArguments[3];
  if (sourceArgument === undefined) throw new TypeError('The save command requires a source directory');
  /** Source resolution uses the same original invocation directory as the cache. */
  const sourceDirectory = resolve(invocationDirectory, sourceArgument);
  /** The receipt is useful application output that can enter deployment metadata. */
  const saved = await saveSnapshot({ cacheRoot, name, sourceDirectory });
  process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
} else if (command === 'list') {
  /** Each path is ordinary logical application output suitable for shell pipelines. */
  const files = await listSnapshot({ cacheRoot, name });
  process.stdout.write(`${files.join('\n')}\n`);
} else if (command === 'read') {
  /** The final argument names one logical file inside the immutable root. */
  const path = cliArguments[3];
  if (path === undefined) throw new TypeError('The read command requires a logical file path');
  /** Verified bytes are written unchanged so text and binary files both remain useful. */
  const content = await readSnapshotFile({ cacheRoot, name, path });
  process.stdout.write(content);
} else {
  throw new TypeError(`Unknown snapshot-cache command: ${command ?? '<missing>'}`);
}
