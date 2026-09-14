# Reproducible browser-free packaging

This packaging shell establishes the process, storage, health, and isolation contract for the Reddit-first runtime. It deliberately implements no social-network operations. The core owns SQLite and the session-key mount. The Reddit worker has neither database nor secret access.

## Pinned inputs

- Python is pinned to `3.13.7` in `.python-version`.
- The multi-platform base is pinned to the OCI index digest in `Dockerfile`.
- The Dockerfile frontend is pinned to an OCI index digest.
- `requirements.lock` records that this shell has no third-party application dependency.
- `security/runtime-dependency-review.json` locks all 98 transitive runtime components. Each entry records its exact version, versioned source locator, license-evidence digest, maintainer/install-script hashes, and an installed-content SHA-256 for AMD64 and ARM64.
- Build provenance attestations are disabled because they contain invocation-specific data. The image instead contains a deterministic SHA-256 source manifest and SPDX 2.3 SBOM under `/opt/social-git/share`.
- `SOURCE_DATE_EPOCH` defaults to the source commit timestamp. OCI export uses BuildKit timestamp rewriting, and build steps have no network access.

The base index contains `linux/amd64` and `linux/arm64` manifests. `scripts/verify-oci-layout.py` checks both in the produced archive.

## Build without publishing

Docker 29 with Buildx 0.33 or compatible versions are sufficient. The default command creates a local OCI archive and does not push it:

```sh
scripts/build-images.sh
```

The archive is written to `dist/social-git-runtime.oci.tar`. The build also writes `dist/attestations/attestation-summary.json` and one SPDX 2.3 runtime SBOM for each architecture. These runtime SBOMs inventory the final filesystem; they are distinct from the source SBOM embedded in the image.

To load one host platform for smoke testing:

```sh
scripts/build-images.sh --load --platform linux/amd64 --tag social-git-runtime:smoke
scripts/smoke-container.sh social-git-runtime:smoke
```

Use `linux/arm64` on an ARM64 runner. A CI matrix can run the same two commands once per architecture, then run the default multi-platform archive build once.

To prove reproducibility, build twice without the build cache and compare the immutable OCI index, manifest, config, and layer digests:

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
```

Comparing OCI object digests avoids mistaking irrelevant outer tar-header differences for image drift.

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

The release check reads every final OCI layer without executing or loading the image:

```sh
python3 tools/security/attest_runtime.py \
  --archive dist/social-git-runtime.oci.tar \
  --review security/runtime-dependency-review.json \
  --output-dir dist/attestations
python3 tools/security/check_repository_policy.py \
  --sbom dist/attestations/linux-amd64.spdx.json \
  --sbom dist/attestations/linux-arm64.spdx.json
```

The attestor verifies every compressed and uncompressed layer digest, requires exactly AMD64 and ARM64 images, checks UID/GID 10001, inventories all installed Debian and Python packages, and rejects any content not present in the approved review. It scans package names, executable names, application content, environment-variable names, and install scripts for browsers, browser drivers, CDP tooling, official Reddit API clients, official OAuth/API configuration, install-time network commands, package managers, and compilers. The runtime removes apt, dpkg, debconf, their executable helpers and support libraries, pip, and ensurepip after the offline build. It retains the Debian package metadata needed for transitive inventory, but makes every retained maintainer script non-executable. The repository policy command independently verifies both complete SBOMs, their exact image/layer digest binding, and every component's reviewed source, license, script, and content evidence.

An architecture-specific component, version, source, license, script, or content change fails closed. To review an intentional base-image update, create a candidate and inspect its complete diff. CI must never approve or rewrite this file:

```sh
python3 tools/security/attest_runtime.py \
  --archive dist/social-git-runtime.oci.tar \
  --write-review-candidate build/runtime-dependency-review.candidate.json
```

The candidate starts with `decision: pending`. A qualified reviewer must examine every change and explicitly record the source, license, and install-script decision before replacing the committed review.

Run the final-image policy inspection after loading either architecture:

```sh
scripts/inspect-image.sh social-git-runtime:smoke
```

This running-container check is a supplemental smoke check. The release gate is the offline, transitive OCI attestation above.

## CI verification

No live credentials or social actions are used:

```sh
scripts/test.sh
scripts/build-images.sh --no-cache --output dist/runtime-first.oci.tar \
  --attestation-output dist/attestations-first
scripts/build-images.sh --no-cache --output dist/runtime-second.oci.tar \
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

`.github/workflows/runtime-supply-chain.yml` runs this release gate with immutable CI action, QEMU, Buildx, BuildKit, Dockerfile frontend, and base-image references. It uploads the digest summary, both final-image SBOMs, and the reviewed closure as one evidence artifact.
