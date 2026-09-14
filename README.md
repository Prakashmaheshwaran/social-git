# Social Git

Social Git is a self-hosted, library-backed gateway for managing multiple social accounts through owner-authorized web sessions.

The Reddit-first MVP will expose a stable REST API for account/session management, reads, and explicitly authorized interactions. Platform adapters use pinned protocol libraries; the production runtime does not use browser automation or official social-network APIs.

This branch contains the integrated session runtime, transport-independent REST/MCP contract, durable action ledger, and bounded live-authorization controls for the Reddit MVP.

## Contract

`src/contract.ts` is the single typed operation registry. It generates:

- the OpenAPI 3.1 document at `openapi/social-git.openapi.json`;
- the REST route metadata used by `src/http.ts`;
- the MCP tool definitions used by `src/mcp.ts`.

The contract covers account registration, encrypted-session reference import and refresh, connection health, capability discovery, all planned Reddit reads, every planned Reddit write shape, action status and reconciliation, revocation, bounded audit history, and replay-safe adapter events.

All operations require a caller principal and an explicit scope. Applications inject authentication and can replace the default scope authorizer with their own policy hook. The connection contract accepts only an opaque vault handle; the API never returns that handle or raw session material.

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

## Development

Requires Node.js 24 or later. The service has no runtime package dependencies; the pinned development dependencies provide static TypeScript checks.

```sh
npm run generate:openapi
npm run typecheck
npm test
```

The tests use only the in-process mock Reddit adapter. They perform no live social access or mutation.

## Explicitly unsupported

- Live Reddit protocol transport and live session bootstrap
- Polling or automatic retry of `UNKNOWN` writes
- Reddit chat, moderation, awards, collections, polls, and account settings
- LinkedIn, Instagram, YouTube, and other platform adapters
- Browser automation and official social-network API integrations

Those capabilities require separately admitted, source-reviewed adapters. The public API does not fabricate support for them.

## Runtime packaging

The browser-free core/worker container contract, development and production Compose files, deterministic source metadata, backup/restore commands, and CI-ready verification scripts are documented in [docs/packaging.md](docs/packaging.md). The release workflow reproduces the AMD64 and ARM64 images, inventories every transitive runtime component, emits digest-bound SPDX SBOMs, and rejects dependency or architecture drift against the committed review.
