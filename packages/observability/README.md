# `@archer/observability`

`@archer/observability` contains first-party projections of Archer's
product-neutral `DiagnosticRecord` protocol. It does not own diagnostic
meaning, domain outcomes, or the span lifecycle.

The package has explicit adapter subpaths:

- `@archer/observability/pino` projects records into structured Pino logs.
- `@archer/observability/opentelemetry` projects records into OpenTelemetry
  traces and bounded metrics.

Importing one subpath must not initialize the other adapter. Pino is a bundled
dependency because managed Node presets use it by default. The OpenTelemetry
API is an optional peer so Pino-only consumers do not acquire an SDK runtime.

## Shared projection rules

Both adapters consume normalized immutable records through `DiagnosticSink`.
They never receive span enrichments, open spans, raw prompts, tool payloads,
file bytes, credentials, native Errors, or authority. A projection failure may
reject its sink write or close operation. It cannot change the work described
by the record.

Each terminal `DiagnosticSpanRecord` produces one destination observation.
Each standalone `DiagnosticEventRecord` produces one destination observation.
Neither adapter manufactures start and finish breadcrumbs.

Correlation IDs remain fields on logs and trace spans. Metrics exclude those
IDs and other unbounded labels. Metric labels are limited to stable record
name, component, severity, settlement kind, outcome, and public error code.

## Pino

The Pino projection performs one level-selected logger call per record. The
complete normalized record remains nested under an `archer` field and the
message is the record name. Pino envelope time records destination ingestion;
`archer.at`, `archer.startedAt`, and `archer.durationMs` retain Archer timing.

The adapter accepts explicit logger or destination ownership. Closing the sink
flushes only resources it owns. It never closes an injected borrowed logger or
destination. Pino types stay inside the adapter subpath.

## OpenTelemetry

The OpenTelemetry projection creates completed spans after terminal records
arrive. `startedAt` supplies wall-clock start, while `durationMs` supplies the
elapsed duration used to calculate the OpenTelemetry end time. `at` remains an
attribute so wall-clock adjustment cannot rewrite Archer's monotonic evidence.
Standalone events become zero-duration spans at `at`.

OpenTelemetry assigns its own trace and span IDs. The adapter never converts an
Archer UUID into a fabricated OpenTelemetry context. It retains Archer IDs as
attributes.

Child records normally settle before their parents. To preserve real
OpenTelemetry parentage, the adapter keeps a bounded pending graph keyed by
Archer `spanId`. When a root or an already-projected parent becomes available,
it creates the parent before its retained descendants and uses the real SDK
`SpanContext`. At a pending bound, flush, or close, unresolved records still
produce spans. They become roots with `archer.parent_span_id` and
`archer.parent_resolution = "missing"`. Bounds may reduce hierarchy fidelity;
they must not discard a diagnostic record.

Completed spans use OpenTelemetry `OK`, failed spans use `ERROR`, and abandoned
spans remain `UNSET` with their abandonment reason attached. Standalone error
events use `ERROR`; other events remain `UNSET`.

Namespaced context stays bounded by the core record. The adapter maps stable
record fields directly and encodes each context namespace as one JSON string
attribute instead of turning arbitrary nested keys into metric labels.

Tests use the real Pino and OpenTelemetry APIs. Recording streams and in-memory
SDK exporters are faithful boundaries for projection, timing, parentage,
ownership, flushing, and failure behavior.
