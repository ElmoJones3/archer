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

### CellHost

A replaceable durability service that creates or restores Cells under exact
Program, projection, codec, and durability revisions and returns a retained
Cell handle.

### Thread

A durable agent conversation and task history composed of Turns and ordered
Items.

### Turn

One user-directed unit of work within a Thread.

### Item

One ordered durable fact in a Thread transcript, such as a request, response
part, tool proposal, tool result, repair, or compaction record.

### OwnedHandle

A retained behavioral object with idempotent asynchronous closure and one
shared `closed` settlement. Its immutable close evidence records terminal
lifecycle or recovery facts when the owned work can survive the current
process.

### ReplayableEventStream

A bounded public source of ordered durable observations. Its branded cursor
belongs to one source and permits exact continuation while retained history is
available. A lagging subscriber resumes or detaches; it never receives a gap
that could be mistaken for complete history.

### TransientEventStream

A bounded public source of ordered presentation or diagnostic events that may
report explicit delivery gaps but makes no replay claim. Each subscription owns
only its queue and attachment; closing it does not cancel the work observed.

### LiveState

A public source of immutable current state and subsequent state subscriptions.
It is the standard-JavaScript projection of Archer's internal reactive runtime.

### AtomicLiveAttachment

A public transport and worker bridge that attaches bounded queues first and
then returns one versioned current-state, durable-cursor, and transient-epoch
seed from the existing live graph. It owns no reducer and starts no work.

### LiveOperation

A retained owner of one finite live attempt, such as a model step, tool
invocation, sandbox acquisition or execution, materialization, or ingestion.
It exposes transient progress, one terminal result, active abort, and immutable
close evidence. Closing observation does not alias abort.

### TaskRun

A retained behavioral object for one durable managed task. It exposes current
state, replayable durable observations, transient presentation and diagnostics,
authorized commands, outcome-or-detachment settlement, and recovery-aware
attachment lifetime without becoming the authority for durable facts.

### TaskRunSnapshot

The immutable current projection of a TaskRun, discriminated by its lifecycle
status. It combines acknowledged facts with explicitly transient activity and
is not reconstructed from logs.

### TaskOutcome

The terminal completed, failed, or cancelled value of a TaskRun. Awaiting an
approval is live task state, not a TaskOutcome.

### TaskRunSettlement

The tagged result of waiting on one TaskRun attachment. It contains either the
durable task outcome or evidence that the attachment closed while the task may
continue elsewhere.

### CancellationReceipt

Evidence that a durable cancellation command was accepted or refused. It is
not itself a terminal task or Turn outcome.

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

### WorkspaceSnapshot

An immutable transferable Workspace lineage product at one acknowledged tree
and generation. It is distinct from the live snapshot of a retained Workspace
handle.

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
