# Accumulate wide diagnostic spans before emitting records

Archer will treat a concrete process-local span as the ordinary unit of
operational diagnosis. A component begins a `DiagnosticSpan`, enriches it with
explicitly admitted context while work progresses, and settles it exactly once
as completed, failed, or abandoned. Settlement emits one immutable terminal
span record. Enrichment does not emit log lines.

A span describes one finite attempt or service hop. Durable tasks, Threads,
Cells, and effects may outlive a process, so their identities correlate several
spans rather than pretending one in-memory span survived recovery. A recovered
attempt begins a new span and retains its durable Archer correlation.

`DiagnosticRecord` is a discriminated union of terminal span records and
standalone diagnostic event records. Event records are reserved for
observations with no meaningful duration, such as a diagnostic delivery gap,
configuration refusal, invariant violation, or process signal. They are not an
escape hatch for function-entry breadcrumbs or high-frequency progress.

Explicit span propagation is canonical. Archer passes the span through the
same operation context that carries durable identities and cancellation.
`AsyncLocalStorage`, OpenTelemetry context, and similar ambient mechanisms may
provide adapter convenience, but they are never the source of Archer
correlation truth and never cross a durable recovery boundary by implication.

Span enrichment accepts immutable JSON under named namespaces. The span owns a
copy, limits namespace count and encoded bytes, rejects enrichment after
settlement, and reports rejected update and byte counts in its terminal record.
Optional starting context is admitted atomically. Context over either bound is
refused and accounted for without preventing the span from observing work.
Prompt content, tool input and output, file bytes, provider headers,
credentials, raw environment values, and secrets remain excluded by default.
Wide context is richly dimensional, not unbounded or indiscriminate.

Pino receives completed span records and standalone event records through
`@archer/observability/pino`. OpenTelemetry projects the same span identity,
timing, hierarchy, outcome, and attributes into traces and bounded metrics.
Neither product owns diagnostic meaning. Direct Pino imports outside its
official adapter are prohibited.

Diagnostic accumulation, emission, overflow, exporter failure, and shutdown
remain non-authoritative. They cannot change acknowledgement, retry,
cancellation, budget, task outcome, checks, or promotion. An orderly
DiagnosticHub shutdown abandons and emits every span still open. A hard process
failure may lose unflushed context; durable state and attempt evidence remain
the recovery truth.

This decision refines ADR 0013. Diagnostics remain a public,
non-authoritative plane, now with one prescribed production mechanism rather
than an immediate logging API that merely permits good discipline.
