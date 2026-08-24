# Archer semantics

Owner: `Archer`

Terms in this file belong to Archer's public domain.

## Core contracts

### ArcherError

The public base Error for failures owned by Archer. Focused Archer error
categories may extend it; ordinary domain outcomes remain tagged values.

### ArcherObject

The shared identity envelope for an identity-bearing Archer domain object. It
carries a UUIDv4 ID, a stable object discriminator, and its trusted creation
time.

### Result

Archer's exact success-or-failure value, represented as either
`{ ok: true, value }` or `{ ok: false, error }`. The failure is an Error;
expected domain outcomes use their own tagged values.

### PublicError

A bounded, immutable JSON failure safe for transport and diagnostics. It is a
redacted projection of a local Error, never the native Error object itself.

### IdempotencyKey

A UUIDv4 command identity scoped to deduplication at the receiving boundary.
It does not identify the domain object or grant authority to execute a command.

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

### ComponentRef

An explicit `owned` or `borrowed` reference that tells a composition whether
it may close an injected retained dependency. A close-shaped method never
implies ownership by itself.

### EventEncoding

The required revision, source-owned normalization, and canonical encoded-byte
measurement for one event protocol. Normalization validates, copies, and
freezes caller input before measurement, retention, or fan-out. A low-level
source uses the same encoding contract for queue limits, loss evidence,
cursors, and transport conformance; it does not guess from a JavaScript object
representation.

### StreamCursorCodec

The public constructor and verifier for a replay cursor bound to source family,
scope, logical stream, epoch, and event protocol revision. A delivered cursor
resumes strictly after that event; callers never manufacture cursors by cast.

### ReplayableEventStream

A bounded public source of ordered durable observations. Its branded cursor
belongs to one source and permits exact continuation while retained history is
available. A lagging subscriber resumes or detaches; it never receives a gap
that could be mistaken for complete history.

### TransientEventStream

A bounded public source of ordered presentation or diagnostic events that may
report explicit delivery gaps but makes no replay claim. Ordinary data is
wrapped in an `event` delivery frame so its shape cannot impersonate a gap.
Each subscription owns only its queue and attachment; closing it does not
cancel the work observed.

### TransientDelivery

The transport frame returned by a transient subscription. An `event` frame
carries normalized application data; a `gap` frame carries source-owned loss
evidence. The outer discriminator is reserved by Archer and cannot be forged by
the application event's own shape.

### LiveState

A public source of immutable current state and subsequent state subscriptions.
It is the standard-JavaScript projection of Archer's internal reactive runtime.
The source retains a normalized immutable snapshot supplied by its aggregate
boundary rather than cloning an arbitrary generic object.

### StateVersion

A canonical non-negative decimal that increases monotonically within one live
state source and epoch. Versions from different sources or epochs are not
comparable.

### DeliveryGap

Exact canonical-decimal item and encoded-byte loss for one transient subscriber
within one source epoch. It is source-owned presentation evidence, not an
application event or durable replay position.

### AtomicLiveAttachment

A public transport and worker bridge that attaches bounded queues first and
then returns one versioned current-state, durable-cursor, and transient-epoch
seed from the existing live graph. It owns no reducer and starts no work.

### LiveOperation

A retained owner of one finite live attempt, such as a model step, tool
invocation, sandbox acquisition or execution, materialization, or ingestion.
It exposes transient progress, one terminal result, active abort, and immutable
close evidence. Closing observation does not alias abort.

### AttemptAbortEvidence

Terminal evidence for one idempotent active-abort command. It records that the
attempt settled as aborted or completed, that cleanup could not be proved, or
that the command arrived after settlement; signal delivery alone is not enough.

### Conformance report

A complete, versioned set of required protocol case results bound to one named
implementation, exact version, and immutable configuration. Only a report in
which every required case ran and passed can be promoted to conformance
evidence.

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

### ProtectedAction

An action discriminator paired with the complete scope owned by the package
that performs the protected operation.

### AuthorityActionDefinition

The runtime scope codec and containment rule registered for one
ProtectedAction. It interprets that action's scope without teaching Authority
the owning package's domain vocabulary.

### GrantRef

A durable lookup reference for an authority decision. Possessing a structurally
valid GrantRef is not permission to act.

### AuthorizationGrant

An immutable Principal-bound authority fact carrying one action, admitted
scope, validity window, delegation bound, issuance attribution, and lineage in
one Authority ledger.

### GrantRevocation

An immutable Authority-ledger fact that retires one AuthorizationGrant and its
attenuated descendants.

### AuthorityVerification

Evidence that one exact Principal, action, and scope check passed against the
broker's current facts and trusted clock. It is not reusable permission.

### AuthorityBroker

The finite current-check port consulted immediately before a protected action.

### AuthorityLedger

The retained owner that verifies current authority and records authorized
grant, attenuation, and revocation transitions. Durability remains an
implementation-specific guarantee.

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

### BlobRef

A content reference to exact regular-file bytes identified by their raw
SHA-256 digest and byte length. It carries no host path or mutable filesystem
identity.

### TreeRef

A versioned content reference to the canonical root directory node that
recursively identifies one complete immutable tree.

### Immutable tree

A content-addressed Merkle hierarchy of logical files and derived directories
rooted at a `TreeRef`. Its identity does not depend on a sandbox, virtual
filesystem, Workspace adapter, or storage product.

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

A normalized, redacted terminal DiagnosticSpan record or standalone
DiagnosticEvent correlated with Archer work. It is not durable state,
authority, retry evidence, or a task outcome.

### DiagnosticSpan

A process-local diagnostic lifecycle for one finite attempt or service hop. It
accumulates admitted context and settles once as completed, failed, or
abandoned.

### DiagnosticSpanRecord

The immutable terminal DiagnosticRecord emitted when a DiagnosticSpan settles.
It contains the span identity, timing, settlement, accumulated context, and
enrichment-loss evidence.

### DiagnosticEvent

A standalone DiagnosticRecord for an operational observation with no
meaningful duration. It is not a breadcrumb emitted from inside a
DiagnosticSpan.

### DiagnosticSink

A best-effort destination for DiagnosticRecords, such as structured logging or
telemetry transport. Its failure cannot change durable work.

### DiagnosticHub

The retained producer and extension boundary for DiagnosticRecords. It fans
records out without awaiting domain work, begins DiagnosticSpans, and gives
every attached sink an independent bounded, serialized queue.
