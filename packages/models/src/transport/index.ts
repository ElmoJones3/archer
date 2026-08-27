/** @file Exposes shape codecs for model DTO boundaries, not ordinary creation. */

import { fromZod } from '@archer/core';

import {
  ModelStepRequestStateSchema,
  modelStepRequestState,
  type ModelStepRequest,
  type ModelStepRequestState,
} from '../contracts.js';
import {
  ModelStateSchema,
  modelState,
  type CompatibleModelState,
  type GoogleModelState,
  type Model,
  type ModelState,
  type OllamaModelState,
  type OpenAIModelState,
  type XAIModelState,
} from '../targets.js';

/** Wire representation of one OpenAI model revision. */
export type OpenAIModelDto = OpenAIModelState;

/** Wire representation of one Google model revision. */
export type GoogleModelDto = GoogleModelState;

/** Wire representation of one xAI model revision. */
export type XAIModelDto = XAIModelState;

/** Wire representation of one Ollama model revision. */
export type OllamaModelDto = OllamaModelState;

/** Wire representation of one compatible-installation model revision. */
export type CompatibleModelDto = CompatibleModelState;

/** Discriminated wire representation of every supported model revision. */
export type ModelDto = ModelState;

/** Wire representation of one provider-neutral model-step request. */
export type ModelStepRequestDto = ModelStepRequestState;

/** Validates and copies persisted or transported model Resource DTOs. */
export const ModelCodec = fromZod(ModelStateSchema);

/** Validates and copies complete persisted model-step request DTOs. */
export const ModelStepRequestCodec = fromZod(ModelStepRequestStateSchema);

/**
 * Projects one admitted Model into detached transport data.
 * @param model - Exact factory-created or hydrated Model.
 * @returns Provider-discriminated DTO without process-local provenance.
 */
export function encodeModel(model: Model): ModelDto {
  return ModelCodec.parse(modelState(model));
}

/**
 * Projects one admitted model-step command into detached transport data.
 * @param request - Exact factory-created request.
 * @returns DTO that cannot be executed without explicit hydration or reconstruction.
 */
export function encodeModelStepRequest(request: ModelStepRequest): ModelStepRequestDto {
  return ModelStepRequestCodec.parse(modelStepRequestState(request));
}
