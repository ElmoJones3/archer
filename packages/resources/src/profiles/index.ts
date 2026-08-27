/**
 * @file Defines reusable AgentProfile selection behavior and pure legal changes.
 *
 * Profiles select exact behavior-bearing Resources. They do not load files,
 * persist themselves, deduplicate commands, or mutate an already-compiled set.
 */

import * as z from 'zod';

import {
  Result,
  TimestampSchema,
  UuidV4Schema,
  type ArcherObject,
  type Result as ResultValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '@archer/core';
import { modelRef, type Model, type ModelRef } from '@archer/models';

import { budgetPolicyRef, type BudgetPolicy, type BudgetPolicyRef } from '../budgets/index.js';
import { resourceDigest, resourcePetname } from '../common.js';
import { ResourcesError } from '../errors.js';
import { promptRef, type Prompt, type PromptRef } from '../prompts/index.js';
import { skillRef, type Skill, type SkillId, type SkillRef } from '../skills/index.js';

/** Prevents unrelated UUIDs from naming an AgentProfile. */
declare const agentProfileIdBrand: unique symbol;

/** Stable identity shared by every immutable AgentProfile revision. */
export type AgentProfileId = UuidV4 & {
  /** Carries compile-time evidence of AgentProfile identity admission. */
  readonly [agentProfileIdBrand]: true;
};

/** Prevents profile identity from posing as one exact profile revision. */
declare const agentProfileRevisionIdBrand: unique symbol;

/** Identity of one exact immutable AgentProfile revision. */
export type AgentProfileRevisionId = UuidV4 & {
  /** Carries compile-time evidence of AgentProfile revision admission. */
  readonly [agentProfileRevisionIdBrand]: true;
};

/** Progressive disclosure states owned by an AgentProfile selection. */
export type SkillActivation = 'discoverable' | 'active';

/** Exact Skill selection retained by a portable profile. */
export type AgentProfileSkillSelection = Readonly<{
  /** Exact behavior-bearing Skill reference. */
  skill: SkillRef;

  /** Whether preparation discloses only summary or complete instructions. */
  activation: SkillActivation;
}>;

/** Portable exact AgentProfile reference retained by ResourceSet receipts. */
export type AgentProfileRef = Readonly<{
  /** Stable logical profile identity. */
  id: AgentProfileId;

  /** Exact immutable profile revision. */
  revisionId: AgentProfileRevisionId;

  /** Human-facing reusable profile name. */
  name: string;

  /** Selection content identity independent from lifecycle metadata. */
  contentDigest: Sha256Digest;
}>;

/** Skill selection input accepted by profile creation and replacement. */
export type SelectSkillInput = Readonly<{
  /** Behavior-bearing Skill revision to select. */
  skill: Skill;

  /** Initial progressive-disclosure state. */
  activation: SkillActivation;
}>;

/** Complete behavior-bearing selections owned by one AgentProfile revision. */
export type AgentProfileSelectionsInput = Readonly<{
  /** One exact immutable Model configuration. */
  model: Model;

  /** Ordered Prompt revisions selected for composition. */
  prompts?: readonly Prompt[];

  /** Ordered Skill revisions and their disclosure state. */
  skills?: readonly SelectSkillInput[];

  /** One reusable policy used to allocate every prepared step. */
  budget: BudgetPolicy;
}>;

/** Input accepted by initial AgentProfile creation. */
export type CreateAgentProfileInput = AgentProfileSelectionsInput &
  Readonly<{
    /** Optional human label; Archer generates a four-part petname when omitted. */
    name?: string;
  }>;

/** Exact identity and time facts accepted by deterministic profile creation. */
export type AgentProfileCreationContext = Readonly<{
  /** Supplies the logical profile UUIDv4. */
  id: AgentProfileId;

  /** Supplies the initial immutable profile revision UUIDv4. */
  revisionId: AgentProfileRevisionId;

  /** Supplies the trusted instant used for both initial timestamps. */
  observedAt: Timestamp;
}>;

/** Shared precondition and child facts required by every profile modifier. */
export type AgentProfileCommand = Readonly<{
  /** Refuses a command observed against a different profile revision number. */
  expectedRevision: number;

  /** Supplies a fresh UUIDv4 for the child profile revision. */
  revisionId: AgentProfileRevisionId;

  /** Supplies the trusted observation used to derive causal update time. */
  observedAt: Timestamp;
}>;

/** Command accepted by AgentProfile rename behavior. */
export type RenameAgentProfileCommand = AgentProfileCommand &
  Readonly<{
    /** Complete replacement display label. */
    name: string;
  }>;

/** Command accepted by complete selection replacement behavior. */
export type ReplaceAgentProfileSelectionsCommand = AgentProfileCommand & AgentProfileSelectionsInput;

/** Command accepted by discoverable Skill activation behavior. */
export type ActivateSkillCommand = AgentProfileCommand &
  Readonly<{
    /** Stable logical Skill identity already selected as discoverable. */
    skillId: SkillId;
  }>;

/** Complete intrinsic AgentProfile state used by projection and hydration boundaries. */
export type AgentProfileState = ArcherObject<'agent-profile', AgentProfileId> &
  Readonly<{
    /** Exact immutable profile revision. */
    revisionId: AgentProfileRevisionId;

    /** Zero-based profile revision number. */
    revision: number;

    /** Exact parent profile revision after initial creation. */
    previousRevisionId?: AgentProfileRevisionId;

    /** Causal instant when this revision was earned. */
    updatedAt: Timestamp;

    /** Human-facing reusable label. */
    name: string;

    /** Exact selected Model reference. */
    model: ModelRef;

    /** Exact selected Prompt references in composition order. */
    prompts: readonly PromptRef[];

    /** Exact selected Skills with disclosure state. */
    skills: readonly AgentProfileSkillSelection[];

    /** Exact selected BudgetPolicy reference. */
    budget: BudgetPolicyRef;

    /** Deterministic identity over selections only. */
    contentDigest: Sha256Digest;
  }>;

/** Behavior objects retained process-locally without entering the profile DTO. */
export type AgentProfileBindings = Readonly<{
  /** Borrowed exact Model configuration. */
  model: Model;

  /** Borrowed immutable Prompt behavior owners. */
  prompts: readonly Prompt[];

  /** Borrowed immutable Skill behavior owners plus activation. */
  skills: readonly SelectSkillInput[];

  /** Borrowed immutable BudgetPolicy behavior owner. */
  budget: BudgetPolicy;
}>;

/** Runtime-only token prevents ordinary callers from invoking the class constructor. */
const PROFILE_CONSTRUCTION = Symbol('archer.profile.construction');

/** Runtime provenance distinguishes legal profile behavior from DTO copies and casts. */
const ADMITTED_AGENT_PROFILES = new WeakSet<object>();

/** Package-private projection lets compilers reach bindings without a public escape hatch. */
const AGENT_PROFILE_BINDINGS = new WeakMap<AgentProfile, AgentProfileBindings>();

/** Human-facing profile name boundary shared by creation and rename behavior. */
const ProfileNameSchema = z.string().trim().min(1).max(256);

/** Runtime boundary prevents JavaScript or casts from inventing disclosure states. */
const SkillActivationSchema = z.enum(['discoverable', 'active']);

/**
 * Normalizes optional selection arrays and proves complete runtime provenance.
 * @param input - Behavior-bearing Model, Prompt, Skill, and BudgetPolicy selections.
 * @returns Deeply immutable borrowed bindings.
 */
function admitBindings(input: AgentProfileSelectionsInput): AgentProfileBindings {
  /** Reference projections prove every object was created or exactly hydrated by its owner. */
  modelRef(input.model);
  budgetPolicyRef(input.budget);
  /** Copies Prompt selections so later caller mutation cannot change profile behavior. */
  const prompts = Object.freeze([...(input.prompts ?? [])]);
  /** Copies Skill selections while admitting every disclosure state at the behavior boundary. */
  const skills = Object.freeze(
    (input.skills ?? []).map((selection) =>
      Object.freeze({ skill: selection.skill, activation: SkillActivationSchema.parse(selection.activation) }),
    ),
  );
  prompts.forEach(promptRef);
  skills.forEach((selection) => skillRef(selection.skill));

  /** Both logical and revision identities must remain unambiguous within each ordered family. */
  const selectedRefs = [
    modelRef(input.model),
    ...prompts.map(promptRef),
    ...skills.map((selection) => skillRef(selection.skill)),
    budgetPolicyRef(input.budget),
  ];
  /** Collects logical identities separately because two revisions of one Resource are still ambiguous. */
  const logicalIds = selectedRefs.map((reference) => reference.id);
  /** Collects revision identities so one immutable revision cannot occupy two profile slots. */
  const revisionIds = selectedRefs.map((reference) => reference.revisionId);
  if (new Set(logicalIds).size !== logicalIds.length || new Set(revisionIds).size !== revisionIds.length) {
    throw new ResourcesError('profile_selection_duplicate', 'AgentProfile selections must have unique identities');
  }

  return Object.freeze({
    model: input.model,
    prompts,
    skills,
    budget: input.budget,
  });
}

/**
 * Projects portable selections while preserving profile order and disclosure state.
 * @param bindings - Exact process-local behavior selected by the profile.
 * @returns Immutable portable selection fields.
 */
function portableSelections(bindings: AgentProfileBindings): Readonly<{
  /** Exact selected Model reference. */
  model: ModelRef;

  /** Ordered exact Prompt references. */
  prompts: readonly PromptRef[];

  /** Ordered exact Skill references and activation. */
  skills: readonly AgentProfileSkillSelection[];

  /** Exact selected BudgetPolicy reference. */
  budget: BudgetPolicyRef;
}> {
  return Object.freeze({
    model: modelRef(bindings.model),
    prompts: Object.freeze(bindings.prompts.map(promptRef)),
    skills: Object.freeze(
      bindings.skills.map((selection) =>
        Object.freeze({ skill: skillRef(selection.skill), activation: selection.activation }),
      ),
    ),
    budget: budgetPolicyRef(bindings.budget),
  });
}

/**
 * Admits explicit initial facts supplied by an application composition boundary.
 * @param context - Exact profile identity and time.
 * @returns Complete validated profile creation facts.
 */
function initialProfileContext(context: AgentProfileCreationContext): AgentProfileCreationContext {
  /** Logical and revision UUIDs identify different facts even when supplied by deterministic callers. */
  const id = UuidV4Schema.parse(context.id) as AgentProfileId;
  /** Initial revision identity must not alias the stable profile identity. */
  const revisionId = UuidV4Schema.parse(context.revisionId) as AgentProfileRevisionId;
  if (String(id) === String(revisionId)) {
    throw new TypeError('AgentProfile logical and revision identities must differ');
  }
  return Object.freeze({
    id,
    revisionId,
    observedAt: TimestampSchema.parse(context.observedAt),
  });
}

/**
 * Validates a profile command precondition before any semantic rule runs.
 * @param profile - Exact current AgentProfile.
 * @param command - Expected revision, child identity, and trusted time.
 * @returns Parsed child facts or exact stale refusal.
 */
function admitCommand(
  profile: AgentProfile,
  command: AgentProfileCommand,
): ResultValue<
  Readonly<{
    /** Supplies the fresh revision identity used only after the command passes. */
    revisionId: AgentProfileRevisionId;
    /** Supplies the causal timestamp derived from the trusted observation. */
    updatedAt: Timestamp;
  }>,
  ResourcesError
> {
  if (!ADMITTED_AGENT_PROFILES.has(profile)) {
    return Result.error(new ResourcesError('resources_invalid_profile', 'Profile behavior requires admitted state'));
  }
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== profile.revision) {
    return Result.error(
      new ResourcesError('profile_revision_stale', 'AgentProfile command observed a stale revision', {
        details: { expectedRevision: command.expectedRevision, actualRevision: profile.revision },
      }),
    );
  }
  try {
    /** Admits the proposed child UUID only after the expected-revision precondition succeeds. */
    const revisionId = UuidV4Schema.parse(command.revisionId) as AgentProfileRevisionId;
    if (String(revisionId) === String(profile.id) || revisionId === profile.revisionId) {
      throw new TypeError('AgentProfile child revision identity must be fresh and distinct');
    }
    /** Admits trusted time independently so malformed clocks cannot create profile children. */
    const observedAt = TimestampSchema.parse(command.observedAt);
    /** Clamps backward observations to preserve causal nondecreasing revision time. */
    const updatedAt = observedAt < profile.updatedAt ? profile.updatedAt : observedAt;
    return Result.ok(Object.freeze({ revisionId, updatedAt }));
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_invalid_profile', 'Invalid AgentProfile command facts', { cause }),
    );
  }
}

