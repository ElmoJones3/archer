/** @file Proves AgentProfile selection ownership and stale-safe immutable transitions. */

import { memoryFileStore } from '@archer/files';
import { afterEach, describe, expect, it } from 'vitest';

import { defineBudgetPolicy } from '../src/entrypoints/budgets.js';
import {
  activateSkill,
  createAgentProfile,
  renameAgentProfile,
  replaceAgentProfileSelections,
  type AgentProfileRevisionId,
} from '../src/entrypoints/profiles.js';
import { definePrompt } from '../src/entrypoints/prompts.js';
import { importSkillDirectory, type Skill } from '../src/entrypoints/skills.js';
import {
  budgetContext,
  createSkillDirectory,
  modelFixture,
  profileContext,
  promptContext,
  skillContext,
  timestamp,
  uuid,
} from './support.js';

/** Temporary host-fixture cleanup owned by each test. */
const cleanups: (() => Promise<void>)[] = [];

/** Removes only test-owned temporary Skill directories. */
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * Imports one real Skill behavior value for profile selection tests.
 * @param sequence - Stable initial Skill identity sequence.
 * @returns Admitted Skill behavior.
 */
async function skillFixture(sequence: number): Promise<Skill> {
  /** Creates a real Skill directory so profile selection cannot rely on synthetic metadata. */
  const fixture = await createSkillDirectory();
  cleanups.push(fixture.cleanup);
  /** Imports the Skill through production acquisition before using it as behavior. */
  const imported = await importSkillDirectory(
    { directory: fixture.directory },
    { files: memoryFileStore(), context: skillContext(sequence) },
  );
  if (!imported.ok) throw imported.error;
  return imported.value;
}

