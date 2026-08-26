/** @file Configures OpenAI and runs the customer-support playbook application. */

import { resolve } from 'node:path';

import { openai } from '@ai-sdk/openai';
import { memoryFileStore } from '@archer/files';
import { bindOpenAIAiSdkModel, createAiSdkModelRouter } from '@archer/models/ai-sdk';

import { createSupportPlaybook } from './application.js';

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) throw new Error('Set OPENAI_API_KEY before running this example');
const ticket = process.argv.slice(2).join(' ').trim();
if (ticket.length === 0) {
  throw new TypeError(
    'Usage: pnpm example:resources:support -- "Where is order A-42? Latest scan: shipped yesterday."',
  );
}
const modelName = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';
const binding = bindOpenAIAiSdkModel({
  sdkModel: openai(modelName),
  name: 'OpenAI support model',
  maxOutputTokens: 1_200,
});
const router = createAiSdkModelRouter({ models: [binding] });
const files = memoryFileStore();
try {
  const playbook = await createSupportPlaybook({
    files,
    model: binding.target,
    router,
    skillDirectory: resolve(import.meta.dirname, '../skills/order-support'),
    promptFile: resolve(import.meta.dirname, '../prompts/support.md'),
    company: 'Northstar Outfitters',
  });
  process.stdout.write('Reply: ');
  const result = await playbook.answer({
    ticket,
    onUpdate: (update) => {
      if (update.type === 'text-delta') process.stdout.write(update.text);
      else
        process.stderr.write(`\nLive reply missed ${update.lostUpdates} updates; waiting for the complete answer.\n`);
    },
  });
  if (!result.liveUpdatesComplete) process.stdout.write(`\nComplete reply: ${result.reply}`);
  process.stdout.write('\n\n');
  process.stdout.write(
    `${JSON.stringify(
      {
        revisions: result.revisions,
        effectiveLimits: { outputTokens: result.outputTokens, deadline: result.deadline ?? 'none' },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await router.close();
  await files.close();
}
