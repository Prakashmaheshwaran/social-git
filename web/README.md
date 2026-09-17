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
admission catalog, audit trail, durable action lookup, health status, first-run
owner setup, login, session inspection, and logout use the committed
REST/OpenAPI operations directly.

Reddit onboarding accepts one explicitly exported `.json` file at
`POST /v1/control-plane/accounts/{accountId}/reddit-session`. The route requires
the HttpOnly owner cookie, the current in-memory CSRF value, and a same-origin
browser request; API keys and bearer tokens are rejected. The browser sends the
bounded file directly and never stores it in local or session storage. Core
allowlists the exact schema, checks the immutable expected native identity,
encrypts the session directly into custody, verifies the live identity, and
wipes its request buffers. It never reads browser cookies, accepts a Reddit
password, stages plaintext on disk, or echoes secret values.

X identities may be registered for inventory. The web application reads the
machine-readable X capability catalog and displays every admission reason, but
does not offer connection or action controls while `productionEnabled` is
false. Fixture contracts and a candidate transport are not represented as live
production support.

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

## Pending control-plane boundaries

Instance backup and upgrade boundaries remain isolated behind
`SocialGitClient`. A `404` becomes a visible `ControlPlaneUnavailableError`
rather than fabricated production data. The current boundary expects:

- `GET|POST /v1/control-plane/api-keys`
- `POST /v1/control-plane/accounts/{accountId}/reddit-session`
- `POST /v1/control-plane/api-keys/{keyId}/revoke`
- `GET|POST /v1/control-plane/backups`
- `GET /v1/control-plane/upgrades/status`

Views do not depend on transport details.

## Verification

`npm run test:web` uses an injected deterministic Fetch implementation and pure
HTML rendering tests, including copy-safe API examples, exact X admission
reasons, reconnect/refresh generation handling, UNKNOWN no-resubmit guidance,
and responsive/accessibility markup. `test/http.test.ts` verifies Core routing,
asset types, HEAD behavior, CSP, and that the `/v1` API namespace still reaches
API routing. `test/runtime-e2e.test.ts` smoke-tests the same assets and X
admission catalog from a production-mode runtime.
