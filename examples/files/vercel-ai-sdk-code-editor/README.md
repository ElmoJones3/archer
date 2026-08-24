# Let an AI agent edit a private project copy

This application imports a host project, gives a Vercel AI SDK `ToolLoopAgent`
ordinary project-file tools, and prints the resulting private diff for review.
The model can list, read, add, modify, rename, and delete files. It never receives
host paths, Workspace generations, grants, Merkle references, or sandbox terms.

Set an OpenAI API key and ask the agent to change a small project:

```sh
export OPENAI_API_KEY="your_api_key_here"
pnpm example:files:code-editor -- ./my-project "Add a sum function and document its use"
```

The default model is `gpt-5.6-luna`; set `OPENAI_MODEL` to another model ID when
needed. The AI SDK owns model calls, schema validation, tool dispatch, and the
multi-step loop. The runnable never calls a tool's `execute` callback itself.

Before the first model call, stderr lists every admitted project path. Import
skips `.git`, dependencies, common build/cache directories, `.env` files,
private-key formats, and common credential files by default. `readProject()`
also accepts caller `include` and additive `ignore` globs. Those controls reduce
accidental disclosure; they are not a proof that remaining source is public.
The selected model may read every listed file.

Archer publishes the input as an immutable tree and applies authorized edits to
a living private Workspace. The command prints complete before-and-after review
content plus semantic blob evidence, but does not write either back to the host
project. Promotion is a separate decision, which is why trying the agent cannot
damage the source directory even though model read access remains a disclosure.

Copy `createWorkspaceTools()` into an existing AI SDK application. Its returned
tool map passes unchanged to `ToolLoopAgent`, `generateText`, or `streamText`, and
the storage or later sandbox choice remains outside the model-facing schemas.
