/** @file Proves Model configuration performs its provider and revision jobs. */

import { describe, expect, it } from 'vitest';

import { TimestampSchema, UuidV4Schema } from '@archer/core';

import { openAIModel, reviseModel, type ModelRevisionId } from '../src/index.js';

/** Deterministic child identity keeps revision proof independent from randomness. */
const CHILD_REVISION_ID = UuidV4Schema.parse('22222222-2222-4222-8222-222222222222') as ModelRevisionId;

describe('Model', () => {
  it('creates credential-free behavior with a four-part default name', () => {
    /** Omits the display name so this proof exercises the public four-part petname path. */
    const model = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 1_200 });

    expect(model).toMatchObject({
      object: 'model',
      type: 'openai',
      model: 'gpt-5.4-mini',
      maxOutputTokens: 1_200,
      revision: 1,
    });
    expect(model.name.split('-')).toHaveLength(4);
    expect('credential' in model).toBe(false);
    expect('contextWindowTokens' in model).toBe(false);

    /** Collides logical and revision identity to prove injected contexts cannot erase their distinction. */
    expect(() =>
      openAIModel(
        { model: 'gpt-5.4-mini', maxOutputTokens: 1_200 },
        {
          id: CHILD_REVISION_ID as never,
          revisionId: CHILD_REVISION_ID,
          observedAt: TimestampSchema.parse('2026-08-26T18:00:00.000Z'),
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'models_invalid_input' }));
  });

  it('earns a child from explicit facts without changing content identity for display metadata', () => {
    /** Uses explicit display metadata to separate rename behavior from provider configuration. */
    const parent = openAIModel({ name: 'Primary support model', model: 'gpt-5.4-mini', maxOutputTokens: 1_200 });
    /** Changes only the name through exact child facts to prove content identity excludes decoration. */
    const changedName = reviseModel(
      parent,
      { name: 'Renamed support model', model: 'gpt-5.4-mini', maxOutputTokens: 1_200 },
      {
        revisionId: CHILD_REVISION_ID,
        observedAt: TimestampSchema.parse('2026-08-26T18:00:00.000Z'),
      },
    );

    expect(changedName).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: parent.id,
        name: 'Renamed support model',
        revisionId: CHILD_REVISION_ID,
        previousRevisionId: parent.revisionId,
        revision: 2,
        contentDigest: parent.contentDigest,
      }),
    });
  });

  it('refuses a child whose provider behavior did not change', () => {
    /** Creates one exact parent whose unchanged behavior must survive refusal. */
    const parent = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 1_200 });
    /** Repeats every parent field so the no-change refusal cannot be attributed to missing input. */
    const unchanged = reviseModel(
      parent,
      { model: 'gpt-5.4-mini', maxOutputTokens: 1_200, name: parent.name },
      {
        revisionId: CHILD_REVISION_ID,
        observedAt: TimestampSchema.parse('2026-08-26T18:00:00.000Z'),
      },
    );

    expect(unchanged).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'models_revision_no_change' }),
    });
    expect(parent.revision).toBe(1);
  });

  it('refuses a child that reuses its exact parent revision identity', () => {
    /** Changes display metadata so revision-identity reuse is the only invalid child fact. */
    const parent = openAIModel({ name: 'Primary model', model: 'gpt-5.4-mini', maxOutputTokens: 1_200 });
    /** Deliberately repeats the parent's UUID despite the nominal child type. */
    const reused = reviseModel(
      parent,
      { name: 'Renamed model', model: 'gpt-5.4-mini', maxOutputTokens: 1_200 },
      {
        revisionId: parent.revisionId,
        observedAt: TimestampSchema.parse('2026-08-26T18:00:00.000Z'),
      },
    );

    expect(reused).toEqual({ ok: false, error: expect.objectContaining({ code: 'models_invalid_input' }) });
    expect(parent.name).toBe('Primary model');
  });
});
