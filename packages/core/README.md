# `@archer/core`

`@archer/core` contains Archer's product-neutral values, pure decision
contracts, lifecycle ownership, RxJS-free reactive bridge, finite operations,
Authority, and the diagnostic dispatcher.

> This is an unreleased workspace package. Its `private` flag is deliberate
> until Archer's first public release; examples use the final package name so
> code written in the monorepo carries forward unchanged.

## Requirements

- Node 26.7 or newer within the Node 26 line
- ESM with TypeScript 5.9; Archer's declarations request the standard
  `ESNext.Disposable` library they use
- React 18 or 19 only when importing `@archer/core/react`

RxJS powers each shared hot graph but does not appear in public declarations.
Consumers use callbacks, promises, bounded async iterators, and async disposal.
The package is ESM-only; CommonJS `require()` is not supported.

## Entry points

- `@archer/core` provides values, codecs, `Result`, errors, `Program`, ownership,
  and diagnostic contract types.
- `@archer/core/program` provides the pure reducer and effect-intent contract.
- `@archer/core/stream` provides live state, durable replay, transient events,
  atomic attachment, finite operations, and staged inference builders.
- `@archer/core/diagnostics` provides record codecs and the diagnostic hub.
- `@archer/core/authority` provides action-owned scopes, immutable grants and
  revocations, current verification, and the ephemeral memory reference ledger.
- `@archer/core/react` provides `useLiveState` over React's external-store
  contract.
- `@archer/core/stream/conformance` and
  `@archer/core/diagnostics/conformance` provide versioned, framework-neutral
  compatibility suites. `@archer/core/authority/conformance` proves current
  grant, attenuation, revocation, administration, idempotency, and lifecycle
  semantics.
- `@archer/core/stream/testing` provides deterministic scheduling and promise
  controls for temporal tests.

## Current state

```ts
import { createLiveState } from '@archer/core/stream';

type TaskState = Readonly<{ status: 'queued' | 'running' }>;

const state = createLiveState<TaskState>(Object.freeze({ status: 'queued' }), {
  onListenerError(error) {
    // Managed Archer hosts send this failure to Diagnostics. A low-level host
    // chooses its own reporter explicitly.
    console.error(error);
  },
});

const unsubscribe = state.subscribe((snapshot) => {
  console.log(snapshot.status);
});

state.publish(Object.freeze({ status: 'running' }));
unsubscribe();
await state.close();
```

Publication never waits for a listener. Each listener receives the latest
snapshot outside the publication stack, and repeated reads preserve object
identity until state changes. `LiveState` deliberately retains the exact value
it is given; callers must publish normalized immutable snapshots. Archer's
domain codecs and aggregate boundaries own that copy-and-freeze step.

A listener failure is isolated from the source and other listeners. With the
low-level factory it is silent unless `onListenerError` is supplied. Managed
hosts wire that callback to the first-party diagnostic hub.

## Ordered delivery

Replayable streams retain durable observations and resume strictly after a
source-validated cursor. They never hide loss behind a gap. Transient streams
may discard presentation or diagnostic values, but every discarded item and
encoded byte is reported to that subscriber through `DeliveryGap`. Ordinary
transient values arrive as `{ kind: 'event', value }`, so application data can
never impersonate source-owned loss evidence.

Low-level sources require an `EventEncoding`:

```ts
import { replayableEventSource } from '@archer/core/stream';

type TaskEvent = Readonly<{ kind: 'acknowledged'; sequence: number }>;

const events = replayableEventSource<TaskEvent>()({
  source: 'task',
  scope: 'local-project',
  streamId: 'task-1',
  epoch: crypto.randomUUID(),
  retentionItems: 1_024,
  eventEncoding: {
    revision: 'task-event/1',
    normalize(event) {
      return Object.freeze({ ...event });
    },
    measure(event) {
      return new TextEncoder().encode(JSON.stringify(event)).byteLength;
    },
  },
});

const subscription = events.subscribe();
try {
  for await (const envelope of subscription) {
    console.log(envelope.cursor, envelope.value);
  }
} finally {
  const evidence = await subscription.close();
  if (evidence.kind === 'resume-required') {
    console.log('reattach strictly after', evidence.after);
  }
  if (evidence.kind === 'reseed-required') {
    console.log('load a fresh state seed:', evidence.reason);
  }
}
```

