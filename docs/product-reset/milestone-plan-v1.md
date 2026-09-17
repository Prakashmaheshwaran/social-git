# Product-reset milestone plan v1

Document version: 1.0.0
Status: living execution plan; gate truth comes from code and release evidence.

## M0 — contract and safety spine

- Versioned Core/adaptor/worker contracts, encrypted custody, identity binding,
  durable idempotency/actions, redacted errors/audit, and deterministic fixtures.
- Exit: contract/security suites pass and browser/official-API dependencies are
  absent from runtime manifests.

## M1 — Reddit self-hosted MVP

- Multi-account registration/connect/refresh/revoke, admitted reads and writes,
  media phases, capability discovery, API keys, action status, and webhooks.
- Exit: clean Compose owner-to-API journey, restart persistence, backup/restore,
  worker isolation, and separately authorized Reddit smoke evidence.

## M2 — usable product surface

- Responsive control plane, action/usage operations, local interactive OpenAPI
  explorer, validated examples, self-hosting/Coolify runbooks, and generated
  capability matrix.
- Exit: no hosted runtime assets; `/app/`, `/docs/`, `/openapi.json`, REST and MCP
  agree on the same operation set and platform availability.

## M3 — release certification

- Clean-clone install, full verification, deterministic black-box acceptance,
  immutable build/attestation, Compose smoke, restore rehearsal, threat review,
  and license/release checklist.
- Exit: every deterministic gate records commit and digest. Any missing live
  proof remains NOT_EVALUATED rather than being inferred from fixtures.

## M4 — X admission

- Refresh exact endpoint/transaction evidence, pass authorized identity/read/
  write canaries, preserve challenge/rate/UNKNOWN stops, and promote only the
  proven subset.
- Exit: every `packages/x-adapter/src/admission.mjs` gate is true and independent
  QA records the authorized proof. Until then, contracts remain fixture-only.

## M5 — additional platforms

- Add one adapter at a time through the same source/license, capability,
  isolation, contract, drift, and live-proof gates.
- Exit: no platform is announced from library presence alone.
