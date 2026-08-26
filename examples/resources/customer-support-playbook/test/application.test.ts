/** @file Proves the support application reaches the AI SDK with Resource-prepared input. */

import { resolve } from 'node:path';

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { CanonicalDecimalSchema } from '@archer/core';
import { memoryFileStore } from '@archer/files';
import { bindOpenAIAiSdkModel, createAiSdkModelRouter } from '@archer/models/ai-sdk';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { SupportReplyError, createSupportPlaybook, toSupportReplyUpdate } from '../src/application.js';

/** Minimal token usage a real AI SDK v3 provider stream can report. */
const USAGE = {
  inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 8, text: 8, reasoning: undefined },
} as const;

/**
 * Publishes provider parts through a real web stream consumed by the AI SDK.
 * @param parts - Ordered provider updates and terminal finish part.
 * @returns Stream used by Vercel's maintained test model.
 */
function providerStream(parts: readonly LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    /** Enqueues exact provider parts before terminal stream closure. */
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

describe('customer support playbook application', () => {
  it('turns a delivery gap into an application update a copied UI can handle', () => {
    expect(
      toSupportReplyUpdate({
        kind: 'gap',
        source: 'model-step',
        epoch: 'attempt-1',
        lostItems: CanonicalDecimalSchema.parse('3'),
        lostBytes: CanonicalDecimalSchema.parse('81'),
      }),
    ).toEqual({ type: 'live-updates-missed', lostUpdates: '3' });
  });

  it('answers one ticket through Resource preparation and the real AI SDK adapter', async () => {
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      doStream: {
        stream: providerStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Your order shipped yesterday. ' },
          { type: 'text-delta', id: 'answer', delta: 'The next carrier scan will show its route.' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: 'stop' } },
        ]),
      },
    });
    const binding = bindOpenAIAiSdkModel({
      sdkModel,
      name: 'Test support model',
      maxOutputTokens: 1_200,
    });
    const router = createAiSdkModelRouter({ models: [binding] });
    const files = memoryFileStore();
    const deltas: string[] = [];
    try {
      const playbook = await createSupportPlaybook({
        files,
        model: binding.target,
        router,
        skillDirectory: resolve(import.meta.dirname, '../skills/order-support'),
        promptFile: resolve(import.meta.dirname, '../prompts/support.md'),
        company: 'Northstar Outfitters',
      });
      const result = await playbook.answer({
        ticket: 'Where is order A-42? The latest scan says it shipped yesterday.',
        onUpdate: (update) => {
          if (update.type === 'text-delta') deltas.push(update.text);
        },
      });

      expect(result.reply).toBe('Your order shipped yesterday. The next carrier scan will show its route.');
      expect(result.liveUpdatesComplete).toBe(true);
      expect(result.outputTokens).toBe(800);
      expect(result.revisions).toEqual({
        profile: 'Customer order support',
        model: 'Test support model',
        prompt: 'Customer support voice',
        skill: 'order-support',
        budget: 'Interactive support reply',
      });
      expect(deltas.join('')).toBe(result.reply);
      expect(sdkModel.doStreamCalls).toHaveLength(1);
      expect(sdkModel.doStreamCalls[0]).toMatchObject({
        maxOutputTokens: 800,
        prompt: [
          {
            role: 'system',
            content: expect.stringContaining('You are a customer support teammate at Northstar Outfitters.'),
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'Where is order A-42? The latest scan says it shipped yesterday.' }],
          },
        ],
      });
      expect((sdkModel.doStreamCalls[0]?.prompt[0] as { content: string }).content).toContain(
        'Use the facts in the customer message.',
      );
      expect((sdkModel.doStreamCalls[0]?.prompt[0] as { content: string }).content).toContain(
        'Treat the latest carrier scan as the current status.',
      );
    } finally {
      await router.close();
      await files.close();
    }
  });

  it('preserves provider failure data for the application error boundary', async () => {
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      doStream: async () => {
        throw new Error('provider unavailable');
      },
    });
    const binding = bindOpenAIAiSdkModel({
      sdkModel,
      name: 'Unavailable support model',
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

      const failure = await playbook.answer({ ticket: 'Where is order A-42?' }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SupportReplyError);
      expect((failure as SupportReplyError).result).toMatchObject({
        type: 'failed',
        error: { code: 'model_provider_failed', retryable: true },
        retry: 'admit-new-attempt',
      });
      expect(sdkModel.doStreamCalls).toHaveLength(1);
    } finally {
      await router.close();
      await files.close();
    }
  });
});