/**
 * Projects one exact AgentProfile reference for ResourceSet compilation.
 * @param profile - Behavior-bearing profile whose revision is selected.
 * @returns Frozen portable exact reference.
 */
export function agentProfileRef(profile: AgentProfile): AgentProfileRef {
  if (!ADMITTED_AGENT_PROFILES.has(profile)) {
    throw new ResourcesError('resources_invalid_profile', 'AgentProfile reference requires admitted behavior');
  }
  return Object.freeze({
    id: profile.id,
    revisionId: profile.revisionId,
    name: profile.name,
    contentDigest: profile.contentDigest,
  });
}

/**
 * Returns exact process-local selections only to package implementation modules.
 * @param profile - Admitted profile whose behavior bindings are required for compilation.
 * @returns Immutable borrowed Resource owners selected by the profile.
 * @internal
 */
export function agentProfileBindings(profile: AgentProfile): AgentProfileBindings {
  /** Looks up the private behavior graph that structural profile copies cannot reproduce. */
  const bindings = AGENT_PROFILE_BINDINGS.get(profile);
  if (bindings === undefined) {
    throw new ResourcesError('resources_invalid_profile', 'AgentProfile bindings require admitted behavior');
  }
  return bindings;
}

/** Reusable immutable selection that owns legal profile changes, not persistence. */
export class AgentProfile {
  /** Stable logical AgentProfile identity. */
  readonly id: AgentProfileId;

