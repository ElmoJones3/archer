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
      /** Builds the same exported application a developer runs, including real Prompt and Skill acquisition. */
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

  it('narrows one ticket below the playbook ceiling and sends that exact limit to the provider', async () => {
    /** Returns one complete short reply through the real AI SDK test-model boundary. */
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      doStream: {
        stream: providerStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Your order is in transit.' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: 'stop' } },
        ]),
      },
    });
    /** Keeps provider capacity above both the playbook and per-ticket ceilings. */
    const binding = bindOpenAIAiSdkModel({ sdkModel, name: 'Narrowed support model', maxOutputTokens: 1_200 });
    /** Routes the application to the single recording provider binding. */
    const router = createAiSdkModelRouter({ models: [binding] });
    /** Retains the example's real Prompt and Skill snapshots during the call. */
    const files = memoryFileStore();
    try {
      /** Builds the exported support application through the same setup used by the CLI. */
      const playbook = await createSupportPlaybook({
        files,
        model: binding.target,
        router,
        skillDirectory: resolve(import.meta.dirname, '../skills/order-support'),
        promptFile: resolve(import.meta.dirname, '../prompts/support.md'),
        company: 'Northstar Outfitters',
      });

      /** Narrows this one reply without changing the reusable 800-token playbook policy. */
      const result = await playbook.answer({ ticket: 'Where is order A-42?', maxOutputTokens: 400 });

      expect(result.outputTokens).toBe(400);
      expect(sdkModel.doStreamCalls).toHaveLength(1);
      expect(sdkModel.doStreamCalls[0]?.maxOutputTokens).toBe(400);
    } finally {
      await router.close();
      await files.close();
    }
  });

  it('refuses a ticket budget that widens policy before making any provider call', async () => {
    /** Uses a real AI SDK test model so an accidental provider invocation remains directly observable. */
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      doStream: { stream: providerStream([]) },
    });
    /** Binds the test model with capacity above the playbook so the Resource policy refuses first. */
    const binding = bindOpenAIAiSdkModel({ sdkModel, name: 'Bounded support model', maxOutputTokens: 1_200 });
    /** Routes only to the recording test binding used by this application instance. */
    const router = createAiSdkModelRouter({ models: [binding] });
    /** Retains imported Prompt and Skill content for the complete real application setup. */
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
      /** Asks for one token beyond this playbook's 800-token policy to exercise real request preparation. */
      const input = Object.freeze({ ticket: 'Where is order A-42?', maxOutputTokens: 801 });
      /** Snapshots caller input so refusal proves request preparation remains non-mutating. */
      const before = JSON.stringify(input);

      /** Captures the exact preparation refusal without weakening the application's throwing boundary. */
      const failure = await playbook.answer(input).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'budget_request_widens_bound' });
      expect(JSON.stringify(input)).toBe(before);
      expect(sdkModel.doStreamCalls).toHaveLength(0);
    } finally {
      await router.close();
      await files.close();
    }
  });
});
