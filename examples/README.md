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

Every new or materially changed public layer must add or update at least one
example that proves the intended use through public package entry points alone.
The example is part of delivering the layer.

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
