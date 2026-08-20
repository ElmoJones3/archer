# Preserve exact sandbox guarantees

Archer's sandbox types will retain the exact backend configuration a caller may
rely on. A provider returns a non-executable candidate and raw runtime
observation; an independent verifier must accept the complete requirement
before Archer exposes an executable handle. A broad label such as `vm` or
`hardware-vm` cannot erase the VMM, accelerator, architecture, image, network,
jailer, runner identity, or applicable conformance evidence.

There is no automatic fallback to weaker isolation. V1 recognizes QEMU with
HVF on the verified x86_64 macOS profile as the production-shaped first-party
backend. Docker and local process execution are explicit development choices.
Firecracker with KVM remains a planned contract until a live Linux
implementation and its required conformance cases pass.
