/** @file Defines provider-neutral model requests, live progress, and results. */

import * as z from 'zod';

import {
  JsonObjectSchema,
  JsonValueSchema,
  PublicErrorSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  createUuidV4,
  type ArcherObject,
  type JsonObject,
  type JsonValue,
  type PublicError,
  type Result,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '@archer/core';
import type { LiveOperation } from '@archer/core/stream';

import { ModelsError } from './errors.js';
import { ModelSchema, assertAdmittedModel, type Model, type ModelDto } from './targets.js';

/** Prevents arbitrary UUIDs from naming a model-step request. */
declare const modelStepRequestIdBrand: unique symbol;

/** Identity of one exact provider request before any attempt exists. */
export type ModelStepRequestId = UuidV4 & {
  /** Carries compile-time evidence of request identity admission. */
  readonly [modelStepRequestIdBrand]: true;
};

/** Portable evidence that ties a prepared request to one exact ResourceSet receipt. */
export type ModelStepResourceSetRef = Readonly<{
  /** Identifies the immutable compiled Resource selection. */
  id: UuidV4;

  /** Prevents another Archer object from posing as compilation evidence. */
  object: 'resource-set';

  /** Binds the request to the selected refs and admission policy. */
  evidenceDigest: Sha256Digest;
}>;

/** Prevents decoded or copied command fields from acquiring provider-effect authority. */
declare const admittedModelStepRequestBrand: unique symbol;

/** Prevents request identity from being reused as an execution attempt. */
declare const modelAttemptIdBrand: unique symbol;

/** Identity of one concrete provider attempt and all its transient deltas. */
export type ModelAttemptId = UuidV4 & {
  /** Carries compile-time evidence of attempt identity admission. */
  readonly [modelAttemptIdBrand]: true;
};

/** Text-only v1 conversation roles shared by supported provider adapters. */
export type ModelMessage = Readonly<{
  /** Selects the speaker without mixing instructions into conversation order. */
  role: 'user' | 'assistant';

  /** Complete UTF-8 text supplied for this message. */
  content: string;
}>;

/** Portable model-visible tool description; execution belongs to a later layer. */
export type ModelToolDefinition = Readonly<{
  /** Unique model-facing name within this exact request. */
  name: string;

  /** Explains when the model should select the tool. */
  description: string;

  /** JSON Schema describing tool input without choosing a validator runtime. */
  inputSchema: JsonObject;
}>;

/** One exact provider-neutral model call. */
export type ModelStepRequest = ArcherObject<'model-step-request', ModelStepRequestId> &
  Readonly<{
    /** Pins the complete immutable model Resource used for adapter resolution. */
    model: Model;

    /** Ordered model instructions kept distinct from conversation history. */
    instructions: readonly string[];

    /** Ordered acknowledged user and assistant messages supplied to this step. */
    messages: readonly ModelMessage[];

    /** Ordered portable tool definitions offered without host executors. */
    tools: readonly ModelToolDefinition[];

    /** Maximum generated tokens already reconciled with model and work budgets. */
    maxOutputTokens: number;

    /** Optional exact ResourceSet evidence supplied by the Resource preparation layer. */
    resourceSet?: ModelStepResourceSetRef;

    /** Optional sampling temperature shared only where the provider supports it. */
    temperature?: number;

    /** Absolute work deadline propagated to the provider abort boundary. */
    deadline?: Timestamp;

    /** Compile-time evidence distinguishes an acknowledged command from transport data. */
    readonly [admittedModelStepRequestBrand]: true;
  }>;

/** JSON-safe model-step request state whose nested model has not earned behavior provenance. */
export type ModelStepRequestDto = Omit<ModelStepRequest, 'model' | typeof admittedModelStepRequestBrand> &
  Readonly<{
    /** Exact portable model fields decoded without process-local admission. */
    model: ModelDto;
  }>;

/** Developer input accepted by {@link createModelStepRequest}. */
export type CreateModelStepRequestInput = Readonly<{
  /** Exact model Resource selected for the request. */
  model: Model;

  /** Optional ordered model instructions; defaults to none. */
  instructions?: readonly string[];

  /** Ordered user and assistant conversation. */
  messages: readonly ModelMessage[];

  /** Optional portable tool catalogue; defaults to none. */
  tools?: readonly ModelToolDefinition[];

  /** Maximum generated tokens admitted for this step. */
  maxOutputTokens: number;

  /** Pins a Resource-prepared request without coupling Models back to Resources. */
  resourceSet?: ModelStepResourceSetRef;

  /** Optional provider-neutral sampling temperature. */
  temperature?: number;

  /** Optional absolute deadline derived by BudgetPolicy allocation. */
  deadline?: Timestamp;
}>;

/** Exact identity and time facts accepted by deterministic request assemblers. */
export type ModelStepRequestContext = Readonly<{
  /** Supplies the UUIDv4 for this acknowledged request. */
  id: ModelStepRequestId;

  /** Supplies the trusted instant at which the request became executable. */
  createdAt: Timestamp;
}>;

/** One ordered non-authoritative update from an active model attempt. */
export type ModelStepEvent =
  | Readonly<{
      /** Identifies generated answer text. */
      type: 'text-delta';
      /** Concrete provider attempt producing the delta. */
      attemptId: ModelAttemptId;
      /** Provider block identity within the response. */
      blockId: string;
      /** UTF-8 byte position immediately before this delta. */
      offsetBytes: number;
      /** Newly generated text. */
      text: string;
    }>
  | Readonly<{
      /** Identifies generated reasoning presentation. */
      type: 'reasoning-delta';
      /** Concrete provider attempt producing the delta. */
      attemptId: ModelAttemptId;
      /** Provider reasoning-block identity. */
      blockId: string;
      /** UTF-8 byte position immediately before this delta. */
      offsetBytes: number;
      /** Newly generated reasoning text. */
      text: string;
    }>
  | Readonly<{
      /** Identifies streamed tool-input JSON text. */
      type: 'tool-input-delta';
      /** Concrete provider attempt producing the delta. */
      attemptId: ModelAttemptId;
      /** Provider tool-call identity. */
      toolCallId: string;
      /** UTF-8 byte position immediately before this delta. */
      offsetBytes: number;
      /** Newly generated JSON text. */
      text: string;
    }>;

/** Complete normalized content retained after transient deltas stop. */
export type ModelOutputPart =
  | Readonly<{
      /** Identifies complete answer text. */
      type: 'text';

      /** Complete text reconstructed from ordered deltas. */
      text: string;
    }>
  | Readonly<{
      /** Identifies complete reasoning presentation. */
      type: 'reasoning';

      /** Complete reasoning text reconstructed from ordered deltas. */
      text: string;
    }>
  | Readonly<{
      /** Identifies one complete model-proposed tool call. */
      type: 'tool-call';

      /** Provider identity used to pair a later tool result. */
      toolCallId: string;

      /** Model-facing tool name selected from the request catalogue. */
      toolName: string;

      /** Validated immutable JSON input proposed by the model. */
      input: JsonValue;
    }>;

/** Provider-neutral token counts; missing provider counters remain absent. */
export type ModelUsage = Readonly<{
  /** Prompt tokens reported by the provider. */
  inputTokens?: number;
  /** Generated tokens reported by the provider. */
  outputTokens?: number;
  /** Total tokens reported or safely derived by the adapter. */
  totalTokens?: number;
}>;

/** One terminal result for a model attempt. */
export type ModelStepResult =
  | Readonly<{
      /** Reports a complete provider response. */
      type: 'completed';
      /** Concrete provider attempt that settled. */
      attemptId: ModelAttemptId;
      /** Normalized provider finish category. */
      finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
      /** Complete ordered response used to recover from presentation gaps. */
      content: readonly ModelOutputPart[];
      /** Bounded provider-neutral usage counters. */
      usage: ModelUsage;
    }>
  | Readonly<{
      /** Reports a provider or adapter failure as data. */
      type: 'failed';
      /** Concrete provider attempt that settled. */
      attemptId: ModelAttemptId;
      /** Redacted failure safe for transport and diagnostics. */
      error: PublicError;
      /** Advises the Cell-owned runtime whether a new attempt may help. */
      retry: 'admit-new-attempt' | 'do-not-retry';
    }>
  | Readonly<{
      /** Reports accepted active termination. */
      type: 'aborted';
      /** Concrete provider attempt that settled. */
      attemptId: ModelAttemptId;
      /** Bounded application reason supplied with the abort command. */
      reason: string;
    }>;

/** Immutable evidence returned when a retained model operation handle closes. */
export type ModelStepCloseEvidence = Readonly<{
  /** Confirms retained operation resources were released. */
  kind: 'closed';
  /** Records the terminal path without replacing the result. */
  disposition: 'completed' | 'failed' | 'aborted';
}>;

/** Immutable evidence returned when the adapter router closes. */
export type ModelRouterCloseEvidence = Readonly<{
  /** Confirms the router accepts no later starts. */
  kind: 'closed';
}>;

/** Process-local activation controls that never enter the durable request. */
export type ModelStepStartOptions = Readonly<{
  /** Standard host cancellation used by HTTP, workers, and application lifecycles. */
  signal?: AbortSignal;
}>;

/** Executes exactly one acknowledged provider step per activation. */
export interface ModelRouter extends AsyncDisposable {
  /** Settles after router closure begins and no new operation can start. */
  readonly closed: Promise<ModelRouterCloseEvidence>;

  /**
   * Resolves and starts one exact target or returns a pre-effect refusal.
   * @param request - Provider-neutral request created by Archer's public factory.
   * @returns Started hot operation or exact local activation failure.
   */
  startStep(
    request: ModelStepRequest,
    options?: ModelStepStartOptions,
  ): Promise<Result<LiveOperation<ModelStepEvent, ModelStepResult, ModelStepCloseEvidence>, ModelsError>>;

  /** Prevents new starts without aborting independent operations already returned. */
  close(): Promise<ModelRouterCloseEvidence>;
}

/** Message boundary shared by request creation and explicit transport hydration. */
const ModelMessageSchema = z
  .strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1) })
  .transform((value) => Object.freeze(value));

