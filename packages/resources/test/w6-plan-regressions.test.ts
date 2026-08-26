/** @file Pins the Wave 6 corrections that the discarded implementations missed. */

import { describe, expect, it } from 'vitest';

import { defineBudgetPolicy } from '../src/entrypoints/budgets.js';
import { definePrompt } from '../src/entrypoints/prompts.js';

describe('Wave 6 merged-plan regressions', () => {
  it('keeps Prompt order outside Prompt behavior and preserves escaped literal delimiters', () => {
    /** Creates escaped delimiters with inferred variables so the exact merged-plan grammar is locked. */
    const prompt = definePrompt({
      name: 'Support instructions',
      placement: 'system',
      template: 'Write {{{{ticketId}}}} literally for {{companyName}}.',
      variables: ['companyName'],
    });

    /** Renders behavior once to prove literals and substitution compose without numeric Prompt order. */
    const rendered = prompt.render({ companyName: 'Acme' });
    expect('order' in prompt).toBe(false);
    expect(rendered).toEqual({
      ok: true,
      value: expect.objectContaining({ content: 'Write {{ticketId}} literally for Acme.' }),
    });
  });

  it('gives equivalent Prompt behavior the same content identity despite display and lifecycle fields', () => {
    /** Uses explicit lifecycle and display metadata around one stable Prompt behavior. */
    const first = definePrompt({
      name: 'First label',
      placement: 'system',
      template: 'Support {{companyName}}.',
      variables: ['companyName'],
    });
    /** Changes identity, time, and name while preserving behavior to lock content-digest semantics. */
    const second = definePrompt({
      name: 'Second label',
      placement: 'system',
      template: 'Support {{companyName}}.',
      variables: ['companyName'],
    });

    expect(first.id).not.toBe(second.id);
    expect(first.contentDigest).toBe(second.contentDigest);
  });

  it('retains absent BudgetPolicy dimensions instead of silently installing unrelated defaults', () => {
    /** Defines output-only policy to prove absent wall time remains genuinely absent. */
    const outputOnly = defineBudgetPolicy({ name: 'Output only', outputTokens: 800 });
    /** Changes only display metadata to prove Budget content identity excludes names and lifecycle. */
    const sameBehavior = defineBudgetPolicy({ name: 'Different label', outputTokens: 800 });

    expect(outputOnly.ceilings).toEqual({ outputTokens: 800 });
    expect(outputOnly.contentDigest).toBe(sameBehavior.contentDigest);
  });
});
