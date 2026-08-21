# Keep RxJS behind the public stream boundary

Supersedes the public RxJS portion of ADR 0003.

RxJS remains Archer's internal implementation for activation lanes, finite
composition, state projection, cancellation, timers, concurrency, and fan-out.
Each first-party live source uses one shared hot graph. Archer's contracts will
expose standard-JavaScript `LiveState`, `ReplayableEventStream`,
`TransientEventStream`, and `LiveOperation` boundaries instead of RxJS types.

A LiveState exposes one immutable current snapshot and subsequent state
subscriptions. A ReplayableEventStream exposes ordered durable observations,
source-branded cursors, and resume-required closure. A TransientEventStream
exposes presentation or diagnostics with exact gaps and source epochs but no
replay claim. Each subscription owns only bounded delivery and detachment. A
LiveOperation owns one finite live attempt, transient progress, one result,
active abort, and close evidence. Closing it waits and does not alias abort.
Its source seals subscription queues before result settlement. Existing
subscribers may drain already accepted progress in order, but no new progress
is accepted after the result and settlement never waits for a slow subscriber.
The abort command carries an idempotency key and returns attempt evidence.

A TaskRun is a hot LiveState for durable managed work and exposes separate
durable, presentation, and diagnostic streams, authorized commands, and an
outcome-or-detachment settlement. Durable cancellation remains a command on
TaskRun or ThreadHandle and returns a receipt rather than claiming terminal
outcome. Cursor resume, gaps, overflow, subscriber and sink failure, and
teardown are explicit. Public declaration checks reject accidental RxJS
imports.

Each hot handle exposes a public `attachLive()` bridge for transport and worker
adapters. It attaches requested queues to the existing graph before returning
one atomic snapshot version, optional durable cursor, and all transient source
epochs. SSE, WebSocket, and stdio project that attachment without polling, a
callback-only fallback, privileged runtime access, or a client-side domain
reducer.

This preserves the temporal behavior proved in the spikes without requiring an
adopter or adapter author to learn Archer's reactive implementation.
