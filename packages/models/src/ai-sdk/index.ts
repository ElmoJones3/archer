/**
 * @file Adapts caller-owned Vercel AI SDK models to Archer model operations.
 *
 * The adapter performs exactly one SDK step with retries disabled. SDK model
 * values remain borrowed; closing the router prevents new work but never closes
 * or mutates a caller's provider client.
 */

import {
  JsonObjectSchema,
  Result,
  createIdempotencyKey,
  createUuidV4,
  toPublicError,
  type JsonObject,
  type PublicError,
  type Result as ResultValue,
} from '@archer/core';
import { createLiveOperation, type LiveOperation, type OperationSettlement } from '@archer/core/stream';
import { jsonSchema, streamText, tool, type LanguageModel, type ModelMessage as AiSdkMessage, type ToolSet } from 'ai';

import {
  admitToolInput,
  assertAdmittedModelStepRequest,
  type ModelAttemptId,
  type ModelOutputPart,
  type ModelRouter,
  type ModelRouterCloseEvidence,
  type ModelStepCloseEvidence,
  type ModelStepEvent,
  type ModelStepRequest,
  type ModelStepResult,
  type ModelUsage,
} from '../contracts.js';
import { ModelsError } from '../errors.js';
import {
  assertAdmittedModel,
  compatibleModel,
  googleModel,
  ollamaModel,
  openAIModel,
  xAIModel,
  type CompatibleModel,
  type CompatibleModelInput,
  type GoogleModel,
  type GoogleModelInput,
  type Model,
  type OllamaModel,
  type OllamaModelInput,
  type OpenAIModel,
  type OpenAIModelInput,
  type XAIModel,
  type XAIModelInput,
} from '../targets.js';

/** AI SDK model objects expose provider and model identity; global string aliases do not. */
export type InspectableAiSdkLanguageModel = Exclude<LanguageModel, string>;

/** Facts available when a local or compatible installation must be confirmed by its owner. */
export type AiSdkInstallationFacts = Readonly<{
  /** Portable installation target whose endpoint cannot be inspected through AI SDK. */
  target: OllamaModel | CompatibleModel;

  /** Provider identity exposed by the borrowed AI SDK model. */
  provider: string;

  /** Exact model identity exposed by the borrowed AI SDK model. */
  modelId: string;
}>;

/** Caller-owned check that ties an opaque AI SDK client to its declared installation endpoint. */
export type ConfirmAiSdkInstallation = (facts: AiSdkInstallationFacts) => boolean;

/** Input for hosted providers whose SDK identity is directly inspectable. */
type HostedAiSdkModelBindingInput = Readonly<{
  /** Portable hosted-provider target to bind. */
  target: OpenAIModel | GoogleModel | XAIModel;

  /** Borrowed concrete AI SDK model carrying provider and model identity. */
  model: InspectableAiSdkLanguageModel;
}>;

/** Input for endpoints AI SDK does not expose back through the borrowed model. */
type InstalledAiSdkModelBindingInput = Readonly<{
  /** Portable local or compatible installation target to bind. */
  target: OllamaModel | CompatibleModel;

  /** Borrowed concrete AI SDK model carrying provider and model identity. */
  model: InspectableAiSdkLanguageModel;

  /** Explicit application check for the hidden endpoint and installation configuration. */
  confirmInstallation: ConfirmAiSdkInstallation;
}>;

/** Every input that can earn an AI SDK binding. */
export type BindAiSdkModelInput = HostedAiSdkModelBindingInput | InstalledAiSdkModelBindingInput;

/** Prevents an unchecked target/model object pair from satisfying router input. */
declare const aiSdkModelBindingBrand: unique symbol;

/** One exact Archer target bound to a caller-created AI SDK model. */
export type AiSdkModelBinding = Readonly<{
  /** Portable model revision used for exact adapter resolution. */
  target: Model;

  /** Borrowed AI SDK model configured by the host, including credentials. */
  model: InspectableAiSdkLanguageModel;

  /** Compile-time evidence that provider, model, and installation checks ran. */
  readonly [aiSdkModelBindingBrand]: true;
}>;

/** Configuration for one retained AI SDK router. */
export type AiSdkModelRouterOptions = Readonly<{
  /** Exact target bindings available to this router instance. */
  models: readonly AiSdkModelBinding[];
}>;

/** Internal binding retained only after its target passes model admission. */
type AdmittedBinding = Readonly<{
  /** Portable target revalidated before entering the lookup map. */
  target: Model;

  /** Caller-owned SDK model retained without lifecycle authority. */
  model: InspectableAiSdkLanguageModel;
}>;

/** Runtime evidence prevents casts and object spreads from bypassing binding checks. */
const ADMITTED_AI_SDK_BINDINGS = new WeakSet<object>();

