# Reactive job runner

This example builds a small process-local job runner from `@archer/core`. It has
no agent, model, sandbox, network, or storage dependency.

The running job is a living object. It exposes current state, replayable accepted
events, transient progress, diagnostics, an explicit abort command, one terminal
result, and retained close evidence. A pure `Program` decides state and effect
intent before the application shell executes a step.

The replayable stream demonstrates cursor and bounded-delivery mechanics inside
one process. It does not claim crash durability. A durable application would put
the same `Program` behind a Cell rather than treating memory retention as an
acknowledgement.

## Run it

From the repository root:

```sh
pnpm example:core
```

The command builds `@archer/core` and this example, then prints presentation
updates, accepted events, terminal wide diagnostic records, and the final
outcome. Those printed lines are the CLI view of public streams. They are not a
second logging path inside the job.

## Proofs

```sh
pnpm --filter @archer/example-core-reactive-job-runner... build
pnpm --filter @archer/example-core-reactive-job-runner test
pnpm --filter @archer/example-core-reactive-job-runner lint
```

The tests cover pure transition order and non-mutation, live success, step
failure, deterministic abort, terminal result, and idempotent cleanup. Every
source import uses an exported `@archer/core` entry point.
