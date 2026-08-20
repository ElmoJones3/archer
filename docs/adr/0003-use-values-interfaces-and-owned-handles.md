# Use values, interfaces, and owned handles

> The public Observable and teardown decisions in the final two paragraphs are
> superseded by ADR 0012. The value, interface, handle, command, and
> terminal-result decisions remain current.

Archer will represent durable and transferable facts as readonly objects and
replaceable behavior as interfaces. Implementations may use classes when they
own a database, lease, process, transport, subscription, or close sequence, but
applications receive them through factories and contract interfaces. This
keeps serialized facts free of process identity while allowing implementations
to own real resources.

Retained lifecycle objects implement `OwnedHandle<CloseResult>` with idempotent
`close()` and `Symbol.asyncDispose`. Close results preserve recovery evidence
where work can survive. Observable teardown stops live observation or work; it
does not substitute for a durable domain cancellation command.

Ongoing delivery uses RxJS Observables, commands use handle methods, and
expected terminal outcomes use tagged values. Archer will not expose a public
nest of provider callbacks.
