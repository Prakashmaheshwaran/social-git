# API, MCP, and webhook contract

Social Git exposes one versioned operation registry through REST (`/v1`),
OpenAPI 3.1 (`/openapi.json` and `openapi/social-git.openapi.json`), and MCP
JSON-RPC (`POST /mcp`). Reddit and X operations use the same tenant principal,
scope checks, error envelope, request IDs, pagination, and durable action
semantics. The committed OpenAPI document is suitable for client generation and
is checked with `npm run validate:openapi`.

The self-hosted interactive explorer is served at `/docs/` from local release
assets. It reads this same OpenAPI document, exposes validated request/response
examples, and reflects `x-social-git-platform`, `x-social-git-availability`, and
`x-social-git-disabled-reasons`. It does not load a CDN or hosted runtime.

## Authentication and common response behavior

Use an owner-created tenant API key as a bearer token. Each operation declares
its exact scope as `x-required-scope` in OpenAPI. A principal whose `tenantId`
does not match the runtime tenant is rejected before resource lookup.

Browser sessions and API keys also carry an explicit `workspaceId`, which is
always the installation's primary `tenantId`. Social Git currently supports one
data workspace with multiple local owner/admin/member identities; it does not
expose secondary-workspace creation or switching over REST, MCP, or the web UI.
One-time invitations and the last-owner guard are documented in
[Local identity and RBAC](local-identity-rbac.md).

Every HTTP response has `X-Request-ID`. Errors use this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "A safe public message.",
    "requestId": "request-correlation-id",
    "retryable": false
  }
}
```

List responses contain `items` and an opaque `nextCursor`. When another page
exists, REST also returns `X-Next-Cursor`. Pass that value as `cursor`; do not
parse or construct cursors. Limits are bounded from 1 through 100.

Every social mutation and every operation that can create or rotate secret
material requires `Idempotency-Key`. Exact replays return the same logical
result and `Idempotency-Replayed: true`; reusing a key with different input
returns `IDEMPOTENCY_CONFLICT`. An SDK should persist a key until the caller has
received a response and should never generate a replacement key merely because
an HTTP request timed out.

Owner session uploads are deliberately outside bearer/API-key authentication.
`POST /v1/control-plane/accounts/{accountId}/reddit-session` and
`POST /v1/control-plane/accounts/{accountId}/x-session` require the signed-in
owner's HttpOnly cookie, fresh in-memory `X-CSRF-Token`, and
`Sec-Fetch-Site: same-origin`. The X body has exactly `platform`,
`expectedNativeUserId`, `auth_token`, and `ct0`. Until X production admission,
that route returns `202 X_TRANSPORT_NOT_ADMITTED` after encrypted custody and
persists `action_required`; it makes no X request and creates no active
connection.

## Reddit and X examples

The X routes below document the stable contract only. The current production X
adapter is fail-closed and returns machine-readable admission reasons until its
endpoint-currentness, transaction-header, and authorized live identity/read/write
gates pass. Contract or fixture coverage is not a claim of production support.

```sh
curl -sS "$SOCIAL_GIT_URL/v1/accounts/$ACCOUNT_ID/feed?limit=25" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY"

curl -sS "$SOCIAL_GIT_URL/v1/accounts/$ACCOUNT_ID/x/timelines/home?limit=25" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY"

curl -sS "$SOCIAL_GIT_URL/v1/accounts/$ACCOUNT_ID/x/users/$X_USER_ID/followers?limit=25" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY"

curl -sS "$SOCIAL_GIT_URL/v1/accounts/$ACCOUNT_ID/x/lists/$X_LIST_ID/timeline?limit=25" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY"

curl -sS -X POST "$SOCIAL_GIT_URL/v1/accounts/$ACCOUNT_ID/x/actions" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: x-post-20260917-001' \
  --data '{"kind":"x_post_create","text":"Hello from Social Git"}'
```

Writes return `202` with a durable action. Poll `GET /v1/actions/{actionId}` or
subscribe to action webhooks. `UNKNOWN` is terminal until explicit reconcile;
Social Git never retries or resubmits an unknown social mutation.

List caller-visible actions with `GET /v1/actions`; filters include `callerId`
(owner only), `accountId`, `state`, and `kind`, followed by the same opaque
cursor rules used by other lists. An API key is always restricted to its own
caller identity. A queued action can be terminally cancelled before dispatch:

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/v1/actions/$ACTION_ID/cancel" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: cancel-action-001' \
  --data '{}'
```