The encoding revision also binds durable cursors. `normalize()` validates,
copies, and freezes caller input into the source-owned event used by retention,
fan-out, and measurement. `measure()` must describe that normalized value's
canonical UTF-8 or binary representation and return a non-negative safe
integer. The low-level runtime rejects failed normalization or invalid
measurement before cursor or queue mutation. Domain packages should provide
their encoding; applications should not repeat ad hoc `JSON.stringify`
functions.

Every subscription owns only its bounded queue. Closing a subscription does
not close, cancel, or abort the source it observes. A subscription created
after a handle-owned source closes completes without replaying retained values.
Durable historical attachment belongs to the source's directory or store, not
to a dead in-memory handle.

Replay and transient sources default to 256 queued source values and 1 MiB of
encoded source data per subscriber. Those defaults are also the maximum unless
the source declares a larger `maximumDelivery`. Transient delivery reserves one
control position for coalesced gap evidence outside the source-value capacity.
Gap item and byte totals are canonical decimal strings, so exact loss evidence
does not end at JavaScript's safe-integer aggregate range.

## Finite work

```ts
import { createIdempotencyKey } from '@archer/core';
import { liveOperation } from '@archer/core/stream';

type Progress = Readonly<{ kind: 'started'; step: number }>;
type AttemptResult = Readonly<{ kind: 'completed' | 'aborted' }>;

const operation = liveOperation<Progress>()({
  source: 'model-step',
  epoch: crypto.randomUUID(),
  eventEncoding: {
    revision: 'model-progress/1',
    normalize(event) {
      return Object.freeze({ ...event });
    },
    measure(event) {
      return new TextEncoder().encode(JSON.stringify(event)).byteLength;
    },
  },
  async start({ emit, signal }): Promise<AttemptResult> {
    emit({ kind: 'started', step: 1 });
    return { kind: signal.aborted ? 'aborted' : 'completed' };
  },
  classifyAbort(settlement) {
    if (settlement.kind === 'failed') {
      return { kind: 'cleanup-unproved', failure: settlement.error };
    }
    return {
      kind: 'attempt-settled',
      outcome: settlement.value.kind,
    };
  },
  closeEvidence(settlement) {
    return { kind: 'closed' as const, settlement };
  },
});

const progress = operation.events.subscribe();
for await (const event of progress) {
  if (event.kind === 'gap') console.warn('progress lost', event.lostItems);
  else console.log(event.value.step);
}

const outcome = await operation.result;
const abortEvidence = await operation.abort({
  reason: 'operator request',
  idempotencyKey: createIdempotencyKey(),
});
await operation.close();
```

Construction starts one admitted attempt. Existing progress subscribers drain
accepted values after result settlement; late subscribers are complete.
`abort()` is the only active termination command and resolves with terminal
attempt or cleanup evidence. `close()` waits for the result and never aliases
abort. Repeating an abort idempotency key returns the same retained promise.

`liveOperation<Progress>()`, `replayableEventSource<Event>()`, and
`transientEventSource<Event>()` let callers select the event type while result,
close-evidence, and source-literal types continue to infer.

## Authority

Authority is a current check, not a shape a caller can possess. A downstream
package defines a `ProtectedAction<Name, Scope>` and registers its scope codec
and containment rule with `defineAuthorityAction()`. That descriptor binds
`GrantRef<Action>`, `AuthorityCheck<Action>`, stored grants, and command results
at compile time; the broker repeats runtime admission because references remain
forgeable at JavaScript and transport boundaries.

`createMemoryAuthorityLedger()` opens the v1 process-local reference over an
explicit UUIDv4 ledger ID, action definitions, bootstrap grants, and optional
trusted clock. It provides:

- `verify()` for one immediate subject, action, scope, time, lineage, and
  revocation decision;
- `grant()` under a current `AuthorityGrantAction` grant;
- `attenuate()` for a narrower same-action subject, scope, lifetime, and
  delegation bound;
- `revoke()` under a distinct current `AuthorityRevokeAction` grant; and
- idempotent closure that stops the attachment without manufacturing a
  revocation fact.

Bootstrap construction is the only trusted root path. `Principal` is
attribution, `GrantRef` is lookup, and `AuthorityVerification` is evidence for
the immediate call—not a reusable capability or permission snapshot. An
attenuated grant remains dependent on current ancestors, so parent expiry or
revocation invalidates its descendants.

