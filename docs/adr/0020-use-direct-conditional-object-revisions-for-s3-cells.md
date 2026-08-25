# ADR 0020: Use direct conditional-object revisions for S3 Cells

## Status

Accepted.

## Context

Archer needs one node-independent CellHost that does not require a database
server. Earlier spikes uploaded SQLite snapshots behind a bucket manifest. That
proved conditional ownership and fencing, but it made SQLite an accidental part
of the remote storage contract and made small-state adopters carry machinery
they did not ask for.

S3 already supplies strongly consistent reads and conditional writes. AWS SDK
v3 already supplies signing, retries, endpoints, and the standard Node
credential provider chain. S3-compatible products may expose similar APIs but
cannot be assumed to honor identical conditional semantics.

## Decision

The first-party S3 CellHost stores each committed Cell record and its new
observations in an immutable revision object. It acknowledges only after a
small head object is replaced under the exact current opaque ETag. A failed head
race leaves an unreachable immutable orphan and returns conflict; it never
acknowledges the orphan.

The adapter performs a mandatory live startup probe for conditional create,
current-token replacement, retired-token rejection, and exact readback. ETags
are opaque versions, not content digests. Recovery discovery scans bounded head
pages under explicit current Authority and returns only expired recoverable Cell
IDs.

Mutable heads occupy a dedicated listing prefix, separate from immutable
revision history. Recovery page bounds therefore count candidate Cells rather
than old commits made by a busy Cell.

Managed construction uses AWS SDK v3's default Node credential chain. Existing
clients may be injected as explicitly borrowed or owned dependencies. Archer
defines no access-key configuration fields and never persists or observes
credentials.

Embedded SQLite remains a separate same-filesystem implementation. Other object
stores may implement Archer's conditional-object port after proving their own
live semantics; they do not claim S3 guarantees by type alias.

## Consequences

- Small durable state can use S3 without PostgreSQL or a SQLite snapshot image.
- Every acknowledged remote mutation costs an immutable write plus one head CAS;
  lease duration and release policy therefore remain visible cost decisions.
- Whole-record bounds are explicit and oversized decisions fail before remote
  publication.
- Immutable orphan cleanup and retained probe objects belong in bucket lifecycle
  policy.
- At-least-once external effects require destinations to honor Archer's stable
  effect ID when exactly-once business behavior matters.
- A replacement process still supplies the exact Program, codecs, effect
  adapter, Principal, and grant; bucket access alone cannot activate code.
