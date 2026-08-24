# Verify authority at the action boundary

Archer will treat a Principal as attribution and a `GrantRef<Action>` as a
lookup reference, not permission. Every protected service verifies the current
subject, action, scope, target, expiry, and revocation state immediately before
the action. Owning a retained handle never supplies authority by itself.

`Action` is a `ProtectedAction<Name, Scope>` descriptor. The package performing
the protected operation owns its discriminator, scope codec, and containment
rule. Authority registers those definitions explicitly at ledger construction;
it does not accept an untyped scope bag or use an import-time global registry.
TypeScript prevents obvious action and scope substitution, while runtime
verification re-admits both because structural references remain forgeable.

Authorization grants and revocations are immutable ledger facts. Bootstrap is
the only trusted root path. Ordinary issuance requires a current
`AuthorityGrantAction` grant, revocation requires a distinct current
`AuthorityRevokeAction` grant, and attenuation may only narrow a same-action
parent's subject, scope, validity, and delegation depth. Parent expiry and
revocation remain dynamically authoritative for every descendant. The broker,
not the caller, supplies the clock used for each finite decision.

This prevents forged TypeScript-shaped records, stale grants, and cross-target
replay from turning structural compatibility into permission.

An authority audit stream may expose replayable ledger facts, but a
subscription, cached snapshot, or prior receipt cannot implement the current
check. The protected service calls an `AuthorityBroker` with its trusted clock
at the action boundary.

The v1 process-local memory ledger is an explicitly ephemeral reference, not a
durability claim. It publishes one best-effort terminal diagnostic span for
each verification or ledger command without including protected scope values;
diagnostics cannot change authority behavior. Alternative implementations run
the public `@archer/core/authority/conformance` suite against each exact
guarantee-bearing configuration.
