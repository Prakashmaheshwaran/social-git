# `@social-git/core` session runtime

This package is the library-independent trust boundary for account sessions. The
core process is the only owner of the SQLite database and the master encryption
key. An isolated platform worker receives one serialized, bounded command for an
active lease. It never receives a database path, handle, or persistence method.

## Public boundary

- `SessionRuntime.importExternalSession()` accepts opaque bytes from an external
  human bootstrap flow. The service does not contain a browser integration.
- `SessionRuntime.acquireWorkerCommand()` validates account generation and lease
  state before decrypting the session and route. It returns a versioned wire
  message capped at `MAX_WORKER_MESSAGE_BYTES`.
- `SessionRuntime.completeWorkerResult()` accepts only a strict, non-secret result
  shape. Account ID, platform, generation, lease ID, fence, request ID, and
  expected native identity must all match before the state transition commits.
- `SessionRuntime.revokeAccount()` durably revokes the generation and removes the
  encrypted session and route from the database.
- `encodeWorkerMessage()`, `decodeWorkerMessage()`, and the worker message types
  form the adapter boundary.

Every mutation uses `BEGIN IMMEDIATE` and commits the account state and lease
history together. On core startup, leases left active by a crash become
`abandoned`; refresh work returns to `required`. An interrupted, expired, or
superseded write records an `UNKNOWN` result and moves the account to `unknown`,
so no new command is issued before explicit reconciliation. A new safe lease
always has a higher fence. Stale completions cannot change account state.

## State rules

| Event | Health | Refresh state | Secret custody |
| --- | --- | --- | --- |
| External import | `pending_identity` | `idle` | encrypted at rest |
| Matching identity result | `healthy` | `idle` | encrypted at rest |
| Auth failure | `needs_refresh` | `required` | encrypted at rest |
| Challenge | `challenged` | `failed` | encrypted at rest |
| Protocol drift | `protocol_drift` | `failed` | encrypted at rest |
| Unknown result | `unknown` | `failed` | encrypted at rest; no automatic retry |
| Wrong identity or revocation | `wrong_identity` or `revoked` | terminal | deleted and generation revoked |

## Core-side example

```js
import { SessionRuntime } from "@social-git/core";

const runtime = new SessionRuntime({
  databasePath: "/var/lib/social-git/core.sqlite",
  masterKey: keyFromTheOperatorKeyProvider
});

runtime.importExternalSession({
  accountId: "account-1",
  platform: "reddit",
  expectedNativeIdentity: "native-user-id",
  generation: 1,
  session: opaqueBootstrapBytes,
  networkRoute: { id: "route-1", material: opaqueRouteBytes }
});

const commandBytes = runtime.acquireWorkerCommand({
  accountId: "account-1",
  generation: 1,
  requestId: "caller-scoped-request-id",
  intent: "identity_validation",
  operation: "identity.current",
  payload: null
});
```

Do not log `commandBytes`, imported byte arrays, encrypted envelopes, or worker
commands. Use `summarizeWorkerMessage()` and `createSafeLogger()` for diagnostic
metadata. The migration is exported at
`@social-git/core/migrations/001_session_runtime.sql`.

## Verification

```sh
npm run test:core
```

The tests use synthetic bytes only. They do not connect to a social platform or
perform a live action.
