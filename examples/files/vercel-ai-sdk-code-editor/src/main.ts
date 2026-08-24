/** @file Runs an OpenAI-backed code editor against a private copy of a host project. */

import { resolve } from 'node:path';

import { openai } from '@ai-sdk/openai';

import { runCodeEditor } from './agent.js';
import { readProject } from './project.js';

/** Nested pnpm scripts may preserve their conventional argument separator. */
const cliArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
/** The first argument selects the project copied into private immutable storage. */
const projectArgument = cliArguments[0];
/** Remaining arguments preserve the caller's natural-language task spacing. */
const task = cliArguments.slice(1).join(' ').trim();
if (projectArgument === undefined || task.length === 0) {
  throw new TypeError('Usage: pnpm example:files:code-editor -- <project-directory> <task>');
}
/** OpenAI's provider reads this server-side secret from the process environment. */
const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) throw new Error('Set OPENAI_API_KEY before running this example');
/** Relative input retains the shell caller's working-directory meaning across pnpm filtering. */
const projectDirectory = resolve(process.env.INIT_CWD ?? process.cwd(), projectArgument);

/** GPT-5.6 Luna keeps a first run inexpensive while allowing an explicit override. */
const modelName = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';
/** Host files are read once, then the model sees only logical project-file tools. */
const project = await readProject(projectDirectory);
/** Preflight disclosure names every host file whose content the selected model may read. */
process.stderr.write(
  `Files available to the model (${project.length}):\n${project.map((file) => `- ${file.path}`).join('\n')}\n`,
);
/** ToolLoopAgent performs the real provider and tool-dispatch workflow. */
const result = await runCodeEditor({ model: openai(modelName), project, task });

process.stdout.write(`${result.response}\n\n`);
process.stdout.write(
  `${JSON.stringify({ files: result.files, review: result.review, evidence: result.changes }, null, 2)}\n`,
);
