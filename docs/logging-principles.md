# Logging what happened, not what the code said

Most logging starts as narration. A function says that it was entered, another
line says that a request is about to leave, and a third says that the request
returned. The code already knew all three facts. Six months later, an operator
still cannot answer why one attempt was slow, why a subset of tasks failed, or
which sandbox guarantee was active when a tool escaped its expected path.

Archer takes a different position. Operational diagnosis begins when concrete
work begins. Context accumulates while the work runs. One complete record is
emitted when that work settles.

This document explains that position for package authors and maintainers. The
normative contracts live in [architecture.md](architecture.md), and the
decision history lives in
[ADR 0016](adr/0016-accumulate-wide-diagnostic-spans.md).

## The record is the product

A useful diagnostic record should stand on its own. An operator ought to query
one completed model attempt and see its provider, model family, retry attempt,
resource revision, elapsed time, token usage, termination reason, and bounded
failure without joining a sequence of sentence fragments.

This does not mean every available value belongs in the record. It means every
admitted value should help answer a question about that unit of work. Archer
records high-cardinality identities such as task, effect, attempt, invocation,
and Workspace IDs because those identities support real investigations. It
also records high-dimensional business and runtime context when the owning
package defines and admits it.

The emitted value is structured data. Human-readable output is one projection
of that data. Pino may print it as JSON, OpenTelemetry may map it to a span, and
a test may inspect it directly. None of those destinations gets to redefine
what happened.

## A span is concrete work

Archer uses a diagnostic span for work with a meaningful beginning and end. A
model step, tool invocation, sandbox execution, materialization, provider hop,
or effect attempt is a span. Each is finite and belongs to one process-local
execution attempt.

A Task or Thread is usually too large to be one span. It may pause for an
approval, move to another worker, recover after process death, or continue for
hours. Durable identities connect the spans produced across that history. They
do not make one in-memory span immortal.

This distinction keeps recovery honest. When a worker replaces another worker,
the new attempt starts a new diagnostic span. It carries the durable task,
Thread, Cell, effect, and attempt identities that explain the relationship. It
does not claim that an ambient trace context survived merely because two pieces
of work belong to the same task.

## Begin, enrich, settle

The ordinary lifecycle has three steps.

First, the component begins a span with its stable name, owning component,
durable correlation, optional parent span, and context already known.

Second, code enriches that span as new facts become available. Enrichment adds
or replaces one named context namespace. It validates, copies, and freezes the
value at admission. It does not emit a record.

Third, the component settles the span as completed, failed, or abandoned.
Settlement captures the final wall time, monotonic duration, outcome, bounded
failure, and accumulated context. It emits one terminal span record.

The distinction matters. This is narration:

```ts
logger.info({ attemptId }, 'calling model');
logger.info({ attemptId, provider }, 'model accepted request');
logger.info({ attemptId, usage }, 'model returned');
```

This is diagnosis:

```ts
const span = diagnostics.beginSpan({
  name: 'model.step',
  component: 'models.ai-sdk',
  correlation: { taskId, threadId, turnId, effectId, attemptId, modelRequestId },
  attributes: {
    model: { provider: 'openai', family: 'gpt-5' },
  },
});

span.enrich('request', {
  toolCount: tools.length,
  estimatedInputTokens,
});

const response = await callModel();

span.enrich('response', {
  finishReason: response.finishReason,
  usage: response.usage,
});

span.complete({ outcome: 'completed' });
```

The span object owns a mutable lifecycle because accumulation is stateful. Its
inputs and terminal record remain immutable values. Callers receive an
interface from the DiagnosticHub rather than a public implementation class.

## Explicit propagation wins

Archer passes a diagnostic span explicitly through the operation that owns it.
The effect shell already carries attempt identity and cancellation. Diagnostic
context belongs beside those values.

Ambient propagation through `AsyncLocalStorage` or an OpenTelemetry context
manager can reduce application plumbing inside one Node process. It can also
attribute work to the wrong task when callbacks, queues, retries, and retained
handles outlive the lexical call that installed the context. It cannot cross a
sandbox, transport, process replacement, or durable wake without an explicit
handoff.

Archer adapters may offer ambient bridges. Core behavior never depends on
them. Durable Archer IDs and explicit parent span identity remain the source of
correlation truth.

