# Social Git release acceptance contract (product reset)

Status: contract draft for DYN-100. Not a release GO. Executable today: the
deterministic harness (`qa/acceptance`), unit/contract suites, packaging
scripts, and the CLI checks in this document. The product-reset features
listed as gaps require implementation and their own harness evidence before
any release.

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
- Every gate has a unique check id (A-xx …) so reports can cite it exactly.

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