  /** Stable wire discriminator. */
  readonly object = 'agent-profile' as const;

  /** First creation instant shared by every revision. */
  readonly createdAt: Timestamp;

  /** Human-facing reusable label. */
  readonly name: string;

  /** Exact immutable profile revision identity. */
  readonly revisionId: AgentProfileRevisionId;

  /** Zero-based immutable revision number. */
  readonly revision: number;

  /** Exact parent revision after initial creation. */
  readonly previousRevisionId?: AgentProfileRevisionId;

  /** Causal instant this exact revision was earned. */
  readonly updatedAt: Timestamp;

  /** Exact selected Model reference. */
  readonly model: ModelRef;

  /** Exact selected Prompt references in composition order. */
  readonly prompts: readonly PromptRef[];

  /** Exact selected Skills with progressive disclosure state. */
  readonly skills: readonly AgentProfileSkillSelection[];

  /** Exact selected BudgetPolicy reference. */
  readonly budget: BudgetPolicyRef;

  /** Deterministic identity over selection behavior only. */
  readonly contentDigest: Sha256Digest;

  /**
   * Installs already-admitted profile state behind a module-private token.
   * @param token - Module-private construction authority.
   * @param state - Complete immutable identity and portable selection state.
   * @param bindings - Exact process-local behavior owners.
   */
  protected constructor(token: typeof PROFILE_CONSTRUCTION, state: AgentProfileState, bindings: AgentProfileBindings) {
    if (token !== PROFILE_CONSTRUCTION) throw new TypeError('Use an AgentProfile factory');
    /** Revalidates every selected behavior owner before trusting portable profile state. */
    const admittedBindings = admitBindings(bindings);
    /** Projects only portable references after private behavior bindings have been admitted. */
    const selections = portableSelections(admittedBindings);
    /** Canonical digests compare exact JSON meaning without depending on object key insertion order. */
    const suppliedSelections = Object.freeze({
      model: state.model,
      prompts: state.prompts,
      skills: state.skills,
      budget: state.budget,
    });
    if (
      resourceDigest('archer.agent-profile.v1', selections) !==
      resourceDigest('archer.agent-profile.v1', suppliedSelections)
    ) {
      throw new ResourcesError('resources_invalid_profile', 'AgentProfile state does not match selected behavior');
    }
    this.id = state.id;
    this.createdAt = state.createdAt;
    this.name = ProfileNameSchema.parse(state.name);
    this.revisionId = state.revisionId;
    this.revision = state.revision;
    if (state.previousRevisionId !== undefined) this.previousRevisionId = state.previousRevisionId;
    this.updatedAt = state.updatedAt;
    this.model = selections.model;
    this.prompts = selections.prompts;
    this.skills = selections.skills;
    this.budget = selections.budget;
    this.contentDigest = resourceDigest('archer.agent-profile.v1', selections);
    if (this.contentDigest !== state.contentDigest) {
      throw new ResourcesError('resources_invalid_profile', 'AgentProfile content digest does not match selections');
    }
    AGENT_PROFILE_BINDINGS.set(this, admittedBindings);
    ADMITTED_AGENT_PROFILES.add(this);
    Object.freeze(this);
  }

