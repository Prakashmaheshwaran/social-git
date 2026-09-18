# Release-admission proof workflow

This workflow captures bounded, redacted evidence; it does not enable a platform. Installation operators cannot promote Reddit or X by setting an environment variable, uploading a local JSON document, changing a database row, or clicking in the owner UI. X product capabilities remain disabled until a later reviewed source commit changes the committed transport-admission policy after independent review.

## Trust and custody boundaries

- The installation owner explicitly imports a documented session export. Social Git never reads browser storage and never accepts a password, MFA code, CAPTCHA solution, proxy, or fingerprint profile.
- A security approver and an independent QA operator sign the same canonical v2 envelope with distinct Ed25519 private keys kept outside the service and container.
- Their public-key fingerprints must already exist in `src/admission-trust.ts`. The shipped set is empty by design; adding roots is a separately reviewed release-maintainer source change.
- The envelope binds tenant, ledger, deployment ID, exact source commit, measured runtime manifest, SBOM, compatibility evidence, account, native identity, encrypted-session generation, direct route, exact operations, resources, TTL, and action limit.
- Core alone holds the imported session. A distinct, envelope-bound Core-only Ed25519 key signs evidence. Its public fingerprint is covered by both envelope signatures; the private key is never displayed or exported.
- The legacy `SOCIAL_GIT_LIVE_GRANT_FILE` v1 document self-declares actor IDs and is fixture-only. Production rejects it.

## Safe operator sequence

1. A release maintainer builds the candidate at the exact commit, records its `source-manifest.sha256` and `sbom.spdx.json`, and records exact endpoint/header compatibility evidence. No provider request is needed for this step.
2. The security approver and independent QA separately inspect and sign the canonical v2 envelope offline. The installation owner cannot sign it in the UI.
3. The installation owner imports the explicitly exported owner session. The UI prepares one proof with a 60–900 second TTL and an exact `PREPARE` confirmation. Preparation performs no provider request.
4. Independent QA reviews the full canonical proof request—tenant, ledger, deployment, hashed account/target/route, platform, proof kind, operation, parent cleanup, session generation, expiry, grant and evidence-key fingerprints—and signs the displayed challenge offline.
5. The owner submits the detached signature and exact `EXECUTE` confirmation with a fresh CSRF token. Identity/read/canary-write/cleanup are separate authorizations. A write is consumed before dispatch and is never automatically retried. Any post-dispatch uncertainty is `UNKNOWN`.
6. A successful canary write is incomplete until a separately signed cleanup proof links the exact parent request, signed evidence digest, result digest, target, and successful cleanup. A terminal `UNKNOWN` parent may also receive an exact-target cleanup because the provider state may have changed; that cleanup never upgrades the original outcome or claims the certification succeeded. An `UNKNOWN` cleanup never claims completion.
7. Export the Ed25519-signed redacted evidence. It contains digests and bindings, never cookies, CSRF tokens, session bytes, route material, passwords, or raw provider payloads.
8. External reviewers validate signatures, measured artifacts, source and compatibility evidence. Closing production gates requires a new reviewed source commit; the locally captured bundle cannot flip `productionEnabled`.

## Certification-only X worker

The candidate X lane is private and authenticated with the existing Core-to-worker command MAC. The worker independently verifies the committed trust roots and signed envelope, recomputes the complete proof-request digest, checks exact command and payload binding, and durably consumes the proof in its worker-only `social-git-x-certification-state` volume before any request. Container recreation therefore cannot replay a captured write. This lane is never registered as the product X adapter and does not change capability or product-readiness truth.

The owner endpoints are browser-session only under `/v1/control-plane/admission`. Bearer/API-key/MCP access is rejected. Every mutation requires exact Origin, `Sec-Fetch-Site: same-origin`, `application/json`, and a fresh CSRF token.

## Reddit proof execution

Reddit proofs use the admitted production Core session and authenticated private HTTP worker, but Core passes the canonical proof digest as the worker request ID and requires the signed generation, direct route, and native identity again at command acquisition. A refresh between preparation and dispatch is therefore rejected before provider egress. Identity/read/save/unsave are single synchronous proof attempts; no ordinary product action can silently switch to a newer session. An interrupted write is recorded `UNKNOWN`, while a cryptographically authenticated pre-submit worker rejection is terminal without poisoning the account as unknown.

The workflow status distinguishes an installed envelope (`configured`) from a currently valid signed window (`active`). A future or expired optional envelope never changes normal product readiness, and the owner UI disables proof mutations outside the exact `notBefore`/`expiresAt` interval.

After a reviewed source release pins the trust-root fingerprints, operators can add the workflow without changing the default stack:

```sh
docker compose -f compose.yaml -f compose.admission.yaml up -d
```

The overlay requires five explicit private file paths and mounts the evidence private key only into Core. The X worker receives only the signed envelope and approval public keys. Omitting the overlay leaves the workflow absent and all product defaults unchanged.

Release review repeats the rendered-Compose and literal container custody check with:

```sh
./scripts/smoke-admission-overlay.sh --platform linux/arm64 <candidate-image>
```

The smoke runs Core as `10001:10001` and both workers as `10002:10002`. It proves Core can read the evidence private/public keys, the Reddit worker receives no admission material, and the X worker can read only the envelope and QA/approver public keys—not either evidence key or the Reddit command key. The standard `scripts/smoke-container.sh` invokes this check as part of the candidate-image smoke.
