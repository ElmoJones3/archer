# `@archer/files`

`@archer/files` owns Archer's logical file identity, private mutable use, and
logical-to-physical mapping contracts. It provides canonical immutable trees,
store ports, hot Workspace and Scratchpad handles, private ChangeSets, and live
Materializer operations without making a sandbox or Git repository part of
file identity.

The immutable root contracts have no VFS, Git, sandbox, host-path, or Workspace
assumption. Flat logical paths are construction sugar compiled into canonical
Merkle directory nodes. A file change replaces only its blob and ancestor
nodes; unrelated directory references remain shareable. Later retained owners
compose those values rather than redefining them.

## Entry points

- `@archer/files` contains immutable values, pure codecs, store contracts, the
  in-memory implementation, and publication/restoration functions.
- `@archer/files/fs` contains durable local content-addressed persistence.
- `@archer/files/conformance` contains the required v1 `FileStore` behavior
  runner for first-party and independent adapters.
- `@archer/files/workspace` contains private lineage, current read/write and
  ingestion Authority actions, hot state, replayable facts, ChangeSets, and the
  process-local reference.
- `@archer/files/workspace/conformance` contains the required v1 Workspace
  behavior runner.
- `@archer/files/scratchpad` contains retention-discriminated private working
  files, transient updates, checkpoint facts, and the ephemeral/checkpointed
  process-local reference.
- `@archer/files/scratchpad/conformance` contains the required v1 process-local
  Scratchpad behavior runner.
- `@archer/files/materializer` and its ergonomic
  `@archer/files/materializer/directory` alias contain the product-neutral
  mapping concepts and cooperative local-directory implementation.
- `@archer/files/materializer/conformance` contains the required v1 directory
  Materializer behavior runner. It does not generalize directory guarantees to
  other Materializer types.

## Identity and storage

Blob identity is SHA-256 over raw bytes plus exact byte length. Tree identity is
SHA-256 over the complete canonical v1 directory-node bytes plus the format and
encoded length. Stores persist and verify those values; they do not define
them.

Blob reads are asynchronous streams. Successful terminal iteration proves the
requested digest and length. Publication validates the complete logical path
set before consuming a streaming source or writing storage. Expected failures
use `Result<Value, FilesError>`.

Both first-party stores are retained owners. `close()` is idempotent and returns
the exact `closed` promise. Closing the memory store releases its process-local
bytes. Closing a filesystem attachment does not delete durable objects.

Runnable examples live under [`examples/files`](../../examples/README.md). In
addition to immutable trees and local persistence, the Vercel AI SDK Workspace
and Scratchpad examples show how the retained owners fit an existing tool loop
without requiring a model to learn Archer vocabulary.

## Private work and physical views

A Workspace begins from one immutable tree and owns acknowledged private
lineage. Its current projection is hot; successful mutations and accepted
ingestion receipts publish replayable facts. Add, modify, rename, and delete
use explicit optimistic preconditions and UUIDv4 idempotency keys. A Workspace
can create a private `ChangeSet`, but it cannot promote it.
Expected mutation refusals preserve both acknowledged lineage and storage: a
rejected add or modify does not publish otherwise unreachable candidate bytes.

A Scratchpad owns private working files under an explicit retention mode. The
memory reference supports `ephemeral` and `checkpointed`; it rejects any claim
of `thread-durable` recovery until a durable Thread adapter exists. Closing
reports recoverability and never claims shared content-addressed blobs were
deleted.

The directory Materializer realizes Workspace, Resource, and Scratchpad trees
under separate ordinary host paths. Only Workspace is eligible for ingestion.
Its quiescence evidence is explicitly `cooperative-directory`; it is not a
sandbox containment or process-stop guarantee. Materialization and ingestion
are shared hot `LiveOperation`s with progress, abort, terminal settlement,
diagnostics, exact current Authority checks, and idempotent replay.
The shared physical-ingestion envelope binds every portable receipt field and
is re-verified before Workspace acceptance. Integrity evidence does not replace
adapter trust or current acceptance Authority.
