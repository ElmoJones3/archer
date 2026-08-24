/** @file Runs an OpenAI-backed agent with notes retained in a local immutable store. */

import { resolve } from 'node:path';

import { openai } from '@ai-sdk/openai';

import { fileTreeStore } from '@archer/files/fs';

import { runNotebookAgent } from './agent.js';

/** Nested pnpm scripts may preserve their conventional argument separator. */
const cliArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
/** The first argument selects durable local storage for checkpoint content. */
const storeArgument = cliArguments[0];
/** Remaining arguments preserve the caller's task spacing. */
const task = cliArguments.slice(1).join(' ').trim();
if (storeArgument === undefined || task.length === 0) {
  throw new TypeError('Usage: pnpm example:files:notebook -- <store-directory> <task>');
}
/** OpenAI's provider reads this server-side secret from the process environment. */
const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) throw new Error('Set OPENAI_API_KEY before running this example');
/** Relative storage retains the shell caller's working-directory meaning across pnpm filtering. */
const storeRoot = resolve(process.env.INIT_CWD ?? process.cwd(), storeArgument);

/** GPT-5.6 Luna keeps a first run inexpensive while allowing an explicit override. */
const modelName = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';
/** Filesystem storage retains immutable checkpoint bytes after this process exits. */
const opened = await fileTreeStore({ root: storeRoot });
if (!opened.ok) throw opened.error;
/** The host application owns storage independently from the process-local Scratchpad. */
const store = opened.value;
try {
  /** ToolLoopAgent performs the real provider and notebook-tool workflow. */
  const result = await runNotebookAgent({ model: openai(modelName), store, task });
  process.stdout.write(`${result.response}\n\n`);
  process.stdout.write(
    `${JSON.stringify({ notes: result.notes, checkpoint: result.checkpoint, disposition: result.disposition }, null, 2)}\n`,
  );
  if (result.checkpoint === undefined) process.exitCode = 2;
} finally {
  await store.close();
}
