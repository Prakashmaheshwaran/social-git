# Control-plane web application

The web UI is a zero-runtime-dependency ES module application served by Core at
`/app/`. Owner authentication uses the server's HttpOnly, SameSite cookie with
`fetch` credentials set to `same-origin`. The CSRF value returned at setup or
login is retained only in the client's private in-memory field and attached to
mutating requests; no session or cookie material enters browser storage. The UI
ships in the existing runtime image. `npm run typecheck:web` validates its
JSDoc contracts under strict TypeScript settings.

The same release image serves a dependency-free interactive OpenAPI explorer at
`/docs/`. Its HTML, CSS, and ES modules are local assets covered by the existing
`default-src 'self'` CSP. It fetches only `/openapi.json`, derives every
operation and availability badge from generated extensions, and never persists
an API key. The request runner is available only for bearer-key operations; X
fixture-only operations remain inspectable but cannot be sent.

## Live REST surface

The dashboard, multi-account directory, platform-aware registration, Reddit
connection/refresh/revocation, per-account capability discovery, X platform
admission catalog, audit trail, durable action lookup and UNKNOWN reconcile,
invitation acceptance, webhook subscriptions and delivery history, health
status, first-run owner setup, login, session inspection, and logout use the
committed REST/OpenAPI operations directly.

Reddit onboarding accepts one explicitly exported `.json` file at
`POST /v1/control-plane/accounts/{accountId}/reddit-session`. The route requires
the HttpOnly owner cookie, the current in-memory CSRF value, and a same-origin
browser request; API keys and bearer tokens are rejected. The browser sends the
bounded file directly and never stores it in local or session storage. Core
allowlists the exact schema, checks the immutable expected native identity,
encrypts the session directly into custody, verifies the live identity, and
wipes its request buffers. It never reads browser cookies, accepts a Reddit
password, stages plaintext on disk, or echoes secret values.

X identities may be registered and the owner may upload one exact four-field
session export at `POST /v1/control-plane/accounts/{accountId}/x-session`. Core
encrypts `auth_token` and `ct0` directly into generation-bound custody. The web
application reads the machine-readable X capability catalog and displays every
admission reason. While `productionEnabled` is false, the upload returns `202`,
persists `action_required`, and performs no identity or platform request; read,
write, and messaging controls remain unavailable. Fixture contracts and a
candidate transport are not represented as live production support.

The identity endpoints are:

- `GET /v1/setup/status`
- `POST /v1/setup/owner`
- `POST /v1/auth/login`
- `GET /v1/auth/session`
- `POST /v1/auth/logout`

After a page reload, the HttpOnly cookie can restore read access but the CSRF
value is deliberately gone. The UI disables changes and asks the owner to
confirm their password, creating a fresh cookie/CSRF pair without weakening the
server contract or persisting the CSRF value.

## Control-plane route handling

Instance backup, upgrade, API-key, invitation, webhook, and reconcile routes are
implemented server-side; see `src/identity.ts` and `src/owner-operations.ts`. The
client still isolates them behind `SocialGitClient`, and a `404` becomes a
visible `ControlPlaneUnavailableError` rather than fabricated production data, so
an older or partial server build degrades honestly instead of rendering invented
records. The routes the client calls at that boundary are:

- `GET|POST /v1/control-plane/api-keys`
- `POST /v1/control-plane/accounts/{accountId}/reddit-session`
- `POST /v1/control-plane/accounts/{accountId}/x-session`
- `POST /v1/control-plane/api-keys/{apiKeyId}/revoke`
- `POST /v1/control-plane/api-keys/{apiKeyId}/rotate`
- `POST /v1/invitations/accept`
- `GET|POST /v1/webhooks/subscriptions`
- `POST /v1/webhooks/subscriptions/{subscriptionId}/rotate-secret`
- `POST /v1/webhooks/subscriptions/{subscriptionId}/disable`
- `GET /v1/webhooks/deliveries`
- `POST /v1/actions/{actionId}/reconcile`
- `GET|POST /v1/control-plane/backups`
- `GET /v1/control-plane/upgrades/status`

The backup and upgrade routes are served by the owner-operations handler and are
not part of the generated OpenAPI document, so a deployment that omits that
handler surfaces the same `ControlPlaneUnavailableError` as a build with older
API-key routes.

Views do not depend on transport details.

## Verification

`npm run test:web` uses an injected deterministic Fetch implementation and pure
HTML rendering tests, including copy-safe API examples, exact X admission
reasons, reconnect/refresh generation handling, UNKNOWN no-resubmit guidance
with verify-only reconcile, one-time API-key rotation and webhook signing
secrets, paste-only invitation acceptance, and responsive/accessibility markup.
`test/http.test.ts` verifies Core routing,
asset types, HEAD behavior, CSP, and that the `/v1` API namespace still reaches
API routing. `test/runtime-e2e.test.ts` smoke-tests the same assets and X
admission catalog from a production-mode runtime.
