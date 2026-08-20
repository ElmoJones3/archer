# Archer semantics

Owner: `Archer`

Terms in this file belong to Archer's public domain.

## Durable execution

### Program

A deterministic domain decision unit that derives new state and effect intents
from current state and an event.

### Effect intent

A durable description of external work requested by a Program. It is neither
the execution itself nor evidence that the work completed.

### Acknowledgement

Evidence that a Cell durably accepted an event and its resulting state and
effect intents under a sequence and fence epoch.

### Cell

The durability boundary that owns canonical state, event order, effect
attempts, ownership fencing, wake state, and recovery.

### Thread

A durable agent conversation and task history composed of Turns and ordered
Items.

### Turn

One user-directed unit of work within a Thread.

### Item

One ordered durable fact in a Thread transcript, such as a request, response
part, tool proposal, tool result, repair, or compaction record.

### OwnedHandle

A retained behavioral object with explicit asynchronous closure. Its close
result records terminal lifecycle or recovery facts when the owned work can
survive the current process.

### EventStream

A bounded public source of ongoing events. Each subscription owns only its
delivery queue and attachment; closing a subscription does not cancel the work
being observed.

### LiveOperation

A retained owner of one finite live attempt, such as a model step or sandbox
execution. It exposes bounded events, one terminal result, active abort, and
close evidence.

### TaskRun

A retained application attachment to one durable managed task. It exposes task
observations, approval commands, a terminal or paused result, and durable
cancellation without making the attachment itself authoritative.

## Resources and authority

### Resource

A named model, prompt, skill, or tool whose usable identity is a specific
immutable revision.

### ResourceSet

The exact immutable selection of admitted resource revisions compiled for a
workspace and profile.

### Principal

The identity attributed to an action. A Principal is not proof that the action
is permitted.

### GrantRef

A durable lookup reference for an authority decision. Possessing a structurally
valid GrantRef is not permission to act.

## Sandboxes

### SandboxRequirement

The exact backend configuration and runner identity that an acquisition must
satisfy. It preserves distinctions such as process, Docker, QEMU with HVF, and
Firecracker with KVM.

### SandboxCandidate

An acquired sandbox whose runtime observation has not yet passed independent
verification. A candidate is not executable through Archer's public contract.

### VerifiedAttestation

The result of comparing a `SandboxCandidate` runtime observation with its exact
`SandboxRequirement` and applicable proof.

### SandboxHandle

A retained execution environment paired with a `VerifiedAttestation`.
Ownership of the handle does not authorize an execution.

## Files and work

### Immutable tree

A content-addressed logical hierarchy of files and directories whose identity
does not depend on a sandbox, workspace adapter, or storage product.

### Workspace

A private mutable view with its own identity and lineage. A Workspace may
produce snapshots and a ChangeSet but does not own canonical promotion.

### Scratchpad

Private working files owned by a Thread or task under an explicit durability
policy. A Scratchpad has no canonical promotion authority by default.

### Materializer

An adapter that turns logical file content into a physical execution view and
ingests resulting changes back into verifiable logical content.

### MaterializedView

One owned physical realization of exact Workspace, Resource, and Scratchpad
trees for an execution target. It is not an authoritative Workspace snapshot.

### IngestionReceipt

Evidence that a Materializer read a quiesced physical view and produced a
complete immutable result tree for an exact base and view generation.

### ChangeSet

An immutable proposal describing changes from a specific Workspace lineage.
It is not evidence that the changes were reviewed, approved, checked, or
promoted.

## Integration

### Adapter

An implementation that connects an Archer contract to a product, provider,
storage system, execution backend, or transport without exporting that
product's types into the contract.

### Extension

A packaging unit that contributes Resources, narrow capability adapters,
named lifecycle participants, or passive observers without combining their
authority or failure rules.

### DiagnosticRecord

A normalized, redacted operational observation correlated with Archer work.
It is not durable state, authority, retry evidence, or a task outcome.

### DiagnosticSink

A best-effort destination for DiagnosticRecords, such as structured logging or
telemetry transport. Its failure cannot change durable work.