/** Mutable text assembly for one provider block. */
interface TextDraft {
  /** Selects answer-text assembly. */
  type: 'text';

  /** Provider block identity. */
  id: string;

  /** Complete text appended so far. */
  text: string;
}

/** Mutable reasoning assembly for one provider block. */
interface ReasoningDraft {
  /** Selects reasoning-text assembly. */
  type: 'reasoning';

  /** Provider block identity. */
  id: string;

  /** Complete reasoning appended so far. */
  text: string;
}

/** Complete provider tool call awaiting immutable JSON admission. */
interface ToolCallDraft {
  /** Selects complete tool-call assembly. */
  type: 'tool-call';

  /** Provider tool-call identity. */
  toolCallId: string;

  /** Model-facing selected tool name. */
  toolName: string;

  /** SDK-validated input awaiting Archer JSON admission. */
  input: unknown;
}

/** Mutable response assembly kept private until terminal deep freezing. */
type ContentDraft = TextDraft | ReasoningDraft | ToolCallDraft;

/** AI SDK usage subset retained by Archer's normalized terminal result. */
type SdkUsage = Readonly<{
  /** Input tokens reported by AI SDK, if the provider supplied them. */
  inputTokens: number | undefined;

  /** Output tokens reported by AI SDK, if the provider supplied them. */
  outputTokens: number | undefined;

  /** Total tokens reported or derived by AI SDK, if available. */
  totalTokens: number | undefined;
}>;

/** Private terminal metadata captured from the SDK finish part. */
type FinishDraft = Readonly<{
  /** Provider-neutral finish category. */
  reason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

  /** Provider-neutral usage copied from the finish part. */
  usage: ModelUsage;
}>;

/** Stable provider failure and retry advice returned together. */
type ProviderFailure = Readonly<{
  /** Redacted provider failure suitable for public transport. */
  error: PublicError;

  /** A provider failure may justify a separately admitted new attempt. */
  retry: 'admit-new-attempt';
}>;

/** UTF-8 byte accounting gives deltas a transport-independent offset. */
const UTF8_ENCODER = new TextEncoder();

/** Shared immutable close evidence for one router instance. */
const ROUTER_CLOSED = Object.freeze({ kind: 'closed' } as const);

/**
 * Creates the exact key used to resolve an immutable model revision.
 * @param model - Complete target or request-carried equivalent.
 * @returns Collision-free tuple encoding over branded UUID values.
 */
function bindingKey(model: Model): string {
  return `${model.id}\0${model.revisionId}\0${model.contentDigest}`;
}

/**
 * Converts an AbortSignal reason into the bounded public model-result vocabulary.
 * @param signal - Already-aborted host signal owned by the caller.
 * @returns Non-empty bounded cancellation reason.
 */
function signalAbortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' && signal.reason.trim().length > 0
    ? signal.reason.trim().slice(0, 256)
    : 'caller-signal';
}

/**
 * Derives the provider namespace expected from one portable target.
 * @param target - Provider-discriminated Archer model configuration.
 * @returns Lower-case AI SDK provider family used for exact-prefix matching.
 */
function expectedProviderFamily(target: Model): string {
  switch (target.type) {
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'xai':
      return 'xai';
    case 'ollama':
      return 'ollama';
    case 'compatible':
      return target.provider.toLowerCase();
  }
}

/**
 * Checks the public identity AI SDK exposes without assuming opaque client configuration.
 * @param target - Portable target used in requests and receipts.
 * @param model - Borrowed concrete AI SDK model used for the provider effect.
 * @returns Whether provider family and exact model identifier agree.
 */
function sdkIdentityMatches(target: Model, model: InspectableAiSdkLanguageModel): boolean {
  /** Provider suffixes identify API families such as `openai.responses`. */
  const provider = model.provider.toLowerCase();
  /** Exact family boundaries prevent `openai-proxy` from posing as `openai`. */
  const family = expectedProviderFamily(target);
  return (provider === family || provider.startsWith(`${family}.`)) && model.modelId === target.model;
}

/**
 * Admits one borrowed AI SDK model only when it matches the portable target it will execute.
 * @param input - Hosted identity pair or installation pair with explicit endpoint confirmation.
 * @returns Opaque binding accepted by {@link createAiSdkModelRouter}.
 * @throws {ModelsError} Before any provider effect when identity or installation disagrees.
 */
