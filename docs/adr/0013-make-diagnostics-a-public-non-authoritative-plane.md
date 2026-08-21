# Make diagnostics a public non-authoritative plane

Archer will define normalized, redacted DiagnosticRecords, a bounded diagnostic
`TransientEventStream`, and replaceable owned DiagnosticSinks. Records carry
stable lifecycle names and correlation for task, Thread, Turn, Cell, effect,
attempt, model, invocation, sandbox, materialized view, Workspace, ResourceSet,
and ChangeSet where available.

Diagnostic delivery is best effort and isolated from Programs. Queue overflow,
sink failure, exporter failure, sampling, and flush failure cannot change
acknowledgement, retry admission, cancellation, authority, budget enforcement,
task outcome, checks, or promotion.

Each sink attachment owns an independent bounded queue. Writes to one sink are
serialized in accepted order and never retried implicitly. Overflow emits an
explicit diagnostic gap. Sink failure follows its attachment policy and
defaults to detachment. Flush waits only for accepted records, respects the
shutdown deadline, and settles before the attachment closes.

Pino is the first-party structured logger and managed presets attach a redacted
Pino sink by default. OpenTelemetry is the first-party traces and metrics
adapter. Datadog, Prometheus, ELK, and other systems connect through those
adapters, their collectors, or an independent DiagnosticSink. Every TaskRun
exposes its filtered diagnostic stream even when log output is disabled. No
logging or telemetry product type enters a contract declaration.
