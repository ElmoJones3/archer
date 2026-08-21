# Build the public API inside out

Archer will ship a small set of TypeScript capability packages. Root modules
publish contracts and common factories. First-party implementations live at
explicit subpath exports such as `@archer/models/ai-sdk` and
`@archer/sandbox/docker`. Source modules preserve strict dependency direction
even when a contract and its first-party adapters share one npm package.

The short `runTask` path returns the same hot TaskRun produced by retained
composition. It composes the same authority, resource, Cell, model, sandbox,
Workspace, diagnostic, and lifecycle contracts available to direct users. It
may own safe defaults and cleanup, but it may not bypass acknowledgement,
invent authority, weaken isolation, hide retries, promote work, or reduce the
running task to a terminal Promise.

Contract source modules point inward. Root imports have no side effects or
adapter registration. Backend dependencies load only when their subpath factory
is selected. Third-party adapters remain independent packages and use the same
public contracts and conformance suites as first-party implementations.

All first-party packages use one v1 version and release train. Capability
packages remain independently installable, while consumers avoid an internal
compatibility matrix. Third-party adapters version against the protocol and
conformance revision they implement.
