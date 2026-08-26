/** @file Defines honest provider-specific model Resource configurations. */

import * as z from 'zod';
import { NumberDictionary, adjectives, animals, colors, uniqueNamesGenerator } from 'unique-names-generator';

import {
  Result,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  createUuidV4,
  type ArcherObject,
  type Result as ResultValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '@archer/core';

import { digestJson } from './canonical.js';
import { ModelsError } from './errors.js';

/** Four-digit dictionary supplies the fourth model petname component. */
const PETNAME_NUMBERS = NumberDictionary.generate({ min: 1000, max: 9999 });

/**
 * Generates a stable human label without making provider identity do two jobs.
 * @param id - UUIDv4 seed that keeps retries for one identity deterministic.
 * @returns Lowercase hyphenated adjective-color-animal-number label.
 */
function modelPetname(id: ModelId): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals, PETNAME_NUMBERS],
    separator: '-',
    length: 4,
    style: 'lowerCase',
    seed: id,
  });
}

/** Prevents an unrelated UUID from naming one logical model Resource. */
declare const modelIdBrand: unique symbol;

/** Stable identity shared by every immutable revision of one model Resource. */
export type ModelId = UuidV4 & {
  /** Carries compile-time evidence of model identity admission. */
  readonly [modelIdBrand]: true;
};

/** Prevents a model identity from posing as one exact immutable revision. */
declare const modelRevisionIdBrand: unique symbol;

/** Identity of one exact model Resource revision. */
export type ModelRevisionId = UuidV4 & {
  /** Carries compile-time evidence of model-revision identity admission. */
  readonly [modelRevisionIdBrand]: true;
};

/** Prevents transport-decoded model fields from satisfying admitted model behavior. */
declare const admittedModelBrand: unique symbol;

/** Shared portable fields present on every provider-specific model. */
export type ModelBase<Type extends string> = ArcherObject<'model', ModelId> &
  Readonly<{
    /** Identifies this value as a Resource selected by an AgentProfile. */
    resource: 'model';

    /** Selects provider-specific configuration and adapter matching rules. */
    type: Type;

    /** Human-facing label supplied by the caller or generated once as a petname. */
    name: string;

    /** Identifies this immutable configuration independently from logical identity. */
    revisionId: ModelRevisionId;

    /** Orders known revisions of the same model starting at one. */
    revision: number;

    /** Links a later revision to the exact configuration it replaced. */
    previousRevisionId?: ModelRevisionId;

    /** Records the latest revision instant without making the value mutable. */
    updatedAt: Timestamp;

    /** Pins the largest provider output the application is willing to request. */
    maxOutputTokens: number;

    /** Binds provider behavior without conflating identity, ancestry, time, or display metadata. */
    contentDigest: Sha256Digest;

    /** Compile-time evidence distinguishes admitted behavior from decoded transport fields. */
    readonly [admittedModelBrand]: true;
  }>;

/** OpenAI controls supported without pretending other providers share them. */
export type OpenAIModel = ModelBase<'openai'> &
  Readonly<{
    /** Exact OpenAI model identifier supplied to the bound SDK model. */
    model: string;

    /** OpenAI reasoning effort, when selected by the application. */
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';

    /** OpenAI service tier, when selected by the application. */
    serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  }>;

/** Google-specific thinking controls retained as one immutable group. */
export type GoogleThinking = Readonly<{
  /** Maximum thinking-token allowance passed only to Google adapters. */
  budgetTokens: number;

  /** Requests thought summaries when the chosen Google model supports them. */
  includeThoughts?: boolean;
}>;

/** Google Gemini controls supported without collapsing them into OpenAI. */
export type GoogleModel = ModelBase<'google'> &
  Readonly<{
    /** Exact Gemini model identifier supplied to the bound SDK model. */
    model: string;

    /** Gemini thinking configuration, absent when application defaults apply. */
    thinking?: GoogleThinking;
  }>;

/** xAI controls supported without claiming OpenAI option equivalence. */
export type XAIModel = ModelBase<'xai'> &
  Readonly<{
    /** Exact xAI model identifier supplied to the bound SDK model. */
    model: string;

    /** xAI reasoning effort supported by the v1 adapter boundary. */
    reasoningEffort?: 'low' | 'high';
  }>;

