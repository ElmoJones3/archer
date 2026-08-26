/** @file Proves transport parsing cannot manufacture Model or request authority. */

import { TimestampSchema, UuidV4Schema, createUuidV4 } from '@archer/core';
import { describe, expect, it } from 'vitest';

import { hydrateModel } from '../src/hydration/index.js';
import {
  openAIModel,
  reviseModel,
  type Model,
  type ModelCreationContext,
  type ModelId,
  type ModelRevisionContext,
  type ModelRevisionId,
} from '../src/index.js';
import { ModelCodec } from '../src/transport/index.js';

/** Supplies deterministic production-valid root identity. */
const ROOT_CONTEXT: ModelCreationContext = Object.freeze({
  id: UuidV4Schema.parse('50000000-0000-4000-8000-000000000001') as ModelId,
  revisionId: UuidV4Schema.parse('50000000-0000-4000-8000-000000000002') as ModelRevisionId,
  observedAt: TimestampSchema.parse('2026-08-26T16:00:00.000Z'),
});

/** Supplies deterministic child identity and causal time. */
const CHILD_CONTEXT: ModelRevisionContext = Object.freeze({
  revisionId: UuidV4Schema.parse('50000000-0000-4000-8000-000000000003') as ModelRevisionId,
  observedAt: TimestampSchema.parse('2026-08-26T17:00:00.000Z'),
});

describe('Model transport and hydration', () => {
  it('restores initial behavior and a child only through its exact admitted parent', () => {
    /** Creates one admitted root whose exact-object identity can authorize child hydration. */
    const parent = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 128_000 }, ROOT_CONTEXT);
    /** Creates a legal child so transport and parent verification exercise real production state. */
    const revised = reviseModel(
      parent,
      { model: 'gpt-5.4-mini', maxOutputTokens: 128_000, serviceTier: 'priority' },
      CHILD_CONTEXT,
    );
    if (!revised.ok) throw revised.error;
    /** Decodes root data separately to prove parsing alone does not preserve behavior provenance. */
    const parentDto = ModelCodec.parse(parent);
    /** Decodes child data separately so hydration must reconnect explicit ancestry. */
    const childDto = ModelCodec.parse(revised.value);

    /** Restores the root through the only boundary allowed to reattach behavior. */
    const hydratedParent = hydrateModel({ dto: parentDto });
    /** Copies every visible parent field to prove structural equality is insufficient ancestry evidence. */
    const forgedParent = { ...parent } as Model;
    /** Attempts restoration with the forged parent so refusal protects the exact-object invariant. */
    const forged = hydrateModel({ dto: childDto, parent: forgedParent });
    /** Uses the admitted parent to prove the legal child restoration path remains available. */
    const hydratedChild = hydrateModel({ dto: childDto, parent });

    expect(hydratedParent).toEqual({ ok: true, value: expect.objectContaining({ revision: 1 }) });
    expect(forged).toEqual({ ok: false, error: expect.objectContaining({ code: 'models_invalid_input' }) });
    expect(hydratedChild).toEqual({
      ok: true,
      value: expect.objectContaining({
        revisionId: revised.value.revisionId,
        previousRevisionId: parent.revisionId,
      }),
    });
  });

  it('keeps invented but structurally valid history out of revision behavior', () => {
    /** Anchors logical identity before constructing an invented skipped revision. */
    const root = openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 128_000 }, ROOT_CONTEXT);
    /** Builds structurally valid but impossible ancestry to prove hydration checks revision continuity. */
    const invented = ModelCodec.parse({
      ...root,
      revisionId: createUuidV4(),
      revision: 99,
      previousRevisionId: createUuidV4(),
    });
    /** Collides transport identities while preserving the content digest, which excludes lifecycle metadata. */
    const collidingIdentity = ModelCodec.safeParse({ ...root, revisionId: root.id });

    expect(collidingIdentity.ok).toBe(false);
    expect(hydrateModel({ dto: invented })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'models_invalid_input' }),
    });
    expect(
      reviseModel(
        invented as Model,
        { model: 'gpt-5.4-mini', maxOutputTokens: 128_000, serviceTier: 'priority' },
        CHILD_CONTEXT,
      ),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'models_invalid_input' }) });
  });
});
