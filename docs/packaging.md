# Reproducible executable packaging

The release image contains the executable Node.js Core gateway and Reddit worker. The default `core` role runs `src/main.ts`. The `worker` role runs the bounded Reddit worker endpoint in `src/reddit-worker-main.ts`. The earlier Python readiness process is not copied into the final image.

## Pinned runtime and reviewed closure

- Node.js is pinned to `26.3.1` and the multi-platform base is pinned to OCI index `sha256:9898bb74f4ee319780e87819df703b3633113bc3422f151fd11155cf974a2749`.
- The Dockerfile frontend and metadata-builder image are also digest pinned.
- The application has no third-party npm runtime dependency. Workspace packages are copied from reviewed source and linked without running npm.
- `security/runtime-dependency-review.json` locks 95 final-image components: 89 Debian packages, Node.js, and five Social Git application components. It records source, license evidence, retained install scripts, and architecture-specific installed-content hashes. First-party components use versioned `urn:social-git:source:` locators; the OCI revision label binds the image to the exact Git commit.
- The final stage removes npm, npx, apt, dpkg, their execution/support code, Node development headers, and all compiler/build-tool surfaces. The policy also rejects browsers, drivers, CDP packages, official Reddit API clients, and official API configuration.
- The image includes deterministic source metadata under `/opt/social-git/share`. Runtime SPDX files are generated from final OCI layers and are bound to the immutable release, manifest, config, and layer digests.

## Build without publishing

The default build creates a local OCI archive. It does not push an image:

```sh
scripts/build-images.sh --no-cache \
  --output dist/social-git-runtime.oci.tar \
  --attestation-output dist/attestations
```

The archive must contain exactly `linux/amd64` and `linux/arm64`.

To prove reproducibility, build twice without cache and compare immutable OCI objects:

```sh
scripts/build-images.sh --no-cache \
  --output dist/runtime-first.oci.tar \
  --attestation-output dist/attestations-first
scripts/build-images.sh --no-cache \
  --output dist/runtime-second.oci.tar \
  --attestation-output dist/attestations-second
python3 tools/security/attest_runtime.py \
  --archive dist/runtime-first.oci.tar \
  --compare-archive dist/runtime-second.oci.tar \
  --review security/runtime-dependency-review.json \
  --output-dir dist/release-attestations
python3 tools/security/check_repository_policy.py \
  --sbom dist/release-attestations/linux-amd64.spdx.json \
  --sbom dist/release-attestations/linux-arm64.spdx.json
```

The outer tar checksum is informational. Reproducibility is the equality of the release index and every platform manifest, config, and layer digest.

## Core and worker isolation

Production Compose uses two identities:

- Core is UID/GID `10001:10001`. Only Core receives the SQLite data, encrypted-backup, import-staging, restore-staging, master-key, audit-key, authentication, and backup-key mounts.
- Reddit worker is UID/GID `10002:10002`. It receives no volume or secret mount. It joins only the internal command network and the Reddit egress network.

Both roles use a read-only root filesystem, a size-limited `noexec` temporary filesystem, all capabilities dropped, `no-new-privileges`, and explicit PID, file, CPU, and memory limits. Core waits for worker readiness and sends bounded versioned worker commands only to `http://reddit-worker:8081/v1/dispatch`.

## Health, OpenAPI, and MCP

- Core `GET /healthz` reports process liveness.
- Core `GET /readyz` reports the action ledger, encrypted session runtime, and write-dispatch state.
- Worker `GET /healthz` and `GET /readyz` report its executable process state.
- Core `GET /openapi.json` returns the generated OpenAPI 3.1 contract.
- Core `POST /mcp` starts the same authenticated operation contract over MCP JSON-RPC.

The image health check uses the Node.js-only `runtime/healthcheck.mjs` probe.

## Encrypted backup and restore

The backup CLI uses Core's authenticated encrypted-backup format. It binds the backup to the tenant and schema, uses a separate backup key, validates expiry and authentication during restore, and creates private files.

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

Restore always targets the isolated restore-staging mount. Validate it before replacing a stopped service database.

## Architecture smoke checks

Load and run each platform without live credentials or Reddit access:

```sh
scripts/build-images.sh --load --no-cache --platform linux/amd64 --tag social-git-runtime:amd64-smoke
scripts/smoke-container.sh --platform linux/amd64 social-git-runtime:amd64-smoke
scripts/build-images.sh --load --no-cache --platform linux/arm64 --tag social-git-runtime:arm64-smoke
scripts/smoke-container.sh --platform linux/arm64 social-git-runtime:arm64-smoke
```

The smoke check verifies REST, OpenAPI, MCP initialization, Core and worker health/readiness, encrypted backup/restore, restart, separate UIDs, worker mount isolation, Compose policy, final-image exclusions, and graceful `SIGTERM` shutdown.

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
