/** @file Proves DTO decoding remains data and explicit hydration re-earns exact behavior. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memoryFileStore } from '@archer/files';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineBudgetPolicy, narrowBudgetPolicy } from '../src/entrypoints/budgets.js';
import { createAgentProfile, type AgentProfileRevisionId } from '../src/entrypoints/profiles.js';
import { definePrompt, importPromptFile, revisePrompt } from '../src/entrypoints/prompts.js';
import { importSkillDirectory } from '../src/entrypoints/skills.js';
import {
  hydrateAgentProfile,
  hydrateBudgetPolicy,
  hydratePrompt,
  hydrateResourceSet,
  hydrateSkill,
} from '../src/hydration/index.js';
import { createLocalResources, nodeResourceSourceImporter } from '../src/index.js';
import {
  AgentProfileCodec,
  BudgetPolicyCodec,
  PromptCodec,
  ResourceSetCodec,
  SkillCodec,
  encodePrompt,
  encodeResourceSet,
} from '../src/transport/index.js';
import {
  budgetContext,
  budgetRevisionContext,
  createSkillDirectory,
  modelFixture,
  profileContext,
  promptContext,
  promptRevisionContext,
  skillContext,
  timestamp,
  uuid,
} from './support.js';

/** Test-owned temporary roots removed after each boundary test. */
const cleanups: (() => Promise<void>)[] = [];

