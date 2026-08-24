# Observe an HTTP service

This application exposes `POST /count` and returns the number of
whitespace-delimited words in a JSON `text` value. It is an ordinary long-lived
Node HTTP service with an explicit shutdown path.

Each successful `/count` request accumulates method, route, body size, response
status, and word count in one wide diagnostic span. Refused routes and inputs
retain the context applicable to their settlement. Every terminal record goes
independently to structured Pino output and a real OpenTelemetry SDK. The
example uses console exporters so no collector account is required, but the
provider lifecycle is the same one a Datadog, Prometheus, or OTLP deployment
would own.

Start the service from the repository root:

```sh
pnpm example:observability
```

Then run the printed `curl` command. `PORT` selects a different listener port.
Pino writes newline-delimited JSON to stderr. OpenTelemetry prints completed
spans and periodic metrics through its console exporters. `Ctrl-C` stops HTTP
admission, drains diagnostic queues, and shuts down both SDK providers.

Copy `startWordCountService()` when instrumenting an existing Node server. The
important part is mechanical: open a span at request admission, enrich it as
facts become known, settle it once, and let independent sinks project the
normalized record. Logging calls never decide the HTTP response.
