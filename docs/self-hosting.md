# Self-hosting and operations

## Fresh-clone install

Requirements: Docker Engine 24 or newer with Docker Compose v2, and enough
space to build the pinned Node.js image. No `.env` file, registry image, or
pre-created secret file is required.

```sh
git clone <your-social-git-repository-url> social-git
cd social-git
docker compose up -d --build
docker compose ps
```

Wait for `core`, `reddit-worker`, and `x-worker` to report `healthy`, then open
<http://127.0.0.1:8080/app/>. The setup screen creates the sole initial owner.
The application never seeds a password or API token. The owner can create
scoped API keys after signing in.

The one command builds one image and starts four roles:

- `secrets-init` is a network-disabled, one-shot process. It creates three
  distinct 256-bit keys only when the secret volume is empty, validates
  existing files on later starts, and never prints key material.
- `core` serves the web application, REST, OpenAPI, MCP, liveness, and
  readiness on container port 8080. It owns SQLite state and all secret and
  staging mounts. Database migrations run automatically before readiness.
- `reddit-worker` has Reddit egress and its private command network, but no
  state or secret mount. It is not published on the host.
- `x-worker` has a distinct X egress network and a separate private command network,
  but no state or secret mount. It is not published on the host. The candidate
  process is healthy for topology monitoring while its dispatch endpoint
  returns `X_TRANSPORT_NOT_ADMITTED`; live X is not enabled.

The default host binding is `127.0.0.1:8080`. Change the host port with
`SOCIAL_GIT_PORT`, but keep the bind address loopback unless an authenticated
HTTPS reverse proxy protects the service. `docker compose down` keeps all
state. **`docker compose down --volumes` permanently deletes databases,
generated keys, backups, and legacy staged imports.**

## Persistent volumes and secrets

| Volume | Purpose | Core access |
| --- | --- | --- |
| `social-git-data` | sessions, owner/API-key identity, durable actions, audit | read/write |
| `social-git-backups` | encrypted backup sets | read/write |
| `social-git-import` | legacy one-time operator session imports; browser upload does not use it | read/write |
| `social-git-restore` | isolated restore validation and promotion staging | read/write |
| `social-git-secrets` | encryption, audit, and backup keys | read-only after initialization |

The backup volume is not an off-host backup. Copy encrypted backup sets to
separate storage, and escrow the generated key volume through an operator-owned
secret backup process. Keep service keys separate from encrypted database
backups. Losing either the service keys or backup key makes a clean-host restore
impossible; exposing both defeats backup confidentiality.

## Configuration

The default values need no environment file. Common non-secret overrides are:

| Variable | Default | Use |
| --- | --- | --- |
| `SOCIAL_GIT_PORT` | `8080` | Published host port. |
| `SOCIAL_GIT_BIND_ADDRESS` | `127.0.0.1` | Host bind address. Prefer a reverse proxy over `0.0.0.0`. |
| `SOCIAL_GIT_SESSION_COOKIE_SECURE` | `false` | Set to `true` whenever the public URL uses HTTPS. |
| `SOCIAL_GIT_TENANT_ID` | `default` | Persistent tenant binding; do not change after first boot. |
| `SOCIAL_GIT_LEDGER_ID` | `default-action-ledger` | Persistent action-ledger binding; do not change after first boot. |
| `SOCIAL_GIT_IMAGE` | `social-git-runtime:local` | Optional shared image name. The default command builds locally. |

The separate `compose.prod.yaml` remains the immutable-release deployment path.
It intentionally requires a digest-pinned image and external secret files. Use
the default `compose.yaml` for the one-command self-hosted product.

## Health and logs

```sh
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
docker compose ps
docker compose logs --tail=200 core reddit-worker x-worker secrets-init
```

`/healthz` proves only that the Core process is serving. `/readyz` is a stable,
unauthenticated, non-secret diagnostics contract (`contractVersion: 1`). It
reports all three database migration versions, database integrity where Core can
verify it, Reddit and X worker reachability, action and webhook worker state,
backup-maintenance state, and bounded action/webhook backlog counts. Counts are
capped at 10,000 and never include tenant, account, action, event, caller, URL,
or payload data.

HTTP 503 means a required runtime dependency is unavailable: a schema mismatch,
failed action-ledger integrity check, dropped Reddit worker, stopped/paused
background writer, or an active backup maintenance window. The X worker is
probed independently, but while X production admission is disabled its absence
does not make the Reddit product unready. Inspect
`checks.workers.x.admission`, `productionEnabled`, and `disabledReasons`; a
reachable X worker proves only the isolated candidate process is present. The
compatibility summary fields `actionWorker`, `productWritesReady`,
`certificationGrantActive`, and `writeExecutionMode` remain available.

## Backup and restore

An authenticated owner can create the same encrypted three-database recovery
set from **Settings → Backups**. This is a creation/listing surface only: the
browser cannot supply a path or name, receives no key or database content, and
cannot restore a running instance. Core briefly enters a maintenance window,
drains in-flight API work, pauses action and webhook writers, and writes one
generated set into the `social-git-backups` volume. API keys are deliberately
not accepted. A fresh CSRF proof from the current owner sign-in is required.