export function bindAiSdkModel(input: BindAiSdkModelInput): AiSdkModelBinding {
  /** Runtime provenance prevents structural casts and decoded DTOs from acquiring provider effects. */
  let target: Model;
  try {
    target = assertAdmittedModel(input.target);
  } catch (cause) {
    throw new ModelsError('models_invalid_input', 'Invalid AI SDK model binding target', { cause });
  }
  if (!sdkIdentityMatches(target, input.model)) {
    throw new ModelsError('models_target_mismatch', 'AI SDK provider or model does not match its Archer target', {
      details: {
        targetProvider: target.type === 'compatible' ? target.provider : target.type,
        targetModel: target.model,
        sdkProvider: input.model.provider,
        sdkModel: input.model.modelId,
      },
    });
  }
  if (target.type === 'ollama' || target.type === 'compatible') {
    if (!('confirmInstallation' in input)) {
      throw new ModelsError('models_target_mismatch', 'AI SDK installation binding requires endpoint confirmation');
    }
    /** AI SDK hides endpoint configuration, so the installation owner must confirm that final fact. */
    let confirmed = false;
    try {
      confirmed = input.confirmInstallation({ target, provider: input.model.provider, modelId: input.model.modelId });
    } catch (cause) {
      throw new ModelsError('models_target_mismatch', 'AI SDK installation confirmation failed', { cause });
    }
    if (!confirmed) {
      throw new ModelsError('models_target_mismatch', 'AI SDK installation does not match its Archer target');
    }
  }
  /** The compile-time brand is intentionally unmaterialized; runtime provenance is held in the WeakSet. */
  const binding = Object.freeze({ target, model: input.model }) as AiSdkModelBinding;
  ADMITTED_AI_SDK_BINDINGS.add(binding);
  return binding;
}

/** OpenAI helper input derives the portable model identifier from the borrowed SDK model. */
export type BindOpenAIAiSdkModelInput = Omit<OpenAIModelInput, 'model'> &
  Readonly<{
    /** Borrowed OpenAI SDK model whose identifier becomes portable target state. */
    sdkModel: InspectableAiSdkLanguageModel;
  }>;

/** Google helper input derives the portable model identifier from the borrowed SDK model. */
export type BindGoogleAiSdkModelInput = Omit<GoogleModelInput, 'model'> &
  Readonly<{
    /** Borrowed Google SDK model whose identifier becomes portable target state. */
    sdkModel: InspectableAiSdkLanguageModel;
  }>;

/** xAI helper input derives the portable model identifier from the borrowed SDK model. */
export type BindXAiSdkModelInput = Omit<XAIModelInput, 'model'> &
  Readonly<{
    /** Borrowed xAI SDK model whose identifier becomes portable target state. */
    sdkModel: InspectableAiSdkLanguageModel;
  }>;

/** Ollama helper input keeps hidden endpoint verification explicit. */
export type BindOllamaAiSdkModelInput = Omit<OllamaModelInput, 'model'> &
  Readonly<{
    /** Borrowed Ollama SDK model whose identifier becomes portable target state. */
    sdkModel: InspectableAiSdkLanguageModel;
    /** Confirms the SDK client's opaque endpoint agrees with the portable target. */
    confirmInstallation: ConfirmAiSdkInstallation;
  }>;

/** Compatible-provider helper input keeps hidden endpoint verification explicit. */
export type BindCompatibleAiSdkModelInput = Omit<CompatibleModelInput, 'model' | 'provider'> &
  Readonly<{
    /** Borrowed compatible SDK model whose identifier becomes portable target state. */
    sdkModel: InspectableAiSdkLanguageModel;
    /** Confirms the SDK client's opaque endpoint agrees with the portable target. */
    confirmInstallation: ConfirmAiSdkInstallation;
  }>;

/** OpenAI-narrowed binding returned by its ergonomic construction helper. */
export type OpenAIAiSdkModelBinding = AiSdkModelBinding &
  Readonly<{
    /** Portable OpenAI target derived and admitted by the helper. */
    target: OpenAIModel;
  }>;

/** Google-narrowed binding returned by its ergonomic construction helper. */
export type GoogleAiSdkModelBinding = AiSdkModelBinding &
  Readonly<{
    /** Portable Google target derived and admitted by the helper. */
    target: GoogleModel;
  }>;

/** xAI-narrowed binding returned by its ergonomic construction helper. */
export type XAiSdkModelBinding = AiSdkModelBinding &
  Readonly<{
    /** Portable xAI target derived and admitted by the helper. */
    target: XAIModel;
  }>;

/** Ollama-narrowed binding returned by its ergonomic construction helper. */
export type OllamaAiSdkModelBinding = AiSdkModelBinding &
  Readonly<{
    /** Portable Ollama target derived and admitted by the helper. */
    target: OllamaModel;
  }>;

/** Compatible-provider binding returned by its ergonomic construction helper. */
export type CompatibleAiSdkModelBinding = AiSdkModelBinding &
  Readonly<{
    /** Portable compatible target derived and admitted by the helper. */
    target: CompatibleModel;
  }>;