/** A caller-addressed Ollama installation and locally served model. */
export type OllamaModel = ModelBase<'ollama'> &
  Readonly<{
    /** Exact Ollama model tag supplied to the bound SDK model. */
    model: string;

    /** Installation endpoint retained because local hosts are not interchangeable. */
    endpoint: string;
  }>;

/** An explicitly named OpenAI-compatible installation. */
export type CompatibleModel = ModelBase<'compatible'> &
  Readonly<{
    /** Stable application name for the non-first-party installation. */
    installation: string;

    /** Exact AI SDK provider namespace used for machine identity checks. */
    provider: string;

    /** Installation-specific model identifier. */
    model: string;

    /** Exact HTTP API root whose guarantees belong to the named installation. */
    endpoint: string;
  }>;

/** Every model configuration understood by Archer's provider-neutral router. */
export type Model = OpenAIModel | GoogleModel | XAIModel | OllamaModel | CompatibleModel;

/** JSON-safe OpenAI model state without process-local admission evidence. */
export type OpenAIModelDto = Omit<OpenAIModel, typeof admittedModelBrand>;

/** JSON-safe Google model state without process-local admission evidence. */
export type GoogleModelDto = Omit<GoogleModel, typeof admittedModelBrand>;

/** JSON-safe xAI model state without process-local admission evidence. */
export type XAIModelDto = Omit<XAIModel, typeof admittedModelBrand>;

/** JSON-safe Ollama model state without process-local admission evidence. */
export type OllamaModelDto = Omit<OllamaModel, typeof admittedModelBrand>;

/** JSON-safe compatible-installation state without process-local admission evidence. */
export type CompatibleModelDto = Omit<CompatibleModel, typeof admittedModelBrand>;

/** Every transportable model Resource revision accepted by the explicit codec. */
export type ModelDto = OpenAIModelDto | GoogleModelDto | XAIModelDto | OllamaModelDto | CompatibleModelDto;

/** Distributive contentDigest-free union used only while factories assemble a revision. */
type UndigestedModel =
  | Omit<OpenAIModelDto, 'contentDigest'>
  | Omit<GoogleModelDto, 'contentDigest'>
  | Omit<XAIModelDto, 'contentDigest'>
  | Omit<OllamaModelDto, 'contentDigest'>
  | Omit<CompatibleModelDto, 'contentDigest'>;

/** Complete model identity carried by profiles and adapter bindings. */
export type ModelRef = Readonly<{
  /** Narrows the Resource family before provider-specific discrimination. */
  resource: 'model';

  /** Stable logical model identity. */
  id: ModelId;

  /** Exact immutable revision selected for one operation. */
  revisionId: ModelRevisionId;

  /** Provider family required from the adapter binding. */
  type: Model['type'];

  /** Human-facing label useful in diagnostics and UIs. */
  name: string;

  /** Content identity prevents a matching UUID pair from hiding changed controls. */
  contentDigest: Sha256Digest;
}>;

/** Common developer input for every model factory. */
type ModelInput = Readonly<{
  /** Provider or installation model identifier. */
  model: string;

  /** Optional label; Archer generates a four-part petname when absent. */
  name?: string;

  /** Declared maximum generated output for request admission. */
  maxOutputTokens: number;
}>;

/** Exact initial identity and time facts accepted by deterministic application boundaries. */
export type ModelCreationContext = Readonly<{
  /** Supplies the logical UUIDv4 that remains stable across revisions. */
  id: ModelId;

  /** Supplies the UUIDv4 for the initial immutable revision. */
  revisionId: ModelRevisionId;

  /** Supplies the trusted instant used for both initial timestamps. */
  observedAt: Timestamp;
}>;

/** Exact child identity and time facts required by pure revision behavior. */
export type ModelRevisionContext = Readonly<{
  /** Supplies a fresh UUIDv4 for the child immutable revision. */
  revisionId: ModelRevisionId;

  /** Supplies the trusted observation used to derive causal revision time. */
  observedAt: Timestamp;
}>;

