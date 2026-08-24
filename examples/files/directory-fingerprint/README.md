# Fingerprint a directory

This command gives a directory one reproducible content identity. Build systems,
deployment scripts, and local caches can use the root digest as a cache key
without relying on modification times, traversal order, or host path syntax.

It reads the directory with Node, rejects links and non-regular entries, then
hands regular-file bytes and executable intent to `@archer/files`. Archer owns
logical path admission, blob hashing, canonical tree construction, and the final
Merkle root. No sandbox, Workspace, or agent participates.

From the repository root, fingerprint the architecture documentation:

```sh
pnpm example:files:fingerprint -- docs
```

The command prints the root reference, canonical file references, and exact
aggregate byte count. Copy `fingerprintDirectory()` into a build or deployment
tool when content, rather than timestamps, should decide whether work is stale.

Symbolic links are rejected because following them would make the result depend
on content outside the selected directory. Empty directories do not enter the
v1 tree grammar; only regular files and their hierarchy determine identity.
