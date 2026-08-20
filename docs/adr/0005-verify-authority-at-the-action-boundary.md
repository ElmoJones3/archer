# Verify authority at the action boundary

Archer will treat a Principal as attribution and a `GrantRef<Action>` as a
lookup reference, not permission. Every protected service verifies the current
subject, action, scope, target, expiry, and revocation state immediately before
the action. Owning a retained handle never supplies authority by itself.

This prevents forged TypeScript-shaped records, stale grants, and cross-target
replay from turning structural compatibility into permission.