Cancellation and worker claim are one durable race: whichever commits first
wins. Once claimed, once submission might have started, or after any terminal
state including `UNKNOWN`, cancellation is rejected. Replaying the original
action idempotency key returns the same cancelled or terminal record and never
creates a replacement submission.

`GET /v1/usage` requires `usage:read` and accepts `since`, `until`,
`accountId`, `operationId`, and a comma-separated `groupBy` made from
`tenant,key,account,operation`. Results are bounded to 100 aggregate rows and
90 days of retained dimensional counters. Usage records contain no request
body, result body, cookies, tokens, CSRF values, session handles, or social
content. Non-owner API keys can read only their own counters and cannot group
by key identity.

The equivalent MCP call uses the registry-generated tool name and the same
scope and idempotency rules:

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/mcp" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x_action_create","arguments":{"accountId":"'$ACCOUNT_ID'","idempotencyKey":"x-post-20260917-001","action":{"kind":"x_post_create","text":"Hello from Social Git"}}}}'
```

## Signed webhooks

Create a tenant subscription with a key that has `webhooks:write`. HTTPS is
required. The signing secret is generated by Core, encrypted at rest with a
purpose-derived key, and returned in the idempotent create response; it is never
included in listings, delivery records, logs, audit data, or backups as
plaintext.

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/v1/webhooks/subscriptions" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: webhook-primary-001' \
  --data '{"url":"https://receiver.example/hooks/social-git","eventTypes":["action.queued","action.succeeded","action.failed","action.action_required","action.UNKNOWN"]}'
```

Each delivery is a canonical JSON envelope:

```json
{
  "version": 1,
  "id": "event-uuid",
  "type": "action.succeeded",
  "occurredAt": "2026-09-17T12:00:00.000Z",
  "data": {
    "actionId": "action-uuid",
    "accountId": "account-uuid",
    "kind": "x_post_create",
    "state": "succeeded",
    "submissionMayHaveStarted": true
  }
}
```

Verify `X-Social-Git-Signature` before parsing or processing the body. Its value
is `v1=` plus the lowercase hex HMAC-SHA256 of the exact UTF-8 string
`<event-id>.<unix-timestamp>.<raw-body>`. Also require the event ID header to
match the body, reject timestamps outside a five-minute window, and retain
processed event IDs so a repeated delivery is a no-op. Compare signatures with
a constant-time function.

Delivery retries reuse the same event ID and body. Core records every attempt,
uses exact claim-token fencing, and retries only webhook HTTP notification on a
bounded 5-second, 30-second, 5-minute, and 30-minute schedule. After five total
attempts the delivery is `exhausted`. Redirects and permanent 4xx responses are
not retried. This worker never invokes or retries a Reddit or X mutation.

The delivery client accepts HTTPS only, resolves each hostname once, rejects
the entire answer set if any address is private, loopback, link-local,
metadata, mapped, multicast, documentation, or otherwise reserved, and pins a
verified public address into the TLS connection while retaining the configured
hostname for certificate verification. It does not consume proxy environment
variables or follow redirects. DNS plus delivery share a five-second deadline,
and response bodies are capped at 64 KiB.

Inspect delivery history without secret material:

```sh
curl -sS "$SOCIAL_GIT_URL/v1/webhooks/deliveries?subscriptionId=$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY"
```

Rotate with `POST /v1/webhooks/subscriptions/{id}/rotate-secret` and an
`Idempotency-Key`; disable with `POST
/v1/webhooks/subscriptions/{id}/disable`. Rotation changes the
`X-Social-Git-Signing-Key-ID` generation. A receiver can retain the prior key
briefly while in-flight deliveries drain.

## Generate an SDK

Fetch or use the committed specification, then run a generator that supports
OpenAPI 3.1. For example:

```sh
npx @openapitools/openapi-generator-cli generate \
  -i openapi/social-git.openapi.json \
  -g typescript-fetch \
  -o generated/social-git-typescript
```

Generated output is intentionally not committed. CI should run
`npm run generate:openapi`, `npm run validate:openapi`, and fail if the working
tree changes. Treat the `operationId` values as stable SDK method identities;
MCP names are available as `x-mcp-tool` for clients that expose both surfaces.

## Adding platform operations

Add each operation once to `OPERATIONS` in `src/contract.ts`, then add its
dispatcher implementation. REST metadata, OpenAPI, and MCP tools are generated
from that registry. Add outbound event types to `WEBHOOK_EVENT_REGISTRY` and
emit a source-keyed event after the durable state transition. Source keys make
re-emission idempotent, so later Reddit/X contract merges do not require
hand-written REST or MCP registration.
