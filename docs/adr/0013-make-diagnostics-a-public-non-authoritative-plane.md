# Make diagnostics a public non-authoritative plane

Archer will define normalized, redacted DiagnosticRecords, a bounded diagnostic
EventStream, and replaceable DiagnosticSinks. Records carry stable lifecycle
names and correlation for task, Thread, Turn, Cell, effect, attempt, model,
invocation, sandbox, materialized view, Workspace, ResourceSet, and ChangeSet
where available.

Diagnostic delivery is best effort and isolated from Programs. Queue overflow,
sink failure, exporter failure, sampling, and flush failure cannot change
acknowledgement, retry admission, cancellation, authority, budget enforcement,
task result, checks, or promotion.

Pino is the first-party structured logging adapter. OpenTelemetry is the
first-party traces and metrics adapter. Datadog, Prometheus, ELK, and other
systems connect through those adapters, their collectors, or an independent
DiagnosticSink. No logging or telemetry product type enters a contract package.