  /**
   * Renames this profile through a stale-safe explicit command.
   * @param command - Expected revision, new label, child identity, and trusted time.
   * @returns Renamed child or exact refusal.
   */
  rename(command: RenameAgentProfileCommand): ResultValue<AgentProfile, ResourcesError> {
    return renameAgentProfile(this, command);
  }

  /**
   * Replaces the complete Resource selection through a stale-safe command.
   * @param command - Complete selections and explicit child facts.
   * @returns Child profile or exact refusal.
   */
  replaceSelections(command: ReplaceAgentProfileSelectionsCommand): ResultValue<AgentProfile, ResourcesError> {
    return replaceAgentProfileSelections(this, command);
  }

  /**
   * Activates one selected discoverable Skill through a stale-safe command.
   * @param command - Selected Skill identity and explicit child facts.
   * @returns Child profile or exact absent/already-active refusal.
   */
  activateSkill(command: ActivateSkillCommand): ResultValue<AgentProfile, ResourcesError> {
    return activateSkill(this, command);
  }
}

/**
 * Projects intrinsic AgentProfile state without exposing private behavior bindings.
 * @param profile - Exact admitted selection behavior.
 * @returns Frozen state suitable for a separate transport mapping.
 * @internal
 */
export function agentProfileState(profile: AgentProfile): AgentProfileState {
  if (!ADMITTED_AGENT_PROFILES.has(profile)) {
    throw new ResourcesError('resources_invalid_profile', 'Profile state projection requires admitted behavior');
  }
  return Object.freeze({
    id: profile.id,
    object: profile.object,
    createdAt: profile.createdAt,
    name: profile.name,
    revisionId: profile.revisionId,
    revision: profile.revision,
    ...(profile.previousRevisionId === undefined ? {} : { previousRevisionId: profile.previousRevisionId }),
    updatedAt: profile.updatedAt,
    model: profile.model,
    prompts: profile.prompts,
    skills: profile.skills,
    budget: profile.budget,
    contentDigest: profile.contentDigest,
  });
}

