# Executable gateway runbook

## Runtime boundary

The `core` image role runs the Node.js composition root. The separate `worker`
role executes bounded Reddit commands. The isolated `x-worker` role exposes only
health/admission state and a fail-closed dispatch endpoint until its production
transport is admitted. Core exposes:

- `GET /healthz`: unauthenticated process liveness.
- `GET /readyz`: unauthenticated, versioned, non-secret dependency and worker readiness.
- `GET /openapi.json`: generated REST contract.
- `GET /v1/setup/status`, one-time `POST /v1/setup/owner`, and owner login/logout/session routes.
- API-key control-plane routes: owner-session authenticated; mutations also require CSRF.
- Other `/v1/*`: owner-session or scoped API-key authenticated REST operations.
- `POST /mcp`: bearer-authenticated MCP JSON-RPC operations.

The server accepts at most 16 KiB of request headers, 4,096 characters in the
request target, and 256 KiB in an ordinary JSON body. `media.create` and MCP
bodies have a 12 MiB envelope limit so one canonical base64 image can carry at
most 8 MiB of decoded bytes. Worker commands use the same 12 MiB envelope bound;
the decoded image is checked independently against the 8 MiB limit and digest.
Internal adapter-result events remain separately bounded and are not exposed as
a REST route, MCP tool, or API-key scope. The action worker dispatches one
action at a time and does not retry platform stops or `UNKNOWN` results.

## Required configuration

Use Node.js 26.3.1. Set these variables before `npm start`:

| Variable | Required value |
| --- | --- |
| `SOCIAL_GIT_MODE` | `production`; `fixture` is accepted only with `NODE_ENV=test`. |
| `SOCIAL_GIT_DATA_DIR` | Absolute private directory. The runtime creates it with mode `0700` when absent. |
| `SOCIAL_GIT_MASTER_KEY_FILE` | Absolute `0600` file containing one canonical base64url-encoded 32-byte key. |
| `SOCIAL_GIT_AUDIT_KEY_FILE` | Absolute `0600` file containing a different canonical base64url-encoded 32-byte key. |
| `SOCIAL_GIT_BACKUP_KEY_FILE` | Absolute `0600` file containing a third, independent canonical base64url-encoded 32-byte key. Core alone receives it. |
| `SOCIAL_GIT_AUTH_FILE` | Optional absolute `0600` legacy authentication file for migration-era service bearer tokens. |
| `SOCIAL_GIT_SESSION_IMPORT_DIR` | Production only. Absolute existing `0700` directory for one-time import files. |
| `SOCIAL_GIT_REDDIT_WORKER_URL` | Internal worker endpoint. Production Compose sets `http://reddit-worker:8081/v1/dispatch`. |
| `SOCIAL_GIT_X_WORKER_URL` | Internal candidate endpoint. Production Compose sets `http://x-worker:8082/v1/dispatch`; dispatch remains fail-closed while X production is disabled. |

Optional values are `SOCIAL_GIT_HOST` (default `127.0.0.1`), `SOCIAL_GIT_PORT` (default `8080`), `SOCIAL_GIT_TENANT_ID`, `SOCIAL_GIT_LEDGER_ID`, `SOCIAL_GIT_WORKER_INTERVAL_MS` (default `250`), `SOCIAL_GIT_LIVE_GRANT_FILE`, and `SOCIAL_GIT_SESSION_COOKIE_SECURE` (defaults to `true` in production and `false` in fixture mode).

The owner Settings page and encrypted backup CLI use the same separate Core-only backup key. `GET /v1/control-plane/backups` and `POST /v1/control-plane/backups` accept only an owner browser cookie; creation additionally requires the fresh, in-memory CSRF proof. API keys cannot access these routes. Core generates every bounded backup-set ID and filesystem path, serializes creation, pauses request and background writers, and captures the tenant-bound sessions, ledger-bound actions, and tenant-bound identity databases under one expiry. The browser receives metadata only. Expired sets are removed at the 30-day retention boundary. Restore remains an offline operator action.

`GET /v1/control-plane/upgrades/status` is owner-only and read-only. It reports that the release channel is manual. No remote release check, image pull, update execution, or automatic upgrade endpoint exists.