`PrincipalSchema` is the canonical Authority-owned specialization of Archer's
shared `{ id, object, createdAt }` envelope. UUIDv4 identity schemas and the
bounded revocation-reason schema are exported beside the contracts so callers
do not duplicate runtime admission.

The ledger may borrow a diagnostics hub. It produces one accumulated terminal
span for verification, issuance, attenuation, revocation, and first closure.
Records correlate ledger and fact identities without retaining protected scope;
diagnostic unavailability never changes the domain outcome. The memory ledger
makes no durability claim. Durable adapters implement the same ports and run
`@archer/core/authority/conformance` against each guarantee-bearing
configuration.

## Diagnostics

`createDiagnostics()` returns a retained hub with a public transient event
stream, explicit span accumulation, and `owned()` or `borrowed()` sink
attachment. Concrete process-local work begins a `DiagnosticSpan`, enriches
package-owned context without emitting, and settles once as completed, failed,
or abandoned. Settlement emits one immutable wide record:

```ts
import { createDiagnostics, withDiagnosticSpan } from '@archer/core/diagnostics';

const diagnostics = createDiagnostics();

const answer = await withDiagnosticSpan(
  diagnostics,
  {
    name: 'model.step',
    component: 'example.model',
    correlation: {},
    attributes: { model: { provider: 'example', family: 'reasoning' } },
  },
  async (span) => {
    span.enrich('request', { toolCount: 3 });
    const value = await Promise.resolve(42);
    span.enrich('response', { resultKind: 'answer' });
    return value;
  },
);

await diagnostics.close();
```

`withDiagnosticSpan()` preserves the callback's exact value or thrown Error.
Direct span methods return Archer `Result` values for expected enrichment and
settlement refusals. Valid starting context that exceeds configured bounds is
refused atomically and counted in the terminal record rather than preventing
the operation. Spans default to 64 context namespaces and 64 KiB of encoded
attributes. Standalone `diagnostics.event()` records are reserved for useful
observations with no meaningful duration, not function-entry narration.

Each sink has an independent bounded queue. Writes are serialized per sink,
never retried implicitly, and cannot block diagnostic producers or change
domain work.

Diagnostic sink queues default to 1,024 records and 4 MiB. Overflow is reported
through a cardinality-bounded `diagnostics.gap` record with exact total items,
bytes, component, and severity counts. Write, flush, and owned-close shutdown
share a five-second deadline by default. Its Node timer remains referenced only
while close evidence depends on it and is cancelled when orderly shutdown wins.
Terminal attachment evidence separates written, dropped, and
timeout-unconfirmed records and bytes.

The hub is the product-neutral source of operational observations. Pino,
OpenTelemetry, Datadog, Prometheus, and ELK integrations belong in
`DiagnosticSink` adapters; logs and metrics are projections rather than hidden
side channels. Archer packages produce `DiagnosticRecord` values and do not
import Pino directly. The full policy is described in
[`docs/logging-principles.md`](../../docs/logging-principles.md).

## Conformance

Alternate temporal and diagnostic implementations run the public suites and
bind the complete result to their exact name, version, and immutable
configuration:

```ts
import {
  CORE_STREAM_CONFORMANCE_TARGET,
  requirePassingStreamConformance,
  runStreamConformance,
} from '@archer/core/stream/conformance';

const report = await runStreamConformance({
  target: CORE_STREAM_CONFORMANCE_TARGET,
  implementation: {
    name: '@archer/core',
    version: 'workspace',
    configuration: { runtime: 'rxjs' },
  },
  environment: {
    runtime: process.version,
    platform: process.platform,
  },
});

const evidence = await requirePassingStreamConformance(report);
```

Reports include the required catalogue, executed and skipped counts,
normalized time, environment, configuration digest, case results, and evidence
digest. Promotion recomputes both digests asynchronously against a deeply
immutable report snapshot. The exported `StreamConformanceReportSchema`,
`DiagnosticsConformanceReportSchema`, and `AuthorityConformanceReportSchema`
admit stored or transported reports through the same Zod 4 boundary before
verification. Hashes prove report integrity, not producer identity; deployments
that require provenance sign the evidence through their own trust boundary.
`pnpm --filter @archer/core check:package` additionally packs the real artifact,
installs it with pnpm into an empty project, compiles the low-level example,
checks clean imports and root side effects, and probes optional React behavior
plus production diagnostic shutdown.

The full rationale and construction order live in
[`docs/architecture.md`](../../docs/architecture.md).
