# Product-reset keep, replace, delete map

Document version: 1.0.0
Status: accepted implementation map.

| Decision | Area | Action and rationale |
| --- | --- | --- |
| KEEP | Core custody and action ledger | Preserve encrypted account/generation/route binding, caller-scoped idempotency, claim fencing, audit, and UNKNOWN semantics. |
| KEEP | Reddit direct-session adapter | Preserve the reviewed source corpus, bounded standard-HTTP transport, normalizers, isolated worker, and admitted capability registry. |
| KEEP | REST/OpenAPI/MCP registry | Preserve `src/contract.ts` as the public operation source and validate every generated artifact against it. |
| KEEP | Deterministic acceptance | Preserve fixture, restart, crash-after-submit, protocol-drift, secret-redaction, image and Compose evidence. |
| KEEP | Local control plane | Preserve owner-only same-origin UI, HttpOnly cookie handling, memory-only CSRF, and no browser session material. |
| REPLACE | Raw JSON documentation link | Make `/docs/` the primary API link while retaining `/openapi.json` as the machine contract. Serve all explorer assets locally under the release CSP. |
| REPLACE | Hand-written parity summaries | Generate the capability matrix from adapter registries and validate product docs against OpenAPI/capability truth. |
| REPLACE | Best-effort platform labels | Show exact production, fixture-only, live-gate, and unsupported states from machine sources. |
| DELETE | Browser-runtime assumptions | Remove Playwright/Selenium/Chromium/CDP from production architecture and documentation. |
| DELETE | Silent or broad write retries | Writes are single-attempt; ambiguous outcomes become UNKNOWN and require read-only reconciliation. |
| DELETE | Hosted UI assets | Do not load API documentation JavaScript, CSS, fonts, analytics, or schemas from a CDN. |
| DELETE | Unsupported parity claims | Do not expose Reddit moderation/messaging/comment expansion or X live behavior until admitted and proven. |

## Drift rule

`npm run validate:product-docs` fails when a capability gains or loses a public
mapping, the generated matrix is stale, required documents lose versioning, or
the documents overstate X availability. Contract changes must update code,
generated OpenAPI/examples, and this decision set in one reviewed change.