/** Input accepted by {@link openAIModel}. */
export type OpenAIModelInput = ModelInput &
  Readonly<{
    /** OpenAI-only reasoning effort. */
    reasoningEffort?: OpenAIModel['reasoningEffort'];

    /** OpenAI-only service tier. */
    serviceTier?: OpenAIModel['serviceTier'];
  }>;

/** Input accepted by {@link googleModel}. */
export type GoogleModelInput = ModelInput &
  Readonly<{
    /** Optional Gemini-only thinking configuration. */
    thinking?: GoogleThinking;
  }>;

/** Input accepted by {@link xAIModel}. */
export type XAIModelInput = ModelInput &
  Readonly<{
    /** Optional xAI-only reasoning effort. */
    reasoningEffort?: XAIModel['reasoningEffort'];
  }>;

/** Input accepted by {@link ollamaModel}. */
export type OllamaModelInput = ModelInput &
  Readonly<{
    /** Ollama HTTP API root, defaulting to the conventional local address. */
    endpoint?: string;
  }>;

/** Input accepted by {@link compatibleModel}. */
export type CompatibleModelInput = ModelInput &
  Readonly<{
    /** Stable application name for this compatible installation. */
    installation: string;

    /** Exact AI SDK provider namespace, independent from the human installation label. */
    provider: string;

    /** Credential-free HTTP API root for the installation. */
    endpoint: string;
  }>;

/** Internal shape admitted before provider discrimination and contentDigest verification. */
const ModelBaseSchema = z.strictObject({
  id: UuidV4Schema.transform((value) => value as ModelId),
  object: z.literal('model'),
  resource: z.literal('model'),
  createdAt: TimestampSchema,
  name: z.string().trim().min(1).max(256),
  revisionId: UuidV4Schema.transform((value) => value as ModelRevisionId),
  revision: z.int().positive(),
  previousRevisionId: UuidV4Schema.transform((value) => value as ModelRevisionId).optional(),
  updatedAt: TimestampSchema,
  maxOutputTokens: z.int().positive(),
  contentDigest: Sha256DigestSchema,
});

/** Runtime schema used only by model creation and explicit transport adapters. */
export const ModelSchema: z.ZodType<ModelDto> = z
  .discriminatedUnion('type', [
    ModelBaseSchema.extend({
      type: z.literal('openai'),
      model: z.string().trim().min(1).max(256),
      reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']).optional(),
      serviceTier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
    }),
    ModelBaseSchema.extend({
      type: z.literal('google'),
      model: z.string().trim().min(1).max(256),
      thinking: z
        .strictObject({ budgetTokens: z.int().nonnegative(), includeThoughts: z.boolean().optional() })
        .transform((value) => Object.freeze({ ...value }))
        .optional(),
    }),
    ModelBaseSchema.extend({
      type: z.literal('xai'),
      model: z.string().trim().min(1).max(256),
      reasoningEffort: z.enum(['low', 'high']).optional(),
    }),
    ModelBaseSchema.extend({
      type: z.literal('ollama'),
      model: z.string().trim().min(1).max(256),
      endpoint: z.url().refine(isSafeHttpEndpoint),
    }),
    ModelBaseSchema.extend({
      type: z.literal('compatible'),
      installation: z.string().trim().min(1).max(128),
      provider: z.string().trim().min(1).max(256),
      model: z.string().trim().min(1).max(256),
      endpoint: z.url().refine(isSafeHttpEndpoint),
    }),
  ])
  .superRefine((value, context) => {
    if (String(value.id) === String(value.revisionId)) {
      context.addIssue({ code: 'custom', path: ['revisionId'], message: 'Model identities must be distinct' });
    }
    if (value.previousRevisionId === value.revisionId) {
      context.addIssue({
        code: 'custom',
        path: ['revisionId'],
        message: 'Model child revision identity must be fresh',
      });
    }
    if (value.revision === 1 && value.previousRevisionId !== undefined) {
      context.addIssue({ code: 'custom', path: ['previousRevisionId'], message: 'Initial model cannot name a parent' });
    }
    if (value.revision === 1 && value.createdAt !== value.updatedAt) {
      context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Initial model timestamps must agree' });
    }
    if (value.revision > 1 && value.previousRevisionId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['previousRevisionId'],
        message: 'Later model revision requires a parent',
      });
    }
    if (value.updatedAt < value.createdAt) {
      context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Model revision cannot predate creation' });
    }
    if (modelDigest(value) !== value.contentDigest) {
      context.addIssue({
        code: 'custom',
        path: ['contentDigest'],
        message: 'Model contentDigest does not match content',
      });
    }
  })
  .transform((value) => Object.freeze(value) as ModelDto);

