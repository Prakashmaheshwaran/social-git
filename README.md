# Social Git

Social Git is a self-hosted, library-backed gateway for managing multiple social accounts through owner-authorized web sessions.

The Reddit-first MVP will expose a stable REST API for account/session management, reads, and explicitly authorized interactions. Platform adapters use pinned protocol libraries; the production runtime does not use browser automation or official social-network APIs.

The integrated source tree contains the executable REST/MCP gateway, session runtime, durable action ledger, bounded live-authorization controls, Reddit protocol corpus, Core-owned Reddit session transport, isolated fixture worker, and reproducible runtime shell.

## Contract

`src/contract.ts` is the single typed operation registry. It generates:

- the OpenAPI 3.1 document at `openapi/social-git.openapi.json`;
- the REST route metadata used by `src/http.ts`;
- the MCP tool definitions used by `src/mcp.ts`.

The contract covers account registration, encrypted-session reference import and refresh, connection health, capability discovery, all planned Reddit reads, every planned Reddit write shape, action status and reconciliation, revocation, bounded audit history, and replay-safe adapter events.

All operations require a caller principal and an explicit scope. Applications inject authentication and can replace the default scope authorizer with their own policy hook. The connection contract accepts only an opaque one-time import handle. The executable runtime consumes the matching private file only after Core encrypts its session and route records. The API never returns the handle or raw session material.

The executable composition root is `src/main.ts`. It serves REST, MCP JSON-RPC at `POST /mcp`, liveness at `GET /healthz`, and dependency readiness at `GET /readyz`. It owns the sequential action worker and closes the HTTP server, adapters, Core runtime, authorization ledger, and action ledger on `SIGTERM` or `SIGINT`.

## Durable action rules

SQLite migrations create the account, connection, action, audit, and inbound-event records. Action idempotency is unique by caller and key, and the key is bound to a canonical request hash. The durable states are `queued`, `running`, `succeeded`, `failed`, `action_required`, and `UNKNOWN`.

A restart safely requeues work that stopped before submission. If submission might have started, recovery sets the action to `UNKNOWN`. The worker never retries an `UNKNOWN` action. The reconciliation operation asks the adapter to verify the result without resubmitting it.

Adapter events carry a version, source, event ID, account ID, timestamp, and size-bounded payload. Exact replays are no-ops; a repeated event ID with different content is rejected.

## Security policy package

`packages/security` implements the default-deny service roles and bounded live-test grants. Its SQLite ledger binds each approved grant and records every action before just-in-time secret lease issuance.

`BoundedLiveActionExecutor` is the only bounded-live write path. It derives the exact operation and resource checks from the persisted API action, commits a `PENDING` authorization action, marks submission in the API ledger, and only then asks `SessionRuntime` to decrypt material for one fenced worker command. A restart converts any incomplete authorization action and its API action to terminal `UNKNOWN` and stops the grant. Worker evidence is allowlisted, size-bounded, checked for secret-like values, and restricted to the platform's canonical hosts.

## Reddit adapter and worker boundary

The library-independent Reddit boundary and deterministic child-process fixture live in
`packages/reddit-adapter`. Run its suite with `npm test` from that directory.

The deny-by-default IPC, worker sandbox, fixed-egress broker, hostile-response,
and stop-circuit primitives live in `packages/worker-security`. Its deterministic
adversarial suite also runs with `npm test` from that directory.

`ProductionRedditAdapter` connects the public `PlatformAdapter` contract to one
Core-provisioned `RedditSessionTransport` per account, route, and generation.
The transport uses the admitted `reddit-lyr` route corpus and the pinned
Node.js HTTPS client. See
[`docs/reddit-session-transport-admission.md`](docs/reddit-session-transport-admission.md)
for its supply-chain disposition and remaining capability limits.

## Run the gateway

Requires Node.js 26.3.1. Runtime configuration is fail-closed and file based. Bearer tokens are configured as SHA-256 digests; master keys, audit keys, and live grants must be private regular files. See [the gateway runbook](docs/gateway-runbook.md) for exact file formats, environment variables, the one-time session import procedure, MCP examples, recovery, and production limitations.

```sh
npm start
```

Production starts without write dispatch when no bounded live grant is configured. In that state, reads and administrative operations remain available and every `social:write` request is denied. `SOCIAL_GIT_MODE=fixture` requires `NODE_ENV=test`; its fixture control routes do not exist in production mode.

## Development

Requires Node.js 26 or later. The TypeScript library has no third-party runtime package dependencies; the pinned development dependencies provide static checks.

```sh
npm run generate:openapi
npm run typecheck
npm run test:gateway
npm test
./scripts/test.sh
```

The executable gateway tests use the independent, isolated Reddit platform fixture. Other focused library tests retain the in-process mock where platform evidence is not under test. No automated test performs live social access or mutation.

## Explicitly unsupported

- In-service login, MFA, CAPTCHA, checkpoint, or session bootstrap; bootstrap is an external human-controlled process
- Proxy routes; the current production command dispatcher admits only the fixed direct Reddit route
- Reddit media submission and caller-owned comment deletion
- Polling or automatic retry of `UNKNOWN` writes
- Reddit chat, moderation, awards, collections, polls, and account settings
- LinkedIn, Instagram, YouTube, and other platform adapters
- Browser automation and official social-network API integrations

Those capabilities require separately admitted, source-reviewed adapters. The public API does not fabricate support for them.

## Runtime packaging

The browser-free core/worker container contract, development and production Compose files, deterministic source metadata, backup/restore commands, and CI-ready verification scripts are documented in [docs/packaging.md](docs/packaging.md). The release workflow reproduces the AMD64 and ARM64 images, inventories every transitive runtime component, emits digest-bound SPDX SBOMs, and rejects dependency or architecture drift against the committed review.