/** Separate instruction boundary prevents adapters from silently reordering conversation. */
const ModelInstructionSchema = z.string().min(1).max(256_000);

/** Model-visible tool boundary with deeply immutable JSON Schema content. */
const ModelToolDefinitionSchema = z
  .strictObject({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u),
    description: z.string().trim().min(1).max(1024),
    inputSchema: JsonObjectSchema,
  })
  .transform((value) => Object.freeze(value));

/** ResourceSet reference boundary stays structural because Resources owns its behavior. */
const ModelStepResourceSetRefSchema = z
  .strictObject({
    id: UuidV4Schema,
    object: z.literal('resource-set'),
    evidenceDigest: Sha256DigestSchema,
  })
  .transform((value) => Object.freeze(value));

/** Runtime provenance admits only the exact deeply immutable command returned by the factory. */
const ADMITTED_MODEL_STEP_REQUESTS = new WeakSet<object>();

/** Runtime schema used internally and by the explicit transport entry point. */
export const ModelStepRequestSchema: z.ZodType<ModelStepRequestDto> = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as ModelStepRequestId),
    object: z.literal('model-step-request'),
    createdAt: TimestampSchema,
    model: ModelSchema,
    instructions: z
      .array(ModelInstructionSchema)
      .max(128)
      .transform((value) => Object.freeze(value)),
    messages: z
      .array(ModelMessageSchema)
      .min(1)
      .transform((value) => Object.freeze(value)),
    tools: z.array(ModelToolDefinitionSchema).transform((value) => Object.freeze(value)),
    maxOutputTokens: z.int().positive(),
    resourceSet: ModelStepResourceSetRefSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    deadline: TimestampSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.maxOutputTokens > value.model.maxOutputTokens) {
      context.addIssue({ code: 'custom', path: ['maxOutputTokens'], message: 'Output limit exceeds model ceiling' });
    }
    /** Tracks tool names already admitted in this one request. */
    const names = new Set<string>();
    /** Rejects ambiguity before any provider receives the catalogue. */
    for (const tool of value.tools) {
      if (names.has(tool.name))
        context.addIssue({ code: 'custom', path: ['tools'], message: 'Tool names must be unique' });
      names.add(tool.name);
    }
  })
  .transform((value) => Object.freeze(value) as ModelStepRequestDto);