/** Runtime provenance records only models created or exactly hydrated by this module. */
const ADMITTED_MODELS = new WeakSet<object>();

/**
 * Accepts only credential-free HTTP endpoints with no URL user-info.
 * @param value - Proposed endpoint text from a model factory or transport.
 * @returns Whether the endpoint is HTTP(S) and contains no user-info.
 */
function isSafeHttpEndpoint(value: string): boolean {
  /** URL parsing has already succeeded at the preceding Zod URL boundary. */
  const endpoint = new URL(value);
  return (
    (endpoint.protocol === 'http:' || endpoint.protocol === 'https:') &&
    endpoint.username === '' &&
    endpoint.password === ''
  );
}

/**
 * Computes one provider-neutral content identity over execution-relevant fields.
 * @param model - Model with or without its already-derived contentDigest.
 * @returns Stable revision content digest.
 */
export function modelDigest(model: UndigestedModel | ModelDto | Model): Sha256Digest;
/**
 * Internal overload admits validator output whose optional fields may be explicit undefined.
 * @param model - Validator output before or after its contentDigest is attached.
 * @returns Stable revision content digest.
 */
export function modelDigest(model: object): Sha256Digest;
/**
 * Implements both public contentDigest inputs through one canonical projection.
 * @param model - Model fields whose lifecycle identity is excluded from semantic content.
 * @returns Stable revision content digest.
 */
export function modelDigest(model: object): Sha256Digest {
  /** A fresh record lets identity-only fields be omitted without mutating input. */
  const content = { ...model } as Record<string, unknown>;
  /** Logical identity does not alter equivalent execution content. */
  delete content.id;
  /** The object envelope names the carrier rather than provider behavior. */
  delete content.object;
  /** The Resource kind is bound by lifecycle evidence rather than content identity. */
  delete content.resource;
  /** A display label may change without changing provider behavior. */
  delete content.name;
  /** Revision identity is derived separately from semantic content. */
  delete content.revisionId;
  /** Sequence position cannot make equivalent provider controls semantically different. */
  delete content.revision;
  /** Creation time cannot make equivalent model controls hash differently. */
  delete content.createdAt;
  /** Update time cannot make equivalent model controls hash differently. */
  delete content.updatedAt;
  /** Ancestry identifies the transition, not equivalent provider execution behavior. */
  delete content.previousRevisionId;
  /** The contentDigest cannot recursively include itself. */
  delete content.contentDigest;
  return digestJson('archer-model-v1', content);
}

/**
 * Creates common identity, revision, output-ceiling, and time fields.
 * @param type - Exact provider discriminator preserved by the return type.
 * @param input - Shared model name and output-ceiling proposal.
 * @param context - Explicit identity and time facts for an initial or child revision.
 * @param parent - Existing same-provider revision when creating a child.
 * @returns Fresh common fields for one initial or child model revision.
 */
function modelBase<const Type extends Model['type']>(
  type: Type,
  input: ModelInput,
  context: ModelCreationContext | ModelRevisionContext,
  parent?: Model,
): Omit<ModelBase<Type>, 'contentDigest' | typeof admittedModelBrand> {
  /** Context parsing prevents a modifier from trusting arbitrary identity or time strings. */
  const observedAt = TimestampSchema.parse(context.observedAt);
  /** Nondecreasing revision time keeps ordinary children compatible with exact-parent hydration. */
  const updatedAt = parent !== undefined && observedAt < parent.updatedAt ? parent.updatedAt : observedAt;
  /** Initial values share the instant and child values retain their root creation. */
  const createdAt = parent?.createdAt ?? updatedAt;
  /** A root receives UUIDv4 identity before deriving its optional display label. */
  const id = parent?.id ?? (UuidV4Schema.parse((context as ModelCreationContext).id) as ModelId);
  /** Logical and revision identity must remain distinct, including across one exact parent edge. */
  const revisionId = UuidV4Schema.parse(context.revisionId) as ModelRevisionId;
  if (String(revisionId) === String(id) || revisionId === parent?.revisionId) {
    throw new ModelsError('models_invalid_input', 'Model revision identity must be fresh and distinct');
  }
  return {
    id,
    object: 'model',
    resource: 'model',
    createdAt,
    type,
    name: input.name?.trim() || parent?.name || modelPetname(id),
    revisionId,
    revision: parent === undefined ? 1 : parent.revision + 1,
    ...(parent === undefined ? {} : { previousRevisionId: parent.revisionId }),
    updatedAt,
    maxOutputTokens: input.maxOutputTokens,
  };
}

