/**
 * @file Binds local Resource behavior and prepares exact bounded model requests.
 *
 * The local facade owns no persistence or background lifecycle. It borrows
 * immutable files, source acquisition, identity generation, and trusted time.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  Result,
  TimestampSchema,
  UuidV4Schema,
  createUuidV4,
  type ArcherObject,
  type Result as ResultValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '@archer/core';
import { LogicalPathSchema, type FileStore } from '@archer/files';
import {
  createModelStepRequest,
  modelRef,
  type Model,
  type ModelMessage,
  type ModelStepRequest,
  type ModelStepRequestId,
  type ModelStepResourceSetRef,
  type ModelRef,
} from '@archer/models';

import {
  allocateBudget,
  budgetPolicyRef,
  createBudgetAllocationId,
  defineBudgetPolicy,
  narrowBudgetPolicy,
  type BudgetAllocation,
  type BudgetLimitsInput,
  type BudgetPolicy,
  type BudgetPolicyCreationContext,
  type BudgetPolicyRef,
  type BudgetPolicyRevisionContext,
} from './budgets/index.js';
import { resourceDigest, resourcePetname } from './common.js';
import { ResourcesError } from './errors.js';
import {
  activateSkill,
  agentProfileBindings,
  agentProfileRef,
  createAgentProfile,
  renameAgentProfile,
  replaceAgentProfileSelections,
  type ActivateSkillCommand,
  type AgentProfile,
  type AgentProfileCreationContext,
  type AgentProfileRef,
  type AgentProfileRevisionId,
  type CreateAgentProfileInput,
  type RenameAgentProfileCommand,
  type ReplaceAgentProfileSelectionsCommand,
} from './profiles/index.js';
import {
  composePromptContributions,
  definePrompt,
  importPromptFile,
  renderPrompt,
  revisePrompt,
  type DefinePromptInput,
  type ImportPromptFileInput,
  type Prompt,
  type PromptContribution,
  type PromptCreationContext,
  type PromptImportDependencies,
  type PromptRef,
  type PromptRevisionContext,
  type PromptSourceFile,
  type PromptSourceImporter,
  type RevisePromptInput,
} from './prompts/index.js';
import {
  fileStoreSkillContentReader,
  importSkillDirectory,
  loadSkillInstructions,
  loadSkillSupport,
  reimportSkillDirectory,
  skillRef,
  skillSummary,
  type ImportSkillDirectoryInput,
  type LoadedSkillSupport,
  type Skill,
  type SkillCreationContext,
  type SkillImportDependencies,
  type SkillRef,
  type SkillRevisionContext,
  type SkillSummary,
} from './skills/index.js';

/** Prevents unrelated UUIDs from naming a compiled ResourceSet. */
declare const resourceSetIdBrand: unique symbol;

/** Identity of one exact compiled ResourceSet fact. */
export type ResourceSetId = UuidV4 & {
  /** Carries compile-time evidence of ResourceSet identity admission. */
  readonly [resourceSetIdBrand]: true;
};

/** Exact identity and time facts used by ResourceSet compilation. */
export type ResourceSetCreationContext = Readonly<{
  /** Supplies the immutable ResourceSet UUIDv4. */
  id: ResourceSetId;

  /** Supplies the trusted compilation instant. */
  createdAt: Timestamp;
}>;

/** Every Resource revision kind admitted by Wave 6 compilation. */
export type ResourceKind = 'model' | 'prompt' | 'skill' | 'budget-policy';

/** Exact portable ref union retained in deterministic ResourceSet order. */
export type ResourceRevisionRef<Kind extends ResourceKind = ResourceKind> = Extract<
  ModelRef | PromptRef | SkillRef | BudgetPolicyRef,
  Readonly<{
    /** Preserves the Resource discriminator so generic references remain kind-safe. */
    resource: Kind;
  }>
>;

/** Explicit policy evidence distinguishing local use from reviewed admission. */
export type ResourceSetAdmission =
  | Readonly<{
      /** Local application ownership deliberately skips independent review ceremony. */
      mode: 'local';

      /** Names the exact local policy without impersonating independent review. */
      policy: 'application';
    }>
  | Readonly<{
      /** Reviewed compilation proves every selected revision has current admission. */
      mode: 'reviewed';

      /** Admission identities follow deterministic Resource order. */
      admissions: readonly UuidV4[];
    }>;

/** Portable ResourceSet state suitable for request evidence and transport. */
export type ResourceSetDto = ArcherObject<'resource-set', ResourceSetId> &
  Readonly<{
    /** Exact AgentProfile revision that selected every member. */
    profile: AgentProfileRef;

    /** Exact Resource refs in Model, Prompt, Skill, then Budget order. */
    resources: readonly ResourceRevisionRef[];

    /** Compiler protocol revision giving evidenceDigest its meaning. */
    compilerRevision: 1;

    /** Names local application policy or independently verified admissions. */
    admission: ResourceSetAdmission;

    /** Deterministic evidence identity over profile, refs, compiler, and policy. */
    evidenceDigest: Sha256Digest;
  }>;

