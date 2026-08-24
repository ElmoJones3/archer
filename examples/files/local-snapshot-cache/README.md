# Keep named local snapshots

This command turns mutable directories into named, content-addressed snapshots.
It is useful for local build inputs, deployment bundles, and reproducible test
fixtures that must remain readable after their source directory changes.

The application owns the friendly name under `<cache>/refs`. `@archer/files/fs`
owns immutable blobs and canonical directory nodes under `<cache>/objects`.
Names are create-only, so saving another tree as an existing name fails instead
of silently changing what earlier scripts will read.

Save the current documentation and inspect it later:

```sh
pnpm example:files:cache -- save /tmp/archer-snapshots docs-before-edit docs
pnpm example:files:cache -- list /tmp/archer-snapshots docs-before-edit
pnpm example:files:cache -- read /tmp/archer-snapshots docs-before-edit architecture.md
```

The cache survives command exit. Each `list` or `read` invocation opens a new
filesystem-store attachment, validates the named tree reference, and verifies
stored content before returning it. Copy the three application functions when a
small local registry is enough and a database-backed alias service would be
unnecessary machinery.

This is not a mutable VFS. A name points at one immutable tree forever. Deleting
aliases or collecting unreachable objects is deployment policy and intentionally
remains outside this example.
