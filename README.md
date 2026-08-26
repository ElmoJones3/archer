# Archer

An agent harness, for polite anarchists. Tights optional.

Archer is a set of composable TypeScript primitives for running asynchronous,
durable work without hiding what is live, what is persisted, or what isolation
a backend actually provides. Use the high-level path when its defaults fit, or
import the same lower contracts to build your own harness.

The public work completed so far includes:

- a reactive core with hot state, bounded event streams, finite live
  operations, authority, and diagnostics;
- immutable files, private Workspaces and Scratchpads, and live
  materialization;
- durable Cells backed by embedded SQLite or direct S3 compare-and-swap;
- first-party Pino and OpenTelemetry observability adapters; and
- behavior-bearing Models, Prompts, Agent Skills, BudgetPolicies,
  AgentProfiles, and prepared ResourceSets.

The v1 design and dependency-ordered construction roadmap live in
[the architecture document](docs/architecture.md).

Real, layer-scoped applications live in [examples](examples/README.md). Each one
starts with a recognizable job and uses Archer through public package entry
points. They run in the repository's ordinary build and test pipeline.

Archer is still under construction: workspace packages remain private until
the initial public release. The examples are runnable from this source checkout
and are the contracts those eventual packages must preserve.

## License

Archer is licensed under the [Apache License, Version 2.0](LICENSE). Future
public package artifacts carry the same license text and SPDX declaration.