The Settings upgrade panel is intentionally informational. Social Git performs
no remote update check and has no automatic update action. Export a verified
backup, then follow the manual deployment procedure below.

Create a transactionally consistent maintenance-window backup of all three
runtime databases. The script stops Core, writes authenticated encrypted
snapshots, and restarts Core if it was previously running:

```sh
./scripts/social-git-backup.sh before-upgrade-20260916
docker compose cp \
  core:/var/lib/social-git/backups/before-upgrade-20260916 \
  ./before-upgrade-20260916
```

Backup sets expire after the Core backup retention limit (currently 30 days).
They contain:

- `sessions.backup`: encrypted social sessions and session audit anchor;
- `actions.backup`: durable actions, idempotency, inbound events, encrypted webhook signing secrets, webhook outbox/delivery attempts, and audit;
- `identity.backup`: owner, browser sessions, API-key digests, and identity audit.

Action/webhook and identity audit streams are authenticated with the separate
audit key. Backup creation and restore validate their complete chains and
retained heads. See [Audit integrity and identity projection](audit-integrity.md)
for the operator verifier and the required off-host head-retention procedure.

Restore only to the same tenant, ledger identity, and service-key set. The
restore command stops Core, decrypts into the isolated restore volume, validates
authentication, expiry, schema, tenant/ledger binding, SQLite integrity, and
audit anchors, promotes the complete set with rollback-on-error, then restarts
Core:

```sh
./scripts/social-git-restore.sh before-upgrade-20260916
curl -fsS http://127.0.0.1:8080/readyz
```

The command consumes the validated staging directory but retains the encrypted
backup set. It refuses missing, expired, tampered, wrong-key, wrong-tenant, and
wrong-ledger backups. Never copy database files over a running Core container.
The separately authorized live-test ledger is deliberately not restored; stale
write authorization must not survive disaster recovery.

## Upgrade and rollback

1. Create and export a backup set.
2. Record the current Git revision: `git rev-parse HEAD`.
3. Fetch and inspect the target release.
4. Run `docker compose up -d --build`.
5. Verify both health endpoints, owner login, and the required API operations.

SQLite migrations are automatic and forward-only. A source rollback after a
schema migration must be paired with a compatible pre-upgrade backup; do not
start old code against a newer data volume. To rebuild or restart without
deleting data:

```sh
docker compose up -d --build
docker compose restart core reddit-worker x-worker
```

Do not use `down --volumes` during an upgrade.

## Coolify

Create a Docker Compose application from the repository and select
`compose.yaml`. Let Coolify build from the checked-out Dockerfile. Configure the
public domain on the `core` service and route it to container port `8080`; do not
publish either platform worker or the initializer. Set:

```text
SOCIAL_GIT_SESSION_COOKIE_SECURE=true
```

Keep the five named volumes persistent across deployments. A normal redeploy
must recreate containers without deleting volumes. After changing Compose
topology, use Coolify's deployment action rather than a container-only restart,
then verify Core and both worker healthchecks plus the public `/readyz` response. Terminate
TLS at Coolify's reverse proxy; never add real social sessions over plain HTTP.

Configure the Coolify health check as `GET /readyz` on Core port 8080 and accept
only HTTP 200. During an owner backup, Core intentionally returns 503 until the
maintenance gate reopens and both background writers resume; this is bounded
maintenance, not data loss. If Coolify reports Core unhealthy outside a backup,
read the component state from `/readyz` before restarting. A container restart
cannot repair a migration mismatch and must not be used to bypass a disabled X
admission reason.

For a registry-based release, set `SOCIAL_GIT_IMAGE` to the reviewed immutable
digest. The source build remains available for ordinary open-source installs.

## Capacity guidance

The committed limits cap steady-state Core at 2 CPUs/768 MiB and each platform
worker at 1 CPU/256 MiB; the initializer is capped at 0.25 CPU/64 MiB and exits.
A practical small installation starts at 2 vCPU and 2 GiB RAM; 3 vCPU is
recommended when Core and both workers may be busy. Start with 10 GiB durable
storage. Leave additional space for container builds, SQLite growth, imported
media, and at least two backup generations. Monitor volume growth and host disk
pressure; SQLite is intended for a single deployment, not active-active replicas.

## Clean-host acceptance

The smoke uses a unique Compose project, image tag, and random host port, builds
from the checkout, rejects default credentials, verifies the normal product-write
readiness flags without fixture mode or a QA grant, creates an owner and scoped
API keys, proves both worker health/isolation and X fail-closed admission, runs a
deterministic Reddit read/write plus signed webhook delivery through the
test-only Compose overlay, proves restart persistence, creates and restores all
three encrypted backups, proves secret initialization is idempotent, and removes
its containers, volumes, and smoke image:

```sh
./scripts/smoke-self-hosted-compose.sh
```

It never contacts Reddit or performs a live social mutation.
