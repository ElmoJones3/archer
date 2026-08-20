# Build the public API inside out

Archer will ship narrow TypeScript contract packages, separate product adapter
packages, and one managed composition package. The short `runTask` path will
compose the same authority, resource, Cell, model, sandbox, and Workspace
contracts available to advanced users. It may own safe defaults and lifecycle,
but it may not bypass acknowledgement, invent authority, weaken isolation, hide
retries, or promote work.

Contract packages point inward. SDKs, SQLite, object storage, Docker, QEMU, Git,
and transports remain in adapters so consumers can replace one integration
without installing the others.