/** Input accepted by finite Resource preparation. */
export type PrepareStepInput = Readonly<{
  /** Values satisfying the union of every selected Prompt declaration. */
  promptInputs: Readonly<Record<string, string>>;

  /** Already-acknowledged provider-neutral conversation history. */
  history: readonly ModelMessage[];

  /** Current application message that caused this model step. */
  userMessage: string;

  /** Optional desired limits refused when they exceed available authority. */
  budgetRequest?: BudgetLimitsInput;

  /** Optional exact parent allocation supplied by advanced nested work. */
  parentAllocation?: BudgetAllocation;
}>;

/** Backward-compatible name retained for existing imports during Wave 6 migration. */
export type PrepareResourceStepInput = PrepareStepInput;

/** One complete finite preparation ready for a caller-owned ModelRouter. */
export type PreparedModelStep = Readonly<{
  /** Exact provider-neutral request; no model effect has started yet. */
  request: ModelStepRequest;

  /** Pins the exact local or reviewed Resource selection. */
  resourceSet: ResourceSet;

  /** Effective generated-output limit and optional deadline. */
  allocation: BudgetAllocation;

  /** Ordered Prompt provenance without exposing contribution construction. */
  promptContributions: readonly PromptContribution[];

  /** Exact active Skill refs whose instructions entered the request. */
  activeSkills: readonly SkillRef[];

  /** Exact discoverable Skill summaries included in the request. */
  discoverableSkills: readonly SkillSummary[];
}>;

/** Application source acquisition port used by local Prompt imports. */
export type ResourceSourceImporter = PromptSourceImporter;

/** Caller-owned identity, time, files, and policy capabilities for local Resources. */
export type LocalResourceDependencies = Readonly<{
  /** Retains imported Prompt and Skill source in immutable content storage. */
  files: FileStore;

  /** Acquires stable Prompt files; defaults to the Node regular-file adapter. */
  source?: ResourceSourceImporter;

  /** Generates UUIDv4 identity for local domain facts. */
  createId?: () => UuidV4;

  /** Reads one trusted canonical instant for each finite application behavior. */
  now?: () => Timestamp;

  /** Derives an optional four-part display label from one already-created identity. */
  petname?: (id: UuidV4) => string;

  /** Applies application hard limits to every prepared Budget allocation. */
  applicationLimits?: BudgetLimitsInput;
}>;

/** Local bound Resource facade returned by createLocalResources. */
export type LocalResources = Readonly<{
  /** Imports and revises real Agent Skill directories. */
  skills: Readonly<{
    /** Imports one current Agent Skills directory. */
    importDirectory(input: string | ImportSkillDirectoryInput): Promise<ResultValue<Skill, ResourcesError>>;

    /** Reimports changed directory content as one exact child revision. */
    reimportDirectory(
      parent: Skill,
      input: string | ImportSkillDirectoryInput,
    ): Promise<ResultValue<Skill, ResourcesError>>;

    /** Loads one exact support file from an imported Skill's immutable snapshot. */
    loadSupport(skill: Skill, path: string): Promise<ResultValue<LoadedSkillSupport, ResourcesError>>;
  }>;

  /** Defines, imports, and revises parameterized Prompts. */
  prompts: Readonly<{
    /** Defines one in-memory behavior-bearing Prompt. */
    define(input: DefinePromptInput): Prompt;

    /** Imports one source file through the bound source and immutable file plane. */
    importFile(
      source: string,
      options: Omit<ImportPromptFileInput, 'source'>,
    ): Promise<ResultValue<Prompt, ResourcesError>>;

    /** Revises one exact Prompt parent through explicit child facts. */
    revise(parent: Prompt, input: RevisePromptInput): ResultValue<Prompt, ResourcesError>;
  }>;

  /** Defines and narrows reusable one-step BudgetPolicies. */
  budgets: Readonly<{
    /** Defines one reusable at-least-one-dimension BudgetPolicy. */
    define(
      input: BudgetLimitsInput &
        Readonly<{
          /** Lets applications label reusable policies while keeping limits as behavior content. */
          name?: string;
        }>,
    ): BudgetPolicy;

    /** Narrows one exact parent BudgetPolicy. */
    narrow(parent: BudgetPolicy, input: BudgetLimitsInput): ResultValue<BudgetPolicy, ResourcesError>;
  }>;

  /** Creates and changes profiles from behavior-bearing selections. */
  profiles: Readonly<{
    /** Creates one reusable exact Resource selection. */
    create(input: CreateAgentProfileInput): AgentProfile;

    /** Renames one exact current profile revision. */
    rename(profile: AgentProfile, name: string): ResultValue<AgentProfile, ResourcesError>;

    /** Replaces the complete Resource selection. */
    replace(
      profile: AgentProfile,
      input: Omit<ReplaceAgentProfileSelectionsCommand, keyof RenameAgentProfileCommand>,
    ): ResultValue<AgentProfile, ResourcesError>;

    /** Activates one selected discoverable Skill for a future ResourceSet. */
    activate(profile: AgentProfile, skill: Skill): ResultValue<AgentProfile, ResourcesError>;
  }>;

  /**
   * Compiles a profile created by this graph under explicit local policy.
   * @param profile - Exact profile whose retained behavior graph is local.
   * @returns Finite repeatable preparation session.
   */
  bind(profile: AgentProfile): ResourceSession;
}>;

/** Exact behavior bindings retained privately by one ResourceSet. */
type ResourceSetBindings = Readonly<{
  /** Exact profile used during compilation. */
  profile: AgentProfile;

  /** Exact selected Model behavior. */
  model: Model;

  /** Ordered selected Prompt behavior. */
  prompts: readonly Prompt[];

  /** Ordered selected Skill behavior and activation. */
  skills: AgentProfile['skills'];

  /** Exact selected BudgetPolicy behavior. */
  budget: BudgetPolicy;
}>;

