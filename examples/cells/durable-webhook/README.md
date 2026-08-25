# Send customer webhooks that survive a restart

SaaS products often need to send events such as `invoice.paid` to a customer's
HTTP endpoint. The first request may fail. Your service may restart before the
next attempt. The customer still expects the event.

This application accepts an event, signs it, sends it to the customer's URL,
and provides a live status stream. It saves unfinished deliveries in S3, so a
new process can continue them without a queue or database server.

The walkthrough runs two real HTTP servers:

- a customer endpoint that verifies the signature and returns `503` twice; and
- the delivery API that retries the request and reports each saved status.

## What you need

- an existing S3 bucket;
- AWS credentials available through the standard AWS SDK credential chain; and
- a signing secret for this walkthrough.

Archer uses the same AWS profiles, SSO sessions, environment credentials,
workload roles, and web identity configuration as other AWS SDK applications.

## 1. Start the customer endpoint

In the first terminal:

```sh
export ARCHER_WEBHOOK_SIGNING_SECRET="local-demo-secret"
pnpm example:cells:webhook -- receiver
```

It prints this destination:

```text
http://127.0.0.1:4318/customer-webhooks
```

The endpoint rejects the first two valid requests for each delivery on purpose.
Each request is printed with its event name, delivery ID, attempt number, and
returned status.

## 2. Start the delivery API

In the second terminal:

```sh
export ARCHER_WEBHOOK_SIGNING_SECRET="local-demo-secret"
export ARCHER_WEBHOOK_BUCKET="my-existing-bucket"
export AWS_REGION="us-west-2"
pnpm example:cells:webhook -- service
```

For an S3-compatible service, set `ARCHER_S3_ENDPOINT`. Set
`ARCHER_S3_FORCE_PATH_STYLE=true` if the service requires path-style URLs.

The API listens at `http://127.0.0.1:4317`. Open
`http://127.0.0.1:4317/docs` to explore the generated API documentation, or use
`http://127.0.0.1:4317/openapi.json` with your own client tooling.

## 3. Send an application event

```sh
curl -i http://127.0.0.1:4317/deliveries \
  -H 'content-type: application/json' \
  -d '{
    "url":"http://127.0.0.1:4318/customer-webhooks",
    "event":"invoice.paid",
    "data":{"invoiceId":"inv_42","amount":4200}
  }'
```

The API returns `202 Accepted`, a delivery ID, and two useful links:

- `Location` reads the latest saved status; and
- `Link` points to a Server-Sent Events stream for live updates.

Use the returned ID to watch the delivery:

```sh
curl -N http://127.0.0.1:4317/deliveries/<delivery-id>/events
```

You will see `delivering`, `waiting`, and finally `delivered`. The customer
terminal shows two `503` responses followed by `204`.

The process that owns a delivery pushes status from its live handle. If a load
balancer sends the stream request to another process, this example checks S3
once per second so the stream still works. At high volume, route streams by
delivery owner or replace that fallback with your shared notification system;
one S3 read per client per second is deliberately visible here, not a free
production guarantee.

## 4. Try a restart

Submit another event, then stop the delivery API after the customer endpoint
returns its first `503`. The next attempt waits ten seconds, so there is time to
press Ctrl-C. Start the service again with the same environment variables. It
finds the unfinished delivery in S3 and continues the remaining attempts.
Reconnect the status `curl` with the same delivery ID.

## What to copy

- [`src/domain.ts`](src/domain.ts) contains the delivery statuses and retry rules.
- [`src/delivery.ts`](src/delivery.ts) signs and sends the real HTTP request.
- [`src/application.ts`](src/application.ts) provides `submit`, `status`,
  `watch`, and `recover` methods to the HTTP routes.
- [`src/api.ts`](src/api.ts) generates OpenAPI from the same request schema used
  by the running service.
- [`src/main.ts`](src/main.ts) configures S3 through the trusted-service
  `s3Cells()` path.

The signing secret never enters the saved delivery. The receiver gets
`Webhook-Signature`, `Webhook-Event`, `Webhook-Id`, and `Idempotency-Key`
headers. A receiver should deduplicate `Idempotency-Key` because a request can
reach it even if the sender restarts before saving the response.

Each customer request stops waiting after fifteen seconds. Network failures,
timeouts, `408`, `425`, `429`, and `5xx` responses are retried. Other `4xx`
responses fail immediately because repeating the same request is unlikely to
help. Change those choices in [`src/delivery.ts`](src/delivery.ts) to match your
product.

This example accepts caller-selected URLs so you can run it locally. A public
service must add authentication, URL allowlists or egress policy, quotas, and
request filtering before exposing the submission route to untrusted callers.