describe('AgentProfile behavior', () => {
  it('selects exact behavior values, preserves order, and starts at revision zero', async () => {
    /** Provides one admitted Skill whose activation and order are observable. */
    const skill = await skillFixture(200);
    /** Provides the first system Prompt to anchor ordered selection. */
    const firstPrompt = definePrompt({ placement: 'system', template: 'First.' }, promptContext(202));
    /** Provides a user Prompt in a distinct position to prove array order is retained. */
    const secondPrompt = definePrompt({ placement: 'user', template: 'Ticket {{ticket}}.' }, promptContext(204));
    /** Creates one complete selection whose initial profile revision and refs can be inspected. */
    const profile = createAgentProfile(
      {
        model: modelFixture(206),
        prompts: [firstPrompt, secondPrompt],
        skills: [{ skill, activation: 'discoverable' }],
        budget: defineBudgetPolicy({ outputTokens: 800 }, budgetContext(208)),
      },
      profileContext(210),
    );

    expect(profile.revision).toBe(0);
    expect(profile.name.split('-')).toHaveLength(4);
    expect(profile.prompts.map((prompt) => prompt.revisionId)).toEqual([
      firstPrompt.revisionId,
      secondPrompt.revisionId,
    ]);
    expect(profile.skills).toEqual([
      expect.objectContaining({
        skill: expect.objectContaining({ revisionId: skill.revisionId }),
        activation: 'discoverable',
      }),
    ]);
    expect(Object.isFrozen(profile)).toBe(true);

    /** Collides logical and revision identity to prove deterministic contexts retain both facts. */
    const colliding = profileContext(212);
    expect(() =>
      createAgentProfile(
        {
          model: modelFixture(214),
          budget: defineBudgetPolicy({ outputTokens: 800 }, budgetContext(216)),
        },
        { ...colliding, revisionId: colliding.id as never },
      ),
    ).toThrow(expect.objectContaining({ code: 'resources_invalid_profile' }));
  });

  it('rejects duplicate logical or revision selections and structural behavior copies', () => {
    /** Provides Prompt behavior for rename while keeping selection content unchanged. */
    const prompt = definePrompt({ placement: 'system', template: 'Be concise.' }, promptContext(220));
    /** Provides Budget behavior for rename while keeping selection content unchanged. */
    const budget = defineBudgetPolicy({ outputTokens: 800 }, budgetContext(222));
    /** Provides Model behavior for rename while keeping selection content unchanged. */
    const model = modelFixture(224);

    expect(() => createAgentProfile({ model, prompts: [prompt, prompt], budget }, profileContext(226))).toThrow(
      expect.objectContaining({ code: 'profile_selection_duplicate' }),
    );
    expect(() =>
      createAgentProfile({ model: { ...model } as never, prompts: [prompt], budget }, profileContext(228)),
    ).toThrow(expect.objectContaining({ code: 'resources_invalid_profile' }));
  });

  it('refuses invalid Skill activation during creation and replacement without mutating the parent', async () => {
    /** Uses admitted Skill behavior so activation is the only invalid selection fact. */
    const skill = await skillFixture(229);
    /** Shares valid Model and Budget behavior across creation and replacement attacks. */
    const model = modelFixture(231);
    /** Provides one valid policy so no unrelated selection check can mask activation admission. */
    const budget = defineBudgetPolicy({ outputTokens: 800 }, budgetContext(233));

    expect(() =>
      createAgentProfile({ model, skills: [{ skill, activation: 'bogus' as never }], budget }, profileContext(235)),
    ).toThrow(expect.objectContaining({ code: 'resources_invalid_profile' }));

    /** Creates a legal parent whose replacement must remain unchanged after the invalid command. */
    const parent = createAgentProfile(
      { model, skills: [{ skill, activation: 'discoverable' }], budget },
      profileContext(237),
    );
    /** Cast bypasses TypeScript so runtime behavior must refuse the invalid activation string. */
    const replaced = replaceAgentProfileSelections(parent, {
      expectedRevision: 0,
      revisionId: uuid(239) as AgentProfileRevisionId,
      observedAt: timestamp(1),
      model,
      skills: [{ skill, activation: 'bogus' as never }],
      budget,
    });

    expect(replaced).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_invalid_profile' }),
    });
    expect(parent.skills).toEqual([expect.objectContaining({ activation: 'discoverable' })]);
    expect(parent.revision).toBe(0);
  });

  it('renames through an explicit child command and refuses stale or no-op commands unchanged', () => {
    /** Creates the exact parent used by successful, stale, and no-change commands. */
    const profile = createAgentProfile(
      { model: modelFixture(230), budget: defineBudgetPolicy({ outputTokens: 800 }, budgetContext(232)) },
      profileContext(234, 5),
    );
    /** Uses fresh child facts to prove rename preserves identity and selection behavior. */
    const renamed = renameAgentProfile(profile, {
      expectedRevision: 0,
      revisionId: uuid(236) as AgentProfileRevisionId,
      observedAt: timestamp(4),
      name: 'Order support',
    });
    /** Uses an old expected revision so refusal occurs before child state can be constructed. */
    const stale = renameAgentProfile(profile, {
      expectedRevision: 1,
      revisionId: uuid(237) as AgentProfileRevisionId,
      observedAt: timestamp(6),
      name: 'Stale',
    });
    /** Repeats the current name so no-change refusal remains distinct from stale refusal. */
    const noChange = renameAgentProfile(profile, {
      expectedRevision: 0,
      revisionId: uuid(238) as AgentProfileRevisionId,
      observedAt: timestamp(6),
      name: profile.name,
    });
    /** Reuses the exact parent revision UUID while changing the name to isolate ancestry refusal. */
    const reusedRevisionId = renameAgentProfile(profile, {
      expectedRevision: 0,
      revisionId: profile.revisionId,
      observedAt: timestamp(6),
      name: 'Impossible child',
    });
    /** Reuses the stable profile identity so child facts cannot collapse logical and revision roles. */
    const collidingLogicalId = renameAgentProfile(profile, {
      expectedRevision: 0,
      revisionId: profile.id as never,
      observedAt: timestamp(6),
      name: 'Colliding child',
    });

    expect(renamed).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: profile.id,
        revision: 1,
        previousRevisionId: profile.revisionId,
        updatedAt: profile.updatedAt,
        name: 'Order support',
      }),
    });
    expect(stale).toEqual({ ok: false, error: expect.objectContaining({ code: 'profile_revision_stale' }) });
    expect(noChange).toEqual({ ok: false, error: expect.objectContaining({ code: 'profile_transition_no_change' }) });
    expect(reusedRevisionId).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_invalid_profile' }),
    });
    expect(collidingLogicalId).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_invalid_profile' }),
    });
    expect(profile.revision).toBe(0);
  });

  it('activates one selected discoverable Skill only for a new profile revision', async () => {
    /** Provides a discoverable real Skill whose activation can change without file loading. */
    const skill = await skillFixture(240);
    /** Creates the exact profile parent with the Skill initially discoverable. */
    const profile = createAgentProfile(
      {
        model: modelFixture(242),
        skills: [{ skill, activation: 'discoverable' }],
        budget: defineBudgetPolicy({ outputTokens: 800 }, budgetContext(244)),
      },
      profileContext(246),
    );
    /** Activates through explicit child facts so current ResourceSet behavior cannot mutate. */
    const activated = activateSkill(profile, {
      expectedRevision: 0,
      revisionId: uuid(248) as AgentProfileRevisionId,
      observedAt: timestamp(1),
      skillId: skill.id,
    });
    if (!activated.ok) throw activated.error;
    /** Repeats activation on the child to prove already-active is a distinct refusal. */
    const alreadyActive = activateSkill(activated.value, {
      expectedRevision: 1,
      revisionId: uuid(249) as AgentProfileRevisionId,
      observedAt: timestamp(2),
      skillId: skill.id,
    });
    /** Names an unselected Skill identity so activation cannot add selections implicitly. */
    const missing = activateSkill(profile, {
      expectedRevision: 0,
      revisionId: uuid(250) as AgentProfileRevisionId,
      observedAt: timestamp(2),
      skillId: uuid(251) as typeof skill.id,
    });

    expect(profile.skills[0]?.activation).toBe('discoverable');
    expect(activated.value.skills[0]?.activation).toBe('active');
    expect(alreadyActive).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'profile_skill_already_active' }),
    });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'profile_skill_not_selected' }) });
  });

  it('replaces complete selections in supplied order without mutating the parent', () => {
    /** Provides the original Prompt behavior retained by the parent profile. */
    const initialPrompt = definePrompt({ placement: 'system', template: 'Initial.' }, promptContext(260));
    /** Creates one exact parent selection whose complete replacement can be compared. */
    const profile = createAgentProfile(
      {
        model: modelFixture(262),
        prompts: [initialPrompt],
        budget: defineBudgetPolicy({ outputTokens: 800 }, budgetContext(264)),
      },
      profileContext(266),
    );
    /** Provides different Prompt behavior so replacement is materially observable. */
    const replacement = definePrompt({ placement: 'system', template: 'Replacement.' }, promptContext(268));
    /** Replaces every selection through explicit child facts without mutating the parent. */
    const changed = replaceAgentProfileSelections(profile, {
      expectedRevision: 0,
      revisionId: uuid(270) as AgentProfileRevisionId,
      observedAt: timestamp(1),
      model: modelFixture(272),
      prompts: [replacement],
      budget: defineBudgetPolicy({ wallTimeMs: 5_000 }, budgetContext(274)),
    });

    expect(changed).toEqual({
      ok: true,
      value: expect.objectContaining({
        revision: 1,
        prompts: [expect.objectContaining({ revisionId: replacement.revisionId })],
      }),
    });
    expect(profile.prompts).toEqual([expect.objectContaining({ revisionId: initialPrompt.revisionId })]);
  });
});
