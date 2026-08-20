# Use retained task runs and explicit dependency ownership

Interactive managed work will use a retained TaskRun with bounded observations,
approval requests, authorized approval decisions, a result Promise, durable
cancellation, and recovery-aware close evidence. The one-call `runTask` helper
uses the same TaskRun. When its configured policy requires a human, it returns a
durable paused result instead of waiting indefinitely on a process-local
callback.

Injected services are borrowed or owned explicitly. Archer closes only
components marked owned, in reverse dependency order. Presets own what they
construct. Closing observation detaches, closing a retained attachment releases
that attachment, aborting a LiveOperation stops one live attempt, and cancelling
a task records a durable command.

This resolves managed approval and cleanup without making the convenient API a
second execution path.
