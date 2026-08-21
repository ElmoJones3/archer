# Make hot retained TaskRuns canonical and dependency ownership explicit

Every managed task start returns a hot retained TaskRun. The top-level
`runTask` Promise covers construction and durable task creation only. TaskRun
exposes an immutable current snapshot, state subscriptions, replayable durable
facts, transient presentation and diagnostics, authorized approval and
cancellation commands, an outcome-or-detachment `settled` Promise, and
recovery-aware close evidence. Its attachment kind states whether closing it
can leave durable work running. Subscriber count never starts, repeats, pauses,
or cancels the work.

When policy requires a human, the TaskRun enters `awaiting-approval` and keeps
the durable request, last acknowledgement, private Workspace snapshot, and
recovery locator in its state. Awaiting approval is live task state, not a
terminal outcome. An application can decide through the authorized command,
detach, or later reattach to the same durable task.

Cancellation returns a durable command receipt rather than a terminal task
outcome. The terminal outcome appears only after the Thread acknowledges it.
TaskRun projects the same Cell and Thread graph exposed by direct handles; it
does not own a managed-only reducer or fold transient events into durable state.
Approval and cancellation commands bind the exact request or acknowledgement,
an expected revision, and an idempotency key. A refused precondition preserves
state, and replaying the same key returns the same receipt.

Injected services are borrowed or owned explicitly. Archer closes only
components marked owned, in reverse dependency order. Presets own what they
construct. Closing observation detaches, closing a retained attachment releases
that attachment, aborting a LiveOperation stops one live attempt, and cancelling
a task records a durable command.

This makes reactivity the convenient path and resolves approval and cleanup
without creating a second batch execution path.