/**
 * Creates and binds one OpenAI target with a single model-ID source of truth.
 * @param input - Borrowed SDK model, declared output ceiling, and OpenAI controls.
 * @returns Opaque binding whose target can be reused by an AgentProfile.
 */
export function bindOpenAIAiSdkModel(input: BindOpenAIAiSdkModelInput): OpenAIAiSdkModelBinding {
  /** SDK identity owns the model string while Archer retains its output ceiling and controls. */
  const { sdkModel, ...targetInput } = input;
  return bindAiSdkModel({
    target: openAIModel({ ...targetInput, model: sdkModel.modelId }),
    model: sdkModel,
  }) as OpenAIAiSdkModelBinding;
}

/**
 * Creates and binds one Google target with a single model-ID source of truth.
 * @param input - Borrowed SDK model, declared output ceiling, and Gemini controls.
 * @returns Opaque binding whose target can be reused by an AgentProfile.
 */
export function bindGoogleAiSdkModel(input: BindGoogleAiSdkModelInput): GoogleAiSdkModelBinding {
  /** SDK identity owns the model string while Archer retains its output ceiling and controls. */
  const { sdkModel, ...targetInput } = input;
  return bindAiSdkModel({
    target: googleModel({ ...targetInput, model: sdkModel.modelId }),
    model: sdkModel,
  }) as GoogleAiSdkModelBinding;
}

/**
 * Creates and binds one xAI target with a single model-ID source of truth.
 * @param input - Borrowed SDK model, declared output ceiling, and xAI controls.
 * @returns Opaque binding whose target can be reused by an AgentProfile.
 */
export function bindXAiSdkModel(input: BindXAiSdkModelInput): XAiSdkModelBinding {
  /** SDK identity owns the model string while Archer retains its output ceiling and controls. */
  const { sdkModel, ...targetInput } = input;
  return bindAiSdkModel({
    target: xAIModel({ ...targetInput, model: sdkModel.modelId }),
    model: sdkModel,
  }) as XAiSdkModelBinding;
}

/**
 * Creates and binds one Ollama target after explicit installation confirmation.
 * @param input - Borrowed SDK model, endpoint, output ceiling, and installation check.
 * @returns Opaque binding whose target can be reused by an AgentProfile.
 */
export function bindOllamaAiSdkModel(input: BindOllamaAiSdkModelInput): OllamaAiSdkModelBinding {
  /** AI SDK identity supplies the model tag; the host confirms its hidden endpoint. */
  const { sdkModel, confirmInstallation, ...targetInput } = input;
  return bindAiSdkModel({
    target: ollamaModel({ ...targetInput, model: sdkModel.modelId }),
    model: sdkModel,
    confirmInstallation,
  }) as OllamaAiSdkModelBinding;
}

/**
 * Creates and binds one named compatible installation after explicit confirmation.
 * @param input - Borrowed SDK model, installation, endpoint, output ceiling, and host check.
 * @returns Opaque binding whose target can be reused by an AgentProfile.
 */
export function bindCompatibleAiSdkModel(input: BindCompatibleAiSdkModelInput): CompatibleAiSdkModelBinding {
  /** SDK identity supplies provider/model keys; the host names and confirms the opaque installation. */
  const { sdkModel, confirmInstallation, ...targetInput } = input;
  return bindAiSdkModel({
    target: compatibleModel({ ...targetInput, provider: sdkModel.provider, model: sdkModel.modelId }),
    model: sdkModel,
    confirmInstallation,
  }) as CompatibleAiSdkModelBinding;
}

/**
 * Maps only controls supported by the model discriminator to AI SDK options.
 * @param model - Exact provider-specific configuration.
 * @returns Provider namespace options or undefined when no control was selected.
 */
function providerOptions(model: Model): JsonObject | undefined {
  switch (model.type) {
    case 'openai': {
      if (model.reasoningEffort === undefined && model.serviceTier === undefined) return undefined;
      return {
        openai: {
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          ...(model.serviceTier === undefined ? {} : { serviceTier: model.serviceTier }),
        },
      };
    }
    case 'google': {
      if (model.thinking === undefined) return undefined;
      return {
        google: {
          thinkingConfig: {
            thinkingBudget: model.thinking.budgetTokens,
            ...(model.thinking.includeThoughts === undefined
              ? {}
              : { includeThoughts: model.thinking.includeThoughts }),
          },
        },
      };
    }
    case 'xai': {
      if (model.reasoningEffort === undefined) return undefined;
      return { xai: { reasoningEffort: model.reasoningEffort } };
    }
    case 'ollama':
    case 'compatible':
      return undefined;
  }
}

/**
 * Converts Archer text messages without passing provider-owned metadata inward.
 * @param request - Admitted request with immutable ordered messages.
 * @returns Fresh AI SDK messages safe for adapter mutation.
 */