/**
 * Creates one exact model request while copying every mutable caller value.
 * @param input - Selected model, conversation, tools, and admitted step limits.
 * @param context - Optional exact request identity and time for deterministic assemblers.
 * @returns Immutable request ready for one router activation.
 */
export function createModelStepRequest(
  input: CreateModelStepRequestInput,
  context?: ModelStepRequestContext,
): ModelStepRequest {
  try {
    /** Request creation requires a Model admitted by its factory or exact hydration boundary. */
    assertAdmittedModel(input.model);
    /** Structural parsing copies every request field but deliberately cannot admit its nested model. */
    const parsed = ModelStepRequestSchema.parse({
      id: context?.id ?? createUuidV4(),
      object: 'model-step-request',
      createdAt: context?.createdAt ?? new Date().toISOString(),
      model: input.model,
      instructions: input.instructions ?? [],
      messages: input.messages,
      tools: input.tools ?? [],
      maxOutputTokens: input.maxOutputTokens,
      ...(input.resourceSet === undefined ? {} : { resourceSet: input.resourceSet }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    });
    /** The already-admitted immutable model replaces the transport-only parsed copy. */
    const admitted = Object.freeze({ ...parsed, model: input.model }) as ModelStepRequest;
    /** Runtime evidence is attached only after every command field and nested Model succeeds. */
    ADMITTED_MODEL_STEP_REQUESTS.add(admitted);
    return admitted;
  } catch (cause) {
    /** Separates output-ceiling refusal from all other invalid request fields. */
    const outputExceeded =
      typeof input.maxOutputTokens === 'number' &&
      typeof input.model?.maxOutputTokens === 'number' &&
      input.maxOutputTokens > input.model.maxOutputTokens;
    throw new ModelsError(
      outputExceeded ? 'models_output_limit_exceeded' : 'models_invalid_input',
      outputExceeded ? 'Model step output limit exceeds the selected model ceiling' : 'Invalid model step request',
      { cause },
    );
  }
}

/**
 * Refuses copied or decoded command fields before any adapter may start a provider effect.
 * @param request - Proposed exact factory-created model-step request.
 * @returns The same deeply immutable command after runtime provenance succeeds.
 * @internal
 */
export function assertAdmittedModelStepRequest(request: ModelStepRequest): ModelStepRequest {
  if (!ADMITTED_MODEL_STEP_REQUESTS.has(request)) {
    throw new ModelsError('models_invalid_input', 'Model step execution requires factory-created request provenance');
  }
  /** Nested behavior is checked again so request admission never substitutes for Model admission. */
  assertAdmittedModel(request.model);
  return request;
}

/** Runtime schema for normalized terminal usage in transport adapters. */
export const ModelUsageSchema: z.ZodType<ModelUsage> = z
  .strictObject({
    inputTokens: z.int().nonnegative().optional(),
    outputTokens: z.int().nonnegative().optional(),
    totalTokens: z.int().nonnegative().optional(),
  })
  .transform((value) =>
    Object.freeze({
      ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
      ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
      ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
    }),
  );

/** Runtime schema for transport-safe model failures. */
export const ModelFailureSchema = z.strictObject({
  type: z.literal('failed'),
  attemptId: UuidV4Schema.transform((value) => value as ModelAttemptId),
  error: PublicErrorSchema,
  retry: z.enum(['admit-new-attempt', 'do-not-retry']),
});

/**
 * Safely admits adapter-returned arbitrary tool input as immutable JSON.
 * @param input - Unknown SDK tool-call input after provider parsing.
 * @returns Deeply immutable JSON suitable for a terminal model result.
 */
export function admitToolInput(input: unknown): JsonValue {
  return JsonValueSchema.parse(input);
}
