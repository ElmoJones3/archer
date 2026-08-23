# `@archer/files`

`@archer/files` owns Archer's product-neutral immutable file identity. It
provides logical path codecs, raw `BlobRef` values, hierarchical `TreeRef`
values, the permanent `archer-tree-v1` directory encoding, blob and tree store
ports, an in-memory store, publication, restoration, and the versioned adapter
conformance suite.

The root package has no VFS, Git, sandbox, host-path, or Workspace assumption.
Flat logical paths are construction sugar compiled into canonical Merkle
directory nodes. A file change replaces only its blob and ancestor nodes;
unrelated directory references remain shareable.

## Entry points

- `@archer/files` contains immutable values, pure codecs, store contracts, the
  in-memory implementation, and publication/restoration functions.
- `@archer/files/fs` contains durable local content-addressed persistence.
- `@archer/files/conformance` contains the required v1 `FileStore` behavior
  runner for first-party and independent adapters.

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

Runnable examples live at
[`examples/files/immutable-tree`](../../examples/files/immutable-tree/README.md)
and [`examples/files/local-store`](../../examples/files/local-store/README.md).
