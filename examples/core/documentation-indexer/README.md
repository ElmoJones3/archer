# Build a documentation search index

This command recursively reads Markdown files and writes a stable JSON index of
their titles and headings. A static documentation site can load the result for
navigation or simple client-side search.

The filesystem work is ordinary Node code. `@archer/core` turns that work into a
living job with current state, bounded progress, diagnostics, abort, terminal
result, and retained cleanup. A CLI presents the streams, while another caller
could bind the same run to React, SSE, or its own event bridge.

From the repository root:

```sh
pnpm example:core -- docs /tmp/archer-docs-index.json
```

Progress and terminal wide diagnostics appear on stderr. Stdout prints the
completed output path, and the JSON file contains the useful application result.
The command never reduces the active job to a lone promise.

Copy `createDocumentationIndexRun()` when finite filesystem or build work needs
live state and cancellation without importing RxJS into the application API.
The generic job assembly in `src/job.ts` shows how a pure `Program` can own
transition decisions while an effect shell performs the actual I/O.