/** Package-local concrete profile keeps the public class non-constructible in TypeScript. */
class InstalledAgentProfile extends AgentProfile {
  /**
   * Delegates admitted state to AgentProfile's runtime-token-checked constructor.
   * @param token - Module-private construction authority.
   * @param state - Complete portable profile state.
   * @param bindings - Exact process-local behavior owners.
   */
  constructor(token: typeof PROFILE_CONSTRUCTION, state: AgentProfileState, bindings: AgentProfileBindings) {
    super(token, state, bindings);
  }
}

/**
 * Creates one legal initial AgentProfile from behavior-bearing Resource objects.
 * @param input - Exact selections and optional display label.
 * @param context - Explicit deterministic logical/revision identity and time.
 * @returns Immutable reusable profile beginning at revision zero.
 */
export function createAgentProfile(input: CreateAgentProfileInput, context: AgentProfileCreationContext): AgentProfile {
  try {
    /** Captures the exact behavior owners the initial profile will retain privately. */
    const bindings = admitBindings(input);
    /** Derives portable state from admitted behavior rather than caller-authored references. */
    const selections = portableSelections(bindings);
    /** Resolves initial identity and trusted time once for all profile envelope fields. */
    const facts = initialProfileContext(context);
    /** Generates an omitted display name from stable identity without changing selection content. */
    const name = ProfileNameSchema.parse(input.name ?? resourcePetname(facts.id));
    /** Builds portable initial state only after every behavior selection is admitted. */
    const state: AgentProfileState = Object.freeze({
      id: facts.id,
      object: 'agent-profile',
      createdAt: facts.observedAt,
      name,
      revisionId: facts.revisionId,
      revision: 0,
      updatedAt: facts.observedAt,
      ...selections,
      contentDigest: resourceDigest('archer.agent-profile.v1', selections),
    });
    return new InstalledAgentProfile(PROFILE_CONSTRUCTION, state, bindings);
  } catch (cause) {
    if (cause instanceof ResourcesError) throw cause;
    throw new ResourcesError('resources_invalid_profile', 'Invalid AgentProfile definition', { cause });
  }
}

