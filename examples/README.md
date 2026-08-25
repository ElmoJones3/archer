# Archer examples

These are complete, runnable TypeScript applications. Pick one by the job you
want to do. Each example has its own README explaining the result, the Archer
packages involved, and the code worth copying into another project.

## Set up the repository

Archer uses Node 26 and pnpm 11. If you use mise, it will select the versions
pinned by this repository.

```sh
mise install
pnpm install
```

Run the commands below from the repository root.

## No account or API key required

### Build a documentation search index

Turn a Markdown directory into stable JSON while receiving live progress,
diagnostics, and completion state.

```sh
pnpm example:core -- docs /tmp/archer-docs-index.json
```

[Read the documentation indexer example](core/documentation-indexer)

### Fingerprint a directory

Calculate one reproducible identity for a directory based on file content and
executable permissions, not timestamps or traversal order.

```sh
pnpm example:files:fingerprint -- docs
```

[Read the directory fingerprint example](files/directory-fingerprint)

### Keep named local snapshots

Save an immutable directory snapshot in a local cache, inspect it in another
process, and read a file from it after the source changes.

```sh
pnpm example:files:cache -- save /tmp/archer-snapshots docs-before-edit docs
pnpm example:files:cache -- list /tmp/archer-snapshots docs-before-edit
pnpm example:files:cache -- read /tmp/archer-snapshots docs-before-edit architecture.md
```

[Read the local snapshot cache example](files/local-snapshot-cache)

### Observe an HTTP service

Run a small HTTP service that sends one context-rich record per request to Pino
and OpenTelemetry. The example uses console exporters, so it needs no collector.

```sh
pnpm example:observability
```

The service prints a `curl` command after it starts.

[Read the observed word-count service example](observability/word-count-service)

## AWS credentials and an S3 bucket required

### Send customer webhooks across process restarts

Send signed application events to customer endpoints, watch their status live,
and continue unfinished retries from S3 after the service restarts.

```sh
export ARCHER_WEBHOOK_SIGNING_SECRET="local-demo-secret"
export ARCHER_WEBHOOK_BUCKET="my-existing-bucket"
export AWS_REGION="us-west-2"
pnpm example:cells:webhook -- service
```

[Read the durable webhook example](cells/durable-webhook)

## OpenAI API key required

These examples make real model calls through the Vercel AI SDK. Set
`OPENAI_API_KEY` before running them. They use `gpt-5.6-luna` by default and
accept another model ID through `OPENAI_MODEL`.

### Let an agent edit a private project copy

Give an AI SDK agent normal file-editing tools without letting it mutate the
source directory. Archer returns the proposed changes for review.

```sh
export OPENAI_API_KEY="your_api_key_here"
pnpm example:files:code-editor -- ./my-project "Add a sum function and document its use"
```

The command lists every file admitted for model access before the first model
call.

[Read the AI SDK code editor example](files/vercel-ai-sdk-code-editor)

### Give an agent a private notebook

Give an AI SDK agent editable working notes and preserve only the checkpoint it
explicitly asks the host to retain.

```sh
export OPENAI_API_KEY="your_api_key_here"
pnpm example:files:notebook -- /tmp/archer-notes "Draft a release checklist and checkpoint your notes"
```

[Read the AI SDK notebook example](files/vercel-ai-sdk-notebook-agent)

## How the directories are organized

Examples are grouped by the highest Archer layer they use. A `core` example
depends only on `@archer/core`. A future `agent` example may combine core, files,
models, tools, and execution. This makes it clear how much of Archer an
application needs without changing the application it demonstrates.

Working on Archer itself? Read the
[example delivery policy](../docs/contributing/examples.md) before adding or
changing a public workflow.
