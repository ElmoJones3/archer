# Retain pre-009 runtimes as local references

Archer will keep `packages/cell-runtime` and `packages/sandbox-runtime` on disk
as construction references but will exclude them from the new Git history.
Their public contracts and package boundaries predate exercise 009 and conflict
with the accepted architecture. Committing them as production packages would
freeze broad sandbox equivalence, incomplete lifecycle evidence, mixed contract
and adapter dependencies, and missing authority and file boundaries into the
new project.

## Reference value

The Cell runtime contains working SQLite journal and outbox transactions,
deterministic effect identity, durable cancellation, snapshot publication,
conditional manifest ownership, fencing, redrive, and RxJS activation logic.
Those mechanisms are source material for the Cell contract and its embedded and
object-store-backed adapters.

The sandbox runtime contains working process cancellation, Docker hardening and
reacquisition, exact QEMU with HVF runner checks, the `sandboxd` protocol, and a
content-addressed artifact registry with immutable materialization. Those
mechanisms are source material for separate sandbox adapters and the new file
domain. The existing root sandbox contract, environment factory, and combined
barrel export are not production foundations.

## Consequences

The two directories remain available locally and are named explicitly in
`.gitignore`. Production construction may extract mechanisms and tests from
them, but neither directory will be added wholesale or treated as a public
compatibility commitment.
