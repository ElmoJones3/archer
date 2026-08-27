/** @file Proves Prompt grammar, exact rendering, revision, and composition behavior. */

import { describe, expect, it } from 'vitest';

import { ResourcesError } from '../src/index.js';
import {
  composePromptContributions,
  definePrompt,
  renderPrompt,
  revisePrompt,
  type PromptContribution,
} from '../src/entrypoints/prompts.js';
import { promptContext, promptRevisionContext, timestamp } from './support.js';

describe('Prompt behavior', () => {
  it('keeps the standalone rendering depth identical to Prompt behavior', () => {
    /** Creates one strict Prompt so both success and refusal can exercise the shared implementation. */
    const prompt = definePrompt(
      { placement: 'user', template: 'Ticket {{ticket}} belongs to {{customer}}.' },
      promptContext(2),
    );
    /** Supplies exact variables for the successful class and standalone rendering paths. */
    const values = { ticket: 'T-42', customer: 'Rae' };

    expect(renderPrompt(prompt, values)).toEqual(prompt.render(values));
    expect(renderPrompt(prompt, { ticket: 'T-42' })).toEqual(prompt.render({ ticket: 'T-42' }));
  });

  it('renders repeated variables verbatim and preserves declared missing order', () => {
    /** Declares repeated and ordered variables so rendering behavior is proved beyond shape. */
    const prompt = definePrompt(
      {
        name: 'Support voice',
        placement: 'system',
        template: '{{tone}} reply for {{company}} in a {{tone}} voice.',
        variables: ['company', 'tone'],
      },
      promptContext(10),
    );
    /** Uses punctuation-bearing values to prove Prompt performs no context-specific escaping. */
    const values = { company: '<Acme>', tone: 'plain & direct' };
    /** Renders once so exact content, provenance, and input non-mutation share the same result. */
    const rendered = prompt.render(values);
    values.tone = 'changed';

    expect(rendered).toEqual({
      ok: true,
      value: expect.objectContaining({
        placement: 'system',
        content: 'plain & direct reply for <Acme> in a plain & direct voice.',
      }),
    });
    expect(prompt.render({})).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'prompt_parameter_missing', details: { variables: ['company', 'tone'] } }),
    });
  });

  it('supports exact literal delimiter escapes and rejects unmatched or expression syntax', () => {
    /** Uses both literal delimiter escapes in one source to prove the grammar is symmetric. */
    const escaped = definePrompt(
      { placement: 'user', template: 'Keep {{{{ticketId}}}} and }}}} around {{ticket}}.' },
      promptContext(20),
    );
    expect(escaped.render({ ticket: 'T-42' })).toEqual({
      ok: true,
      value: expect.objectContaining({ content: 'Keep {{ticketId}} and }} around T-42.' }),
    });

    /** Exercises unmatched and expression-like syntax that JavaScript template engines might accept. */
    for (const template of ['Broken {{ticket', 'Broken ticket}}', '{{ ticket }}', '{{ticket.name}}']) {
      expect(() => definePrompt({ placement: 'system', template }, promptContext(30))).toThrow(ResourcesError);
    }
  });

  it('rejects duplicate, undeclared, unused, missing, and extra variables exactly', () => {
    expect(() =>
      definePrompt({ placement: 'system', template: '{{ticket}}', variables: ['ticket', 'ticket'] }, promptContext(40)),
    ).toThrow(expect.objectContaining({ code: 'prompt_variable_invalid' }));
    expect(() =>
      definePrompt({ placement: 'system', template: '{{ticket}}', variables: [] }, promptContext(42)),
    ).toThrow(expect.objectContaining({ code: 'prompt_variable_undeclared' }));
    expect(() =>
      definePrompt({ placement: 'system', template: '{{ticket}}', variables: ['ticket', 'unused'] }, promptContext(44)),
    ).toThrow(expect.objectContaining({ code: 'prompt_variable_unused' }));

    /** Creates one strict variable contract reused across missing and extra input refusals. */
    const prompt = definePrompt(
      { placement: 'user', template: '{{ticket}} {{customer}}', variables: ['ticket', 'customer'] },
      promptContext(46),
    );
    expect(prompt.render({ ticket: 'T-42', customer: 'Rae', zebra: '1', alpha: '2' })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'prompt_parameter_extra',
        details: { variables: ['alpha', 'zebra'] },
      }),
    });
  });

  it('composes system and user contributions in profile order around immutable history', () => {
    /** Provides the first system contribution in AgentProfile order. */
    const first = definePrompt({ placement: 'system', template: 'First' }, promptContext(50));
    /** Provides a user contribution that must appear after history but before the current message. */
    const user = definePrompt({ placement: 'user', template: 'Ticket {{ticket}}' }, promptContext(52));
    /** Provides a later system contribution to prove placement partitioning preserves relative order. */
    const second = definePrompt({ placement: 'system', template: 'Second' }, promptContext(54));
    /** Unwraps only real render results so composition receives behavior-owned provenance. */
    const contributions = [first.render({}), user.render({ ticket: 'T-42' }), second.render({})].map((result) => {
      if (!result.ok) throw result.error;
      return result.value;
    });
    /** Keeps acknowledged history mutable-looking so composition non-mutation can be asserted. */
    const history = [{ role: 'assistant' as const, content: 'How can I help?' }];
    /** Composes all placements into exact provider-neutral instructions and messages. */
    const composed = composePromptContributions({ contributions, history, userMessage: 'Where is it?' });

    expect(composed).toEqual({
      ok: true,
      value: expect.objectContaining({
        instructions: ['First', 'Second'],
        messages: [
          { role: 'assistant', content: 'How can I help?' },
          { role: 'user', content: 'Ticket T-42' },
          { role: 'user', content: 'Where is it?' },
        ],
        sources: [first, user, second].map((prompt) => expect.objectContaining({ revisionId: prompt.revisionId })),
      }),
    });
    expect(history).toEqual([{ role: 'assistant', content: 'How can I help?' }]);
  });

  it('refuses forged and duplicate contributions without producing partial request parts', () => {
    /** Creates one real Prompt whose contribution can be copied structurally. */
    const prompt = definePrompt({ placement: 'system', template: 'Be concise.' }, promptContext(60));
    /** Mints the only legal contribution before producing forged and duplicate inputs. */
    const rendered = prompt.render({});
    if (!rendered.ok) throw rendered.error;
    /** Copies visible fields to prove WeakSet provenance, not shape, authorizes composition. */
    const forged = { ...rendered.value } as PromptContribution;

    expect(composePromptContributions({ contributions: [forged], history: [], userMessage: 'Hello' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'prompt_contribution_unverified' }),
    });
    expect(
      composePromptContributions({
        contributions: [rendered.value, rendered.value],
        history: [],
        userMessage: 'Hello',
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'prompt_duplicate_revision' }) });
  });

  it('earns an exact causal child while keeping content identity independent from lifecycle and name', () => {
    /** Creates the first revision with explicit identity and lifecycle metadata. */
    const first = definePrompt(
      { name: 'First label', placement: 'system', template: 'Be concise.' },
      promptContext(70, 5),
    );
    /** Creates equivalent behavior under different identity and display metadata. */
    const equivalent = definePrompt(
      { name: 'Second label', placement: 'system', template: 'Be concise.' },
      promptContext(72, 6),
    );
    /** Collides logical and revision identity to prove explicit initial contexts preserve both facts. */
    const colliding = promptContext(76, 7);
    expect(() =>
      definePrompt(
        { placement: 'system', template: 'Invalid identity.' },
        { ...colliding, revisionId: colliding.id as never },
      ),
    ).toThrow(expect.objectContaining({ code: 'resources_invalid_prompt' }));
    /** Renames through exact child facts to prove content identity excludes lifecycle and name. */
    const child = revisePrompt(first, { name: 'Renamed' }, promptRevisionContext(74, 4));
    /** Reuses the parent revision UUID to prove nominal typing cannot create impossible ancestry. */
    const reusedRevisionId = revisePrompt(
      first,
      { name: 'Invalid child' },
      {
        revisionId: first.revisionId,
        observedAt: timestamp(7),
      },
    );
    /** Reuses the stable logical identity to prove child revisions cannot make identity roles ambiguous. */
    const collidingLogicalId = revisePrompt(
      first,
      { name: 'Colliding child' },
      {
        revisionId: first.id as never,
        observedAt: timestamp(7),
      },
    );

    expect(first.contentDigest).toBe(equivalent.contentDigest);
    expect(child).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: first.id,
        previousRevisionId: first.revisionId,
        revision: 2,
        updatedAt: first.updatedAt,
        name: 'Renamed',
        contentDigest: first.contentDigest,
      }),
    });
    expect(reusedRevisionId).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_prompt_transition_refused' }),
    });
    expect(collidingLogicalId).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_prompt_transition_refused' }),
    });
    expect(first.name).toBe('First label');
  });
});
