/** @file Proves provider discrimination, content identity, and request authority. */

import { Sha256DigestSchema, TimestampSchema, UuidV4Schema } from '@archer/core';
import { describe, expect, it } from 'vitest';

import {
  ModelsError,
  compatibleModel,
  createModelStepRequest,
  googleModel,
  ollamaModel,
  openAIModel,
  xAIModel,
  type Model,
  type ModelCreationContext,
  type ModelId,
  type ModelRevisionId,
  type ModelStepRequestContext,
  type ModelStepRequestId,
} from '../src/index.js';

/**
 * Creates production-valid initial facts without relying on wall time or randomness.
 * @param suffix - Twelve-digit UUID tail unique to the fixture under construction.
 * @returns Admitted logical and revision identities at one fixed trusted instant.
 */
function creationContext(suffix: string): ModelCreationContext {
  return Object.freeze({
    id: UuidV4Schema.parse(`10000000-0000-4000-8000-${suffix}`) as ModelId,
    revisionId: UuidV4Schema.parse(`20000000-0000-4000-8000-${suffix}`) as ModelRevisionId,
    observedAt: TimestampSchema.parse('2026-08-26T16:00:00.000Z'),
  });
}

describe('provider Models', () => {
  it('retains only controls owned by each provider discriminator', () => {
    /** Uses OpenAI-only controls so cross-provider flattening would be visible. */
    const openai = openAIModel(
      {
        model: 'gpt-5.4-mini',
        maxOutputTokens: 128_000,
        reasoningEffort: 'medium',
        serviceTier: 'flex',
      },
      creationContext('000000000001'),
    );
    /** Uses Gemini thinking fields that no other provider target is allowed to inherit. */
    const google = googleModel(
      {
        model: 'gemini-2.5-flash',
        maxOutputTokens: 65_536,
        thinking: { budgetTokens: 2_048, includeThoughts: false },
      },
      creationContext('000000000002'),
    );
    /** Uses xAI's narrower reasoning contract to prove provider-specific discrimination. */
    const xai = xAIModel(
      { model: 'grok-4', maxOutputTokens: 32_000, reasoningEffort: 'high' },
      creationContext('000000000003'),
    );
    /** Omits endpoint to exercise the explicit local Ollama default. */
    const ollama = ollamaModel({ model: 'gpt-oss:20b', maxOutputTokens: 32_768 }, creationContext('000000000004'));
    /** Names the installation and endpoint because compatible providers do not share guarantees. */
    const compatible = compatibleModel(
      {
        installation: 'company-gateway',
        provider: 'openai.compatible',
        model: 'support-v3',
        endpoint: 'https://models.example.test/v1',
        maxOutputTokens: 8_000,
      },
      creationContext('000000000005'),
    );

    expect([openai.type, google.type, xai.type, ollama.type, compatible.type]).toEqual([
      'openai',
      'google',
      'xai',
      'ollama',
      'compatible',
    ]);
    expect(openai).toMatchObject({ object: 'model', resource: 'model', revision: 1 });
    expect(google.thinking).toEqual({ budgetTokens: 2_048, includeThoughts: false });
    expect(ollama.endpoint).toBe('http://127.0.0.1:11434/api');
    expect(compatible.installation).toBe('company-gateway');
    expect(Object.isFrozen(google.thinking)).toBe(true);
  });

  it('copies nested provider controls and excludes identity metadata from content identity', () => {
    /** Keeps mutable nested caller input so defensive copying can be observed. */
    const thinking = { budgetTokens: 1_024, includeThoughts: true };
    /** Captures the first immutable model before the caller mutates nested controls. */
    const first = googleModel(
      { name: 'Primary', model: 'gemini-2.5-pro', maxOutputTokens: 65_536, thinking },
      creationContext('000000000006'),
    );
    /** Uses different identity and display metadata to isolate behavior content identity. */
    const sameBehavior = googleModel(
      { name: 'Secondary', model: 'gemini-2.5-pro', maxOutputTokens: 65_536, thinking },
      creationContext('000000000007'),
    );

    thinking.budgetTokens = 8_192;
    expect(first.thinking).toEqual({ budgetTokens: 1_024, includeThoughts: true });
    expect(first.contentDigest).toBe(sameBehavior.contentDigest);
  });

  it('rejects credentials and unowned capacity claims instead of silently dropping them', () => {
    /** Includes forbidden production-looking fields so silent omission would fail the test. */
    const decorativeClaim = {
      model: 'gpt-5.4-mini',
      maxOutputTokens: 128_000,
      contextWindowTokens: 400_000,
      credential: 'personal',
    };

    expect(() => openAIModel(decorativeClaim)).toThrowError(
      expect.objectContaining<Partial<ModelsError>>({ code: 'models_invalid_input' }),
    );
  });
});

describe('ModelStepRequest', () => {
  it('copies nested input and binds optional ResourceSet evidence', () => {
    /** Provides an admitted model whose ceiling and provenance constrain request creation. */
    const model = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 1_200 }, creationContext('000000000008'));
    /** Keeps caller-owned mutable messages so request copying is directly observable. */
    const messages = [{ role: 'user' as const, content: 'Summarize the incident.' }];
    /** Supplies deterministic request identity to prove the application assembler can own facts. */
    const requestContext: ModelStepRequestContext = Object.freeze({
      id: UuidV4Schema.parse('30000000-0000-4000-8000-000000000001') as ModelStepRequestId,
      createdAt: TimestampSchema.parse('2026-08-26T17:00:00.000Z'),
    });
    /** Creates the executable request before mutating the original message array. */
    const request = createModelStepRequest(
      {
        model,
        messages,
        maxOutputTokens: 800,
        resourceSet: {
          id: UuidV4Schema.parse('40000000-0000-4000-8000-000000000001'),
          object: 'resource-set',
          evidenceDigest: Sha256DigestSchema.parse(
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ),
        },
      },
      requestContext,
    );

    messages[0]!.content = 'Mutated';
    expect(request).toMatchObject({ ...requestContext, object: 'model-step-request', maxOutputTokens: 800 });
    expect(request.messages).toEqual([{ role: 'user', content: 'Summarize the incident.' }]);
    expect(Object.isFrozen(request.messages)).toBe(true);
    expect(Object.isFrozen(request.resourceSet)).toBe(true);
  });

  it('refuses a widened output limit and every structural request forgery', () => {
    /** Uses a low model ceiling so one-token widening produces an exact refusal. */
    const model = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 1_000 }, creationContext('000000000009'));

    expect(() =>
      createModelStepRequest({
        model,
        messages: [{ role: 'user', content: 'Write a novel.' }],
        maxOutputTokens: 1_001,
      }),
    ).toThrowError(expect.objectContaining<Partial<ModelsError>>({ code: 'models_output_limit_exceeded' }));

    /** Creates one real admitted request whose structural copies must lose effect authority. */
    const admitted = createModelStepRequest({
      model,
      messages: [{ role: 'user', content: 'Write one sentence.' }],
      maxOutputTokens: 100,
    });
    expect(() => createModelStepRequest({ ...admitted, model: { ...model } as Model })).toThrowError(
      expect.objectContaining<Partial<ModelsError>>({ code: 'models_invalid_input' }),
    );
  });
});