The authentication file contains only token digests, caller IDs, and scopes:

```json
{
  "version": 1,
  "principals": [
    {
      "tokenSha256": "<64 lowercase hex characters>",
      "callerId": "operator-service",
      "scopes": ["accounts:write", "accounts:read", "connections:write", "connections:read", "social:read", "social:write", "actions:read"]
    }
  ]
}
```

This file is retained for migration and break-glass compatibility. New service integrations should use an owner-created tenant API key. Compute a legacy token digest outside the configuration file. Do not put any bearer token, social session, or route value in the repository, logs, or issue tracker.

## First-run owner and browser sessions

A new data directory has no user and no default password. `GET /v1/setup/status`
returns `{"required":true}` until exactly one initial owner is created with
`POST /v1/setup/owner`. The request requires JSON `email`, `displayName`, and a
12-256 character password containing letters and a non-letter. The creation is
transactional, and every later setup attempt is rejected.

Passwords are stored as salted scrypt hashes. Browser session and CSRF values
are random 256-bit values; only their SHA-256 digests are stored. The session
cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` in production by default.
Login responses return the CSRF token once; send it as `X-CSRF-Token` on every
state-changing API request made with the browser cookie. Login failures use one
generic error. `POST /v1/auth/logout` requires both the cookie and CSRF token
and revokes the server-side session.

Before the deliberately expensive password derivation, login requests pass two
bounded, expiring, fail-closed per-process failure buckets: five failures for a
SHA-256-keyed socket-address plus normalized account identifier, and 30
failures for the socket address independent of the identifier. A successful
login clears only its narrow account bucket; it cannot erase coarse
identifier-rotation evidence. Limited requests return `429`, `Retry-After`, and
`X-RateLimit-*` metadata without deriving a password. The runtime deliberately
does not trust `X-Forwarded-For` or similar headers without an explicit trusted
proxy boundary. Consequently, Coolify and other reverse proxies may present one
socket address for multiple clients and share the coarse 30-failure budget;
operators should monitor 429s and use an upstream trusted edge limiter for
larger multi-user deployments, without disabling the in-process controls.

The owner, sessions, and identity audit trail live in `identity.sqlite` under
the private data directory. They are bound to `SOCIAL_GIT_TENANT_ID`; the same
tenant is also bound into Core's encrypted social-session envelopes. A caller
claiming a different tenant is rejected before account data is read.

## Tenant API keys

Only an authenticated owner browser session can manage API keys. Send the
session cookie and `X-CSRF-Token` to create, revoke, or rotate a key:

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/v1/control-plane/api-keys" \
  -H 'Content-Type: application/json' \
  -H "Cookie: social_git_session=<owner-session>" \
  -H "X-CSRF-Token: <owner-csrf>" \
  --data '{"name":"automation","scopes":["accounts:read","social:read"]}'
```

The create and rotate responses return `secret` exactly once. It has the form
`sgk_<non-secret-prefix>_<secret>`; store it in the calling service's secret
manager. Social Git stores only the SHA-256 digest. `GET
/v1/control-plane/api-keys` returns active keys and a safe `sgk_<prefix>_`
display value, scopes, creation time, and last-use time, never the secret or its
digest. Rotation atomically revokes the old key before creating its replacement.
Revocation takes effect on the next request.

Use a key as the bearer credential for REST or MCP:

```sh
curl -sS "$SOCIAL_GIT_URL/v1/accounts" \
  -H "Authorization: Bearer $SOCIAL_GIT_API_KEY"
```

Allowed API-key scopes are `accounts:read`, `accounts:write`,
`connections:read`, `connections:write`, `social:read`, `social:write`,
`actions:read`, `audit:read`, `webhooks:read`, and
`webhooks:write`. Wildcard and fixture-control
scopes cannot be issued. Successful authentication updates `lastUsedAt`; key
creation, rotation, and revocation append tenant-bound identity audit events.
API-key requests always use a bounded, expiring, fail-closed per-process default
of 300 authenticated requests per key per minute. Programmatic deployments can
replace it by passing `apiKeyRateLimit` to `startSocialGitRuntime`; the hook
receives only bounded key metadata, never the secret, and can return standard
rate-limit metadata. Missing hooks no longer mean unlimited access, and invalid
custom hook output fails closed with a bounded 429 response.

