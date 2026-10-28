# Social Git release acceptance contract (product reset)

Status: contract draft for DYN-100. Not a release GO. Executable today: the
deterministic harness (`qa/acceptance`), unit/contract suites, packaging
scripts, and the CLI checks in this document. The M1–M3 product features this
document once listed as gaps — contract registry, webhooks, backups, the API
explorer, and the generated capability matrix — are implemented. What remains
missing is release evidence: the upgrade rehearsal has no runner, and no gate
below has authorized live evidence.

## 1. Scope and truth sources

- Product direction: board task DYN-90. Working contract: `AGENTS.md`.
- Runtime boundary and configuration: `docs/gateway-runbook.md`.
- Image, backup, and architecture evidence: `docs/packaging.md`.
- Deterministic acceptance boundary: `qa/acceptance/README.md`.
- Public API contract: `src/contract.ts` generates `openapi/social-git.openapi.json`.

## 2. Evidence classes and verdicts

| Class | Definition | Verdict authority |
| --- | --- | --- |
| Deterministic fixture | qa/acceptance black-box suite + unit/contract suites | QA owns GO/NO-GO |
| Packaging | reproducibility guard, attestations, smoke checks | QA owns GO/NO-GO |
| Authorized live smoke | explicitly approved live canary runs | Named approver records GO/NO-GO |

Rules:

- A green CI run is necessary but never sufficient; verdicts cite evidence
  class, commit, image digest, and exact commands.
- Deterministic evidence never substitutes for live evidence, and live smoke
  never runs from CI or from an ordinary agent run.
- Each gate below names its runner. A gate without an implemented runner is
  `action_required` until the runner exists, and its rows stay `NOT_EVALUATED`.
- The gate names and their runner mapping in this document are prose. No stable
  per-check identifier exists yet in `qa/`, `scripts/`, or any result schema, so
  a report must cite the gate by name and quote the observed command output
  rather than a check id.

## 3. Gate order

Run in order; a failed gate stops the release.

1. Clean clone, verify, and build
2. Unit and contract suites
3. Deterministic fixture acceptance
4. Restart persistence and unknown-action discipline
5. Backup and restore
6. Upgrade rehearsal
7. Packaging and multi-arch
8. Compose from clean clone
9. First owner, scoped key, representative calls
10. Revocation, tenant isolation, secret leakage
11. Capability matrix honesty
12. Authorized live smoke

## 4. Gate runners

| Gate | Check id | Runner | Current state |
| --- | --- | --- | --- |
| 1. Clean clone, verify, and build | A-01 | `docker compose up -d --build` from a fresh clone; `npm run verify` | Implemented |
| 2. Unit and contract suites | A-02 | `npm test` | Implemented |
| 3. Deterministic fixture acceptance | A-03 | `npm run qa:acceptance -- --driver … --candidate-ref … --image-digest …` | Implemented |
| 4. Restart persistence and unknown-action discipline | A-04 | `qa/acceptance` restart supervisor and the write-failure matrix suites | Implemented |
| 5. Backup and restore | A-05 | `scripts/smoke-self-hosted-compose.sh`, `scripts/backup-restore-smoke.sh` | Implemented |
| 6. Upgrade rehearsal | A-06 | `scripts/upgrade-rehearsal.sh --from <old-commit> --to <new-commit>` | Implemented; requires a host with Docker and two committed revisions |
| 7. Packaging and multi-arch | A-07 | `scripts/build-images.sh`, `scripts/verify-oci-layout.py`, `scripts/verify-release-reproducibility.sh` | Implemented |
| 8. Compose from clean clone | A-08 | `scripts/smoke-self-hosted-compose.sh` | Implemented |
| 9. First owner, scoped key, representative calls | A-09 | `scripts/smoke-self-hosted-compose.sh` | Implemented |
| 10. Revocation, tenant isolation, secret leakage | A-10 | `npm test` security suites plus the smoke secret-mount checks | Implemented |
| 11. Capability matrix honesty | A-11 | `npm run validate:product-docs`, `test/reddit-platform-capabilities.test.ts` | Implemented |
| 12. Authorized live smoke | A-12 | Separately authorized live canary task; never run from CI or an ordinary agent run | `action_required` until an approver schedules it |

### A-06 Upgrade rehearsal

`scripts/upgrade-rehearsal.sh` is the missing runner for gate 6. It builds both
the old and new images from committed source, creates a representative
installation through the public API, takes an encrypted backup, upgrades in
place on the same volumes, and restores the pre-upgrade backup onto fresh
volumes, asserting readiness, the migration tuple reported by `/readyz`, owner
login, API-key access, action history, webhook subscriptions and deliveries, and
audit-chain integrity at every step.

```sh
./scripts/upgrade-rehearsal.sh --from <old-commit> --to HEAD
```

Evidence to record: both commit SHAs, the printed old and new schema tuples,
the retained audit heads, the run duration, and the final
`upgrade_rehearsal=ok …` line. The run cleans up its own project, volumes, and
images. It makes no live social-network request: the Reddit write is served by
the deterministic fixture overlay (`qa/compose.smoke.yaml`), exactly as gate 8's
smoke does, while the backup, upgrade, and restore phases run on the
unmodified `compose.yaml` production topology. See the upgrade section of
`docs/self-hosting.md` for the operator procedure and every assertion.

A pass is deterministic packaging evidence, not live evidence. It does not
substitute for gate 12.


