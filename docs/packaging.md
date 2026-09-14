# Reproducible browser-free packaging

This packaging shell establishes the process, storage, health, and isolation contract for the Reddit-first runtime. It deliberately implements no social-network operations. The core owns SQLite and the session-key mount. The Reddit worker has neither database nor secret access.

## Pinned inputs

- Python is pinned to `3.13.7` in `.python-version`.
- The multi-platform base is pinned to the OCI index digest in `Dockerfile`.
- The Dockerfile frontend is pinned to an OCI index digest.
- `requirements.lock` records that this shell has no third-party Python dependency.
- Build provenance attestations are disabled because they contain invocation-specific data. The image instead contains a deterministic SHA-256 source manifest and SPDX 2.3 SBOM under `/opt/social-git/share`.
- `SOURCE_DATE_EPOCH` defaults to the source commit timestamp. OCI export uses BuildKit timestamp rewriting.

The base index contains `linux/amd64` and `linux/arm64` manifests. `scripts/verify-oci-layout.py` checks both in the produced archive.

## Build without publishing

Docker 29 with Buildx 0.33 or compatible versions are sufficient. The default command creates a local OCI archive and does not push it:

```sh
scripts/build-images.sh
```

The archive is written to `dist/social-git-runtime.oci.tar`. To load one host platform for smoke testing:

```sh
scripts/build-images.sh --load --platform linux/amd64 --tag social-git-runtime:smoke
scripts/smoke-container.sh social-git-runtime:smoke
```

Use `linux/arm64` on an ARM64 runner. A CI matrix can run the same two commands once per architecture, then run the default multi-platform archive build once.

To compare reproducibility, run the archive build twice with the same checkout and `SOURCE_DATE_EPOCH`, use different `--output` paths, and compare `sha256sum` results.

## Health and readiness

Both roles expose dependency-free endpoints:

- `GET /healthz` proves that the process can answer requests.
- `GET /readyz` proves that the role can accept work.

Core readiness requires a valid session-key mount and a writable, schema-valid SQLite database in WAL mode. Worker readiness has no database or long-lived secret dependency. Compose uses `/readyz` for both health checks.

## Development Compose

Create the local application key as described in `secrets/README.md`, then start the two roles:

```sh
docker compose -f compose.dev.yaml up --build
```

The API binds to `127.0.0.1:8080` by default. The core joins the API and internal worker networks and mounts the `social-git-data` volume. The worker joins only the internal network and has no volume or secret mount.

## Production Compose

Production Compose does not build or pull implicitly. Supply an image by immutable digest and a host secret file:

```sh
export SOCIAL_GIT_IMAGE='registry.example/social-git-runtime@sha256:REPLACE_WITH_IMAGE_DIGEST'
export SOCIAL_GIT_SESSION_KEY_FILE='/secure/path/social-git-session-key'
docker compose -f compose.prod.yaml up -d --pull never
```

Both services run as UID/GID 10001 with a read-only root filesystem, a size-limited temporary filesystem, all Linux capabilities dropped, `no-new-privileges`, PID limits, CPU limits, and memory limits. Only the named SQLite volume is writable and persistent.

## Backup and restore

The backup command uses SQLite's online backup API, validates `PRAGMA integrity_check`, verifies the schema marker, writes through a private temporary file, and atomically replaces the destination:

```sh
docker compose -f compose.prod.yaml exec core \
  python -m runtime.backup backup \
  --database /var/lib/social-git/social-git.sqlite3 \
  --output /var/lib/social-git/backups/social-git.sqlite3
```

Restore to a new file and validate before changing the configured database path:

```sh
docker compose -f compose.prod.yaml exec core \
  python -m runtime.backup restore \
  --backup /var/lib/social-git/backups/social-git.sqlite3 \
  --database /var/lib/social-git/restored.sqlite3
docker compose -f compose.prod.yaml exec core \
  python -m runtime.backup validate \
  --database /var/lib/social-git/restored.sqlite3
```

`scripts/backup-restore-smoke.sh` performs this cycle against the running smoke core.

## Image exclusion proof

Run the final-image policy inspection after loading either architecture:

```sh
scripts/inspect-image.sh social-git-runtime:smoke
```

It checks the final filesystem, installed Python distributions, Debian package database, image user and environment names, and application files. It fails if it finds Chromium, ChromeDriver, Playwright, Selenium, Xvfb, or configuration names and endpoints for official Reddit API credentials. The scan reports names only and never prints environment values.

## CI verification

No live credentials or social actions are used:

```sh
scripts/test.sh
scripts/build-images.sh --load --platform linux/amd64 --tag social-git-runtime:ci
scripts/smoke-container.sh social-git-runtime:ci
scripts/build-images.sh --output dist/social-git-runtime.oci.tar
```
