/** @file Runs the directory fingerprint application for a caller-selected directory. */

import { resolve } from 'node:path';

import { fingerprintDirectory } from './fingerprint.js';

/** Nested pnpm scripts may preserve their conventional argument separator. */
const cliArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
/** The first positional argument is the directory whose contents define identity. */
const sourceArgument = cliArguments[0];
if (sourceArgument === undefined) {
  throw new TypeError('Usage: pnpm example:files:fingerprint -- <directory>');
}
/** Relative input retains the shell caller's working-directory meaning across pnpm filtering. */
const sourceDirectory = resolve(process.env.INIT_CWD ?? process.cwd(), sourceArgument);

/** The application emits a reusable cache-key value rather than contract-test evidence. */
const fingerprint = await fingerprintDirectory(sourceDirectory);
process.stdout.write(`${JSON.stringify(fingerprint, null, 2)}\n`);
