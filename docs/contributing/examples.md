# Example delivery policy

Examples let developers judge Archer through applications they recognize. They
are not substitutes for package tests, conformance suites, or internal design
documents. This policy keeps that distinction enforceable as the repository
grows.

## Directory structure

An example's directory states how much Archer machinery it uses:

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

## Delivery requirements

Every new or materially changed public workflow must add or update at least one
example that uses the workflow through public package entry points alone. The
example is part of delivering the workflow.

A contained contract or protocol slice may ship without a standalone example
when isolated execution would be theatre rather than a meaningful workflow. It
must instead publish executable conformance, and the first real consuming layer
must exercise the contract in that layer's example. Authority follows this
path: its contained proof is `@archer/core/authority/conformance`, and the first
protected mutation workflow will carry its runnable demonstration.

An example starts with the application, not the package. Its README names the
job, the inputs it needs, the output or side effect it produces, and the part a
developer can copy into an existing application. Directory and package names
describe that job rather than an Archer type or guarantee whenever a clear job
name exists.

The runnable entry point must cross the real boundary named by the example. An
AI SDK example lets the AI SDK run the model and dispatch tools. An HTTP example
listens for HTTP requests. A database example executes against the database. An
example may not call a framework-owned callback directly, replace a model with a
hard-coded sequence, or bypass the dependency whose integration it claims.

The executable entry point is a thin configuration shell over an exported
application function. Tests call that same function and prove every adapter,
framework, or service boundary claimed by the README. Removing a named
integration from the runnable composition must make an application test fail;
package-level adapter tests elsewhere do not substitute for that proof.

Credentials, network access, long-lived processes, and caller-supplied files are
valid application requirements. The README states them plainly and gives one
copyable command. CI convenience must never remove the behavior that makes the
example real.

An external model, service, or database is also a disclosure boundary. The
example states which caller data crosses it, applies safe default admission when
the input is broad, and presents the admitted set before an irreversible or
remote action when practical. Write isolation must never be described as data
privacy from the selected provider.

Each example must:

- install, build, and run as its own private workspace package;
- use only public package entry points, with no `packages/*/src` import, path
  alias, or unpublished entry point;
- explain which Archer packages and guarantees it relies on without making
  Archer vocabulary the application's purpose;
- perform useful work and emit the application's result, not a list of booleans
  or evidence fields proving library contracts;
- return useful data before ephemeral dependencies close, or retain an explicit
  reachable owner for every reference returned to the caller;
- comment application policy, integration boundaries, and lifecycle obligations
  beside the code;
- keep secrets in documented environment variables or external secret stores;
- participate in root formatting, lint, typecheck, build, and test commands; and
- keep its runnable entry point separate from its automated tests.

Tests make an example safe to maintain, but they do not define its story. They
exercise the same application function as the runnable and use a real dependency
or that dependency's maintained test implementation when its semantics matter.
Tests may inject clocks, identities, models, destinations, or temporary storage;
the runnable may not inherit those substitutions. A package test must never run
the example's credentialed or long-lived entry point as a hidden final assertion.

Success, expected refusal, and cleanup remain package and conformance obligations.
An example includes the cases that belong naturally to its job and does not
manufacture failures merely to satisfy a checklist. Example output is for the
person running the application. Machine-oriented proof stays in tests and
conformance suites.

Before review, ask one blunt question: would a developer copy this program to do
something, or only read it to verify Archer works? Only the first belongs here.