/** Module-private authority prevents DTO parsing from becoming ResourceSet compilation. */
const RESOURCE_SET_CONSTRUCTION = Symbol('archer.resource-set.construction');

/** Runtime provenance prevents prototype tricks and casts from entering preparation. */
const COMPILED_RESOURCE_SETS = new WeakSet<ResourceSet>();

/** Private exact behavior bindings prevent receipt splicing. */
const RESOURCE_SET_BINDINGS = new WeakMap<ResourceSet, ResourceSetBindings>();

/** Immutable compiled fact plus process-local exact behavior bindings. */
export class ResourceSet {
  /** Immutable ResourceSet identity. */
  readonly id: ResourceSetId;

  /** Stable wire discriminator. */
  readonly object = 'resource-set' as const;

  /** Trusted compilation instant. */
  readonly createdAt: Timestamp;

  /** Exact AgentProfile revision selected by this set. */
  readonly profile: AgentProfileRef;

  /** Exact ordered Resource references. */
  readonly resources: readonly ResourceRevisionRef[];

  /** Compiler protocol revision giving evidence identity meaning. */
  readonly compilerRevision = 1 as const;

  /** Local application or independently reviewed admission evidence. */
  readonly admission: ResourceSetAdmission;

  /** Deterministic evidence identity over portable compilation facts. */
  readonly evidenceDigest: Sha256Digest;

  /**
   * Installs one exact compiled set behind package-owned authority.
   * @param token - Module-private compilation authority.
   * @param profile - Exact behavior-bearing profile.
   * @param admission - Local or independently reviewed admission evidence.
   * @param context - Exact ResourceSet identity and trusted compilation time.
   */
  protected constructor(
    token: typeof RESOURCE_SET_CONSTRUCTION,
    profile: AgentProfile,
    admission: ResourceSetAdmission,
    context: ResourceSetCreationContext,
  ) {
    if (token !== RESOURCE_SET_CONSTRUCTION) throw new TypeError('Use a Resource compiler');
    /** Requires admitted profile provenance before a ResourceSet receipt can name it. */
    const profileReference = agentProfileRef(profile);
    /** Retrieves exact selected behavior rather than reconstructing it from portable refs. */
    const bindings = agentProfileBindings(profile);
    /** Copies activation alongside each Skill ref so the receipt reflects the exact profile revision. */
    const selectedSkills = Object.freeze(
      bindings.skills.map((selection) =>
        Object.freeze({ skill: skillRef(selection.skill), activation: selection.activation }),
      ),
    );
    /** Pins Model, Prompt, Skill, then Budget order as part of compiler evidence. */
    const resources = Object.freeze([
      modelRef(bindings.model),
      ...bindings.prompts.map((prompt) => promptRefFromProfile(profile, prompt)),
      ...bindings.skills.map((selection) => skillRef(selection.skill)),
      budgetPolicyRef(bindings.budget),
    ] as ResourceRevisionRef[]);
    /** Copies admission arrays before hashing so caller mutation cannot alter receipt meaning. */
    const normalizedAdmission =
      admission.mode === 'local'
        ? Object.freeze({ mode: 'local' as const, policy: 'application' as const })
        : Object.freeze({ mode: 'reviewed' as const, admissions: Object.freeze([...admission.admissions]) });
    /** Runtime UUID admission protects advanced compilers from nominal casts at JavaScript boundaries. */
    this.id = UuidV4Schema.parse(context.id) as ResourceSetId;
    this.createdAt = TimestampSchema.parse(context.createdAt);
    this.profile = profileReference;
    this.resources = resources;
    this.admission = normalizedAdmission;
    this.evidenceDigest = resourceDigest('archer.resource-set.v1', {
      profile: this.profile,
      resources: this.resources,
      compilerRevision: this.compilerRevision,
      admission: this.admission,
    });
    RESOURCE_SET_BINDINGS.set(
      this,
      Object.freeze({
        profile,
        model: bindings.model,
        prompts: Object.freeze([...bindings.prompts]),
        skills: selectedSkills,
        budget: bindings.budget,
      }),
    );
    COMPILED_RESOURCE_SETS.add(this);
    Object.freeze(this);
  }

  /**
   * Emits exact JSON-safe compiled evidence without process-local bindings.
   * @returns Frozen ResourceSet receipt.
   */
  toJSON(): ResourceSetDto {
    if (!COMPILED_RESOURCE_SETS.has(this)) {
      throw new ResourcesError('resources_invalid_resource_set', 'ResourceSet requires compiler provenance');
    }
    return Object.freeze({
      id: this.id,
      object: this.object,
      createdAt: this.createdAt,
      profile: this.profile,
      resources: this.resources,
      compilerRevision: this.compilerRevision,
      admission: this.admission,
      evidenceDigest: this.evidenceDigest,
    });
  }
}

/**
 * Projects a Prompt through the profile's exact already-validated order.
 * @param profile - Exact profile retaining the Prompt selection.
 * @param prompt - Exact selected Prompt behavior.
 * @returns Portable Prompt ref.
 */