/** Removes only roots registered by the current test. */
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Resource transport and hydration', () => {
  it('decodes detached immutable DTO data without granting domain behavior', () => {
    /** Creates real Prompt behavior so transport proof begins at an admitted owner. */
    const prompt = definePrompt({ placement: 'system', template: 'Support {{company}}.' }, promptContext(600));
    /** Encodes through Prompt behavior rather than hand-authoring a DTO fixture. */
    const encoded = encodePrompt(prompt);
    /** Makes caller-owned nested transport data mutable so defensive decoding is observable. */
    const mutable = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
    /** Decodes after mutation to prove the result is detached and deeply immutable. */
    const decoded = PromptCodec.parse(mutable);
    mutable.name = 'Changed later';

    expect(decoded.name).toBe(prompt.name);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect('render' in decoded).toBe(false);
    expect(() => PromptCodec.parse({ ...decoded, extra: true })).toThrow();
    expect(PromptCodec.safeParse({ ...decoded, revisionId: decoded.id }).ok).toBe(false);
  });

  it('hydrates initial Prompt and BudgetPolicy methods only through the explicit boundary', async () => {
    /** Provides initial Prompt behavior for the successful explicit hydration path. */
    const prompt = definePrompt({ placement: 'user', template: 'Ticket {{ticket}}.' }, promptContext(610));
    /** Provides initial BudgetPolicy behavior so multiple domain owners cross the same boundary. */
    const budget = defineBudgetPolicy({ outputTokens: 800 }, budgetContext(612));
    /** Restores Prompt methods only through the Prompt hydration capability. */
    const hydratedPrompt = await hydratePrompt({ dto: PromptCodec.parse(prompt.toJSON()) });
    /** Restores BudgetPolicy methods only through the Budget hydration capability. */
    const hydratedBudget = hydrateBudgetPolicy({ dto: BudgetPolicyCodec.parse(budget.toJSON()) });
    if (!hydratedPrompt.ok || !hydratedBudget.ok) throw new Error('Expected initial behavior hydration');

    expect(hydratedPrompt.value.render({ ticket: 'T-42' })).toEqual({
      ok: true,
      value: expect.objectContaining({ content: 'Ticket T-42.' }),
    });
    expect(hydratedBudget.value.ceilings).toEqual({ outputTokens: 800 });
  });

  it('requires the exact admitted parent for every child revision', async () => {
    /** Creates one exact Prompt parent for legal and unrelated-parent child restoration. */
    const prompt = definePrompt({ placement: 'system', template: 'First.' }, promptContext(620));
    /** Creates a production-valid child whose ancestry must be re-established. */
    const child = revisePrompt(prompt, { template: 'Second.' }, promptRevisionContext(622));
    if (!child.ok) throw child.error;
    /** Uses equivalent content with different identity to prove exact-parent checks are nominal. */
    const unrelated = definePrompt({ placement: 'system', template: 'First.' }, promptContext(624));
    expect(await hydratePrompt({ dto: child.value.toJSON() })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_hydration_failed' }),
    });
    expect(await hydratePrompt({ dto: child.value.toJSON(), parent: unrelated })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_hydration_failed' }),
    });
    expect((await hydratePrompt({ dto: child.value.toJSON(), parent: prompt })).ok).toBe(true);

    /** Creates one exact BudgetPolicy parent for its child hydration proof. */
    const policy = defineBudgetPolicy({ outputTokens: 1_000 }, budgetContext(626));
    /** Creates a legal narrowed child whose parent cannot be inferred from matching fields. */
    const narrowed = narrowBudgetPolicy(policy, { outputTokens: 500 }, budgetRevisionContext(628));
    if (!narrowed.ok) throw narrowed.error;
    expect(hydrateBudgetPolicy({ dto: narrowed.value.toJSON() })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_hydration_failed' }),
    });
    expect(hydrateBudgetPolicy({ dto: narrowed.value.toJSON(), parent: policy }).ok).toBe(true);
  });

  it('rechecks imported Prompt source bytes before restoring rendering behavior', async () => {
    /** Owns the temporary Prompt source lifecycle used by the real file importer. */
    const root = await mkdtemp(join(tmpdir(), 'archer-prompt-hydration-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    /** Names the source file whose later byte change hydration must observe. */
    const source = join(root, 'support.md');
    await writeFile(source, 'Support {{company}}.', 'utf8');
    /** Retains imported source bytes in caller-owned immutable storage across host edits. */
    const files = memoryFileStore();
    /** Imports through production source acquisition before corrupting the host copy. */
    const imported = await importPromptFile(
      { source, placement: 'system' },
      { files, source: nodeResourceSourceImporter(), context: promptContext(630) },
    );
    if (!imported.ok) throw imported.error;

    expect(await hydratePrompt({ dto: imported.value.toJSON() })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_hydration_failed' }),
    });
    /** Attempts hydration after source change to prove immutable snapshot, not host path, is authoritative. */
    const hydrated = await hydratePrompt({ dto: imported.value.toJSON(), files });
    expect(hydrated.ok).toBe(true);
  });

  it('hydrates Skill behavior from immutable storage after the host directory is gone', async () => {
    /** Creates a real Agent Skills directory so restoration crosses the actual file plane. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Retains the complete imported Skill tree after the host directory is removed. */
    const files = memoryFileStore();
    /** Imports and validates behavior before deleting its original physical source. */
    const imported = await importSkillDirectory(
      { directory: fixture.directory },
      { files, context: skillContext(640) },
    );
    if (!imported.ok) throw imported.error;
    /** Decodes only portable Skill state after behavior has been acquired. */
    const dto = SkillCodec.parse(imported.value.toJSON());
    await rm(fixture.directory, { recursive: true, force: true });
    /** Restores behavior from immutable content without consulting the deleted host directory. */
    const hydrated = await hydrateSkill({ dto, files });

    expect(hydrated.ok).toBe(true);
    if (hydrated.ok) expect(hydrated.value.instructions()).toContain('Check the order status reference');
  });

  it('hydrates AgentProfile only from exact selected behavior and exact parent state', async () => {
    /** Creates a Skill selected by the AgentProfile hydration scenario. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Keeps Skill content available so hydrated profile bindings retain real behavior. */
    const files = memoryFileStore();
    /** Imports one exact Skill revision for the profile selection. */
    const skill = await importSkillDirectory({ directory: fixture.directory }, { files, context: skillContext(650) });
    if (!skill.ok) throw skill.error;
    /** Provides admitted Model behavior because profile DTO data cannot restore it. */
    const model = modelFixture(652);
    /** Provides admitted Prompt behavior because contribution methods are not transport data. */
    const prompt = definePrompt({ placement: 'system', template: 'Be direct.' }, promptContext(654));
    /** Provides admitted Budget behavior because allocation methods are not transport data. */
    const budget = defineBudgetPolicy({ outputTokens: 800 }, budgetContext(656));
    /** Creates the exact behavior-bearing profile whose DTO will cross the boundary. */
    const profile = createAgentProfile(
      { model, prompts: [prompt], skills: [{ skill: skill.value, activation: 'active' }], budget },
      profileContext(658),
    );
    /** Decodes portable profile state independently from its private behavior graph. */
    const dto = AgentProfileCodec.parse(profile.toJSON());

    /** Reconnects exact Model, Prompt, Skill, and Budget owners through explicit hydration. */
    const hydratedProfile = hydrateAgentProfile({
      dto,
      model,
      prompts: [prompt],
      skills: [{ skill: skill.value, activation: 'active' }],
      budget,
    });
    if (!hydratedProfile.ok) throw hydratedProfile.error.cause;
    expect(hydratedProfile.value.toJSON()).toEqual(dto);
    expect(
      hydrateAgentProfile({
        dto,
        model: modelFixture(660),
        prompts: [prompt],
        skills: [{ skill: skill.value, activation: 'active' }],
        budget,
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_hydration_failed' }) });

    /** Creates a legal child to prove later profile revisions require exact parent behavior. */
    const child = profile.rename({
      expectedRevision: 0,
      revisionId: uuid(662) as AgentProfileRevisionId,
      observedAt: timestamp(1),
      name: 'Renamed support',
    });
    if (!child.ok) throw child.error;
    expect(
      hydrateAgentProfile({
        dto: child.value.toJSON(),
        model,
        prompts: [prompt],
        skills: [{ skill: skill.value, activation: 'active' }],
        budget,
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_hydration_failed' }) });
  });

  it('hydrates a local ResourceSet only after application authentication', async () => {
    /** Seeds deterministic UUID generation for the local ResourceSet hydration fixture. */
    let next = 680;
    /** Builds one application-owned graph whose local receipt can be authenticated. */
    const resources = createLocalResources({
      files: memoryFileStore(),
      /**
       * Returns production-valid sequential UUIDv4 values for every local fact.
       * @returns Fresh deterministic UUIDv4.
       */
      createId: () => uuid(next++),
      /**
       * Pins trusted time so receipt reconstruction compares exact envelope fields.
       * @returns Fixed trusted test timestamp.
       */
      now: () => timestamp(),
    });
    /** Creates the exact graph-owned profile used to compile local policy evidence. */
    const profile = resources.profiles.create({
      model: modelFixture(700),
      budget: resources.budgets.define({ outputTokens: 800 }),
    });
    /** Obtains the closed ResourceSet through the ordinary local bind path. */
    const compiled = resources.bind(profile).resourceSet;
    /** Decodes the receipt without carrying its process-local behavior binding. */
    const dto = ResourceSetCodec.parse(encodeResourceSet(compiled));
    /** Records successful application authentication over the exact restored receipt. */
    const authenticate = vi.fn(() => true);
    /** Restores the local set only after profile behavior and application provenance agree. */
    const hydrated = await hydrateResourceSet({ dto, profile, admission: { mode: 'local', authenticate } });
    /** Uses the same receipt with denied provenance to prove parsing alone cannot restore it. */
    const refused = await hydrateResourceSet({
      dto,
      profile,
      admission: {
        mode: 'local',
        /**
         * Refuses application provenance to prove local hydration cannot bypass authentication.
         * @returns False for every decoded local receipt.
         */
        authenticate: () => false,
      },
    });

    if (!hydrated.ok) throw hydrated.error.cause;
    expect(hydrated.value.toJSON()).toEqual(dto);
    expect(authenticate).toHaveBeenCalledWith(dto);
    expect(refused).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_hydration_failed' }) });
  });
});
