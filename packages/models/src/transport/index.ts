/** @file Exposes shape codecs for model DTO boundaries, not ordinary creation. */

import { fromZod } from '@archer/core';

import { ModelStepRequestSchema } from '../contracts.js';
import { ModelSchema } from '../targets.js';

/** DTO types live beside their codecs rather than in the ordinary behavior barrel. */
export type { ModelStepRequestDto } from '../contracts.js';
export type {
  CompatibleModelDto,
  GoogleModelDto,
  ModelDto,
  OllamaModelDto,
  OpenAIModelDto,
  XAIModelDto,
} from '../targets.js';

/** Validates and copies persisted or transported model Resource DTOs. */
export const ModelCodec = fromZod(ModelSchema);

/** Validates and copies complete persisted model-step request DTOs. */
export const ModelStepRequestCodec = fromZod(ModelStepRequestSchema);