/**
 * Builds one legal child state after command and semantic checks succeed.
 * @param parent - Exact admitted parent profile.
 * @param name - Child display label.
 * @param bindings - Complete child behavior selection.
 * @param command - Parsed explicit child facts.
 * @returns New immutable child AgentProfile.
 */
function createProfileChild(
  parent: AgentProfile,
  name: string,
  bindings: AgentProfileBindings,
  command: Readonly<{
    /** Carries the already-admitted child revision identity. */
    revisionId: AgentProfileRevisionId;
    /** Carries the already-derived causal update time. */
    updatedAt: Timestamp;
  }>,
): AgentProfile {
  /** Projects child selections from exact behavior owners to prevent state/binding divergence. */
  const selections = portableSelections(bindings);
  /** Preserves logical identity and ancestry while replacing only the child revision facts. */
  const state: AgentProfileState = Object.freeze({
    id: parent.id,
    object: 'agent-profile',
    createdAt: parent.createdAt,
    name,
    revisionId: command.revisionId,
    revision: parent.revision + 1,
    previousRevisionId: parent.revisionId,
    updatedAt: command.updatedAt,
    ...selections,
    contentDigest: resourceDigest('archer.agent-profile.v1', selections),
  });
  return new InstalledAgentProfile(PROFILE_CONSTRUCTION, state, bindings);
}

/**
 * Renames one exact profile revision without changing its Resource selections.
 * @param profile - Exact behavior-bearing parent profile.
 * @param command - Stale precondition, replacement name, and child facts.
 * @returns Renamed child or exact stale/no-change refusal.
 */
export function renameAgentProfile(
  profile: AgentProfile,
  command: RenameAgentProfileCommand,
): ResultValue<AgentProfile, ResourcesError> {
  /** Checks provenance and stale revision before attempting a rename. */
  const admitted = admitCommand(profile, command);
  if (!admitted.ok) return admitted;
  /** Separates parse failure from no-change refusal so both preserve the exact parent. */
  let name: string;
  try {
    name = ProfileNameSchema.parse(command.name);
  } catch (cause) {
    return Result.error(new ResourcesError('resources_invalid_profile', 'Invalid AgentProfile name', { cause }));
  }
  if (name === profile.name) {
    return Result.error(new ResourcesError('profile_transition_no_change', 'AgentProfile already has that name'));
  }
  return Result.ok(createProfileChild(profile, name, agentProfileBindings(profile), admitted.value));
}

