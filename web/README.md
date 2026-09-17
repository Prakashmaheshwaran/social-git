# Control-plane web application

The web UI is a zero-runtime-dependency ES module application served by Core at
`/app/`. It uses the same origin as REST, keeps the bearer token in
`sessionStorage` (never persistent browser storage), and ships in the existing
runtime image. `npm run typecheck:web` validates its JSDoc contracts under
strict TypeScript settings.

## Live REST surface

The dashboard, account directory, account connection/revocation, audit trail,
action lookup, health status, and sign-in token validation use the committed
REST/OpenAPI operations directly.

## DYN-104 control-plane boundary

First-run identity and instance operations are isolated in `SocialGitClient` so
the UI does not invent production data when the endpoints are absent. A `404`
becomes a visible `ControlPlaneUnavailableError` with an actionable empty state.
The integration boundary expects:

- `GET /v1/control-plane/status`
- `POST /v1/control-plane/setup`
- `GET|POST /v1/control-plane/api-keys`
- `POST /v1/control-plane/api-keys/{keyId}/revoke`
- `GET|POST /v1/control-plane/backups`
- `GET /v1/control-plane/upgrades/status`

When DYN-104 selects final paths or response shapes, update only
`web/client.js`; views do not depend on transport details.

## Verification

`npm run test:web` uses an injected deterministic Fetch implementation and pure
HTML rendering tests. `test/http.test.ts` verifies Core routing, asset types,
HEAD behavior, CSP, and that the `/v1` API namespace still reaches API routing.
