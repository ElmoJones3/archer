/** @file Composes verified Prompt contributions into provider-neutral request parts. */

import { Result, type Result as ResultValue } from '@archer/core';
import type { ModelMessage } from '@archer/models';

import { ResourcesError } from '../errors.js';
import { isPromptContribution, type PromptContribution, type PromptRef, type PromptRevisionId } from './index.js';

/** Input accepted by deterministic Prompt composition. */
export type ComposePromptContributionsInput = Readonly<{
  /** Contributions already ordered by AgentProfile selection. */
  contributions: readonly PromptContribution[];

  /** Acknowledged conversation preserved before current user context. */
  history: readonly ModelMessage[];

  /** Current user request appended after user-placed Prompt contributions. */
  userMessage: string;
}>;

/** Request parts derived from verified Prompt contributions. */
export type ComposedPrompt = Readonly<{
  /** System-placed contributions in exact AgentProfile order. */
  instructions: readonly string[];

  /** History, user contributions, then the current user request. */
  messages: readonly ModelMessage[];

  /** Ordered exact Prompt refs used to derive these request parts. */
  sources: readonly PromptRef[];
}>;

/**
 * Composes verified contributions in caller-supplied AgentProfile order.
 * @param input - Ordered contributions, acknowledged history, and current user message.
 * @returns Complete request parts or exact contribution refusal.
 */
export function composePromptContributions(
  input: ComposePromptContributionsInput,
): ResultValue<ComposedPrompt, ResourcesError> {
  /** Copying preserves caller state while retaining exact object identities for provenance. */
  const contributions = [...input.contributions];
  /** Structural copies cannot substitute for contributions minted by Prompt rendering. */
  const unverified = contributions.find((contribution) => !isPromptContribution(contribution));
  if (unverified !== undefined) {
    return Result.error(
      new ResourcesError(
        'prompt_contribution_unverified',
        'Prompt composition requires rendered contribution evidence',
        { details: { promptRevisionId: unverified.source?.revisionId ?? 'unknown' } },
      ),
    );
  }
  /** One exact Prompt revision may contribute at most once to one request. */
  const seen = new Set<PromptRevisionId>();
  /** Checks provenance in supplied order so duplicate refusal remains deterministic. */
  for (const contribution of contributions) {
    if (seen.has(contribution.source.revisionId)) {
      return Result.error(
        new ResourcesError('prompt_duplicate_revision', 'Prompt composition received one revision more than once', {
          details: { promptRevisionId: contribution.source.revisionId },
        }),
      );
    }
    seen.add(contribution.source.revisionId);
  }
  /** System instructions preserve AgentProfile order inside their placement. */
  const instructions = Object.freeze(
    contributions
      .filter((contribution) => contribution.placement === 'system')
      .map((contribution) => contribution.content),
  );
  /** History is copied deeply enough for Archer's text-only immutable message values. */
  const history = input.history.map((message) => Object.freeze({ ...message }));
  /** User contributions immediately precede the current user request. */
  const current = contributions
    .filter((contribution) => contribution.placement === 'user')
    .map((contribution): ModelMessage => Object.freeze({ role: 'user', content: contribution.content }));
  /** Placement is a projection rule, not a mutation of caller-owned history. */
  const messages = Object.freeze([
    ...history,
    ...current,
    Object.freeze({ role: 'user' as const, content: input.userMessage }),
  ]);
  return Result.ok(
    Object.freeze({
      instructions,
      messages,
      sources: Object.freeze(contributions.map((contribution) => contribution.source)),
    }),
  );
}
