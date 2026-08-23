# Immutable tree

This example uses only `@archer/files`. It publishes flat logical file input as
a hierarchical Merkle tree, proves caller order does not change identity, shows
an unchanged directory being structurally shared after another branch changes,
rejects a reserved logical path, and closes its retained memory store.

From the repository root:

```sh
pnpm exampleFilesImmutable
```

No sandbox, host filesystem adapter, VFS, Git implementation, or network
service participates in the tree identity demonstrated here.
