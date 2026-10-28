# Platform Adapter Admission Checklist

Use this checklist when adding a new platform adapter to Social Git. It is the
admission gate referenced by `AGENTS.md`: a platform is added only after source
and licence review, exact version pinning, contract tests, protocol-drift tests,
and an authorized live proof.

`docs/product-reset/capability-matrix.md` is generated from the adapter
contracts, but the capability-to-public-operation mapping in
`scripts/product-reset-docs.ts` is **hand-maintained**. Both must agree.

## Phase 1: Research and evaluation

### Library evaluation
- [ ] Identify candidate libraries for the platform
- [ ] Evaluate licence compatibility (MIT, BSD-2-Clause, or similar)
- [ ] Review source for security issues
- [ ] Verify no copyleft licence affects the project
- [ ] Check for browser automation dependencies
- [ ] Check for official platform API dependencies
- [ ] Assess maintenance status and community activity
- [ ] Document alternative libraries considered and rejected
- [ ] Verify the repository still exists at a resolvable commit — record the
      HTTP status of the source-of-record lookup

### Protocol understanding
- [ ] Understand the authentication mechanism
- [ ] Document session handling and whether a browser-exported session is even
      accepted by the surface being targeted
- [ ] Document rate limiting behaviour
- [ ] Identify all read operations to support
- [ ] Identify all write operations to support
- [ ] Identify explicitly unsupported features
- [ ] Document challenge and CAPTCHA behaviour
- [ ] Document revocation detection
- [ ] Enumerate every stop string the platform can return, including the ones
      the candidate library itself handles incorrectly

## Phase 2: Source and licence review

### Source attribution
- [ ] Record the exact commit for all source
- [ ] Record the branch name and author
- [ ] Read the repository at that commit
- [ ] Extract a minimal protocol corpus only
- [ ] Record SHA-256 of all extracted blobs
- [ ] Do not vendor the entire library

### Licence documentation
- [ ] Copy the full licence text into `THIRD_PARTY_NOTICES.md`
- [ ] Verify the licence allows modification and redistribution
- [ ] Verify the licence allows commercial use
- [ ] Document attribution requirements
- [ ] Verify no copyleft (GPL, AGPL) contamination
- [ ] **Reproduce every copyright line verbatim.** A multi-holder licence makes
      GitHub report `NOASSERTION` even when the licence is MIT; both notices are
      still obligations

## Phase 3: Implementation

### Package structure

