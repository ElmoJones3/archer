# Archer contributor instructions

## Build for the application developer

Archer exists to take on distributed-systems, lifecycle, and provider
complexity so an application developer can perform useful work through a small,
honest API. Start every public layer review with the job a developer can do,
then verify that the package vocabulary, exports, and example make that job
obvious. Schema coverage, hashes, brands, comments, and test volume do not make
an API useful by themselves.

Do not require the ordinary path to speak infrastructure vocabulary that its
job does not need. Keep the lower contract available for developers who are
building infrastructure, but do not make them assemble control-plane ceremony
to prove the abstraction is rigorous.

## Domain concepts earn their names

Read and apply the repository's `domain-modeling` skill before creating,
changing, or reviewing an Archer domain concept. A named concept must own the
behavior and legal transitions its name promises. Passing a Zod schema,
retaining a digest, or wrapping a DTO in a class does not count as behavior.

For every named public concept, write down before implementation:

- the useful operation it performs for an application;
- the state and invariants it owns;
- the legal transitions or decisions it makes;
- the effects it performs, if any, and who owns those effects; and
- the transport DTO and hydration capability needed at boundaries.

Prefer immutable behavior values and pure functions when no retained lifecycle
exists. Use a class when closed construction, behavior ownership, or retained
lifecycle makes the contract clearer. Syntax is secondary; an anemic class and
an anemic interface are the same modeling failure.

## Keep boundaries separate

Ordinary construction creates behavior. Transport parsing creates detached
data. Hydration restores behavior only after exact external facts are checked.
Persistence belongs to an explicit owner, not every domain concept. Never let a
public schema, cast, spread, or prototype substitution mint earned authority,
review evidence, executable requests, or behavior bindings.

Pure modifiers take their preconditions and trusted identity or time facts
explicitly. They do not read clocks, generate revision identities, persist,
publish, or claim replay idempotency. Idempotency keys and durable receipts
belong to the boundary that actually settles and remembers commands.

## Review public layers from two directions

Before declaring a new public layer complete, ask for two independent reviews.
One compares code, tests, exports, and examples with the canonical architecture
and implementation plan. The other approaches only the public documentation,
exports, and example as a developer seeing Archer for the first time, then
states what job they believe the layer performs, whether they would use it, and
what they would choose instead if not. Give reviewers the actual acceptance
criteria; do not narrow their prompts to mechanics that cannot expose a domain
or adoption failure.

## Examples are product work

Before creating, changing, or reviewing anything under `examples/`, read
`docs/contributing/examples.md` and apply the repository's
`principle-example-adoption` skill.

An example exists to help an application developer recognize a job, run it,
and copy the useful integration into their own project. Package tests and
conformance suites prove Archer's internal contracts. Do not turn an example
into another correctness fixture or lead its story with Archer terminology.

If a real application needs a large block of repetitive Archer setup, treat
that friction as a public API finding. Add the smallest honest factory or
bound application object that removes the repetition, while keeping the raw
contract available for advanced use.
