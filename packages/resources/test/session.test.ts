/** @file Proves the ordinary local Resource workflow prepares one exact finite model step. */

import { memoryFileStore } from '@archer/files';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResourcesError, bindCompiledResources, createLocalResources } from '../src/index.js';
import { createSkillDirectory, modelFixture, timestamp, uuid } from './support.js';

/** Temporary host-fixture cleanup owned by each test. */
const cleanups: (() => Promise<void>)[] = [];

/** Removes only test-owned temporary Skill directories. */
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * Supplies deterministic UUIDs for a complete local workflow.
 * @param start - First UUID tail sequence.
 * @returns Stable identity capability with one fresh UUID per call.
 */
function identitySequence(start: number): () => ReturnType<typeof uuid> {
  /** Advances one test-local counter so every created domain fact receives a fresh UUID. */
  let next = start;
  return () => uuid(next++);
}

describe('local Resource session', () => {
  it('prepares exact Prompt, Skill, Budget, Model, and ResourceSet evidence without executing a model', async () => {
    /** Creates a real Skill directory so request preparation proves file-backed behavior. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Counts trusted-clock reads to prove one preparation observes time exactly once. */
    const now = vi.fn(() => timestamp());
    /** Builds the ordinary local facade with deterministic identity, time, and application limits. */
    const resources = createLocalResources({
      files: memoryFileStore(),
      createId: identitySequence(400),
      now,
      applicationLimits: { outputTokens: 900, wallTimeMs: 5_000 },
    });
    /** Imports and validates the active playbook before it can enter a profile. */
    const skill = await resources.skills.importDirectory(fixture.directory);
    if (!skill.ok) throw skill.error;
    /** Defines a parameterized Prompt whose rendered text is observable downstream. */
    const prompt = resources.prompts.define({
      name: 'Support voice',
      placement: 'system',
      template: 'You support {{company}}.',
    });
    /** Defines looser wall time than the application limit so intersection is observable. */
    const budget = resources.budgets.define({ outputTokens: 800, wallTimeMs: 8_000 });
    /** Selects every Wave 6 Resource behavior in one reusable profile. */
    const profile = resources.profiles.create({
      name: 'Order support',
      model: modelFixture(420, 1_000),
      prompts: [prompt],
      skills: [{ skill: skill.value, activation: 'active' }],
      budget,
    });
    /** Compiles the exact local selection once for repeatable finite preparation. */
    const session = resources.bind(profile);
    /** Copies every visible receipt field to prove a spread loses private behavior binding. */
    const spread = { ...session.resourceSet } as typeof session.resourceSet;
    /** Inherits every visible field to prove prototype access cannot impersonate the compiled object. */
    const inherited = Object.create(session.resourceSet) as typeof session.resourceSet;
    expect(() => bindCompiledResources(spread)).toThrow(
      expect.objectContaining({ code: 'resources_invalid_resource_set' }),
    );
    expect(() => bindCompiledResources(inherited)).toThrow(
      expect.objectContaining({ code: 'resources_invalid_resource_set' }),
    );
    /** Records clock usage after construction so only preparation-time reads are counted. */
    const callsBeforePreparation = now.mock.calls.length;
    /** Prepares one request whose derived Prompt, Skill, Budget, and receipt are all asserted. */
    const prepared = session.prepareStep({
      promptInputs: { company: 'Acme' },
      history: [{ role: 'assistant', content: 'What can I check?' }],
      userMessage: 'Where is order A-42?',
      budgetRequest: { outputTokens: 700, wallTimeMs: 4_000 },
    });
    if (!prepared.ok) throw prepared.error;

    expect(now.mock.calls.length).toBe(callsBeforePreparation + 1);
    expect(prepared.value.request.instructions).toEqual([
      'You support Acme.',
      expect.stringContaining('Check the order status reference'),
    ]);
    expect(prepared.value.request.messages).toEqual([
      { role: 'assistant', content: 'What can I check?' },
      { role: 'user', content: 'Where is order A-42?' },
    ]);
    expect(prepared.value.request.tools).toEqual([]);
    expect(prepared.value.allocation).toEqual(
      expect.objectContaining({ outputTokens: 700, deadline: '2026-08-26T16:00:04.000Z' }),
    );
    expect(prepared.value.activeSkills).toEqual([expect.objectContaining({ revisionId: skill.value.revisionId })]);
    expect(prepared.value.resourceSet.admission).toEqual({ mode: 'local', policy: 'application' });
    expect(prepared.value.request.resourceSet).toEqual({
      id: prepared.value.resourceSet.id,
      object: 'resource-set',
      evidenceDigest: prepared.value.resourceSet.evidenceDigest,
    });
  });

  it('keeps discoverable Skill instructions private while returning a useful summary', async () => {
    /** Creates a real Skill directory for the discoverable-only disclosure path. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Builds an independent local graph so activation state cannot leak from another test. */
    const resources = createLocalResources({
      files: memoryFileStore(),
      createId: identitySequence(440),
      /**
       * Pins trusted time because the test is about disclosure, not the host clock.
       * @returns Fixed trusted test timestamp.
       */
      now: () => timestamp(),
    });
    /** Imports real Skill behavior before marking it discoverable. */
    const skill = await resources.skills.importDirectory(fixture.directory);
    if (!skill.ok) throw skill.error;
    /** Selects the Skill without activation so only its summary may enter the request. */
    const profile = resources.profiles.create({
      model: modelFixture(460),
      skills: [{ skill: skill.value, activation: 'discoverable' }],
      budget: resources.budgets.define({ outputTokens: 800 }),
    });
    /** Prepares a request that can expose any accidental full-instruction disclosure. */
    const prepared = resources.bind(profile).prepareStep({
      promptInputs: {},
      history: [],
      userMessage: 'Can you help with an order?',
    });
    if (!prepared.ok) throw prepared.error;

    expect(prepared.value.activeSkills).toEqual([]);
    expect(prepared.value.discoverableSkills).toEqual([
      expect.objectContaining({ name: 'order-support', description: expect.stringContaining('order questions') }),
    ]);
    expect(prepared.value.request.instructions).toEqual([
      'Available Skill: order-support — Helps a support rep answer order questions.',
    ]);
    expect(prepared.value.request.instructions.join('\n')).not.toContain('Check the order status reference');
  });

  it('uses a newly activated profile only for a newly compiled ResourceSet', async () => {
    /** Creates a real Skill directory shared by the old and new profile revisions. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Builds one local graph so both ResourceSets differ only by profile activation. */
    const resources = createLocalResources({
      files: memoryFileStore(),
      createId: identitySequence(480),
      /**
       * Pins trusted time because selection immutability, not clock behavior, is under proof.
       * @returns Fixed trusted test timestamp.
       */
      now: () => timestamp(),
    });
    /** Imports the exact Skill behavior selected by both profile revisions. */
    const skill = await resources.skills.importDirectory(fixture.directory);
    if (!skill.ok) throw skill.error;
    /** Starts with a discoverable selection whose compiled set must remain unchanged. */
    const profile = resources.profiles.create({
      model: modelFixture(500),
      skills: [{ skill: skill.value, activation: 'discoverable' }],
      budget: resources.budgets.define({ outputTokens: 800 }),
    });
    /** Binds the original profile before any activation child exists. */
    const current = resources.bind(profile);
    /** Creates a new profile revision without mutating the already-bound selection. */
    const activated = resources.profiles.activate(profile, skill.value);
    if (!activated.ok) throw activated.error;
    /** Binds the activated child to produce a distinct later ResourceSet. */
    const next = resources.bind(activated.value);
    /** Reuses identical application input so only Resource selection can change output. */
    const input = { promptInputs: {}, history: [], userMessage: 'Where is my order?' } as const;
    /** Prepares against the old set after activation to prove it remains immutable. */
    const currentStep = current.prepareStep(input);
    /** Prepares against the new set to prove activation becomes visible only after rebinding. */
    const nextStep = next.prepareStep(input);
    if (!currentStep.ok || !nextStep.ok) throw new Error('Expected both immutable selections to prepare');

    expect(current.resourceSet.id).not.toBe(next.resourceSet.id);
    expect(currentStep.value.activeSkills).toEqual([]);
    expect(nextStep.value.activeSkills).toEqual([expect.objectContaining({ id: skill.value.id })]);
  });

  it('rejects foreign profiles across local transitions and ResourceSet binding', () => {
    /** Creates the receiving graph whose local policy must reject foreign behavior. */
    const resources = createLocalResources({
      files: memoryFileStore(),
      createId: identitySequence(520),
      /**
       * Pins trusted time because graph provenance, not lifecycle ordering, is under proof.
       * @returns Fixed trusted test timestamp.
       */
      now: () => timestamp(),
    });
    /** Creates a separate graph-owned profile with structurally valid selected behavior. */
    const foreign = createLocalResources({
      files: memoryFileStore(),
      createId: identitySequence(540),
      /**
       * Pins the foreign graph time so provenance is the only reason binding is refused.
       * @returns Fixed trusted test timestamp.
       */
      now: () => timestamp(),
    }).profiles.create({
      model: modelFixture(560),
      budget: resources.budgets.define({ outputTokens: 800 }),
    });

    /** Local convenience transitions cannot launder a foreign profile into this graph's binding authority. */
    const renamed = resources.profiles.rename(foreign, 'Adopted support profile');
    /** Complete replacement is subject to the same graph-ownership precondition as rename. */
    const replaced = resources.profiles.replace(foreign, {
      model: modelFixture(570),
      budget: resources.budgets.define({ outputTokens: 700 }),
    });

    expect(renamed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_invalid_profile' }),
    });
    expect(replaced).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_invalid_profile' }),
    });
    expect(() => resources.bind(foreign)).toThrow(ResourcesError);
    expect(() => bindCompiledResources({} as never)).toThrow(
      expect.objectContaining({ code: 'resources_invalid_resource_set' }),
    );
  });
});
