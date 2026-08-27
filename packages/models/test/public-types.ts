/** @file Proves root model declarations remain independent of RxJS and AI SDK. */

import type { LiveOperation } from '@archer/core/stream';

import type {
  Model,
  ModelMessage,
  ModelRouter,
  ModelStepCloseEvidence,
  ModelStepEvent,
  ModelStepRequest,
  ModelStepResult,
} from '../src/index.js';
import { openAIModel } from '../src/index.js';
import type { ModelCodec, ModelStepRequestCodec } from '../src/transport/index.js';

/** A successful start reveals Archer's shared live-operation contract. */
type StartedOperation = Extract<
  Awaited<ReturnType<ModelRouter['startStep']>>,
  Readonly<{
    /** Selects the operation-bearing Result branch. */
    ok: true;
  }>
>['value'];

/** Compile-time assignment rejects accidental adapter-specific public types. */
const operation: LiveOperation<ModelStepEvent, ModelStepResult, ModelStepCloseEvidence> =
  null as never as StartedOperation;

void operation;

/** Instructions are a distinct request field and cannot be reordered inside conversation history. */
// @ts-expect-error System instructions are not conversation messages.
const systemMessage: ModelMessage = { role: 'system', content: 'Do not hoist me.' };

void systemMessage;

/** Transport parsing cannot mint the process-local provenance required by Model behavior. */
type DecodedModel = ReturnType<typeof ModelCodec.parse>;
/** This impossible assignment protects every behavior consumer from shape-only models. */
// @ts-expect-error A Model DTO has no factory or exact-hydration admission evidence.
const admittedModel: Model = null as never as DecodedModel;

void admittedModel;

/** Decoded commands remain transport data even when their nested model fields are valid. */
type DecodedModelStepRequest = ReturnType<typeof ModelStepRequestCodec.parse>;
/** Provider effects require the exact command object returned by the ordinary factory. */
// @ts-expect-error A request DTO has no factory-created command provenance.
const admittedRequest: ModelStepRequest = null as never as DecodedModelStepRequest;

void admittedRequest;

/** An unmeasured context-window claim cannot masquerade as enforced model behavior. */
// @ts-expect-error Model configuration exposes only the output ceiling its consumers enforce.
openAIModel({ model: 'gpt-5.4-mini', maxOutputTokens: 128_000, contextWindowTokens: 400_000 });