## One-time Reddit session import

The connection API accepts a safe import ID, not session bytes. Before the API call, an authorized session custodian places `<import-id>.json` in `SOCIAL_GIT_SESSION_IMPORT_DIR` with mode `0600`:

```json
{
  "sessionBase64": "<canonical base64url of the session JSON>",
  "networkRoute": {
    "id": "direct-reddit-route-1",
    "materialBase64": "<canonical base64url of {\"kind\":\"direct\"}>"
  }
}
```

The decoded session JSON has this bounded shape:

```json
{
  "cookies": { "reddit_session": "<value>" },
  "csrfToken": "<value>",
  "userAgent": "<optional fixed value>"
}
```

Then register and connect the account:

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/v1/accounts" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"platform":"reddit","expectedNativeUserId":"reddit:t2_expected"}'

curl -sS -X POST "$SOCIAL_GIT_URL/v1/accounts/<account-id>/connections" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"vaultHandle":"<import-id>","generation":1}'
```

Core encrypts distinct session and route envelopes with tenant, purpose, account, platform, schema, and generation binding and fresh nonces. Only after that durable import succeeds does the source file get deleted. Identity validation then runs through a fenced Core command. If validation fails, the imported generation is revoked and its Core ciphertext is removed.

For a refresh, stage a new import ID and use the next exact generation through the explicit refresh route. A stale or skipped generation fails closed:

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/v1/accounts/<account-id>/connection/refresh" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"vaultHandle":"<new-import-id>","generation":2}'
```

The matching MCP tool is `social_connections_refresh`.

## Publication and status

Every write needs `social:write` and a caller-scoped idempotency key. In normal production, admitted Reddit actions execute through the isolated worker without a QA grant:

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/v1/accounts/<account-id>/actions" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN" \
  -H 'Idempotency-Key: publish-2026-09-14-001' \
  -H 'Content-Type: application/json' \
  --data '{"kind":"text_post","subreddit":"example","title":"Title","text":"Body"}'

curl -sS "$SOCIAL_GIT_URL/v1/actions/<action-id>" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN"
```

A repeated caller/key with identical account and input returns the same action. Different input or a different account returns `IDEMPOTENCY_CONFLICT`. On restart, pre-submit work returns to `queued`; work whose submission might have started becomes `UNKNOWN`. The runtime never submits an `UNKNOWN` action again. `POST /v1/actions/<action-id>/reconcile` is read-only and can leave the action unresolved.

Challenge, checkpoint, CAPTCHA, wrong-identity, and revoked-session outcomes stop the Core account. If an optional bounded certification grant selected the action, they also stop that grant. They are not retried. Replace the session only after a separately authorized human completes the platform action.

For an image post, stage the bytes in Core first. This endpoint accepts JPEG,
PNG, GIF, or WebP only and returns a caller- and account-bound `core-media:`
reference. It never returns the bytes:

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/v1/accounts/<account-id>/media" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"filename":"canary.png","mimeType":"image/png","dataBase64":"<canonical-base64>"}'

curl -sS -X POST "$SOCIAL_GIT_URL/v1/accounts/<account-id>/actions" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN" \
  -H 'Idempotency-Key: publish-media-2026-09-14-001' \
  -H 'Content-Type: application/json' \
  --data '{"kind":"media_post","subreddit":"example","title":"Title","mediaRef":"core-media:<uuid>"}'
```

Core durably records `reserved`, `leased`, `uploaded`, `submitting`,
`submitted`, and `processed`. Lease and upload failures occur before the submit
boundary. Core records `submitting` before the one allowed Reddit submit call.
Any later disconnect, crash, malformed result, or processing timeout is
`UNKNOWN` and must not be submitted again. Success requires the native post ID
and canonical URL.

Caller-owned comment deletion uses the normal `delete` action with a `t1_`
target. The worker performs an exact bounded author read and compares it with
the validated expected identity. A foreign, missing, or malformed author is
denied before deletion is submitted.

## MCP

The MCP endpoint supports `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call` over JSON-RPC 2.0. It uses the same bearer principal, scopes, dispatcher, action ledger, and normalized errors as REST.

