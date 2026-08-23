# Diagnostic projections

This example gives one core `Diagnostics` hub ownership of both first-party
projection sinks. A single span accumulates context during work and emits one
terminal wide record. Pino receives that normalized record as structured JSON;
OpenTelemetry receives it as a real SDK span. Each adapter retains independent
delivery; the hub owns both sinks, while the application retains and later
closes the borrowed SDK provider lifecycle. The borrowed in-memory Pino
destination remains untouched by sink cleanup.

From the repository root:

```sh
pnpm exampleObservability
```

The example uses in-memory destinations so it runs without credentials,
network access, files, or ambient logging configuration.