function promptRefFromProfile(profile: AgentProfile, prompt: Prompt): PromptRef {
  /** Profile reference lookup proves the Prompt is part of this exact selection. */
  const selected = profile.prompts.find((reference) => reference.revisionId === prompt.revisionId);
  if (selected === undefined) {
    throw new ResourcesError('resources_invalid_profile', 'Profile bindings contain an unselected Prompt');
  }
  return selected;
}

/** Package-local concrete set keeps the public class non-constructible in TypeScript. */
class CompiledResourceSet extends ResourceSet {
  /**
   * Delegates legal compilation to ResourceSet's token-checked constructor.
   * @param token - Module-private compilation authority.
   * @param profile - Exact behavior-bearing profile.
   * @param admission - Local or reviewed admission evidence.
   * @param context - Exact set identity and trusted compilation time.
   */
  constructor(
    token: typeof RESOURCE_SET_CONSTRUCTION,
    profile: AgentProfile,
    admission: ResourceSetAdmission,
    context: ResourceSetCreationContext,
  ) {
    super(token, profile, admission, context);
  }
}

/**
 * Compiles one profile under explicit already-earned admission policy.
 * @param profile - Legal behavior-bearing profile revision.
 * @param admission - Local or reviewed policy evidence.
 * @param context - Exact ResourceSet identity and trusted compilation time.
 * @returns Exact immutable ResourceSet with private behavior bindings.
 * @internal
 */
export function compileResourceSetFromProfile(
  profile: AgentProfile,
  admission: ResourceSetAdmission,
  context: ResourceSetCreationContext,
): ResourceSet {
  return new CompiledResourceSet(RESOURCE_SET_CONSTRUCTION, profile, admission, context);
}

/** Finite local behavior bound to one immutable ResourceSet. */
export interface ResourceSession {
  /** Exact compiled Resource selection used by every preparation. */
  readonly resourceSet: ResourceSet;

  /**
   * Renders, discloses, allocates, and creates one exact request without executing it.
   * @param input - Prompt values, history, current message, and optional Budget demand.
   * @returns Complete prepared step or exact domain refusal.
   */
  prepareStep(input: PrepareStepInput): ResultValue<PreparedModelStep, ResourcesError>;
}

/** Package-owned session implementation that never accepts detached receipt data. */
class BoundResourceSession implements ResourceSession {
  /** Exact compiled Resource selection used by every preparation. */
  readonly resourceSet: ResourceSet;

  /** Generates fresh identity for allocation and request facts. */
  readonly #createId: () => UuidV4;

  /** Reads one trusted instant per finite preparation. */
  readonly #now: () => Timestamp;

  /** Optional application hard limits applied to every allocation. */
  readonly #applicationLimits?: BudgetLimitsInput;

  /**
   * Binds one exact ResourceSet and local finite dependencies.
   * @param resourceSet - Exact selection and private behavior bindings.
   * @param createId - UUIDv4 identity source.
   * @param now - Trusted canonical clock.
   * @param applicationLimits - Optional hard limits.
   */
  constructor(
    resourceSet: ResourceSet,
    createId: () => UuidV4,
    now: () => Timestamp,
    applicationLimits?: BudgetLimitsInput,
  ) {
    this.resourceSet = resourceSet;
    this.#createId = createId;
    this.#now = now;
    if (applicationLimits !== undefined) this.#applicationLimits = Object.freeze({ ...applicationLimits });
    Object.freeze(this);
  }