function sdkMessages(request: ModelStepRequest): AiSdkMessage[] {
  return request.messages.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Joins provider-neutral system messages into AI SDK's dedicated instructions field.
 * @param request - Admitted request whose message order is already acknowledged.
 * @returns Complete instructions or undefined when the request has none.
 */
function sdkInstructions(request: ModelStepRequest): string | undefined {
  /** AI SDK's dedicated field preserves Archer's distinct instruction contract. */
  const instructions = request.instructions.join('\n\n');
  return instructions.length === 0 ? undefined : instructions;
}

/**
 * Converts portable JSON Schema tool descriptions into non-executing SDK tools.
 * @param request - Admitted request with unique model-facing tool names.
 * @returns SDK tool set that can produce calls but has no host execution callback.
 */
function sdkTools(request: ModelStepRequest): ToolSet | undefined {
  if (request.tools.length === 0) return undefined;
  /** Owns a fresh map so model SDK code cannot mutate request-owned arrays. */
  const tools: ToolSet = {};
  /** Tool order follows the already-admitted request catalogue. */
  for (const definition of request.tools) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
    });
  }
  return tools;
}

/**
 * Freezes one model event before it enters core's bounded shared hot graph.
 * @param event - Adapter-created transient progress.
 * @returns Immutable event with the same discriminated shape.
 */
function normalizeEvent(event: ModelStepEvent): ModelStepEvent {
  return Object.freeze({ ...event });
}

/**
 * Measures the exact JSON wire form used by the v1 event bridge.
 * @param event - Already normalized model event.
 * @returns UTF-8 encoded byte length.
 */
function measureEvent(event: ModelStepEvent): number {
  return UTF8_ENCODER.encode(JSON.stringify(event)).byteLength;
}

/**
 * Converts SDK usage while preserving unavailable counters as absent fields.
 * @param usage - AI SDK's normalized counters.
 * @param usage.inputTokens - Input-token count or provider omission.
 * @param usage.outputTokens - Output-token count or provider omission.
 * @param usage.totalTokens - Total-token count or provider omission.
 * @returns Deeply immutable Archer usage.
 */
function normalizeUsage(usage: SdkUsage): ModelUsage {
  return Object.freeze({
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  });
}

/**
 * Converts private content assembly into complete immutable terminal parts.
 * @param drafts - Content blocks in provider start/call order.
 * @returns Complete normalized output suitable for gap recovery.
 */
function finishContent(drafts: readonly ContentDraft[]): readonly ModelOutputPart[] {
  return Object.freeze(
    drafts.map((draft): ModelOutputPart => {
      switch (draft.type) {
        case 'text':
          return Object.freeze({ type: 'text', text: draft.text });
        case 'reasoning':
          return Object.freeze({ type: 'reasoning', text: draft.text });
        case 'tool-call':
          return Object.freeze({
            type: 'tool-call',
            toolCallId: draft.toolCallId,
            toolName: draft.toolName,
            input: admitToolInput(draft.input),
          });
      }
    }),
  );
}

/**
 * Produces stable retry advice without exposing arbitrary provider errors.
 * @param error - Unknown provider or SDK failure.
 * @returns Redacted error plus conservative new-attempt advice.
 */
function providerFailure(error: unknown): ProviderFailure {
  return Object.freeze({
    error: toPublicError(error, {
      code: 'model_provider_failed',
      message: 'The model provider failed during generation',
      retryable: true,
    }),
    retry: 'admit-new-attempt',
  });
}

/**
 * Runs one AI SDK stream and publishes only normalized Archer progress.
 * @param binding - Exact borrowed SDK model resolved before the operation began.
 * @param request - Revalidated immutable request.
 * @param attemptId - Identity shared by every delta and terminal result.
 * @param emit - Core-owned publication capability.
 * @param abortSignal - Active abort signal from the retained operation.
 * @returns One terminal model result; expected provider failures remain data.
 */