/**
 * Derives ordinary initial identity and time while keeping deterministic callers injectable.
 * @param context - Optional exact facts from an application boundary.
 * @returns A complete validated initial construction context.
 */
function initialContext(context?: ModelCreationContext): ModelCreationContext {
  if (context !== undefined) {
    return Object.freeze({
      id: UuidV4Schema.parse(context.id) as ModelId,
      revisionId: UuidV4Schema.parse(context.revisionId) as ModelRevisionId,
      observedAt: TimestampSchema.parse(context.observedAt),
    });
  }
  /** Default construction reads one instant and generates independent logical and revision identities. */
  return Object.freeze({
    id: UuidV4Schema.parse(createUuidV4()) as ModelId,
    revisionId: UuidV4Schema.parse(createUuidV4()) as ModelRevisionId,
    observedAt: TimestampSchema.parse(new Date().toISOString()),
  });
}

/** Shared factory keys supported by every provider-specific model input. */
const MODEL_INPUT_KEYS = Object.freeze(['model', 'name', 'maxOutputTokens'] as const);

/**
 * Refuses stale or decorative configuration before output construction can silently drop it.
 * @param input - Runtime factory input supplied despite TypeScript's compile-time shape.
 * @param providerKeys - Additional fields owned by the exact provider discriminator.
 */
function assertModelInputKeys(input: object, providerKeys: readonly string[]): void {
  /** One explicit set keeps factory strictness aligned with each discriminated input type. */
  const accepted = new Set<string>([...MODEL_INPUT_KEYS, ...providerKeys]);
  /** Unknown fields cannot pose as safety guarantees merely because construction ignores them. */
  const unknown = Object.keys(input).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw new ModelsError('models_invalid_input', 'Model definition contains unsupported fields', {
      details: { fields: unknown },
    });
  }
}

/**
 * Builds one OpenAI revision through the shared target admission boundary.
 * @param input - Complete replacement OpenAI configuration.
 * @param context - Explicit identity and time facts for this revision.
 * @param parent - Optional exact OpenAI parent.
 * @returns Admitted initial or child OpenAI revision.
 */
function buildOpenAIModel(
  input: OpenAIModelInput,
  context: ModelCreationContext | ModelRevisionContext,
  parent?: OpenAIModel,
): OpenAIModel {
  assertModelInputKeys(input, ['reasoningEffort', 'serviceTier']);
  return admitModel({
    ...modelBase('openai', input, context, parent),
    model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
  }) as OpenAIModel;
}

/**
 * Builds one Google revision through the shared target admission boundary.
 * @param input - Complete replacement Google configuration.
 * @param context - Explicit identity and time facts for this revision.
 * @param parent - Optional exact Google parent.
 * @returns Admitted initial or child Google revision.
 */
function buildGoogleModel(
  input: GoogleModelInput,
  context: ModelCreationContext | ModelRevisionContext,
  parent?: GoogleModel,
): GoogleModel {
  assertModelInputKeys(input, ['thinking']);
  return admitModel({
    ...modelBase('google', input, context, parent),
    model: input.model,
    ...(input.thinking === undefined ? {} : { thinking: { ...input.thinking } }),
  }) as GoogleModel;
}

/**
 * Builds one xAI revision through the shared target admission boundary.
 * @param input - Complete replacement xAI configuration.
 * @param context - Explicit identity and time facts for this revision.
 * @param parent - Optional exact xAI parent.
 * @returns Admitted initial or child xAI revision.
 */
