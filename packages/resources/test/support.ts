/** @file Supplies production-valid deterministic Resource test facts and host fixtures. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TimestampSchema, UuidV4Schema, type Timestamp, type UuidV4 } from '@archer/core';
import { openAIModel, type Model, type ModelCreationContext } from '@archer/models';

import type { BudgetPolicyCreationContext, BudgetPolicyRevisionContext } from '../src/budgets/index.js';
import type { ResourceControlFactContext } from '../src/control/index.js';
import type { AgentProfileCreationContext, AgentProfileRevisionId } from '../src/profiles/index.js';
import type { PromptCreationContext, PromptRevisionContext } from '../src/prompts/index.js';
import type { ResourceSetCreationContext } from '../src/session.js';
import type { SkillCreationContext, SkillRevisionContext } from '../src/skills/index.js';

/** One disposable, valid Agent Skills directory used by importer boundary tests. */
export type SkillDirectoryFixture = Readonly<{
  /** Absolute host directory whose basename matches the manifest name. */
  directory: string;

  /** Removes the fixture tree after the test finishes. */
  cleanup(): Promise<void>;
}>;

/**
 * Creates one deterministic UUIDv4 without consuming ambient randomness.
 * @param sequence - Positive fixture sequence encoded in the UUID tail.
 * @returns Schema-admitted UUIDv4 suitable for narrowing to a domain ID.
 */
export function uuid(sequence: number): UuidV4 {
  return UuidV4Schema.parse(`00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`);
}

/**
 * Creates one canonical test timestamp without reading the wall clock.
 * @param second - Seconds after the stable fixture minute.
 * @returns Schema-admitted timestamp.
 */
export function timestamp(second = 0): Timestamp {
  return TimestampSchema.parse(`2026-08-26T16:00:${String(second).padStart(2, '0')}.000Z`);
}

/**
 * Creates initial Prompt facts with independently controllable identity and time.
 * @param sequence - Base UUID sequence.
 * @param second - Trusted observation second.
 * @returns Complete Prompt creation context.
 */
export function promptContext(sequence: number, second = 0): PromptCreationContext {
  return Object.freeze({
    id: uuid(sequence) as PromptCreationContext['id'],
    revisionId: uuid(sequence + 1) as PromptCreationContext['revisionId'],
    observedAt: timestamp(second),
  });
}

/**
 * Creates explicit child Prompt facts.
 * @param sequence - Revision UUID sequence.
 * @param second - Trusted observation second.
 * @returns Complete Prompt revision context.
 */
export function promptRevisionContext(sequence: number, second = 1): PromptRevisionContext {
  return Object.freeze({
    revisionId: uuid(sequence) as PromptRevisionContext['revisionId'],
    observedAt: timestamp(second),
  });
}

/**
 * Creates initial BudgetPolicy facts.
 * @param sequence - Base UUID sequence.
 * @param second - Trusted observation second.
 * @returns Complete BudgetPolicy creation context.
 */
export function budgetContext(sequence: number, second = 0): BudgetPolicyCreationContext {
  return Object.freeze({
    id: uuid(sequence) as BudgetPolicyCreationContext['id'],
    revisionId: uuid(sequence + 1) as BudgetPolicyCreationContext['revisionId'],
    observedAt: timestamp(second),
  });
}

/**
 * Creates explicit child BudgetPolicy facts.
 * @param sequence - Revision UUID sequence.
 * @param second - Trusted observation second.
 * @returns Complete BudgetPolicy revision context.
 */
export function budgetRevisionContext(sequence: number, second = 1): BudgetPolicyRevisionContext {
  return Object.freeze({
    revisionId: uuid(sequence) as BudgetPolicyRevisionContext['revisionId'],
    observedAt: timestamp(second),
  });
}

/**
 * Creates initial Skill facts.
 * @param sequence - Base UUID sequence.
 * @param second - Trusted observation second.
 * @returns Complete Skill creation context.
 */