```sh
curl -sS -X POST "$SOCIAL_GIT_URL/mcp" \
  -H "Authorization: Bearer $SOCIAL_GIT_CALLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"social_action_get","arguments":{"actionId":"<action-id>"}}}'
```

The same generated registry exposes webhook subscription and delivery tools.
Webhook secrets remain Core-only and are returned only by idempotent create or
rotate calls. See [API, MCP, and webhook contract](api-contract.md).

## Optional bounded certification authorization

Without `SOCIAL_GIT_LIVE_GRANT_FILE`, production uses the normal product path. `/readyz` reports `actionWorker: true`, `productWritesReady: true`, `certificationGrantActive: false`, and `writeExecutionMode: "product"`. These fields prove that Core's durable action path is active; in the default Compose stack, the separate worker health dependency additionally proves that the private command endpoint is ready.

The version 1 readiness detail under `checks` is the operational source of
truth. `databases` compares current and expected action/session/identity
migrations; `workers` separates the two background writers from Reddit and X
network-worker reachability; `maintenance` shows whether an owner backup has
paused admission; and `backlog` returns only capped counts. A required failure
returns 503. X remains `capability_disabled` until every admission gate passes,
so its worker reachability is visible but optional and cannot be mistaken for
live platform support. Do not alert on X admission reasons as if they were a
Core outage; do alert on an unexpected unreachable X candidate if the complete
Compose topology is part of the deployment SLO.

When `SOCIAL_GIT_LIVE_GRANT_FILE` is present, `/readyz` reports `certificationGrantActive: true` and `writeExecutionMode: "product_with_certification"`. The private grant file contains `version: 1`, an `actors` object with distinct `qaOperatorId`, `approverId`, and `coreActorId`, and a `grant` object accepted by `approveLiveTestGrant`. Only the exact canary account, admitted operation, session generation, route, identity, and resource constraints enter this lane. Other accounts continue through the product adapter; an action targeting the canary but violating the grant fails closed instead of bypassing certification. X actions never enter the Reddit grant, and X remains unavailable in production until its adapter capabilities are independently admitted.

The grant must bind the ledger ID, deployment environment, artifact, SBOM and test-evidence digests, exact canary account, expected identity, session generation, route, exact operations, resource bounds, action limit, and validity interval. Examples are `reddit.post.text.create` and `reddit.post.media.create`; each operation must be named explicitly. A grant file is an operator certification artifact; do not synthesize one in an ordinary service run.

## Shutdown and recovery

Send `SIGTERM` or `SIGINT`. The runtime stops accepting requests, waits for the current sequential action, closes adapters, closes the authorization and Core stores, and then closes the action ledger.

After an unclean stop:

1. Start with the same data directory, tenant ID, ledger ID, master key, and audit key.
2. Check `/readyz`.
3. Inspect action status through REST or MCP.
4. Do not submit another write for an `UNKNOWN` action. Use explicit reconciliation only.
5. If Core reports challenge, wrong identity, revocation, rate limit, or protocol drift, leave dispatch stopped and escalate to the authorized session or release owner.

## Unsupported capability list

- LinkedIn, Instagram, YouTube, and every non-Reddit adapter.
- Social-platform password login, MFA handling, CAPTCHA solving, checkpoint handling, and session bootstrap.
- Browser, CDP, Playwright, Selenium, Chromium, or visible/headless automation in the service runtime.
- Official Reddit API integration.
- Proxy routes, proxy rotation, fingerprint spoofing, and rate-limit evasion. Only the fixed direct Reddit route is admitted.
- Automatic retry or polling of `UNKNOWN` writes.
- Automatic recovery after a challenge, checkpoint, CAPTCHA, suspicious-activity response, wrong identity, revocation, or protocol drift.
- Reddit chat, moderation, awards, collections, polls, and account settings.
- Live acceptance from fixture results. Fixture mode is deterministic test evidence only.

The release image contains both executable roles. Core is UID/GID `10001:10001`; Reddit worker is UID/GID `10002:10002` and receives no state or secret mount. See `docs/packaging.md` for the immutable image, backup, attestation, and smoke-check commands.