function buildXAIModel(
  input: XAIModelInput,
  context: ModelCreationContext | ModelRevisionContext,
  parent?: XAIModel,
): XAIModel {
  assertModelInputKeys(input, ['reasoningEffort']);
  return admitModel({
    ...modelBase('xai', input, context, parent),
    model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
  }) as XAIModel;
}

/**
 * Builds one Ollama revision through the shared target admission boundary.
 * @param input - Complete replacement Ollama configuration.
 * @param context - Explicit identity and time facts for this revision.
 * @param parent - Optional exact Ollama parent.
 * @returns Admitted initial or child Ollama revision.
 */
function buildOllamaModel(
  input: OllamaModelInput,
  context: ModelCreationContext | ModelRevisionContext,
  parent?: OllamaModel,
): OllamaModel {
  assertModelInputKeys(input, ['endpoint']);
  return admitModel({
    ...modelBase('ollama', input, context, parent),
    model: input.model,
    endpoint: input.endpoint ?? 'http://127.0.0.1:11434/api',
  }) as OllamaModel;
}

/**
 * Builds one compatible-installation revision through the shared target admission boundary.
 * @param input - Complete replacement compatible-installation configuration.
 * @param context - Explicit identity and time facts for this revision.
 * @param parent - Optional exact compatible-installation parent.
 * @returns Admitted initial or child compatible-installation revision.
 */
function buildCompatibleModel(
  input: CompatibleModelInput,
  context: ModelCreationContext | ModelRevisionContext,
  parent?: CompatibleModel,
): CompatibleModel {
  assertModelInputKeys(input, ['installation', 'provider', 'endpoint']);
  return admitModel({
    ...modelBase('compatible', input, context, parent),
    installation: input.installation,
    provider: input.provider,
    model: input.model,
    endpoint: input.endpoint,
  }) as CompatibleModel;
}

/**
 * Admits one factory candidate and translates validator detail into one stable Error.
 * @param candidate - Provider-specific candidate before contentDigest attachment.
 * @returns Validated immutable model Resource.
 */
function admitModel<Candidate extends UndigestedModel>(candidate: Candidate): Model {
  try {
    /** Shape validation returns a DTO copy before this factory grants process-local behavior provenance. */
    const parsed = ModelSchema.parse({ ...candidate, contentDigest: modelDigest(candidate) });
    /** The brand is compile-time only; the WeakSet is authoritative at runtime. */
    const admitted = parsed as Model;
    ADMITTED_MODELS.add(admitted);
    return admitted;
  } catch (cause) {
    throw new ModelsError('models_invalid_input', 'Invalid model definition', { cause });
  }
}

/**
 * Defines one exact OpenAI model Resource without accepting credentials.
 * @param input - OpenAI identity, output ceiling, and supported provider controls.
 * @param context - Optional exact facts for deterministic application construction.
 * @returns Immutable provider-discriminated model configuration.
 */
export function openAIModel(input: OpenAIModelInput, context?: ModelCreationContext): OpenAIModel {
  return buildOpenAIModel(input, initialContext(context));
}

/**
 * Defines one exact Google Gemini model Resource.
 * @param input - Gemini identity, output ceiling, and optional thinking controls.
 * @param context - Optional exact facts for deterministic application construction.
 * @returns Immutable provider-discriminated model configuration.
 */
export function googleModel(input: GoogleModelInput, context?: ModelCreationContext): GoogleModel {
  return buildGoogleModel(input, initialContext(context));
}

/**
 * Defines one exact xAI model Resource.
 * @param input - xAI identity, output ceiling, and supported reasoning control.
 * @param context - Optional exact facts for deterministic application construction.
 * @returns Immutable provider-discriminated model configuration.
 */
export function xAIModel(input: XAIModelInput, context?: ModelCreationContext): XAIModel {
  return buildXAIModel(input, initialContext(context));
}

/**
 * Defines one exact Ollama model and installation endpoint.
 * @param input - Local model tag, output ceiling, and optional installation endpoint.
 * @param context - Optional exact facts for deterministic application construction.
 * @returns Immutable provider-discriminated model configuration.
 */
export function ollamaModel(input: OllamaModelInput, context?: ModelCreationContext): OllamaModel {
  return buildOllamaModel(input, initialContext(context));
}

