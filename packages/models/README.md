# `@archer/models`

Configure a model once, prepare provider-neutral requests, and run each request
as a live operation. The package keeps credentials and provider SDK objects at
the adapter boundary while preserving the differences between OpenAI, Google
Gemini, xAI, Ollama, and compatible installations.

## One model step

```ts
import { openai } from '@ai-sdk/openai';
import { createModelStepRequest } from '@archer/models';
import { bindOpenAIAiSdkModel, createAiSdkModelRouter } from '@archer/models/ai-sdk';

const binding = bindOpenAIAiSdkModel({
  sdkModel: openai('gpt-5.6-luna'),
  maxOutputTokens: 1_200,
});
const router = createAiSdkModelRouter({ models: [binding] });

try {
  const request = createModelStepRequest({
    model: binding.target,
    instructions: ['Answer clearly and briefly.'],
    messages: [{ role: 'user', content: 'Summarize this release note.' }],
    maxOutputTokens: 600,
  });
  const started = await router.startStep(request);
  if (!started.ok) throw started.error;

  const subscription = started.value.events.subscribe();
  try {
    let missedLiveUpdates = false;
    for await (const delivery of subscription) {
      if (delivery.kind === 'gap') {
        missedLiveUpdates = true;
        console.warn(`Missed ${delivery.lostItems} live updates.`);
      } else if (delivery.value.type === 'text-delta') process.stdout.write(delivery.value.text);
    }
    const result = await started.value.result;
    if (result.type === 'completed' && missedLiveUpdates) {
      const complete = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      process.stdout.write(`\nComplete response: ${complete}`);
    }
    if (result.type === 'failed') console.error(result.error.code, result.retry);
    if (result.type === 'aborted') console.error('Model step aborted:', result.reason);
  } finally {
    await subscription.close();
    await started.value.close();
  }
} finally {
  await router.close();
}
```

The router performs exactly one provider attempt, disables AI SDK retries, and
never runs an agent loop. Its event stream is hot; the terminal result retains
the complete normalized response so presentation gaps do not become data loss.
The AI SDK model is borrowed from the caller, while the router and returned
operation handles must be closed.

If a live subscriber receives a `gap` delivery, it missed presentation updates
and should say so or redraw from application state. Never concatenate around a
gap as if the stream were complete. The terminal result remains the
authoritative full model response.

## Use an OpenAI-compatible installation

Archer ships the AI SDK runtime used by its first-party adapter. You choose and
configure the provider package because it owns the endpoint and credentials:

```sh
pnpm add @archer/models @ai-sdk/openai-compatible
```

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { bindCompatibleAiSdkModel, createAiSdkModelRouter } from '@archer/models/ai-sdk';

const baseURL = 'http://127.0.0.1:8000/v1';
const provider = createOpenAICompatible({
  name: 'local-vllm',
  baseURL,
});
const sdkModel = provider('openai/gpt-oss-20b');
const binding = bindCompatibleAiSdkModel({
  sdkModel,
  installation: 'Local vLLM',
  endpoint: baseURL,
  maxOutputTokens: 8_000,
  confirmInstallation: ({ target, provider: sdkProvider, modelId }) =>
    target.type === 'compatible' &&
    target.endpoint === baseURL &&
    sdkProvider === sdkModel.provider &&
    modelId === sdkModel.modelId,
});
const router = createAiSdkModelRouter({ models: [binding] });
```

The confirmation is deliberate: AI SDK model objects expose provider and model
identity but not the configured endpoint. The application that created the
client confirms that hidden fact before Archer lets the binding start work.
Pass `apiKey` or headers to `createOpenAICompatible` when that installation
requires credentials; they remain in the provider client, never the Archer
Model.

The same adapter subpath exports `bindGoogleAiSdkModel`, `bindXAiSdkModel`, and
`bindOllamaAiSdkModel`. Hosted helpers verify the provider/model identity
exposed by the borrowed AI SDK client. Ollama uses the same explicit
installation confirmation as the compatible helper because its endpoint is
also hidden by the SDK model object.

## Failure and cancellation

Invalid configuration throws `ModelsError` before an effect exists.
`router.startStep` returns `Result`, so an unbound or forged request is an
ordinary pre-effect refusal. Once a step starts, provider failures, deadlines,
and cancellation settle through `operation.result`; provider failures retain a
stable public error and retry advice instead of escaping through the event
subscriber.

A deadline or host `AbortSignal` is forwarded to the AI SDK call. That asks the
client and provider to stop work, but Archer cannot promise a remote provider
will stop compute or billing after it has accepted the request. Always close
the subscription and operation; close the router when its application owner is
done.

## Package boundaries

- `@archer/models` owns provider-neutral Model behavior and admitted one-step
  requests.
- `@archer/models/ai-sdk` binds caller-configured AI SDK models and creates the
  first-party router.
- `@archer/models/transport` owns explicit `encodeModel` and
  `encodeModelStepRequest` mappings plus detached JSON-safe DTO codecs.
- `@archer/models/hydration` restores Model behavior only after exact parent
  checks. Decoding a request never grants permission to execute it.

Models are credential-free configuration. API keys stay in the provider client
or its environment. Provider-specific controls remain on their matching target
instead of being flattened into a misleading common shape.

## Type-checking maintenance note

This package keeps `skipLibCheck` enabled because AI SDK 7 currently publishes
declarations that fail under Archer's `exactOptionalPropertyTypes` setting. The
exception applies only to dependency declarations: Archer's source, tests, and
emitted public types are still checked with the repository's strict compiler
options. Re-test without `skipLibCheck` when upgrading the AI SDK, and remove the
exception once its declarations pass unchanged.
