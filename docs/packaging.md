# Reproducible executable packaging

The release image contains the executable Node.js Core gateway, Reddit worker,
and fail-closed X worker candidate. The default `core` role runs `src/main.ts`.
The `worker` role runs the bounded Reddit endpoint in `src/reddit-worker-main.ts`;
the `x-worker` role runs the production-disabled admission boundary in
`src/x-worker-main.ts`. The earlier Python readiness process is not copied into
the final image.

For the fresh-clone source-build experience, owner setup, Coolify deployment,
and full installation backup/restore scripts, see
[`docs/self-hosting.md`](self-hosting.md). This document retains the stricter
digest-pinned release-image path.

## Pinned runtime and reviewed closure

- Node.js is pinned to `26.3.1` and the multi-platform base is pinned to OCI index `sha256:9898bb74f4ee319780e87819df703b3633113bc3422f151fd11155cf974a2749`.
- The Dockerfile frontend and metadata-builder image are also digest pinned.
- The application has no third-party npm runtime dependency. Workspace packages are copied from reviewed source and linked without running npm.
- `security/runtime-dependency-review.json` locks 95 final-image components: 89 Debian packages, Node.js, and five Social Git application components. It records source, license evidence, retained install scripts, and architecture-specific installed-content hashes. First-party components use versioned `urn:social-git:source:` locators; the OCI revision label binds the image to the exact Git commit.
- The current source tree also copies the first-party X contract package needed
  by Core's fail-closed X adapter. The committed 95-component review predates
  that addition, so an immutable release build remains gated until an
  independent reviewer approves the regenerated six-application-component
  candidate after DYN-112 is integrated. The default self-hosted build and
  deterministic tests do not constitute that release approval.
- The final stage removes npm, npx, apt, dpkg, their execution/support code, Node development headers, and all compiler/build-tool surfaces. The policy also rejects browsers, drivers, CDP packages, official Reddit API clients, and official API configuration.
- The image includes deterministic source metadata under `/opt/social-git/share`. Runtime SPDX files are generated from final OCI layers and are bound to the immutable release, manifest, config, and layer digests.

## Build without publishing

The default build creates a local OCI archive. It does not push an image:

```sh
scripts/build-images.sh --no-cache \
  --output dist/social-git-runtime.oci.tar \
  --attestation-output dist/attestations
```

The script always builds a normalized `git archive` of committed `HEAD`. It excludes
dirty and untracked checkout files, gives every source entry the commit timestamp,
derives the revision label and `SOURCE_DATE_EPOCH` from that commit, and runs the
layout and dependency checks from the same archived source. Conflicting
`VCS_REF` or `SOURCE_DATE_EPOCH` overrides fail before the build.

The archive must contain exactly `linux/amd64` and `linux/arm64`.

At the release boundary, build the candidate and then rebuild it from a clean
detached clone. The guard compares the release index descriptor, the canonical
`index.json` digest, every platform manifest, and the complete archive bytes:

```sh
scripts/build-images.sh --no-cache \
  --tag social-git-runtime:release-candidate \
  --output dist/runtime-candidate.oci.tar \
  --attestation-output dist/attestations
scripts/verify-release-reproducibility.sh \
  --candidate dist/runtime-candidate.oci.tar \
  --tag social-git-runtime:release-candidate \
  --output dist/reproducibility.json
```

The guard must report `status: ok` and `archivesByteEqual: true` before handoff.
The exact tag is an input because it is recorded in the OCI layout index.

## Core and worker isolation

Production Compose uses two identities across three long-running roles:

- Core is UID/GID `10001:10001`. Only Core receives the SQLite data, encrypted-backup, import-staging, restore-staging, master-key, audit-key, authentication, and backup-key mounts.
- Reddit worker is UID/GID `10002:10002`. It receives no volume or secret mount. It joins only the internal command network and the Reddit egress network.
- X worker is UID/GID `10002:10002`. It receives no volume or secret mount. It
  joins only the internal command network and its distinct X egress network.

All roles use a read-only root filesystem, a size-limited `noexec` temporary
filesystem, all capabilities dropped, `no-new-privileges`, and explicit PID,
file, CPU, and memory limits. Core waits for both workers' healthchecks. It sends
bounded versioned Reddit commands only to
`http://reddit-worker:8081/v1/dispatch`; X dispatch at
`http://x-worker:8082/v1/dispatch` returns `X_TRANSPORT_NOT_ADMITTED` until all
admission gates pass.

## Health, OpenAPI, and MCP