/**
 * Defines one explicitly named OpenAI-compatible installation.
 * @param input - Installation identity, endpoint, model, and declared output ceiling.
 * @param context - Optional exact facts for deterministic application construction.
 * @returns Immutable compatible-installation configuration.
 */
export function compatibleModel(input: CompatibleModelInput, context?: ModelCreationContext): CompatibleModel {
  return buildCompatibleModel(input, initialContext(context));
}

/** Provider-correlated input accepted by {@link reviseModel}. */
export type ReviseModelInput<ModelType extends Model> = ModelType extends OpenAIModel
  ? OpenAIModelInput
  : ModelType extends GoogleModel
    ? GoogleModelInput
    : ModelType extends XAIModel
      ? XAIModelInput
      : ModelType extends OllamaModel
        ? OllamaModelInput
        : CompatibleModelInput;

/**
 * Earns a child provider configuration without changing logical Model identity.
 * @param previous - Exact immutable parent configuration.
 * @param input - Complete replacement fields for the same provider discriminator.
 * @param context - Explicit child revision identity and trusted observed time.
 * @returns Immutable child revision or an exact invalid/no-change refusal.
 */
export function reviseModel<ModelType extends Model>(
  previous: ModelType,
  input: ReviseModelInput<ModelType>,
  context: ModelRevisionContext,
): ResultValue<ModelType, ModelsError> {
  try {
    /** Revision behavior accepts only a parent created or exactly hydrated by this module. */
    assertAdmittedModel(previous);
    /** Provider discrimination keeps replacement controls aligned with the existing logical Model. */
    const revised = (() => {
      switch (previous.type) {
        case 'openai':
          return buildOpenAIModel(input as OpenAIModelInput, context, previous);
        case 'google':
          return buildGoogleModel(input as GoogleModelInput, context, previous);
        case 'xai':
          return buildXAIModel(input as XAIModelInput, context, previous);
        case 'ollama':
          return buildOllamaModel(input as OllamaModelInput, context, previous);
        case 'compatible':
          return buildCompatibleModel(input as CompatibleModelInput, context, previous);
      }
    })();
    if (revised.contentDigest === previous.contentDigest && revised.name === previous.name) {
      return Result.error(
        new ModelsError('models_revision_no_change', 'Model revision must change behavior or display metadata'),
      );
    }
    return Result.ok(revised as ModelType);
  } catch (cause) {
    /** Existing Archer errors already carry the most precise stable refusal code. */
    const error =
      cause instanceof ModelsError
        ? cause
        : new ModelsError('models_invalid_input', 'Invalid model revision', { cause });
    return Result.error(error);
  }
}

/**
 * Projects exact model identity without retaining the complete configuration.
 * @param model - Immutable model revision selected by a profile or binding.
 * @returns Frozen reference suitable for portable selection records.
 */
export function modelRef(model: Model): ModelRef {
  /** Projection is behavior, so transport records and structural copies cannot invoke it. */
  assertAdmittedModel(model);
  return Object.freeze({
    id: model.id,
    resource: 'model',
    revisionId: model.revisionId,
    type: model.type,
    name: model.name,
    contentDigest: model.contentDigest,
  });
}

/**
 * Refuses structural model fields before internal behavior consumes them.
 * @param model - Proposed process-local admitted model.
 * @returns The same immutable model after runtime provenance succeeds.
 * @internal
 */
export function assertAdmittedModel<ModelType extends Model>(model: ModelType): ModelType {
  if (!ADMITTED_MODELS.has(model)) {
    throw new ModelsError('models_invalid_input', 'Model behavior requires factory or hydration provenance');
  }
  return model;
}

/**
 * Restores one already-validated model DTO as admitted process-local behavior.
 * @param dto - Exact transport-validated model revision.
 * @returns Frozen admitted model recognized by later behavior.
 * @internal
 */
export function hydrateModelState(dto: ModelDto): Model {
  /** A fresh parse prevents the hydration caller from retaining mutable aliases. */
  const parsed = ModelSchema.parse(dto);
  /** Hydration grants provenance only after its public adapter proves exact ancestry. */
  const admitted = parsed as Model;
  ADMITTED_MODELS.add(admitted);
  return admitted;
}
