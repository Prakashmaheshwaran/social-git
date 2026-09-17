# Control-plane web application

The web UI is a zero-runtime-dependency ES module application served by Core at
`/app/`. Owner authentication uses the server's HttpOnly, SameSite cookie with
`fetch` credentials set to `same-origin`. The CSRF value returned at setup or
login is retained only in the client's private in-memory field and attached to
mutating requests; no session or cookie material enters browser storage. The UI
ships in the existing runtime image. `npm run typecheck:web` validates its
JSDoc contracts under strict TypeScript settings.

## Live REST surface

The dashboard, account directory, account connection/revocation, audit trail,
action lookup, health status, first-run owner setup, login, session inspection,
and logout use the committed REST/OpenAPI operations directly.

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

API-key management remains isolated behind `SocialGitClient` for DYN-106. A
`404` becomes a visible `ControlPlaneUnavailableError` rather than fabricated
production data. Instance backup and upgrade boundaries follow the same rule.
The current boundary expects:

- `GET|POST /v1/control-plane/api-keys`
- `POST /v1/control-plane/api-keys/{keyId}/revoke`
- `GET|POST /v1/control-plane/backups`
- `GET /v1/control-plane/upgrades/status`

When DYN-106 selects final paths or response shapes, update only `web/client.js`;
views do not depend on transport details.

## Verification

`npm run test:web` uses an injected deterministic Fetch implementation and pure
HTML rendering tests. `test/http.test.ts` verifies Core routing, asset types,
HEAD behavior, CSP, and that the `/v1` API namespace still reaches API routing.
