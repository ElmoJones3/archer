/** @file Proves ToolLoopAgent writes and checkpoints private notes through the AI SDK. */

import { memoryFileStore } from '@archer/files';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { runNotebookAgent } from '../src/agent.js';

/** Minimal valid usage returned by Vercel's maintained model test implementation. */
const MOCK_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
} as const;

describe('Vercel AI SDK notebook agent application', () => {
  it('lets ToolLoopAgent create a note and explicitly retain its checkpoint', async () => {
    /** Vercel's mock controls provider output without bypassing the agent loop or tool dispatcher. */
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          warnings: [],
          usage: MOCK_USAGE,
          finishReason: { unified: 'tool-calls', raw: undefined },
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-write-plan',
              toolName: 'addNote',
              input: JSON.stringify({ path: 'plan.md', content: '# Launch plan\n\n- Verify release\n' }),
            },
          ],
        },
        {
          warnings: [],
          usage: MOCK_USAGE,
          finishReason: { unified: 'tool-calls', raw: undefined },
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-checkpoint-plan',
              toolName: 'checkpointNotes',
              input: '{}',
            },
          ],
        },
        {
          warnings: [],
          usage: MOCK_USAGE,
          finishReason: { unified: 'stop', raw: undefined },
          content: [{ type: 'text', text: 'The launch plan is ready and checkpointed.' }],
        },
      ],
    });
    /** Caller-owned storage has the same explicit lifecycle as the runnable filesystem store. */
    const store = memoryFileStore();
    try {
      /** The production application receives a model and storage port, not direct tool calls. */
      const result = await runNotebookAgent({ model, store, task: 'Draft and checkpoint a launch plan.' });

      expect(model.doGenerateCalls).toHaveLength(3);
      expect(result.response).toBe('The launch plan is ready and checkpointed.');
      expect(result.notes).toEqual(['plan.md']);
      expect(result.disposition).toBe('checkpoint-retained');
      expect(result.checkpoint).toMatchObject({ format: 'archer-tree-v1' });
    } finally {
      await store.close();
    }
  });
});
