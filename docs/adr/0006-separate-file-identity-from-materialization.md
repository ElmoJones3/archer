# Separate file identity from materialization

Archer will treat files as a first-party domain independent of sandboxing and
storage products. Immutable trees name content, Workspaces and Scratchpads own
private mutable use, and Materializers create physical execution views for a
sandbox. This lets QEMU disks, Docker volumes, and local directories realize
the same logical content without making any one execution backend authoritative.

## Considered options

A universal virtual filesystem handle was rejected as the public model. It
would hide different ownership and lifecycle rules and imply compatibility
across path normalization, case sensitivity, links, modes, rename, locking, and
durability that adapters may not provide.

## Consequences

Programs inside a sandbox still receive ordinary operating-system paths.
Archer's file contracts define logical identity and lineage, while each
Materializer chooses the physical mechanism and verifies ingestion.

Workspace and Scratchpad handles expose hot acknowledged summary state, not raw
filesystem watcher events. Materialization and ingestion are finite
`LiveOperation`s because their progress, abort, cleanup, and terminal evidence
matter. A `MaterializedView` exposes a fixed generation but is not `LiveState`:
unquiesced physical bytes are not acknowledged logical facts.

An immutable `WorkspaceSnapshot` is a transferable lineage product. A
`WorkspaceHandleSnapshot` is the hot current projection of a retained
attachment. The separate names prevent process lifecycle such as `ingesting`
or `closing` from being mistaken for durable Workspace evidence.
