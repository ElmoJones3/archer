# Use one reactive graph and explicit temporal classes

Archer will implement one shared RxJS graph for each live source and project it
through four public standard-JavaScript temporal contracts:

- `LiveState` for a retained owner whose meaningful acknowledged state can
  change without a caller method;
- `ReplayableEventStream` for ordered durable observations with branded
  cursors;
- `TransientEventStream` for presentation and diagnostics with explicit gaps;
- `LiveOperation` for one bounded attempt with progress, abort, one result, and
  close evidence.

Immutable evidence, pure decisions, point-in-time authority checks, and
one-shot commands remain readonly values or Promises. Reactive does not mean
making every fact a stream.

TaskRun, Thread, Cell, Workspace, Scratchpad, and sandbox handles expose hot
current state. Model steps, tool invocations, sandbox acquisition and
execution, materialization, ingestion, and meaningful build attempts use
`LiveOperation`. Diagnostics remain transient and non-authoritative. A Turn is
durable Thread state rather than another live owner. A MaterializedView is not
live state because arbitrary physical writes are not acknowledged logical file
facts.

Managed paths, direct handles, framework bindings, logs, SSE, WebSocket, and
stdio derive from those same sources. A remote attachment begins with an atomic
snapshot, state version, optional durable cursor, and all transient source
epochs. No adapter may add polling, reconstruct current domain state by folding
events, merge replayable and gap-tolerant signals under one contract, or
maintain another agent loop or reducer.

That atomic attachment is a public companion capability on each hot handle,
not privileged transport access. It attaches queues before capturing and
releasing the seed and projects the existing graph without owning a reducer.

## Evidence

The spike reanalysis found the temporal concepts in both comparison systems
but distributed across product-specific machinery. Grok Build commit
`19d42e35c07a9c9244f03f6df0c4c353f970d4f9` has typed sampling updates, a
one-shot result, cancellation, coalescing, and replay barriers, but shared
unbounded channels, hidden retries, and ordering hazards make its event path
unsuitable as Archer's public contract. Codex commit
`2151d3a5b78ca93128496b26333bc30187385a5f` has bounded submission, unbounded
event broadcast, status watches, app-server Thread and Turn watches, JSON-RPC
notifications, rollout history, and a TypeScript JSONL fold. The same living
work is therefore reconstructed at several boundaries.

Rust, Tokio, and existing product protocols explain those implementations.
Archer is a new TypeScript framework with RxJS already selected. Encoding the
temporal classes once gives lower-level users the same reactive object quality
as the managed path without exporting RxJS or asking every transport and UI to
reinvent it.

## Consequences

Every public temporal source needs item and byte bounds, subscriber isolation,
deterministic close semantics, and conformance for its exact delivery class.
Remote transports need atomic attachment and versioned codecs. This is more
work than returning a Promise or exposing callbacks, but it prevents the
reactivity cliffs that would otherwise split Archer into managed, direct, and
remote runtimes.
