# Archer examples

Examples are executable consumers of Archer's public packages. Their directory
names state how much Archer machinery they use:

```text
examples/
  core/
  observability/
  files/
  cell/
  agent/
```

An example under `core/` may use `@archer/core` but may not reach into a later
layer. An example under `agent/` may compose the layers beneath it. This ordering
keeps assumptions visible when two examples solve similar problems with
different amounts of Archer.

## Delivery policy

Every new or materially changed public workflow must add or update at least one
example that proves the intended use through public package entry points alone.
The example is part of delivering the workflow.

A contained contract or protocol slice may ship without a standalone example
when isolated execution would be theatre rather than a meaningful workflow. It
must instead publish executable conformance, and the first real consuming layer
must exercise the contract in that layer's example. Authority follows this
path: its contained proof is `@archer/core/authority/conformance`, and the first
protected mutation workflow will carry its runnable demonstration.

Each example must:

- install, build, and run as its own private workspace package;
- explain which Archer packages and guarantees it relies on;
- use no `packages/*/src` import, path alias, or unpublished entry point;
- run deterministically without credentials or network access when its layer
  permits;
- comment architectural decisions and lifecycle obligations beside the code;
- exercise success, a representative failure, and cleanup;
- participate in root formatting, lint, typecheck, build, and test commands; and
- provide one named command that a reader can copy from its README.

An example proves public usability. It does not replace package unit tests,
protocol conformance, or a real dependency test when that dependency owns the
claimed behavior.

## Available examples

- [`core/reactive-job-runner`](core/reactive-job-runner/README.md) composes a
  pure `Program`, living state, bounded event delivery, finite work, abort, and
  wide diagnostics without an agent, model, sandbox, or network dependency.
- [`observability/diagnostic-projections`](observability/diagnostic-projections/README.md)
  sends one accumulated terminal record to Pino and a real OpenTelemetry SDK
  while preserving independent delivery and explicit lifecycle ownership.
- [`files/immutable-tree`](files/immutable-tree/README.md) proves canonical
  identity convergence, hierarchical structural sharing, path rejection, and
  retained in-memory cleanup without a host filesystem.
- [`files/local-store`](files/local-store/README.md) persists the same immutable
  contracts through `@archer/files/fs`, closes, reopens, verifies a stream,
  handles missing content, and cleans only its example-owned temporary root.
