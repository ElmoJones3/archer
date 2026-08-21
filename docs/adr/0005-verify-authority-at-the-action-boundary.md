# Verify authority at the action boundary

Archer will treat a Principal as attribution and a `GrantRef<Action>` as a
lookup reference, not permission. Every protected service verifies the current
subject, action, scope, target, expiry, and revocation state immediately before
the action. Owning a retained handle never supplies authority by itself.

This prevents forged TypeScript-shaped records, stale grants, and cross-target
replay from turning structural compatibility into permission.

An authority audit stream may expose replayable ledger facts, but a
subscription, cached snapshot, or prior receipt cannot implement the current
check. The protected service calls an `AuthorityBroker` with its trusted clock
at the action boundary.
