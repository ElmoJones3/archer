# Use values, interfaces, and owned handles

> ADR 0012 supersedes the original decision to expose RxJS Observable types.
> This record reflects the current public boundary below.

Archer will represent durable and transferable facts as readonly objects and
replaceable behavior as interfaces. Implementations may use classes when they
own a database, lease, process, transport, subscription, or close sequence, but
applications receive them through factories and contract interfaces. This
keeps serialized facts free of process identity while allowing implementations
to own real resources.

Retained lifecycle objects implement `OwnedHandle<CloseResult>` with idempotent
`close()`, one shared `closed` settlement, and `Symbol.asyncDispose`. Repeated
closure returns the same immutable evidence rather than a caller-relative
`alreadyClosed` variant. Close outcomes preserve recovery evidence where work
can survive. Subscription teardown stops observation. Aborting a finite
LiveOperation stops that attempt. Closing a LiveOperation waits and does not
alias abort. Neither substitutes for a durable domain cancellation command.

Internal ongoing delivery uses shared hot RxJS Observables. Public code uses
`LiveState`, `ReplayableEventStream`, `TransientEventStream`, and
`LiveOperation`; commands use handle methods, and expected terminal outcomes
use tagged values. Archer will not expose a public nest of provider callbacks.