/**
 * Replaces every Resource selection in one stale-safe profile transition.
 * @param profile - Exact behavior-bearing parent profile.
 * @param command - Complete replacement selection and child facts.
 * @returns Child profile or exact stale/duplicate/no-change refusal.
 */
export function replaceAgentProfileSelections(
  profile: AgentProfile,
  command: ReplaceAgentProfileSelectionsCommand,
): ResultValue<AgentProfile, ResourcesError> {
  /** Checks provenance and stale revision before validating replacement selections. */
  const admitted = admitCommand(profile, command);
  if (!admitted.ok) return admitted;
  /** Holds candidate bindings separately so a failed replacement cannot mutate the profile. */
  let bindings: AgentProfileBindings;
  try {
    bindings = admitBindings(command);
  } catch (cause) {
    /** Preserves exact selection errors while normalizing unexpected boundary failures. */
    const error =
      cause instanceof ResourcesError
        ? cause
        : new ResourcesError('resources_invalid_profile', 'Invalid AgentProfile selections', { cause });
    return Result.error(error);
  }
  /** Projects the candidate selection for an exact no-change comparison. */
  const next = portableSelections(bindings);
  /** Projects current private bindings so equality cannot be forged through public DTO fields. */
  const current = portableSelections(agentProfileBindings(profile));
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return Result.error(new ResourcesError('profile_transition_no_change', 'AgentProfile selections did not change'));
  }
  return Result.ok(createProfileChild(profile, profile.name, bindings, admitted.value));
}

/**
 * Activates one already-selected discoverable Skill for the next ResourceSet.
 * @param profile - Exact behavior-bearing parent profile.
 * @param command - Skill identity, stale precondition, and child facts.
 * @returns Child profile or exact missing/already-active refusal.
 */
export function activateSkill(
  profile: AgentProfile,
  command: ActivateSkillCommand,
): ResultValue<AgentProfile, ResourcesError> {
  /** Checks provenance and stale revision before evaluating Skill activation. */
  const admitted = admitCommand(profile, command);
  if (!admitted.ok) return admitted;
  /** Reads the exact private Skill selections retained by this profile revision. */
  const bindings = agentProfileBindings(profile);
  /** Finds by logical Skill identity because activation changes selection state, not Skill content. */
  const selected = bindings.skills.find((candidate) => candidate.skill.id === command.skillId);
  if (selected === undefined) {
    return Result.error(
      new ResourcesError('profile_skill_not_selected', 'Skill is not selected by this AgentProfile', {
        details: { skillId: command.skillId },
      }),
    );
  }
  if (selected.activation === 'active') {
    return Result.error(
      new ResourcesError('profile_skill_already_active', 'Skill is already active', {
        details: { skillId: command.skillId },
      }),
    );
  }
  /** Rebuilds the ordered Skill selection while changing only the requested activation. */
  const skills = bindings.skills.map((candidate) =>
    candidate.skill.id === command.skillId
      ? Object.freeze({ skill: candidate.skill, activation: 'active' as const })
      : candidate,
  );
  return Result.ok(
    createProfileChild(
      profile,
      profile.name,
      Object.freeze({ ...bindings, skills: Object.freeze(skills) }),
      admitted.value,
    ),
  );
}

/**
 * Reconstructs admitted AgentProfile state from exact hydrated Resources and parent verification.
 * @param state - Domain-validated exact profile state.
 * @param bindings - Hydrated behavior objects matching every exact reference.
 * @returns Behavior-bearing profile with persisted identity and revision.
 * @internal
 */
export function hydrateAgentProfileState(state: AgentProfileState, bindings: AgentProfileBindings): AgentProfile {
  return new InstalledAgentProfile(PROFILE_CONSTRUCTION, state, bindings);
}
