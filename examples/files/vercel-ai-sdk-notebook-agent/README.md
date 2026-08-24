# Give an AI agent a checkpointed private notebook

This application gives a Vercel AI SDK `ToolLoopAgent` private working notes for
a real task. The model can list, read, add, modify, rename, and delete notes. A
separate `checkpointNotes` tool acknowledges the exact note generation the host
may recover later.

Set an OpenAI API key, choose a local object store, and give the agent a task:

```sh
export OPENAI_API_KEY="your_api_key_here"
pnpm example:files:notebook -- /tmp/archer-notes "Draft a release checklist and checkpoint your notes"
```

The default model is `gpt-5.6-luna`; set `OPENAI_MODEL` to override it. The AI
SDK owns every model call, schema check, tool dispatch, and continuation step.
The runnable never invokes a tool's `execute` callback directly.

The final output includes the assistant response, private note paths, cleanup
disposition, and the exact immutable checkpoint tree when the model called
`checkpointNotes`. The filesystem store retains that tree's bytes after process
exit. The host still owns the checkpoint reference; a directory full of objects
does not invent recovery policy by itself. If the model omits checkpointing, the
command reports `uncheckpointed-released` and exits with status 2.

Copy `createCheckpointedScratchpadTools()` into an existing AI SDK application.
Editing and retention remain separate permissions, while the model sees only a
notebook it already knows how to use.