- Core `GET /healthz` reports process liveness.
- Core `GET /readyz` reports the action ledger, encrypted session runtime, and write-dispatch state.
- Reddit worker `GET /healthz` and `GET /readyz` report its executable process state.
- X worker `GET /healthz` and `GET /readyz` report candidate process and admission
  state. A healthy candidate is not evidence of live X acceptance.
- Core `GET /openapi.json` returns the generated OpenAPI 3.1 contract.
- Core `POST /mcp` starts the same authenticated operation contract over MCP JSON-RPC.

The image health check uses the Node.js-only `runtime/healthcheck.mjs` probe.

## Encrypted backup and restore

The backup CLI uses Core's authenticated encrypted-backup format. It binds each backup to its runtime identity and schema, uses a separate backup key, validates expiry and authentication during restore, and creates private files. Back up `sessions.sqlite`, `actions.sqlite`, and `identity.sqlite`; the action database contains the durable idempotency, action, inbound-event, and audit records required to prevent duplicate writes after recovery, while identity holds the owner and API-key control plane. The default Compose wrappers cover all three.

```sh
docker compose -f compose.prod.yaml exec core \
  node /opt/social-git/runtime/backup.mjs create \
  --tenant-id default \
  --database /var/lib/social-git/sessions.sqlite \
  --output /var/lib/social-git/backups/sessions.backup \
  --master-key-file /run/secrets/social_git_master_key \
  --audit-key-file /run/secrets/social_git_audit_key \
  --backup-key-file /run/secrets/social_git_backup_key

docker compose -f compose.prod.yaml exec core \
  node /opt/social-git/runtime/backup.mjs restore \
  --tenant-id default \
  --backup /var/lib/social-git/backups/sessions.backup \
  --database /var/lib/social-git/restore/sessions.sqlite \
  --backup-key-file /run/secrets/social_git_backup_key
```

Create and restore the action ledger separately with the same backup key:

```sh
docker compose -f compose.prod.yaml exec core \
  node /opt/social-git/runtime/backup.mjs ledger-create \
  --ledger-id default-action-ledger \
  --database /var/lib/social-git/actions.sqlite \
  --output /var/lib/social-git/backups/actions.backup \
  --backup-key-file /run/secrets/social_git_backup_key

docker compose -f compose.prod.yaml exec core \
  node /opt/social-git/runtime/backup.mjs ledger-restore \
  --ledger-id default-action-ledger \
  --backup /var/lib/social-git/backups/actions.backup \
  --database /var/lib/social-git/restore/actions.sqlite \
  --backup-key-file /run/secrets/social_git_backup_key

docker compose -f compose.prod.yaml exec core \
  node /opt/social-git/runtime/backup.mjs ledger-validate \
  --ledger-id default-action-ledger \
  --database /var/lib/social-git/restore/actions.sqlite
```

The action-ledger backup uses a transactionally consistent SQLite snapshot and authenticates a bounded audit/idempotency/webhook anchor. It includes encrypted webhook signing secrets, immutable events, outbox claims, and delivery attempts, so a restore neither loses notification history nor reuses an unfenced claim. Restore rejects tampering, expiry, schema drift, ledger-identity mismatch, integrity failure, and foreign-key failure. Restore always targets the isolated restore-staging mount. Stop Core and validate both restored files before replacing live database files.

## Architecture smoke checks

Load and run each platform without live credentials or Reddit access:

```sh
scripts/build-images.sh --load --no-cache --platform linux/amd64 --tag social-git-runtime:amd64-smoke
scripts/smoke-container.sh --platform linux/amd64 social-git-runtime:amd64-smoke
scripts/build-images.sh --load --no-cache --platform linux/arm64 --tag social-git-runtime:arm64-smoke
scripts/smoke-container.sh --platform linux/arm64 social-git-runtime:arm64-smoke
```

The smoke check verifies REST, OpenAPI, MCP initialization, Core and worker
health/readiness, X fail-closed admission, encrypted backup/restore, restart,
separate UIDs, worker mount isolation, Compose policy, final-image exclusions,
and graceful `SIGTERM` shutdown.

## Production start

Supply an immutable local or registry reference and four private host files. Compose does not build the production service:

```sh
export SOCIAL_GIT_IMAGE='registry.example/social-git-runtime@sha256:REPLACE_WITH_RELEASE_DIGEST'
export SOCIAL_GIT_MASTER_KEY_FILE='/secure/master-key'
export SOCIAL_GIT_AUDIT_KEY_FILE='/secure/audit-key'
export SOCIAL_GIT_AUTH_FILE='/secure/auth.json'
export SOCIAL_GIT_BACKUP_KEY_FILE='/secure/backup-key'
docker compose -f compose.prod.yaml up -d --pull never
```

Do not publish an image until independent QA has verified the exact commit and digest-bound evidence.