export function skillContext(sequence: number, second = 0): SkillCreationContext {
  return Object.freeze({
    id: uuid(sequence) as SkillCreationContext['id'],
    revisionId: uuid(sequence + 1) as SkillCreationContext['revisionId'],
    observedAt: timestamp(second),
  });
}

/**
 * Creates explicit child Skill facts.
 * @param sequence - Revision UUID sequence.
 * @param second - Trusted observation second.
 * @returns Complete Skill revision context.
 */
export function skillRevisionContext(sequence: number, second = 1): SkillRevisionContext {
  return Object.freeze({
    revisionId: uuid(sequence) as SkillRevisionContext['revisionId'],
    observedAt: timestamp(second),
  });
}

/**
 * Creates initial AgentProfile facts.
 * @param sequence - Base UUID sequence.
 * @param second - Trusted observation second.
 * @returns Complete AgentProfile creation context.
 */
export function profileContext(sequence: number, second = 0): AgentProfileCreationContext {
  return Object.freeze({
    id: uuid(sequence) as AgentProfileCreationContext['id'],
    revisionId: uuid(sequence + 1) as AgentProfileRevisionId,
    observedAt: timestamp(second),
  });
}

/**
 * Creates one reusable OpenAI Model behavior value without credentials.
 * @param sequence - Base UUID sequence.
 * @param maxOutputTokens - Declared model output ceiling.
 * @returns Admitted provider-specific Model behavior.
 */
export function modelFixture(sequence: number, maxOutputTokens = 2_000): Model {
  /** Separates deterministic Model identity facts from provider behavior input. */
  const context: ModelCreationContext = Object.freeze({
    id: uuid(sequence) as ModelCreationContext['id'],
    revisionId: uuid(sequence + 1) as ModelCreationContext['revisionId'],
    observedAt: timestamp(),
  });
  return openAIModel({ name: 'Support model', model: 'gpt-5.4-mini', maxOutputTokens }, context);
}

/**
 * Creates exact lifecycle fact identity and time.
 * @param sequence - Fact UUID sequence.
 * @param second - Trusted decision second.
 * @returns Context narrowed by the receiving lifecycle fact type.
 */
export function controlContext<Id extends UuidV4>(sequence: number, second = 0): ResourceControlFactContext<Id> {
  return Object.freeze({ id: uuid(sequence) as Id, createdAt: timestamp(second) });
}

/**
 * Creates exact ResourceSet compilation identity and time.
 * @param sequence - Set UUID sequence.
 * @param second - Trusted compilation second.
 * @returns Complete ResourceSet creation context.
 */
export function resourceSetContext(sequence: number, second = 0): ResourceSetCreationContext {
  return Object.freeze({
    id: uuid(sequence) as ResourceSetCreationContext['id'],
    createdAt: timestamp(second),
  });
}

/**
 * Creates a real Agent Skills directory with one contained reference file.
 * @param name - Manifest and directory name.
 * @param instructions - Human-readable instruction body.
 * @returns Disposable production-valid host fixture.
 */
export async function createSkillDirectory(
  name = 'order-support',
  instructions = 'Check the order status reference before answering.',
): Promise<SkillDirectoryFixture> {
  /** Owns one unique temporary root so cleanup cannot affect another fixture. */
  const root = await mkdtemp(join(tmpdir(), 'archer-resource-test-'));
  /** Makes the directory basename and required manifest name agree. */
  const directory = join(root, name);
  await mkdir(join(directory, 'references'), { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Helps a support rep answer order questions.\n---\n\n${instructions}\n\nRead [order status](references/order-status.md).\n`,
    'utf8',
  );
  await writeFile(
    join(directory, 'references', 'order-status.md'),
    '# Order status\nUse the latest carrier scan.\n',
    'utf8',
  );
  return Object.freeze({
    directory,
    /**
     * Removes only the unique test-owned temporary root.
     * @returns Settlement after recursive test-fixture cleanup.
     */
    cleanup: () => rm(root, { recursive: true, force: true }),
  });
}