## Point events are the exception

Some observations have no useful duration. A diagnostic queue reports a gap at
one instant. A configuration boundary refuses an unsupported value. A process
receives a signal. These are diagnostic events rather than spans.

Point events must still carry enough context to answer a question on their own.
They are not permission to revive line logging. Function entry, loop progress,
provider chunks, tool output, and file updates already belong elsewhere.

Archer exposes four observable planes for this reason:

- Live state reports what a retained owner currently believes.
- Durable observations report acknowledged facts that may support recovery or
  audit.
- Presentation events report timely progress and explicit gaps.
- Diagnostics explain operation, performance, and failure without authority.

Putting progress into logs wastes storage and leaves the actual public API
blind. Putting durable facts into logs makes recovery depend on a best-effort
sink. Package authors must select the plane that owns the claim.

## Wide does not mean reckless

An agent runtime sees data that ordinary web applications rarely handle in one
place. Prompts, tool arguments, file contents, provider responses, credentials,
environment values, and private workspace state may all pass through one task.
The easiest logging strategy would also be the worst one: collect everything,
then ask a downstream redactor to repair the damage.

Archer admits context at the source instead. Each package decides which
attributes are safe and useful. It supplies normalized immutable JSON under a
stable namespace. Secrets and raw payloads stay out unless a future explicit
policy defines a safe projection.

Every span also has a namespace and encoded-byte budget. An enrichment that
would exceed the budget is refused without changing previously admitted
context. The terminal record reports accepted updates, rejected updates, and
known rejected bytes. Operators can therefore tell the difference between
"no context existed" and "context was discarded by policy."

Starting context follows the same policy. It is admitted as one atomic value.
If it exceeds either bound, the span starts with empty context and records one
refusal. Optional diagnostic detail cannot prevent the operation from running.

These limits protect process memory and storage bills. They also force package
authors to choose fields with diagnostic value instead of treating the logger
as an object dump.

## Failure cannot change the work

Diagnostics are best effort. A full queue, failed Pino destination, rejected
OpenTelemetry export, invalid enrichment, or shutdown timeout cannot alter the
domain result.

The helper that wraps work in a diagnostic span must preserve the exact value
or Error produced by that work. It may record a bounded failure projection. It
may not swallow, replace, retry, or reinterpret the failure.

An orderly DiagnosticHub shutdown settles every open span as abandoned and
emits the context accumulated so far. A hard process failure cannot promise the
same thing. The missing terminal span may itself help an investigation, but
durable Cell and attempt state remain the recovery evidence. Logs never become
a substitute journal.

## Pino is a projection

`@archer/observability/pino` receives normalized DiagnosticRecords. It maps
terminal span records and standalone event records to Pino levels, bindings,
and destinations. It does not own span accumulation and does not expose a
logger to domain packages.

No Archer package outside that adapter imports Pino or calls `logger.info()`.
That rule prevents each package from inventing a second record schema,
redaction policy, correlation mechanism, or failure path. Applications may
attach a different DiagnosticSink without changing the records Archer
produces.

The OpenTelemetry adapter consumes the same meaning. It maps span identity,
parentage, start time, duration, outcome, and attributes into tracing data. It
derives bounded metrics from named outcomes and durations. Pino and
OpenTelemetry can disagree about transport and storage while agreeing on what
the operation did.

## What maintainers owe

When adding instrumentation, start by naming the concrete work. If it has a
beginning and an end, use a DiagnosticSpan. Choose a stable event name and
component. Add context under package-owned namespaces. Settle every legal path
exactly once.

Use a DiagnosticEvent only when the observation is instantaneous and useful by
itself. Send user-visible progress through a presentation stream. Record
acknowledged truth through the owning durable protocol. Never log raw prompts,
tool payloads, file bytes, headers, environments, credentials, or native Error
graphs.

Tests should prove the final record, not that a logger method was called. Pin
the accumulated context, settlement, duration, redaction, bounds, and
non-interference behavior. Adapter tests then prove that the same normalized
record reaches Pino or OpenTelemetry without acquiring new meaning.

The standard is simple to state and demanding to keep. One complete record per
concrete span. Explicit context. Honest bounds. No authority. No narration.
