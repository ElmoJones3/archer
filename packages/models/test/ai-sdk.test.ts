/** @file Proves the AI SDK adapter performs one observable provider step. */

import { TimestampSchema, createIdempotencyKey } from '@archer/core';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindAiSdkModel,
  bindCompatibleAiSdkModel,
  bindOllamaAiSdkModel,
  bindOpenAIAiSdkModel,
  createAiSdkModelRouter,
} from '../src/ai-sdk/index.js';
import { createModelStepRequest, openAIModel } from '../src/index.js';
import { ModelStepRequestCodec } from '../src/transport/index.js';

/** Usage fixture a real AI SDK v3 provider can produce. */
const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

/**
 * Creates a real web stream from provider parts without bypassing AI SDK normalization.
 * @param parts - Ordered response parts a conforming v3 provider can emit.
 * @returns Web stream consumed by Vercel's maintained mock model.
 */
function providerStream(parts: readonly LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    /**
     * Publishes the complete deterministic provider fixture in source order.
     * @param controller - Web stream controller receiving provider parts.
     */
    start(controller) {
      /** Each provider part is accepted before terminal stream closure. */
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** Restores real time after each deadline proof so no fake clock leaks into another model case. */
afterEach(() => {
  vi.useRealTimers();
});

describe('AI SDK model router', () => {
  it('starts once, emits ordered byte-offset deltas, and returns normalized terminal content', async () => {
    /** Exact target is shared by portable request and borrowed SDK binding. */
    const target = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Maintained SDK mock exercises the real streamText normalization path. */
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      doStream: {
        stream: providerStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Hello ' },
          { type: 'text-delta', id: 'answer', delta: 'Steve' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: 'stop' } },
        ]),
      },
    });
    /** Router binds only this exact immutable target revision. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Request proves a normal text step with a narrower output limit. */
    const request = createModelStepRequest({
      model: target,
      instructions: ['Answer as a friendly greeter.', 'Keep the answer brief.'],
      messages: [{ role: 'user', content: 'Say hello.' }],
      maxOutputTokens: 40,
    });

    /** Successful outer Result proves target resolution happened before activation. */
    const started = await router.startStep(request);
    expect(started.ok).toBe(true);
    if (!started.ok) throw started.error;
    /** Attachment observes the already-running shared hot attempt. */
    const subscription = started.value.events.subscribe();
    /** Concurrent collector preserves every delivered event until source completion. */
    const events = (async () => {
      /** Values omit transport envelopes so assertions focus on model progress. */
      const values = [];
      /** Gap markers would remain visible by making the expected count fail. */
      for await (const delivery of subscription) {
        if (delivery.kind === 'event') values.push(delivery.value);
      }
      return values;
    })();
    /** Terminal result must reconstruct complete content independently of deltas. */
    const result = await started.value.result;

    expect(await events).toEqual([
      expect.objectContaining({ type: 'text-delta', blockId: 'answer', offsetBytes: 0, text: 'Hello ' }),
      expect.objectContaining({ type: 'text-delta', blockId: 'answer', offsetBytes: 6, text: 'Steve' }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        type: 'completed',
        finishReason: 'stop',
        content: [{ type: 'text', text: 'Hello Steve' }],
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      }),
    );
    expect(sdkModel.doStreamCalls).toHaveLength(1);
    /** AI SDK normalizes its dedicated instructions option into one provider system message. */
    expect(sdkModel.doStreamCalls[0]).toMatchObject({
      maxOutputTokens: 40,
      prompt: [
        { role: 'system', content: 'Answer as a friendly greeter.\n\nKeep the answer brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
      ],
    });

    await subscription.close();
    await started.value.close();
    await router.close();
  });

  it('returns an exact refusal without invoking a model when the target is not bound', async () => {
    /** Bound target remains unused when the request asks for a different revision. */
    const configured = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Requested target differs in both logical and revision identity. */
    const requested = openAIModel({
      model: 'gpt-5.4',
      maxOutputTokens: 128_000,
    });
    /** Call history proves refusal occurred before an SDK effect. */
    const sdkModel = new MockLanguageModelV3({ provider: 'openai.responses', modelId: 'gpt-5.4-mini' });
    /** Router deliberately exposes only the configured target. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target: configured, model: sdkModel })] });

    /** Start must return a Result failure rather than throw or fall back by provider. */
    const result = await router.startStep(
      createModelStepRequest({
        model: requested,
        messages: [{ role: 'user', content: 'Hello.' }],
        maxOutputTokens: 40,
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'models_target_unbound' }),
    });
    expect(sdkModel.doStreamCalls).toHaveLength(0);
    await router.close();
  });

  it('returns one provider failure without a hidden retry', async () => {
    /** Exact target isolates retry behavior from routing refusal. */
    const target = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Provider failure would produce multiple calls if the SDK retry default leaked through. */
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      /**
       * Fails every provider attempt so one recorded call proves retries are disabled.
       * @returns A promise that always rejects with provider-local failure.
       */
      doStream: async () => {
        throw new Error('provider unavailable');
      },
    });
    /** Router borrows the deterministic failing provider. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Valid request reaches the provider rather than failing admission. */
    const started = await router.startStep(
      createModelStepRequest({
        model: target,
        messages: [{ role: 'user', content: 'Say hello.' }],
        maxOutputTokens: 40,
      }),
    );
    if (!started.ok) throw started.error;

    /** Terminal failure is data and any retry requires a separately admitted new attempt. */
    const result = await started.value.result;

    expect(result).toMatchObject({ type: 'failed', retry: 'admit-new-attempt' });
    expect(sdkModel.doStreamCalls).toHaveLength(1);
    await started.value.close();
    await router.close();
  });

  it('propagates abort to the borrowed SDK model and retains abort evidence', async () => {
    /** Exact target identifies the borrowed model receiving the abort. */
    const target = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Captured signal proves active termination crossed the SDK boundary. */
    let receivedSignal: AbortSignal | undefined;
    /** Provider fixture settles only after observing its abort signal. */
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      /**
       * Returns a provider stream controlled solely by the supplied abort signal.
       * @param options - SDK call options carrying the merged abort signal.
       * @returns Provider stream that settles only after abort.
       */
      doStream: async (options) => {
        receivedSignal = options.abortSignal;
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            /**
             * Handles both sides of the deterministic activation-versus-abort race.
             * @param controller - Web stream controller closed after abort evidence.
             */
            start(controller) {
              /** A real provider must honor both an already-aborted and later-aborted signal. */
              const stop = () => {
                controller.enqueue({ type: 'error', error: options.abortSignal?.reason });
                controller.close();
              };
              if (options.abortSignal?.aborted) stop();
              else options.abortSignal?.addEventListener('abort', stop, { once: true });
            },
          }),
        };
      },
    });
    /** Router borrows the abort-aware SDK fixture. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Started operation exposes abort independently from handle closure. */
    const started = await router.startStep(
      createModelStepRequest({
        model: target,
        messages: [{ role: 'user', content: 'Wait.' }],
        maxOutputTokens: 40,
      }),
    );
    if (!started.ok) throw started.error;

    /** Accepted abort command carries one real idempotency key and bounded reason. */
    const evidence = await started.value.abort({ idempotencyKey: createIdempotencyKey(), reason: 'user-request' });
    /** Terminal result must agree with retained abort evidence. */
    const result = await started.value.result;

    expect(receivedSignal?.aborted).toBe(true);
    expect(evidence).toMatchObject({ kind: 'attempt-settled', outcome: 'aborted' });
    expect(result).toMatchObject({ type: 'aborted', reason: 'user-request' });
    await started.value.close();
    await router.close();
  });

  it('rejects a borrowed provider or model that disagrees with the portable target', () => {
    /** Portable target must describe the same provider effect used for billing and receipts. */
    const target = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Mismatched mock exposes the same identity fields as a real AI SDK model. */
    const sdkModel = new MockLanguageModelV3({ provider: 'google.generative-ai', modelId: 'gemini-3' });

    expect(() => bindAiSdkModel({ target, model: sdkModel })).toThrow(
      expect.objectContaining({ code: 'models_target_mismatch' }),
    );
    expect(sdkModel.doStreamCalls).toHaveLength(0);
  });

  it('derives the portable OpenAI model identifier from the borrowed SDK model', () => {
    /** Concrete SDK identity is the only model string the application supplies. */
    const sdkModel = new MockLanguageModelV3({ provider: 'openai.responses', modelId: 'gpt-5.4-mini' });

    /** Helper output carries both the admitted portable target and borrowed SDK model. */
    const binding = bindOpenAIAiSdkModel({
      sdkModel,
      maxOutputTokens: 128_000,
      serviceTier: 'priority',
    });

    expect(binding.target).toMatchObject({ type: 'openai', model: sdkModel.modelId, serviceTier: 'priority' });
    expect(binding.model).toBe(sdkModel);
  });

  it('keeps a compatible installation label separate from its SDK provider identity', () => {
    /** Provider namespace is machine identity while the installation remains a human label. */
    const sdkModel = new MockLanguageModelV3({ provider: 'openai.compatible', modelId: 'support-v3' });
    /** Captured facts prove the host sees the exact hidden-endpoint claim before admitting it. */
    let observedEndpoint: string | undefined;

    /** Helper must preserve the human label while deriving machine identity from the SDK model. */
    const binding = bindCompatibleAiSdkModel({
      sdkModel,
      installation: 'Local vLLM',
      endpoint: 'http://127.0.0.1:8000/v1',
      maxOutputTokens: 8_000,
      /**
       * Confirms the exact hidden endpoint facts and records the value supplied to the host.
       * @param facts - Installation identity Archer cannot observe from the SDK object alone.
       * @returns Whether the host recognizes the declared endpoint and SDK identity.
       */
      confirmInstallation: (facts) => {
        observedEndpoint = facts.target.endpoint;
        return facts.provider === sdkModel.provider && facts.modelId === sdkModel.modelId;
      },
    });

    expect(binding.target).toMatchObject({
      type: 'compatible',
      installation: 'Local vLLM',
      provider: 'openai.compatible',
      model: 'support-v3',
    });
    expect(observedEndpoint).toBe('http://127.0.0.1:8000/v1');
  });

  it('refuses hidden installations when confirmation returns false or throws', () => {
    /** Compatible client hides its endpoint and must not bind on a negative host check. */
    const compatible = new MockLanguageModelV3({ provider: 'openai.compatible', modelId: 'support-v3' });
    /** Ollama client exercises the same boundary through a distinct provider helper. */
    const ollama = new MockLanguageModelV3({ provider: 'ollama', modelId: 'gpt-oss:20b' });

    expect(() =>
      bindCompatibleAiSdkModel({
        sdkModel: compatible,
        installation: 'Local vLLM',
        endpoint: 'http://127.0.0.1:8000/v1',
        maxOutputTokens: 8_000,
        /**
         * Explicit refusal must prevent the opaque compatible installation from binding.
         * @returns Deliberate negative installation evidence.
         */
        confirmInstallation: () => false,
      }),
    ).toThrow(expect.objectContaining({ code: 'models_target_mismatch' }));
    expect(() =>
      bindOllamaAiSdkModel({
        sdkModel: ollama,
        endpoint: 'http://127.0.0.1:11434/api',
        maxOutputTokens: 8_000,
        /** Host lookup failure must become a stable binding refusal rather than escape raw. */
        confirmInstallation: () => {
          throw new Error('installation lookup failed');
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'models_target_mismatch' }));
    expect(compatible.doStreamCalls).toHaveLength(0);
    expect(ollama.doStreamCalls).toHaveLength(0);
  });

  it('binds Ollama only after the host confirms its exact hidden endpoint facts', () => {
    /** Real SDK shape exposes provider/model identity but deliberately hides its configured endpoint. */
    const sdkModel = new MockLanguageModelV3({ provider: 'ollama', modelId: 'gpt-oss:20b' });
    /** Captured facts prove confirmation receives the portable endpoint selected by the host. */
    let confirmed = false;

    /** Helper result may exist only after the callback observes and approves every exact fact. */
    const binding = bindOllamaAiSdkModel({
      sdkModel,
      endpoint: 'http://127.0.0.1:11434/api',
      maxOutputTokens: 8_000,
      /**
       * Confirms all facts rather than trusting the callback's mere presence.
       * @param facts - Exact portable and SDK identity proposed for the hidden endpoint.
       * @returns Whether every expected installation fact agrees.
       */
      confirmInstallation: (facts) => {
        confirmed =
          facts.target.type === 'ollama' &&
          facts.target.endpoint === 'http://127.0.0.1:11434/api' &&
          facts.provider === 'ollama' &&
          facts.modelId === 'gpt-oss:20b';
        return confirmed;
      },
    });

    expect(confirmed).toBe(true);
    expect(binding.target).toMatchObject({ type: 'ollama', model: 'gpt-oss:20b' });
  });

  it('does not invoke the provider when the host signal is already aborted', async () => {
    /** Exact target proves cancellation occurs after local routing but before provider activation. */
    const target = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Call history is the boundary evidence; stream behavior is irrelevant if the boundary stays closed. */
    const sdkModel = new MockLanguageModelV3({ provider: 'openai.responses', modelId: 'gpt-5.4-mini' });
    /** Router retains the exact admitted SDK binding. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Pre-aborted signal models a request disconnected before application activation. */
    const controller = new AbortController();
    controller.abort('client-already-gone');

    /** Started terminal handle preserves cancellation as data without a provider call. */
    const started = await router.startStep(
      createModelStepRequest({
        model: target,
        messages: [{ role: 'user', content: 'This must not be sent.' }],
        maxOutputTokens: 40,
      }),
      { signal: controller.signal },
    );
    if (!started.ok) throw started.error;

    await expect(started.value.result).resolves.toMatchObject({
      type: 'aborted',
      reason: 'client-already-gone',
    });
    expect(sdkModel.doStreamCalls).toHaveLength(0);
    await started.value.close();
    await router.close();
  });

  it('refuses an already-elapsed deadline before invoking the provider', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T16:00:00.000Z'));
    /** Exact target keeps deadline behavior independent from provider resolution. */
    const target = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 1_000 });
    /** Empty call history proves the expired command never crosses the provider boundary. */
    const sdkModel = new MockLanguageModelV3({ provider: 'openai.responses', modelId: 'gpt-5.4-mini' });
    /** Router binds the target before the already-expired request is admitted for execution. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Deadline predates controlled current time by one millisecond. */
    const request = createModelStepRequest({
      model: target,
      messages: [{ role: 'user', content: 'Too late.' }],
      maxOutputTokens: 40,
      deadline: TimestampSchema.parse('2026-08-26T15:59:59.999Z'),
    });

    /** Starts the finite operation so terminal evidence can prove the provider boundary stayed closed. */
    const started = await router.startStep(request);
    if (!started.ok) throw started.error;
    await expect(started.value.result).resolves.toMatchObject({
      type: 'failed',
      error: { code: 'model_deadline_exceeded', retryable: false },
      retry: 'do-not-retry',
    });
    expect(sdkModel.doStreamCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await started.value.close();
    await router.close();
  });

  it('aborts one active provider stream when its deadline elapses and clears the timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T16:00:00.000Z'));
    /** Exact target keeps the active deadline proof on one provider attempt. */
    const target = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 1_000 });
    /** Provider stream settles only after the adapter's combined signal reports deadline cancellation. */
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      /**
       * Creates one provider stream whose only settlement is the supplied cancellation signal.
       * @param options - Provider call options carrying Archer's combined deadline signal.
       * @returns Stream that closes after observing deadline cancellation.
       */
      doStream: async (options) => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          /**
           * Converts the provider-visible abort into terminal stream evidence.
           * @param controller - Provider stream closed after the deadline signal.
           */
          start(controller) {
            /** Completes the mock stream exactly once when the adapter deadline fires. */
            const stop = () => {
              controller.enqueue({ type: 'error', error: options.abortSignal?.reason });
              controller.close();
            };
            if (options.abortSignal?.aborted) stop();
            else options.abortSignal?.addEventListener('abort', stop, { once: true });
          },
        }),
      }),
    });
    /** Router retains the exact SDK binding while the finite operation owns its timer. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Deadline is one controlled second after activation. */
    const request = createModelStepRequest({
      model: target,
      messages: [{ role: 'user', content: 'Wait for the deadline.' }],
      maxOutputTokens: 40,
      deadline: TimestampSchema.parse('2026-08-26T16:00:01.000Z'),
    });

    /** Starts exactly one provider attempt before advancing the controlled deadline. */
    const started = await router.startStep(request);
    if (!started.ok) throw started.error;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(started.value.result).resolves.toMatchObject({
      type: 'failed',
      error: { code: 'model_deadline_exceeded', retryable: false },
      retry: 'do-not-retry',
    });
    expect(sdkModel.doStreamCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await started.value.close();
    await router.close();
  });

  it('refuses copied, inherited, and decoded requests before invoking the provider', async () => {
    /** Exact target and borrowed model isolate request provenance from routing identity. */
    const target = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Provider call history proves copied command fields never cross the effect boundary. */
    const sdkModel = new MockLanguageModelV3({ provider: 'openai.responses', modelId: 'gpt-5.4-mini' });
    /** Router binds the same admitted model carried by the legitimate request. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Factory output is the only request object that earned local execution provenance. */
    const request = createModelStepRequest({
      model: target,
      messages: [{ role: 'user', content: 'Approved message.' }],
      maxOutputTokens: 40,
    });
    /** Spreading preserves identifiers but substitutes effect-bearing content. */
    const substituted = {
      ...request,
      messages: [{ role: 'user' as const, content: 'Substituted message.' }],
    };

    /** A prototype object can expose every field without being the acknowledged command. */
    const inherited = Object.create(request) as typeof request;
    /** Transport decoding produces valid portable fields but deliberately no effect authority. */
    const decoded = ModelStepRequestCodec.parse(JSON.parse(JSON.stringify(request)));
    /** Reattaching the admitted Model cannot promote decoded request fields into a local command. */
    const reattached = Object.freeze({ ...decoded, model: target }) as typeof request;

    /** Every structural route must refuse before the borrowed SDK model is observable. */
    for (const candidate of [substituted as typeof request, inherited, reattached]) {
      /** Each independent attack receives the same pre-effect refusal contract. */
      const started = await router.startStep(candidate);
      expect(started).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'models_invalid_input' }),
      });
    }
    expect(sdkModel.doStreamCalls).toHaveLength(0);
    await router.close();
  });

  it('maps a standard AbortSignal into the active operation without exposing command machinery', async () => {
    /** Exact target identifies the provider effect cancelled by the host signal. */
    const target = openAIModel({
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
    });
    /** Provider waits for cancellation so signal propagation is deterministic. */
    const sdkModel = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      /**
       * Creates one provider stream that settles only after cancellation.
       * @param options - SDK call options carrying the merged abort signal.
       * @returns Provider stream controlled by cancellation.
       */
      doStream: async (options) => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          /**
           * Closes only after the AI SDK call receives the host cancellation.
           * @param controller - Provider stream controller closed after abort.
           */
          start(controller) {
            /** Handles cancellation both before and after provider stream activation. */
            const stop = () => {
              controller.enqueue({ type: 'error', error: options.abortSignal?.reason });
              controller.close();
            };
            if (options.abortSignal?.aborted) stop();
            else options.abortSignal?.addEventListener('abort', stop, { once: true });
          },
        }),
      }),
    });
    /** Binding proves provider and model identity before cancellation behavior starts. */
    const router = createAiSdkModelRouter({ models: [bindAiSdkModel({ target, model: sdkModel })] });
    /** Host-owned controller is the normal HTTP, worker, and application cancellation primitive. */
    const controller = new AbortController();
    /** Activation receives the host signal through the new public start option. */
    const started = await router.startStep(
      createModelStepRequest({
        model: target,
        messages: [{ role: 'user', content: 'Wait.' }],
        maxOutputTokens: 40,
      }),
      { signal: controller.signal },
    );
    if (!started.ok) throw started.error;

    controller.abort('client-disconnected');

    await expect(started.value.result).resolves.toMatchObject({ type: 'aborted', reason: 'client-disconnected' });
    await started.value.close();
    await router.close();
  });
});