async function runStep(
  binding: AdmittedBinding,
  request: ModelStepRequest,
  attemptId: ModelAttemptId,
  emit: (event: ModelStepEvent) => void,
  abortSignal: AbortSignal,
): Promise<ModelStepResult> {
  /** Deadline abort remains distinct from a caller-issued operation abort. */
  const deadlineController = new AbortController();
  /** Uses the platform signal combiner so both cancellation sources reach the SDK. */
  const signal = AbortSignal.any([abortSignal, deadlineController.signal]);
  /** Prevents a settled request from retaining its deadline timer. */
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  if (request.deadline !== undefined) {
    /** Canonical timestamps make this conversion independent of local timezone. */
    const remaining = Date.parse(request.deadline) - Date.now();
    if (remaining <= 0) deadlineController.abort('deadline-exceeded');
    else deadlineTimer = setTimeout(() => deadlineController.abort('deadline-exceeded'), remaining);
  }

  /** Preserves provider block order separately from content lookup. */
  const content: ContentDraft[] = [];
  /** Locates text and reasoning blocks for incremental append. */
  const blocks = new Map<string, TextDraft | ReasoningDraft>();
  /** Tracks streamed tool-input offsets even before the complete call arrives. */
  const toolInputBytes = new Map<string, number>();
  /** Retains the last finish metadata only after the stream proves terminal. */
  let finish: FinishDraft | undefined;
  /** Records the first SDK error part without leaking it through transient events. */
  let streamError: unknown;

  try {
    if (deadlineController.signal.aborted) {
      return Object.freeze({
        type: 'failed',
        attemptId,
        error: toPublicError(new Error('deadline'), {
          code: 'model_deadline_exceeded',
          message: 'The model step deadline elapsed before generation began',
        }),
        retry: 'do-not-retry',
      });
    }

    /** Resolve optional structures once so exact-optional typing cannot retain undefined. */
    const tools = sdkTools(request);
    /** Resolve provider options once for the same exact model revision. */
    const options = providerOptions(request.model);
    /** AI SDK 7 requires system content through its dedicated instructions field. */
    const instructions = sdkInstructions(request);
    /** One streamText call is the complete adapter effect; retries are disabled. */
    const generated = streamText({
      model: binding.model,
      messages: sdkMessages(request),
      ...(instructions === undefined ? {} : { instructions }),
      ...(tools === undefined ? {} : { tools }),
      maxRetries: 0,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(options === undefined ? {} : { providerOptions: options as never }),
      abortSignal: signal,
      /**
       * Suppresses AI SDK's default console logger; terminal errors remain Archer data.
       * @returns No callback output or side effect.
       */
      onError: () => undefined,
    });

    /** Pulling the SDK stream drives the provider once and preserves native order. */
    for await (const part of generated.stream) {
      switch (part.type) {
        case 'text-start': {
          /** New text block retains provider order even before content arrives. */
          const block: TextDraft = { type: 'text', id: part.id, text: '' };
          blocks.set(`text\0${part.id}`, block);
          content.push(block);
          break;
        }
        case 'text-delta': {
          /** Kind-qualified key prevents a provider reusing an ID across block kinds. */
          const key = `text\0${part.id}`;
          /** Missing start parts are tolerated without losing terminal reconstruction. */
          const block = blocks.get(key) ?? { type: 'text', id: part.id, text: '' };
          if (!blocks.has(key)) {
            blocks.set(key, block);
            content.push(block);
          }
          /** Offset measures complete prior text, not JavaScript UTF-16 units. */
          const offsetBytes = UTF8_ENCODER.encode(block.text).byteLength;
          block.text += part.text;
          emit(Object.freeze({ type: 'text-delta', attemptId, blockId: part.id, offsetBytes, text: part.text }));
          break;
        }
        case 'reasoning-start': {
          /** New reasoning block stays distinct from user-visible answer text. */
          const block: ReasoningDraft = {
            type: 'reasoning',
            id: part.id,
            text: '',
          };
          blocks.set(`reasoning\0${part.id}`, block);
          content.push(block);
          break;
        }
        case 'reasoning-delta': {
          /** Kind-qualified key prevents a provider reusing an ID across block kinds. */
          const key = `reasoning\0${part.id}`;
          /** Missing start parts are tolerated without losing terminal reconstruction. */
          const block = blocks.get(key) ?? { type: 'reasoning', id: part.id, text: '' };
          if (!blocks.has(key)) {
            blocks.set(key, block);
            content.push(block);
          }
          /** Offset measures complete prior reasoning as UTF-8 bytes. */
          const offsetBytes = UTF8_ENCODER.encode(block.text).byteLength;
          block.text += part.text;
          emit(Object.freeze({ type: 'reasoning-delta', attemptId, blockId: part.id, offsetBytes, text: part.text }));
          break;
        }
        case 'tool-input-start':
          toolInputBytes.set(part.id, 0);
          break;
        case 'tool-input-delta': {
          /** Tool-input offsets start at zero when providers omit the start marker. */
          const offsetBytes = toolInputBytes.get(part.id) ?? 0;
          toolInputBytes.set(part.id, offsetBytes + UTF8_ENCODER.encode(part.delta).byteLength);
          emit(
            Object.freeze({ type: 'tool-input-delta', attemptId, toolCallId: part.id, offsetBytes, text: part.delta }),
          );
          break;
        }
        case 'tool-call':
          content.push({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
          break;
        case 'finish':
          finish = Object.freeze({ reason: part.finishReason, usage: normalizeUsage(part.totalUsage) });
          break;
        case 'abort':
          break;
        case 'error':
          streamError ??= part.error;
          break;
        case 'custom':
        case 'file':
        case 'finish-step':
        case 'reasoning-end':
        case 'reasoning-file':
        case 'source':
        case 'start':
        case 'start-step':
        case 'text-end':
        case 'tool-approval-request':
        case 'tool-approval-response':
        case 'tool-error':
        case 'tool-input-end':
        case 'tool-output-denied':
        case 'tool-result':
          break;
        default:
          break;
      }
    }

    if (abortSignal.aborted) {
      return Object.freeze({ type: 'aborted', attemptId, reason: String(abortSignal.reason ?? 'aborted') });
    }
    if (deadlineController.signal.aborted) {
      return Object.freeze({
        type: 'failed',
        attemptId,
        error: toPublicError(new Error('deadline'), {
          code: 'model_deadline_exceeded',
          message: 'The model step deadline elapsed during generation',
        }),
        retry: 'do-not-retry',
      });
    }
    if (streamError !== undefined) {
      return Object.freeze({ type: 'failed', attemptId, ...providerFailure(streamError) });
    }
    if (finish === undefined) {
      return Object.freeze({
        type: 'failed',
        attemptId,
        error: toPublicError(new Error('missing finish'), {
          code: 'model_protocol_failed',
          message: 'The model stream ended without terminal metadata',
        }),
        retry: 'admit-new-attempt',
      });
    }
    return Object.freeze({
      type: 'completed',
      attemptId,
      finishReason: finish.reason,
      content: finishContent(content),
      usage: finish.usage,
    });
  } catch (error) {
    if (abortSignal.aborted) {
      return Object.freeze({ type: 'aborted', attemptId, reason: String(abortSignal.reason ?? 'aborted') });
    }
    if (deadlineController.signal.aborted) {
      return Object.freeze({
        type: 'failed',
        attemptId,
        error: toPublicError(error, {
          code: 'model_deadline_exceeded',
          message: 'The model step deadline elapsed during generation',
        }),
        retry: 'do-not-retry',
      });
    }
    return Object.freeze({ type: 'failed', attemptId, ...providerFailure(error) });
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

/**
 * Maps operation settlement into retained non-authoritative cleanup evidence.
 * @param settlement - Tagged operation result or redacted unexpected failure.
 * @returns Immutable close evidence reflecting the terminal path.
 */
function closeEvidence(settlement: OperationSettlement<ModelStepResult>): ModelStepCloseEvidence {
  if (settlement.kind === 'failed') return Object.freeze({ kind: 'closed', disposition: 'failed' });
  return Object.freeze({ kind: 'closed', disposition: settlement.value.type });
}

/**
 * Creates one retained router over exact borrowed AI SDK model bindings.
 * @param options - Caller-owned SDK models paired with portable targets.
 * @returns Router that prevents new starts after idempotent closure.
 */
export function createAiSdkModelRouter(options: AiSdkModelRouterOptions): ModelRouter {
  /** Resolves exact target revisions without provider or name fallback. */
  const bindings = new Map<string, AdmittedBinding>();
  /** Each proposed binding is independently admitted before the map is usable. */
  for (const proposed of options.models) {
    if (!ADMITTED_AI_SDK_BINDINGS.has(proposed)) {
      throw new ModelsError(
        'models_target_mismatch',
        'AI SDK routers require bindings produced by bindAiSdkModel or a provider helper',
      );
    }
    /** Admitted models are already immutable and retain factory or hydration provenance. */
    let target: Model;
    try {
      target = assertAdmittedModel(proposed.target);
    } catch (cause) {
      throw new ModelsError('models_invalid_input', 'Invalid AI SDK model binding target', { cause });
    }
    if (!sdkIdentityMatches(target, proposed.model)) {
      throw new ModelsError('models_target_mismatch', 'AI SDK binding identity changed after admission');
    }
    /** Exact revision tuple rejects both duplicates and silent fallback. */
    const key = bindingKey(target);
    if (bindings.has(key)) {
      throw new ModelsError('models_target_duplicate', 'AI SDK router contains a duplicate target binding', {
        details: JsonObjectSchema.parse({ modelId: target.id, revisionId: target.revisionId }),
      });
    }
    bindings.set(key, Object.freeze({ target, model: proposed.model }));
  }

  /** Closure rejects future starts but does not cancel returned independent operations. */
  let closing = false;
  /** Retains one shared router close settlement. */
  let closePromise: Promise<ModelRouterCloseEvidence> | undefined;
  /** Settles `closed` even when the owner observes it before calling close. */
  let settleClosed: ((evidence: ModelRouterCloseEvidence) => void) | undefined;
  /** Public close observation remains separate from activation. */
  const closed = new Promise<ModelRouterCloseEvidence>((resolve) => {
    settleClosed = resolve;
  });

  /** Public router owns only its activation gate and borrowed binding table. */
  const router: ModelRouter = {
    closed,
    /**
     * Resolves one exact target before returning an already-running operation.
     * @param request - Provider-neutral request to revalidate and resolve.
     * @param startOptions - Optional process-local cancellation signal.
     * @returns Started operation or an exact pre-effect refusal.
     */
    async startStep(
      request,
      startOptions,
    ): Promise<ResultValue<LiveOperation<ModelStepEvent, ModelStepResult, ModelStepCloseEvidence>, ModelsError>> {
      if (closing) {
        return Result.error(new ModelsError('models_router_closed', 'The model router is closed'));
      }

      /** Exact command provenance prevents a structural copy from reaching the SDK. */
      let admitted: ModelStepRequest;
      try {
        /** Parsing may establish shape, but only the factory-created object carries effect authority. */
        admitted = assertAdmittedModelStepRequest(request);
      } catch (cause) {
        return Result.error(new ModelsError('models_invalid_input', 'Invalid model step request', { cause }));
      }

      /** Lookup requires logical identity, revision identity, and content identity. */
      const binding = bindings.get(bindingKey(admitted.model));
      if (binding === undefined) {
        return Result.error(
          new ModelsError('models_target_unbound', 'No AI SDK model is bound to the requested target revision', {
            details: JsonObjectSchema.parse({ modelId: admitted.model.id, revisionId: admitted.model.revisionId }),
          }),
        );
      }

      /** Capture pre-activation cancellation before the hot operation can invoke a provider. */
      const signal = startOptions?.signal;
      /** An already-aborted host receives a terminal operation without crossing the SDK boundary. */
      const initialAbortReason = signal?.aborted === true ? signalAbortReason(signal) : undefined;

      /** A fresh UUID separates retries of one request into distinct attempts. */
      const attemptId = createUuidV4() as ModelAttemptId;
      /** Core owns hot fan-out, active abort, terminal settlement, and retained close. */
      const operation = createLiveOperation<ModelStepEvent, ModelStepResult, ModelStepCloseEvidence>({
        source: 'model-step',
        epoch: attemptId,
        eventEncoding: { revision: 'archer-model-step-event-v1', normalize: normalizeEvent, measure: measureEvent },
        /**
         * Activates the one borrowed SDK model selected before this operation existed.
         * @param context - Core-owned progress and abort capabilities.
         * @returns Tagged terminal result for the attempt.
         */
        async start(context) {
          if (initialAbortReason !== undefined) {
            return Object.freeze({ type: 'aborted', attemptId, reason: initialAbortReason });
          }
          return await runStep(binding, admitted, attemptId, context.emit, context.signal);
        },
        closeEvidence,
        /**
         * Classifies whether accepted abort reached a tagged terminal settlement.
         * @param settlement - Terminal result or unexpected runtime failure.
         * @returns Core abort disposition for retained evidence.
         */
        classifyAbort(settlement) {
          if (settlement.kind === 'failed') {
            return Object.freeze({ kind: 'cleanup-unproved', failure: settlement.error });
          }
          return Object.freeze({
            kind: 'attempt-settled',
            outcome: settlement.value.type === 'aborted' ? 'aborted' : 'completed',
          });
        },
        failure: {
          code: 'model_operation_failed',
          message: 'The model operation failed outside its terminal protocol',
          retryable: true,
        },
      });
      /** Standard AbortSignal sugar maps host cancellation into the explicit operation command. */
      if (signal !== undefined && initialAbortReason === undefined) {
        /** One listener owns exactly one idempotency identity for this activation. */
        const idempotencyKey = createIdempotencyKey();
        /** Fire-and-observe avoids delaying the signal event while retaining rejection handling. */
        const abort = () => {
          /** Bounded conversion observes the reason only after the host actually aborts. */
          const reason = signalAbortReason(signal);
          void operation.abort(Object.freeze({ idempotencyKey, reason })).catch(() => undefined);
        };
        signal.addEventListener('abort', abort, { once: true });
        /** Terminal settlement releases a host signal that may outlive this operation. */
        void operation.result.then(
          () => signal.removeEventListener('abort', abort),
          () => signal.removeEventListener('abort', abort),
        );
      }
      return Result.ok(operation);
    },
    /**
     * Idempotently closes only the router activation gate.
     * @returns Shared immutable router close evidence.
     */
    close() {
      closing = true;
      closePromise ??= Promise.resolve(ROUTER_CLOSED);
      void closePromise.then((evidence) => settleClosed?.(evidence));
      return closePromise;
    },
    /** Delegates language disposal to the same borrowed-resource-safe close path. */
    async [Symbol.asyncDispose]() {
      await router.close();
    },
  };

  return Object.freeze(router);
}