  /**
   * Prepares one exact request and the evidence that produced it.
   * @param input - Per-step Prompt, conversation, and Budget facts.
   * @returns Complete prepared step or first exact refusal with no partial request.
   */
  prepareStep(input: PrepareStepInput): ResultValue<PreparedModelStep, ResourcesError> {
    try {
      if (!COMPILED_RESOURCE_SETS.has(this.resourceSet)) {
        return Result.error(
          new ResourcesError('resources_invalid_resource_set', 'Preparation requires compiled ResourceSet behavior'),
        );
      }
      /** Requires private ResourceSet behavior binding before preparing any executable request. */
      const bindings = RESOURCE_SET_BINDINGS.get(this.resourceSet);
      if (bindings === undefined) {
        return Result.error(
          new ResourcesError('resources_invalid_resource_set', 'ResourceSet behavior bindings are unavailable'),
        );
      }

      /** Global Prompt input must equal the union of selected declarations. */
      const values = { ...input.promptInputs };
      /** Unifies declared Prompt keys in profile order before validating caller input. */
      const expected = new Set(bindings.prompts.flatMap((prompt) => prompt.variables));
      /** Reports missing values in stable declaration order and produces no partial contributions. */
      const missing = [...expected].filter((variable) => typeof values[variable] !== 'string');
      /** Sorts unexpected caller keys so equivalent invalid maps refuse deterministically. */
      const extra = Object.keys(values)
        .filter((variable) => !expected.has(variable))
        .sort();
      if (missing.length > 0) {
        return Result.error(
          new ResourcesError('prompt_parameter_missing', 'Prepared step is missing Prompt variables', {
            details: { variables: missing },
          }),
        );
      }
      if (extra.length > 0) {
        return Result.error(
          new ResourcesError('prompt_parameter_extra', 'Prepared step contains extra Prompt variables', {
            details: { variables: extra },
          }),
        );
      }

      /** Each Prompt receives only the values it declared, in AgentProfile order. */
      const promptContributions: PromptContribution[] = [];
      /** Renders Prompts in exact AgentProfile order rather than introducing a second order field. */
      for (const prompt of bindings.prompts) {
        /** Passes only each Prompt's declared keys so one Prompt cannot consume another's inputs. */
        const promptValues = Object.fromEntries(
          prompt.variables.map((variable) => [variable, values[variable] as string]),
        );
        /** Mints source-bound contribution evidence only through the selected Prompt behavior. */
        const rendered = renderPrompt(prompt, promptValues);
        if (!rendered.ok) return rendered;
        promptContributions.push(rendered.value);
      }
      /** Maps verified Prompt contributions into provider-neutral request parts before other inputs join. */
      const composed = composePromptContributions({
        contributions: promptContributions,
        history: input.history,
        userMessage: input.userMessage,
      });
      if (!composed.ok) return composed;

      /** Skill disclosure preserves profile order and never changes activation. */
      const activeSkills: SkillRef[] = [];
      /** Collects discoverable summaries separately because they are model-visible catalogue entries. */
      const discoverableSkills: SkillSummary[] = [];
      /** Collects active instructions separately because they become immediate model guidance. */
      const skillInstructions: string[] = [];
      /** Walks the exact selected Skill order retained by AgentProfile. */
      for (const selection of bindings.skills) {
        /** Reconnects the portable activation entry to the private behavior owner selected by the profile. */
        const exact = agentProfileBindings(bindings.profile).skills.find(
          (candidate) => candidate.skill.revisionId === selection.skill.revisionId,
        );
        if (exact === undefined) {
          return Result.error(
            new ResourcesError('resources_invalid_resource_set', 'ResourceSet Skill binding no longer matches profile'),
          );
        }
        switch (selection.activation) {
          case 'active': {
            /** Loads full instructions only for active Skills; support files remain explicitly disclosed. */
            const loaded = loadSkillInstructions(exact.skill);
            if (!loaded.ok) return loaded;
            activeSkills.push(loaded.value.ref);
            skillInstructions.push(`Skill ${loaded.value.ref.name}:\n${loaded.value.content}`);
            break;
          }
          case 'discoverable': {
            /** Projects only manifest summary for discoverable Skills to keep prompt cost bounded. */
            const summary = skillSummary(exact.skill);
            discoverableSkills.push(summary);
            skillInstructions.push(`Available Skill: ${summary.name} — ${summary.description}`);
            break;
          }
        }
      }

      /** One clock read supplies allocation start and request creation time. */
      const startedAt = TimestampSchema.parse(this.#now());
      /** Intersects every applicable ceiling at one trusted preparation instant. */
      const allocation = allocateBudget({
        allocationId: createBudgetAllocationIdFrom(this.#createId),
        policy: bindings.budget,
        model: bindings.model,
        ...(input.budgetRequest === undefined ? {} : { request: input.budgetRequest }),
        ...(input.parentAllocation === undefined ? {} : { parent: input.parentAllocation }),
        ...(this.#applicationLimits === undefined ? {} : { applicationLimits: this.#applicationLimits }),
        startedAt,
      });
      if (!allocation.ok) return allocation;

      /** Creates an admitted request only after Prompt, Skill, and Budget preparation all succeed. */
      const request = createModelStepRequest(
        {
          model: bindings.model,
          instructions: Object.freeze([...composed.value.instructions, ...skillInstructions]),
          messages: composed.value.messages,
          tools: [],
          maxOutputTokens: allocation.value.outputTokens,
          ...(allocation.value.deadline === undefined ? {} : { deadline: allocation.value.deadline }),
          resourceSet: resourceSetRef(this.resourceSet),
        },
        {
          id: UuidV4Schema.parse(this.#createId()) as ModelStepRequestId,
          createdAt: startedAt,
        },
      );

      return Result.ok(
        Object.freeze({
          request,
          resourceSet: this.resourceSet,
          allocation: allocation.value,
          promptContributions: Object.freeze(promptContributions),
          activeSkills: Object.freeze(activeSkills),
          discoverableSkills: Object.freeze(discoverableSkills),
        }),
      );
    } catch (cause) {
      /** Preserves exact Resource refusals while normalizing unexpected preparation boundary failures. */
      const error =
        cause instanceof ResourcesError
          ? cause
          : new ResourcesError('resources_prepare_refused', 'Resource preparation failed', { cause });
      return Result.error(error);
    }
  }
}

/**
 * Projects ResourceSet evidence into the package-independent Model request contract.
 * @param resourceSet - Exact compiled ResourceSet.
 * @returns Portable ResourceSet reference understood by Models without circular imports.
 */
function resourceSetRef(resourceSet: ResourceSet): ModelStepResourceSetRef {
  return Object.freeze({
    id: resourceSet.id,
    object: 'resource-set',
    evidenceDigest: resourceSet.evidenceDigest,
  });
}

/**
 * Narrows one generated UUID to BudgetAllocation identity after UUIDv4 admission.
 * @param createId - Caller-owned UUIDv4 source.
 * @returns Fresh BudgetAllocation identity.
 */
function createBudgetAllocationIdFrom(createId: () => UuidV4): ReturnType<typeof createBudgetAllocationId> {
  return UuidV4Schema.parse(createId()) as ReturnType<typeof createBudgetAllocationId>;
}

/**
 * Creates a Node source importer that refuses links and observed file changes.
 * @returns Stable regular-file importer used by the local facade default.
 */
export function nodeResourceSourceImporter(): ResourceSourceImporter {
  /** Contextual typing keeps the adapter callback aligned with the public acquisition port. */
  const importer: ResourceSourceImporter = {
    /**
     * Acquires one detached file using no-follow descriptor checks.
     * @param source - Host path supplied by the application source boundary.
     * @returns Detached stable bytes or one bounded source-acquisition failure.
     */
    async readFile(source): Promise<ResultValue<PromptSourceFile, ResourcesError>> {
      /** Retains one descriptor so pre/post identity checks and cleanup observe the same file. */
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        /** Captures source identity before reading bytes to detect replacement during acquisition. */
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) {
          return Result.error(new ResourcesError('prompt_source_not_regular', 'Prompt source is not a regular file'));
        }
        /** Copies bytes before closing the host descriptor or publishing immutable content. */
        const bytes = Uint8Array.from(await handle.readFile());
        /** Rechecks source identity after reading so an observed concurrent replacement is refused. */
        const after = await handle.stat({ bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          BigInt(bytes.byteLength) !== after.size
        ) {
          return Result.error(new ResourcesError('prompt_source_changed', 'Prompt source changed during acquisition'));
        }
        return Result.ok(
          Object.freeze({
            path: LogicalPathSchema.parse(basename(source)),
            bytes,
          }),
        );
      } catch (cause) {
        /** Maps only expected filesystem failures to stable Prompt source error codes. */
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
            ? 'prompt_source_missing'
            : 'resources_prompt_import_failed';
        return Result.error(new ResourcesError(code, 'Prompt source could not be acquired', { cause }));
      } finally {
        await handle?.close();
      }
    },
  };
  return Object.freeze(importer);
}

/**
 * Creates the ergonomic local Resource graph with explicit borrowed dependencies.
 * @param dependencies - Immutable files, source acquisition, identity, time, naming, and hard limits.
 * @returns Reusable finite Resource behavior without persistence or background lifecycle.
 */
export function createLocalResources(dependencies: LocalResourceDependencies): LocalResources {
  /** Uses injected UUID generation so deterministic applications and tests control identity. */
  const createId = dependencies.createId ?? createUuidV4;
  /**
   * Uses the injected trusted clock or a canonical local instant at finite boundaries.
   * @returns Current trusted timestamp for one finite domain operation.
   */
  const now = dependencies.now ?? (() => TimestampSchema.parse(new Date().toISOString()));
  /** Uses an injected naming policy without coupling display names to identity generation. */
  const petname = dependencies.petname ?? resourcePetname;
  /** Defaults to the Node regular-file adapter while leaving source acquisition replaceable. */
  const source = dependencies.source ?? nodeResourceSourceImporter();
  /** Binds explicit Skill support disclosure to the same borrowed immutable file plane. */
  const skillContent = fileStoreSkillContentReader(dependencies.files);
  /** Only profiles created by this graph may enter its local application policy compiler. */
  const localProfiles = new WeakSet<AgentProfile>();

  /**
   * Applies the local graph precondition before a convenience transition consumes identity or time.
   * @param profile - Proposed exact parent profile.
   * @returns A stable refusal when another graph owns the profile, otherwise no refusal.
   */
  const refuseForeignProfile = (profile: AgentProfile): ResultValue<never, ResourcesError> | undefined =>
    localProfiles.has(profile)
      ? undefined
      : Result.error(
          new ResourcesError(
            'resources_invalid_profile',
            'Local profile transitions require a profile created by this Resource graph',
          ),
        );

  /**
   * Generates exact initial Prompt facts from the bound UUID and clock capabilities.
   * @returns Fresh identity and trusted time for one initial Prompt.
   */
  const promptContext = (): PromptCreationContext =>
    Object.freeze({
      id: UuidV4Schema.parse(createId()) as PromptCreationContext['id'],
      revisionId: UuidV4Schema.parse(createId()) as PromptCreationContext['revisionId'],
      observedAt: TimestampSchema.parse(now()),
    });
  /**
   * Generates exact child Prompt facts without hidden modifier dependencies.
   * @returns Fresh revision identity and trusted time for one Prompt child.
   */
  const promptRevisionContext = (): PromptRevisionContext =>
    Object.freeze({
      revisionId: UuidV4Schema.parse(createId()) as PromptRevisionContext['revisionId'],
      observedAt: TimestampSchema.parse(now()),
    });
  /**
   * Generates exact initial Skill facts from the same local identity policy.
   * @returns Fresh identity and trusted time for one imported Skill.
   */
  const skillContext = (): SkillCreationContext =>
    Object.freeze({
      id: UuidV4Schema.parse(createId()) as SkillCreationContext['id'],
      revisionId: UuidV4Schema.parse(createId()) as SkillCreationContext['revisionId'],
      observedAt: TimestampSchema.parse(now()),
    });
  /**
   * Generates exact child Skill facts without letting file acquisition read time.
   * @returns Fresh revision identity and trusted time for one Skill child.
   */
  const skillRevisionContext = (): SkillRevisionContext =>
    Object.freeze({
      revisionId: UuidV4Schema.parse(createId()) as SkillRevisionContext['revisionId'],
      observedAt: TimestampSchema.parse(now()),
    });
  /**
   * Generates exact initial BudgetPolicy facts.
   * @returns Fresh identity and trusted time for one BudgetPolicy.
   */
  const budgetContext = (): BudgetPolicyCreationContext =>
    Object.freeze({
      id: UuidV4Schema.parse(createId()) as BudgetPolicyCreationContext['id'],
      revisionId: UuidV4Schema.parse(createId()) as BudgetPolicyCreationContext['revisionId'],
      observedAt: TimestampSchema.parse(now()),
    });
  /**
   * Generates exact child BudgetPolicy facts.
   * @returns Fresh revision identity and trusted time for one narrowed policy.
   */
  const budgetRevisionContext = (): BudgetPolicyRevisionContext =>
    Object.freeze({
      revisionId: UuidV4Schema.parse(createId()) as BudgetPolicyRevisionContext['revisionId'],
      observedAt: TimestampSchema.parse(now()),
    });
  /**
   * Generates exact initial AgentProfile facts.
   * @returns Fresh identity and trusted time for one AgentProfile.
   */
  const profileContext = (): AgentProfileCreationContext =>
    Object.freeze({
      id: UuidV4Schema.parse(createId()) as AgentProfileCreationContext['id'],
      revisionId: UuidV4Schema.parse(createId()) as AgentProfileRevisionId,
      observedAt: TimestampSchema.parse(now()),
    });
  /**
   * Generates one complete stale-safe child profile command base.
   * @param profile - Exact parent whose revision becomes the command precondition.
   * @returns Fresh child revision facts without persistence or replay claims.
   */
  const profileCommand = (profile: AgentProfile) =>
    Object.freeze({
      expectedRevision: profile.revision,
      revisionId: UuidV4Schema.parse(createId()) as AgentProfileRevisionId,
      observedAt: TimestampSchema.parse(now()),
    });

  /** Contextual typing makes every nested convenience callback part of the public local facade. */
  const local: LocalResources = {
    skills: Object.freeze({
      /**
       * Imports one real Agent Skills directory into the bound immutable file plane.
       * @param input - Directory path or explicit import input.
       * @returns Imported behavior or one exact acquisition refusal.
       */
      importDirectory(input) {
        /** Normalizes the ergonomic string form before invoking the standalone Skill importer. */
        const normalized = typeof input === 'string' ? { directory: input } : input;
        /** Supplies borrowed FileStore and fresh identity facts without adding facade ownership. */
        const importDependencies: SkillImportDependencies = {
          files: dependencies.files,
          context: skillContext(),
        };
        return importSkillDirectory(normalized, importDependencies);
      },
      /**
       * Reimports changed source as one exact Skill child revision.
       * @param parent - Exact admitted Skill parent.
       * @param input - Directory path or explicit import input.
       * @returns Child behavior or one exact acquisition or transition refusal.
       */
      reimportDirectory(parent, input) {
        /** Normalizes reimport input identically so only parent and acquired content affect revision behavior. */
        const normalized = typeof input === 'string' ? { directory: input } : input;
        return reimportSkillDirectory(parent, normalized, {
          files: dependencies.files,
          context: skillRevisionContext(),
        });
      },
      /**
       * Loads one explicitly selected support file from an imported Skill snapshot.
       * @param skill - Exact admitted Skill behavior retained by the local file plane.
       * @param path - Canonical path inside the immutable Skill directory.
       * @returns Detached verified bytes bound to the exact Skill revision.
       */
      loadSupport(skill, path) {
        return loadSkillSupport(skill, path, skillContent);
      },
    }),
    prompts: Object.freeze({
      /**
       * Defines a pure in-memory Prompt through the facade's identity policy.
       * @param input - Prompt template, placement, variables, and optional name.
       * @returns Admitted behavior-bearing Prompt.
       */
      define(input) {
        /** Creates exact identity facts for pure in-memory Prompt definition. */
        const context = promptContext();
        return definePrompt(
          {
            ...input,
            name: input.name ?? petname(context.id),
          },
          context,
        );
      },
      /**
       * Imports one Prompt file and binds its immutable source snapshot.
       * @param sourcePath - Application source locator understood by the bound importer.
       * @param options - Prompt placement, variables, and optional display name.
       * @returns Imported Prompt behavior or one exact source refusal.
       */
      importFile(sourcePath, options) {
        /** Supplies identity facts before acquisition; behavior is published only after acquisition succeeds. */
        const context = promptContext();
        /** Binds caller-owned file and source capabilities to Prompt import without retaining lifecycle. */
        const importDependencies: PromptImportDependencies = {
          files: dependencies.files,
          source,
          context,
        };
        return importPromptFile(
          {
            source: sourcePath,
            ...options,
            name: options.name ?? petname(context.id),
          },
          importDependencies,
        );
      },
      /**
       * Revises one admitted Prompt through a pure explicit child transition.
       * @param parent - Exact current Prompt parent.
       * @param input - Behavior or display fields to replace.
       * @returns Child Prompt or one exact transition refusal.
       */
      revise(parent, input) {
        return revisePrompt(parent, input, promptRevisionContext());
      },
    }),
    budgets: Object.freeze({
      /**
       * Defines one reusable BudgetPolicy without installing hidden limits.
       * @param input - At least one output or wall-time ceiling and optional name.
       * @returns Admitted immutable BudgetPolicy.
       */
      define(input) {
        /** Creates exact identity facts for the reusable BudgetPolicy definition. */
        const context = budgetContext();
        return defineBudgetPolicy(
          {
            ...input,
            name: input.name ?? petname(context.id),
          },
          context,
        );
      },
      /**
       * Narrows one exact BudgetPolicy parent through explicit child facts.
       * @param parent - Exact current policy parent.
       * @param input - Equal or tighter ceilings; omitted dimensions inherit.
       * @returns Child policy or one exact widening or no-change refusal.
       */
      narrow(parent, input) {
        return narrowBudgetPolicy(parent, input, budgetRevisionContext());
      },
    }),
    profiles: Object.freeze({
      /**
       * Creates one reusable exact Resource selection.
       * @param input - Behavior-bearing Model, Prompts, Skills, and BudgetPolicy.
       * @returns Admitted AgentProfile retained by this local graph.
       */
      create(input) {
        /** Creates exact identity facts for the reusable AgentProfile definition. */
        const context = profileContext();
        /** Delegates selection invariants to AgentProfile while the facade retains the resulting graph. */
        const profile = createAgentProfile(
          {
            ...input,
            name: input.name ?? petname(context.id),
          },
          context,
        );
        localProfiles.add(profile);
        return profile;
      },
      /**
       * Renames one exact profile through a stale-safe pure transition.
       * @param profile - Exact current profile retained by this graph.
       * @param name - New nonempty human-readable label.
       * @returns Child profile or one exact transition refusal.
       */
      rename(profile, name) {
        /** Refuses foreign state before minting child facts or registering any derived profile. */
        const foreign = refuseForeignProfile(profile);
        if (foreign !== undefined) return foreign;
        /** Builds a stale-safe rename command from the currently selected profile revision. */
        const command: RenameAgentProfileCommand = { ...profileCommand(profile), name };
        /** Tracks only the successful immutable child so failed changes leave the graph untouched. */
        const revised = renameAgentProfile(profile, command);
        if (revised.ok) localProfiles.add(revised.value);
        return revised;
      },
      /**
       * Replaces the complete Resource selection in caller-supplied order.
       * @param profile - Exact current profile retained by this graph.
       * @param input - Complete replacement Model, Prompt, Skill, and Budget selections.
       * @returns Child profile or one exact selection refusal.
       */
      replace(profile, input) {
        /** Refuses foreign state before validating replacement selections or consuming child facts. */
        const foreign = refuseForeignProfile(profile);
        if (foreign !== undefined) return foreign;
        /** Builds replacement facts with a fresh child revision while preserving explicit selections. */
        const command = {
          ...profileCommand(profile),
          ...input,
        } as ReplaceAgentProfileSelectionsCommand;
        /** Admits only successful replacement children into the local graph. */
        const revised = replaceAgentProfileSelections(profile, command);
        if (revised.ok) localProfiles.add(revised.value);
        return revised;
      },
      /**
       * Activates one selected discoverable Skill for a future ResourceSet.
       * @param profile - Exact current profile retained by this graph.
       * @param skill - Already-selected Skill whose activation changes.
       * @returns Child profile or one exact activation refusal.
       */
      activate(profile, skill) {
        /** Refuses foreign state before activation can launder it into this graph's binding authority. */
        const foreign = refuseForeignProfile(profile);
        if (foreign !== undefined) return foreign;
        /** Builds activation as a profile transition, never as Skill file-loading behavior. */
        const command: ActivateSkillCommand = {
          ...profileCommand(profile),
          skillId: skill.id,
        };
        /** Admits only successful activation children for later ResourceSet binding. */
        const revised = activateSkill(profile, command);
        if (revised.ok) localProfiles.add(revised.value);
        return revised;
      },
    }),
    /**
     * Compiles one graph-owned profile under explicit local application policy.
     * @param profile - Exact profile previously created or revised by this facade.
     * @returns Reusable finite request-preparation session.
     */
    bind(profile) {
      if (!localProfiles.has(profile)) {
        throw new ResourcesError(
          'resources_invalid_profile',
          'Local binding requires a profile created by this Resource graph',
        );
      }
      /** Compiles local application evidence from the exact behavior graph retained by this facade. */
      const compiled = compileResourceSetFromProfile(
        profile,
        { mode: 'local', policy: 'application' },
        {
          id: UuidV4Schema.parse(createId()) as ResourceSetId,
          createdAt: TimestampSchema.parse(now()),
        },
      );
      return new BoundResourceSession(compiled, createId, now, dependencies.applicationLimits);
    },
  };
  return Object.freeze(local);
}

/**
 * Binds an already-compiled exact ResourceSet for advanced reviewed use.
 * @param resourceSet - Exact compiled set carrying private behavior bindings.
 * @param dependencies - Identity, clock, and optional application limits.
 * @returns Finite preparation session.
 */
export function bindCompiledResources(
  resourceSet: ResourceSet,
  dependencies?: Pick<LocalResourceDependencies, 'createId' | 'now' | 'applicationLimits'>,
): ResourceSession {
  if (!COMPILED_RESOURCE_SETS.has(resourceSet)) {
    throw new ResourcesError('resources_invalid_resource_set', 'ResourceSet lacks compiler provenance');
  }
  return new BoundResourceSession(
    resourceSet,
    dependencies?.createId ?? createUuidV4,
    dependencies?.now ?? (() => TimestampSchema.parse(new Date().toISOString())),
    dependencies?.applicationLimits,
  );
}
