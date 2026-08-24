/** @file Proves the AI SDK itself dispatches Archer-backed project tools. */

import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { runCodeEditor } from '../src/agent.js';

/** Minimal valid usage returned by Vercel's maintained model test implementation. */
const MOCK_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
} as const;

describe('Vercel AI SDK code editor application', () => {
  it('lets ToolLoopAgent add, modify, rename, and delete before returning reviewable content', async () => {
    /** Vercel's mock owns provider semantics while preserving the complete agent loop. */
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          warnings: [],
          usage: MOCK_USAGE,
          finishReason: { unified: 'tool-calls', raw: undefined },
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-add-math',
              toolName: 'addFile',
              input: JSON.stringify({
                path: 'src/math.ts',
                content: 'export const add = (a: number, b: number) => a + b;\n',
              }),
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
              toolCallId: 'call-document-math',
              toolName: 'modifyFile',
              input: JSON.stringify({ path: 'README.md', content: '# Calculator\n\nExports `add`.\n' }),
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
              toolCallId: 'call-rename-math',
              toolName: 'renameFile',
              input: JSON.stringify({ from: 'src/math.ts', to: 'src/add.ts' }),
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
              toolCallId: 'call-delete-old-entry',
              toolName: 'deleteFile',
              input: JSON.stringify({ path: 'src/index.ts' }),
            },
          ],
        },
        {
          warnings: [],
          usage: MOCK_USAGE,
          finishReason: { unified: 'stop', raw: undefined },
          content: [{ type: 'text', text: 'Added, renamed, documented, and removed the obsolete entry.' }],
        },
      ],
    });

    /** Production-shaped project input enters through immutable publication. */
    const result = await runCodeEditor({
      model,
      project: [
        { path: 'README.md', content: '# Calculator\n' },
        { path: 'src/index.ts', content: 'export const version = 1;\n' },
      ],
      task: 'Add an add function and document it.',
    });

    expect(model.doGenerateCalls).toHaveLength(5);
    expect(result.response).toBe('Added, renamed, documented, and removed the obsolete entry.');
    expect(result.files).toEqual(['README.md', 'src/add.ts']);
    expect(
      result.changes.map((change) => ({ type: change.type, path: 'path' in change ? change.path : undefined })),
    ).toEqual([
      { type: 'modify', path: 'README.md' },
      { type: 'add', path: 'src/add.ts' },
      { type: 'delete', path: 'src/index.ts' },
    ]);
    expect(result.review).toEqual([
      {
        type: 'modify',
        path: 'README.md',
        before: { encoding: 'utf8', value: '# Calculator\n' },
        after: { encoding: 'utf8', value: '# Calculator\n\nExports `add`.\n' },
      },
      {
        type: 'add',
        path: 'src/add.ts',
        after: { encoding: 'utf8', value: 'export const add = (a: number, b: number) => a + b;\n' },
      },
      {
        type: 'delete',
        path: 'src/index.ts',
        before: { encoding: 'utf8', value: 'export const version = 1;\n' },
      },
    ]);
  });
});