The real layout. See
[`platform-adapter-framework.md`](platform-adapter-framework.md#package-structure)
for what each module does.

- [ ] Create `packages/<platform>-adapter/`
- [ ] `package.json` with the `"."` export, `engines.node` `26.9.0`, and a
      `test` script
- [ ] Add to the root `workspaces` list (already `packages/*`)
- [ ] `src/index.mjs`, `src/index.d.ts`, `src/contract.mjs`
- [ ] `src/protocol-corpus.mjs`, `src/protocol-normalizers.mjs`,
      `src/validation.mjs`, `src/worker-result-schema.mjs`
- [ ] `src/session-connector.mjs`, `src/session-transport.mjs`
- [ ] `README.md` and `THIRD_PARTY_NOTICES.md`
- [ ] `test/` directory

Note what does **not** exist: `normalizer.mjs` and `transport.mjs` are not real
module names, and `admission.mjs` exists in the X package only — a Reddit-style
platform carries admission facts in `contract.mjs`.

### Capability definition
- [ ] `contract.mjs` exports a frozen **array** (`<P>_CAPABILITIES`), not an
      object keyed by operation
- [ ] Each entry carries `operation`, `mode`, `authorizationScope`,
      `fixtureEnabled`, `protocolMapping`, `productionEnabled`, and a disabled
      reason (singular for Reddit, a `disabledReasons` list for X)
- [ ] Read capabilities defined with fixture support
- [ ] Write capabilities defined with fixture support
- [ ] Unsupported capabilities explicitly marked
- [ ] Every disabled capability has a stable, machine-readable reason

### Admission gates
- [ ] If the platform uses the two-party release-proof workflow, create
      `admission.mjs` with a **committed boolean gate map**, and derive
      `disabledReasons` from the failed gates through a `reasonByGate` table
- [ ] Do not hand-list `disabledReasons`; deriving them prevents drift
- [ ] `productionEnabled` stays false until a reviewed source commit changes it
- [ ] Verify fixture mode can bypass gates for testing

### Transport implementation
- [ ] Standard HTTP/HTTPS only
- [ ] Fixed egress to known platform hosts
- [ ] DNS pinning
- [ ] Reject proxy environment variables
- [ ] Reject or strictly validate redirects
- [ ] Bounded deadlines
- [ ] Size limits on streamed data
- [ ] Replay detection
- [ ] Single-attempt writes; no retry after a possibly-submitted request
- [ ] No inherited library retry, challenge-resolve, or evasion sleep

### Normalization
- [ ] Bound DTOs; never expose raw library objects
- [ ] Native IDs and canonical URLs when the platform supplies them
- [ ] Secret-like values redacted
- [ ] Errors normalized to the shared stop states
- [ ] Silent-empty results treated as protocol drift, not success

### Shared modules
Bind to these rather than copying them:

- [ ] `src/<p>-ipc-auth.ts` is a ~8-line binding over
      `createPlatformCommandMac` from `src/platform-command-mac.ts`
- [ ] `src/<p>-worker-http.ts` imports the body/signing/wipe helpers from
      `src/platform-worker-http.ts` and keeps only routing, readiness, and
      failure sanitisation
- [ ] `src/<p>-session-import.ts` is a schema module plus one
      `createOwnerSessionImportController` registration from
      `src/owner-session-import.ts`
- [ ] Append the controller to the `ownerSessionImports` list in `src/runtime.ts`
- [ ] `src/http.ts` is left unchanged — its `ownerSessionImport` option is
      already generic

### Core integration

These are the shared files that must actually change. The list is longer than a
per-platform file count suggests.

- [ ] `src/adapter.ts` — add the read/write request unions and extend `ReadRequest` / `WriteRequest`;
      add every kind to `WRITE_KIND_REGISTRY` and `READ_KIND_PLATFORM`
- [ ] `src/contract.ts` — `ContractAvailability.platform` union, both
      `enum: ["reddit","x"]` occurrences, `WRITE_KINDS`, the native-id schema,
      the per-platform route definitions, and the control-plane path entry
- [ ] `src/dispatcher.ts` — one `case` per operation
- [ ] `src/service.ts` — `importOwner<P>Session`, the `platform !== "<p>"` guard,
      and `READ_FIELDS` (write routing already reads the registry)
- [ ] `src/runtime.ts` — construct the adapter(s) and register them in the
      `adapters: [...]` array; add worker readiness probes and log fields
- [ ] `src/runtime-config.ts` — command key, worker URL, transport flag, and
      cross-key uniqueness
- [ ] `src/readiness.ts` — the certification platform union, `<p>Reachable`, and
      the required-ness rule
- [ ] `src/index.ts` — export the new modules
- [ ] Create `src/<p>-adapter.ts`, `src/<p>-production-adapter.ts`, and
      `src/runtime-<p>.ts`
- [ ] Create `src/<p>-worker-main.ts` and `src/<p>-worker-http.ts`
- [ ] `runtime/entrypoint.mjs` — map `"<p>-worker"` to the worker main
- [ ] Compose service for the worker, with its own command and egress networks

**Where the registries actually live.** `src/adapter.ts` holds the
`PlatformAdapter` interface and the kind-to-platform registries
(`WRITE_KIND_REGISTRY`, `READ_KIND_PLATFORM`), not the adapter instances. The adapter map is `src/service.ts` (`private readonly adapters =
new Map<string, PlatformAdapter>()`, populated from the constructor's `adapters`
array), and that array is assembled in `src/runtime.ts`
(`adapters: [adapter, xAdapter]`). Worker construction, readiness probing, and
shutdown live in `src/runtime.ts`, **not** in `service.ts`.

### The `admission_proofs` platform constraint
- [ ] If the platform uses the release-proof workflow, add it to
      `ADMISSION_PROOF_PLATFORMS` in `src/admission-proof.ts`;
      `ensureAdmissionProofSchema()` migrates existing databases on startup
- [ ] Extend `operationFor` and `writeRequest` for the new platform, or confirm
      the platform never reaches that path

### Platform registration points
- [ ] Add every new write kind to `WRITE_KINDS` in `src/contract.ts`
- [ ] Add each write kind to `WRITE_KIND_REGISTRY` and each read kind to
      `READ_KIND_PLATFORM` in `src/adapter.ts`, and extend `WritePlatform` /
      `ReadPlatform`; the compiler rejects a missing entry
- [ ] Never route by a kind's spelling: type guards must call
      `platformForWriteKind` / `platformForReadKind`

## Phase 4: Testing

### Deterministic tests
- [ ] Capability matrix verification, both directions of the mapping
- [ ] Protocol corpus parsing
- [ ] Normalization for every read operation
- [ ] Normalization for every write operation
- [ ] Secret redaction verification
- [ ] Worker boundary and IPC message tests
- [ ] Egress validation
- [ ] Fixture-only production-disabled state
- [ ] Idempotency for writes
- [ ] Crash-after-submit
- [ ] `UNKNOWN` recovery
- [ ] Every stop state: challenge, checkpoint, CAPTCHA, rate limit, wrong
      identity, revocation, protocol drift
- [ ] Per-write-kind stop matrix — the stop must hold for each write kind, not
      only one representative kind

### Test coverage
- [ ] No live credentials in tests
- [ ] No live platform calls in tests

### Test execution
- [ ] `npm test --prefix packages/<platform>-adapter`
- [ ] `npm test` — **no regression in any existing platform suite**
- [ ] `npm run typecheck`
- [ ] `npm run validate:openapi && npm run validate:product-docs`

## Phase 5: Documentation

### Package documentation
- [ ] `README.md` with source attribution, licence, supported and unsupported
      operations, protocol and egress requirements, and usage

### Product documentation
- [ ] Run `npm run generate:product-docs` — never hand-edit
      `docs/product-reset/capability-matrix.md`
- [ ] Add the hand-maintained capability-to-public-operation mapping for the new
      platform in `scripts/product-reset-docs.ts`; `capabilityMappingErrors()`
      fails on a missing or stale entry
- [ ] Update `docs/api-contract.md` if the REST/MCP surface changes
- [ ] Update `README.md` if the platform is user-facing

### Licence notices
- [ ] `THIRD_PARTY_NOTICES.md` with full licence text, attribution, and the
      source commit
- [ ] Add the package to `APPLICATION_NOTICE_EVIDENCE` in
      `tools/security/attest_runtime.py` with its licence list
- [ ] Add the copied files to the reviewed-source set in
      `tests/test_source_metadata.py`
- [ ] Verify the notice reaches the runtime image

## Phase 6: Supply chain review

### Dependency review
- [ ] No browser dependencies
- [ ] No official platform API dependencies
- [ ] All dependencies pinned to exact versions
- [ ] Review all transitive dependencies

### Image review
- [ ] Build the Docker image
- [ ] Generate the SBOM
- [ ] Verify no browser components in the SBOM
- [ ] Verify no official API clients in the SBOM
- [ ] Verify the adapter source and notices are in the image
- [ ] Update `security/runtime-dependency-review.json` through its approved
      regeneration process
- [ ] Run the Python security tests in `tests/`

### Reproducibility
- [ ] Build the image twice from the same source and compare digests
- [ ] Verify SBOMs and source manifests match

## Phase 7: Core integration verification

### Service integration
- [ ] Worker starts, health check passes, Core reaches it
- [ ] Command dispatch and result ingestion work
- [ ] Worker isolation (no DB access) and egress isolation hold

### Contract integration
- [ ] `npm run generate:openapi`
- [ ] `npm run validate:openapi`
- [ ] MCP tools generated
- [ ] Capability matrix regenerated and validated

### End-to-end tests
- [ ] Action lifecycle, idempotency, and `UNKNOWN` handling
- [ ] The web UI shows the platform honestly
- [ ] **No regression in the existing platform suites** — run the Reddit and X
      platform tests explicitly and confirm the counts have not changed

## Phase 8: Admission gates (deterministic)

- [ ] Document how endpoint evidence was obtained and record public asset hashes
- [ ] Record GraphQL operation IDs if applicable
- [ ] Implement any required transaction header and prove its format
- [ ] All operations work in fixture mode
- [ ] Production is disabled by default
- [ ] Admission gates are enforced at the worker
- [ ] The worker returns `NOT_ADMITTED` when gates fail

## Phase 9: Live proof (separate QA gate)

**Note**: this phase requires separate QA authorization and dedicated test
accounts. It is not part of the development implementation, and no developer
receives live social credentials.

### Identity proof
- [ ] Authorized QA obtains a dedicated test account
- [ ] Expected native identity documented
- [ ] Session material obtained through an external, human-controlled bootstrap
- [ ] Session material imported
- [ ] Identity verification succeeds

### Read proof
- [ ] Bounded read operations succeed with native IDs and canonical URLs
- [ ] Pagination works
- [ ] Rate limit and challenge behaviour verified

### Write proof (separate approval)
- [ ] Separate approval for write operations
- [ ] Bounded write succeeds with native ID and canonical URL
- [ ] Idempotency, crash-after-submit, and reconciliation verified

### Admission decision
- [ ] All live evidence reviewed
- [ ] Independent QA records GO/NO-GO
- [ ] Admission gates updated to true in a reviewed source commit
- [ ] `productionEnabled` set to true and `disabledReasons` cleared
- [ ] Live proof never substitutes for deterministic evidence

## Phase 10: Release preparation

- [ ] `npm run verify`
- [ ] Deterministic acceptance harness passes
- [ ] Release images build and reproduce
- [ ] SBOMs match the review
- [ ] Release notes document supported operations, admission evidence, and known
      limitations
- [ ] Tag the release commit

## Post-release

- [ ] Monitor for protocol drift, rate-limit changes, and auth changes
- [ ] Refresh endpoint evidence periodically
- [ ] Keep the protocol corpus current
- [ ] Re-run the admission process after any major upstream change
