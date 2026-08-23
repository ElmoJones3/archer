# Own the canonical tree encoding

Archer will derive tree identity from an Archer-owned, versioned,
length-prefixed binary encoding rather than delegating canonical bytes to a
virtual filesystem, Git, an archive format, Protobuf, or a general serializer.
Raw blobs retain ordinary SHA-256 content identity. Canonical directory bytes
bind entry kind, normalized name, portable mode, byte length, and child content
references into each tree digest. This keeps durable identity narrower than any
mutable filesystem and stable across dependency upgrades.

## Considered options

Git provides the right recursive object shape but carries Git-specific object
headers, modes, path rules, and hash-transition behavior. Nix Archive provides
a useful model for ordered, length-prefixed encoding but serializes file content
inline instead of addressing independent blobs. Protobuf explicitly does not
promise canonical bytes. Deterministic CBOR is viable, but its general data
model and permissive decoders add canonical forms Archer does not need for two
entry kinds.

## Consequences

`@archer/files` will depend on `@archer/core`, Zod 4, and the Node standard
library, but none of them owns the encoded tree form. A VFS implementation
cannot enter the identity path. The format requires a language-neutral grammar,
permanent golden byte and digest vectors, strict rejection of alternate
encodings, and property-based proof. `fast-check` is a development dependency
for that proof, not part of the runtime format.
