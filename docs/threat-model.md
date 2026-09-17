# Social Git Reddit MVP threat model

Status: security design review; release verdict **NO-GO** until the release gates in this document have implementation evidence.

Review date: 2026-09-14

Reviewed baseline: `d602f94` (`chore: bootstrap Social Git architecture`)

## Scope and review limits

This review covers the Reddit-first service described by `README.md` and `AGENTS.md`: a multi-tenant core, encrypted account sessions and network routes, isolated platform workers, stable REST and MCP surfaces, a durable action ledger, SQLite storage, backups, and an external human session-bootstrap process.

The original reviewed baseline contained no application source, package manifest, lockfile, container image, or software bill of materials (SBOM). The runtime packaging closure now supplies the missing SG-SEC-012/TM-08 implementation evidence: a digest-pinned multi-platform image, a complete reviewed dependency lock, direct OCI filesystem inspection, per-architecture SPDX SBOMs, exact digest comparison across independent builds, and a release-blocking CI gate. The overall Reddit MVP remains NO-GO until the other findings in this model are closed and the integrated artifact is independently rechecked.

No live credentials were accessed, and no social read or write was executed.

## Security objectives

1. A caller can act only in its tenant, on an explicitly authorized account, using an explicitly authorized operation.
2. A native session can be used only for its bound platform, tenant, account, expected native identity, purpose, and current generation.
3. A worker compromise cannot yield database access, encryption keys, another account's session, or unrestricted network access.
4. A write is never repeated after submission may have begun unless a human authorizes a new action after reconciliation.
5. Challenge, checkpoint, CAPTCHA, rate-limit, identity mismatch, revocation, and protocol drift stop work instead of triggering evasion.
6. Secrets do not enter API results, logs, audit events, crash reports, metrics, traces, database journals, backups, build artifacts, or test fixtures.
7. The production dependency closure contains no browser runtime and no client for Reddit's official OAuth/API surface.

## Assets and data classification

| Asset | Classification | Required handling |
| --- | --- | --- |
| Session cookies, CSRF values, access tokens, MFA material, proxy credentials, decrypted session envelopes | Secret | Never returned or logged. Encrypt at rest. Decrypt only in the core for one fenced job. Zero/discard promptly. |
| Key-encryption keys and data-encryption keys | Secret | Separate from the database and backups. Purpose-scoped access. Rotation and revocation are audited. |
| Tenant, account, expected native identity, route assignment, revocation generation | Confidential integrity data | Tenant-scoped storage and authorization. Include in authenticated encryption context where applicable. |
| Write authorization, idempotency records, action state, payload digest | Confidential integrity data | Durable before dispatch. Append-only state transitions. Retain long enough to prevent replay. |
| Audit events | Confidential | Allowlisted schemas, restricted read access, tamper evidence, retention policy, no raw platform payloads. |
| Native post/comment identifiers and canonical URLs | Potentially confidential | Return only to an authorized caller. Validate and normalize before storage or output. |
| Core media bytes, digest, and phase state | Confidential | Bind to caller and account, cap decoded content at 8 MiB, keep upload credentials worker-only, and retain a durable submit boundary. |
| Source, lockfiles, SBOM, dependency review | Internal integrity data | Reviewable, exact-versioned, and bound to the released artifact digest. |

## Actors and minimum trust boundaries

```text
API caller
    | authenticated tenant and scopes
    v
API boundary -> policy/core -> encrypted SQLite + WAL
                       |
                       | versioned, bounded, request-bound IPC
                       v
                 isolated Reddit worker -> fixed egress/proxy -> Reddit

Session custodian -> secret import boundary -> policy/core
Build system -> pinned dependency closure -> signed runtime artifact
Backup operator <- ciphertext-only backups; no decryption key access
Independent QA -> separately approved canary live task; no developer credentials
```

The worker and all platform responses are untrusted. The database is not reachable by workers. API authentication does not by itself authorize an account or a write. A network route is secret configuration, not caller-provided request data.

## Mandatory security invariants

| ID | Invariant | Minimum evidence before release |
| --- | --- | --- |
| SG-SEC-001 | Every lookup and mutation is scoped by `tenant_id`; account-native identifiers are never globally authoritative. | Cross-tenant tests for account, route, action, idempotency, and audit APIs plus tenant-scoped database constraints. |
| SG-SEC-002 | Session and route envelopes use an authenticated encryption scheme with a fresh nonce and authenticated context containing schema version, platform, tenant, account, purpose, and generation. | Wrong-context, nonce, ciphertext, generation, and key-rotation tests; database and WAL inspection finds no known plaintext canary. |
| SG-SEC-003 | Import and refresh verify the observed native identity against the stored expected identity using a read-only operation. Mismatch quarantines the account. | Wrong-identity and stale-generation tests; no worker dispatch after mismatch or revocation. |
| SG-SEC-004 | Writes require caller, tenant, account, capability, resource, and operation authorization. Delete additionally proves caller ownership. | Denial matrix for each write and resource ownership boundary. |
| SG-SEC-005 | Idempotency uniqueness is at least `(caller, tenant, account, operation, key)`. A repeated key with a different canonical payload digest fails closed. | Concurrency, cross-caller, cross-account, payload-mismatch, restart, and retention tests. |
| SG-SEC-006 | The action ledger is durable before dispatch. `dispatch_started` or any later ambiguous crash becomes `UNKNOWN`; it is never automatically retried. | Kill-point tests before dispatch, during submit, after submit, and before result persistence; read-only reconciliation tests. |
| SG-SEC-007 | IPC is schema-versioned, size/depth bounded, request-correlated, capability bounded, and rejects unknown fields/types. Worker output never selects tenant, account, route, or authorization. | Fuzz and malformed-message tests, oversized payload tests, peer/request mismatch tests, and late-response fencing tests. |
| SG-SEC-008 | Workers run as a distinct non-root identity with no database/key access, a read-only filesystem, resource limits, and egress restricted to the assigned route and admitted Reddit endpoints. | Container/process policy inspection plus tests for loopback, link-local, private, metadata, DNS-rebinding, alternate-scheme, redirect, and proxy-override attempts. |
| SG-SEC-009 | Challenge, checkpoint, CAPTCHA, rate limit, wrong identity, revocation, and protocol drift open an account/route/platform circuit breaker. No account or route rotation is used to evade a platform control. | Fixture tests for every stop signal and proof that queued writes remain stopped. |
| SG-SEC-010 | Platform responses are treated as hostile: byte/depth/item/time bounds, strict schema decoding, safe URL canonicalization, no active HTML rendering, and no library object leakage. | Oversize, decompression, deep nesting, malformed Unicode, hostile URL, HTML/script, and unknown-schema fixtures. |
| SG-SEC-011 | Secret fields are structurally excluded from logs, errors, audit records, traces, metrics, and crash output; redaction is a second defense. | Canary-secret capture tests across success and every normalized error. |
| SG-SEC-012 | Production dependencies are exactly pinned and source-reviewed; the final artifact SBOM is denied if it contains browser automation/runtime packages or an official-API Reddit client. | `security/runtime-dependency-review.json`; `tools/security/attest_runtime.py`; two digest-bound SPDX SBOMs; `.github/workflows/runtime-supply-chain.yml`; and `tools/security/check_repository_policy.py --sbom ...`. |

## Threat register and required controls

### TM-01 — session theft or replay

An attacker who reads the database, WAL, a backup, logs, a crash dump, or a worker message attempts to reuse a native session.

- Encrypt session and network-route fields independently with fresh nonces and the SG-SEC-002 context binding. Keep the key-encryption key outside SQLite and outside database backups.
- Give a worker only the single decrypted session and route required for a fenced job. Do not persist them in worker storage or include them in exceptions.
- Increment a durable generation on refresh, revocation, identity mismatch, and suspected theft. Reject leases, envelopes, and results from older generations.
- Treat host/core compromise as capable of stealing active sessions. Mitigate with least privilege, short worker exposure, rotation, revocation, and auditable key access; encryption at rest does not solve an active core compromise.

Residual risk: **high** until envelope misuse tests, plaintext-canary storage tests, and key separation are demonstrated.

### TM-02 — tenant, account, or identity confusion

A valid caller supplies another tenant's account identifier, a reused native identifier, or a session for the wrong Reddit identity.

- Derive tenant and caller from authenticated server context, never from a trusted request-body claim.
- Use composite tenant/account keys and tenant-scoped foreign keys for routes, actions, idempotency, and audit data.
- Before the first read or any write after import/refresh, fetch the native identity through a read-only adapter operation and compare a canonical immutable identifier, not only a display name.
- Quarantine on mismatch. Never “helpfully” update expected identity from the observed session.

Residual risk: **critical release blocker** until cross-tenant and wrong-identity tests pass.

### TM-03 — privilege-boundary failure

An API user, session custodian, developer, worker, backup operator, or reviewer gains a capability outside its role.

- Enforce authorization inside the core immediately before ledger creation and again before worker dispatch. Adapter capability declarations cannot grant policy.
- Separate session import, write grant, code deployment, backup custody, security review, and live QA roles as defined below.
- Workers cannot query policy or choose a broader operation. A job capability is single-use and names the exact operation/account/action/generation.

Current control: the default-deny role map, bounded grant model, and persistent live-authorization ledger are implemented in `packages/security/src/index.js`. `src/live-execution.ts` connects that boundary to the durable API action and encrypted session runtime. The release remains blocked until an independent reviewer rechecks the integrated path.

### TM-04 — worker compromise and IPC injection

A compromised dependency or malicious response controls the worker and attempts database access, arbitrary egress, confused-deputy IPC, oversized-message denial of service, or false success.

- Run workers outside the core trust boundary with no database path, encryption key, admin socket, sibling process access, or reusable credentials.
- Authenticate/localize the IPC peer, frame messages with a strict maximum before allocation, validate schemas with unknown-field rejection, bind request/action/generation, and fence late or duplicate results.
- Core decides tenant, account, route, authorization, and state transition. Worker-reported URLs, identifiers, errors, rate data, and success are normalized and validated.
- Ordinary control IPC remains small. The one media command envelope is capped
  at 12 MiB, while Core and worker separately verify an 8 MiB decoded-image
  bound, canonical encoding, exact byte count, and SHA-256 digest.

Residual risk: **critical release blocker** until sandbox, egress, and malformed IPC evidence exists.

### TM-05 — SQLite, WAL, temporary-file, and backup leakage

SQLite pages, `-wal`/`-shm` files, temporary files, filesystem snapshots, or backups retain secrets.

- Store only authenticated ciphertext for secret fields so journal modes cannot reveal plaintext. Use restrictive directory/file permissions and a dedicated core UID.
- Do not put plaintext in indexed columns, SQL parameters logged by instrumentation, FTS, temporary tables, or migration backups.
- Take transactionally consistent encrypted backups; encrypt the backup again with a backup-specific key. Exclude service keys and secret-manager state. Test restores in an isolated environment and securely expire old copies.
- Inspect the database, WAL, SHM, backup, and process output for a unique canary after import, rotation, checkpoint, and restore.

Residual risk: **high** until storage and restore canary tests pass.

### TM-06 — SSRF, proxy abuse, and control bypass

A caller-controlled route, URL, redirect, DNS answer, or platform response reaches localhost, metadata services, private networks, alternate proxies, or arbitrary destinations. Automatic route rotation could also evade a rate limit or challenge.

- Only a privileged session/network custodian can provision a route. Calls reference a server-side route ID; they cannot supply a URL or proxy setting.
- Permit only explicit proxy schemes. Reject userinfo in non-secret fields, unsupported schemes, IP literals where not required, loopback, unspecified, private, link-local, multicast, reserved ranges, and cloud metadata endpoints after each DNS resolution and redirect.
- Pin worker egress at the network layer to the assigned proxy and admitted Reddit hosts. Ignore environment proxy variables and platform-supplied proxy/redirect overrides.
- Outbound webhooks use an HTTPS-only Core client that resolves once, rejects
  the complete answer set on any non-public/mapped/reserved address, pins the
  selected address into certificate-verified TLS, ignores proxy environment,
  does not follow redirects, and bounds DNS plus response time and bytes.
- Media upload authority admits only
  `reddit-uploaded-media.s3-accelerate.amazonaws.com`; processing admits only
  `wss://wss.redditmedia.com`. Both use public-address DNS pinning, SNI and peer
  checks, fixed deadlines, byte limits, and no Reddit session cookies. Redirect,
  alternate-host, private-address, and DNS-rebinding attempts fail closed.
- Circuit-break on rate/challenge/checkpoint signals. Do not rotate accounts or routes to continue the operation.

Residual risk: **critical release blocker** until network-policy and DNS/redirect tests pass.

### TM-07 — request replay, collision, and crash-after-submit

Concurrent callers reuse an idempotency key or a crash makes submission outcome ambiguous, causing duplicate social actions.

- Canonicalize and hash the authorized request. Atomically insert a ledger record with the fully scoped uniqueness key before dispatch.
- Same scope/key plus same hash returns the original action; a different hash fails. Different callers, tenants, accounts, or operations do not alias.
- Persist a pre-dispatch state and transition to `dispatch_started` before crossing the worker boundary. After that transition, timeout, worker death, core crash, lost IPC, or malformed confirmation yields `UNKNOWN`.
- Reconciliation is read-only, separately bounded, and cannot silently turn absence into permission to retry.
- Media has finer durable phases: `reserved`, `leased`, `uploaded`,
  `submitting`, `submitted`, and `processed`. Lease and upload may recover before
  submit. Core atomically records `submitting` before the only submit call. A
  restart or failure at that phase or later is `UNKNOWN`; the action is never
  requeued. Only an opaque bounded worker ticket crosses back to Core.

Residual risk: **critical release blocker** until concurrency and every kill point are deterministic tests.

### TM-08 — dependency or build compromise

A direct/transitive package introduces a browser runtime, official Reddit API client, credential exfiltration, install script, typosquat, or compromised release.

- Admit dependencies only after source, maintainer, release, license, transitive, and install-script review. Pin exact versions and integrity hashes; generate reproducible lockfiles and an SBOM.
- Build with network disabled after dependency fetch where practical. Run as non-root with a read-only image and no compilers/package managers in the runtime stage.
- Apply the repository admission test in this change and scan the final runtime SBOM. The SBOM must be tied to the exact image digest; scanning only direct manifest entries is insufficient.

Implementation evidence: `security/runtime-dependency-review.json` locks the complete final-image closure, including architecture-specific content and install-script hashes. `tools/security/attest_runtime.py` verifies OCI compressed and uncompressed digests, non-root execution, closure parity, the review lock, and forbidden runtime/configuration content before it emits one image-digest-bound SPDX document per architecture. `.github/workflows/runtime-supply-chain.yml` performs two cache-free, network-isolated builds, requires exact OCI object equality, and applies `tools/security/check_repository_policy.py` to both full transitive SBOMs. Unknown, unreviewed, forbidden, or architecture-drifted content fails the release job.

Supporting protocol evidence for exact-item lookup and media is pinned to PRAW
`8.0.3`, commit `fdc29bb103ad652eea6740c77c2be099d1c1357e`, with four Git
blob IDs and SHA-256 digests in the protocol corpus. PRAW is not installed or
linked, and its OAuth client, transport, credential storage, and retry behavior
remain excluded. The primary session-protocol source admission remains the
bounded `reddit-lyr` corpus.

Residual risk: **independent recheck required** against the integrated release digest. The packaging evidence closes the implementation gap but does not waive the separate reviewer or the other release findings.

### TM-09 — malicious or drifting platform responses

Reddit or an on-path service returns oversized, recursive, malformed, deceptive, active-content, or schema-drifted data.

- Bound compressed and decompressed bytes, JSON depth, collection length, string length, redirect count, and total time before parsing or storage.
- Normalize only allowlisted fields. Validate native identifiers and canonical URLs; never render returned HTML in an operator surface without separate sanitization.
- Unknown required fields, incompatible schema, impossible identity, or changed write confirmation becomes `PROTOCOL_DRIFT`/`UNKNOWN` and opens the circuit breaker.
- Media lease fields, upload acknowledgement, WSS frames, redirect URL, native
  fullname, and canonical URL use separate strict schemas. A malformed
  pre-submit response fails; malformed evidence after submit is `UNKNOWN`.

Residual risk: **high** until hostile fixture and drift tests pass.

### TM-10 — challenge or rate-limit bypass

Retries, concurrency, route rotation, or account rotation evade a platform challenge or limit.

- Normalize stop signals centrally. Stop new and queued operations at account, route, and platform scope as indicated.
- Honor server retry windows with a conservative local floor and bounded jitter for reads only. Never retry an ambiguous write.
- Require explicit human recovery after challenge/checkpoint/CAPTCHA or repeated drift. Preserve evidence without preserving secrets.

Residual risk: **high** until circuit-breaker concurrency tests pass.

### TM-11 — audit-log disclosure or tampering

Audit events leak session material or attacker-controlled platform data, or a privileged actor edits the record of a write.

- Use per-event allowlists. Record opaque internal IDs, action state, policy decision ID, reason code, actor, time, and hashes where required; never serialize requests, headers, library objects, session envelopes, proxy URLs, or raw platform bodies.
- Escape control characters, bound values, restrict audit readers, separate retention/export permission, and make events append-only with integrity monitoring.
- Authenticate action, webhook, and identity streams as contiguous HMAC chains,
  commit their heads atomically, and retain verified heads off-host so rollback
  and tail truncation remain detectable after full-database compromise.
- Project identity events through a transactional outbox with stable IDs,
  ordered replay, and an idempotent public projection; never mirror directly
  across the two SQLite databases inside an identity mutation.
- Use canary-secret tests on every error and state transition. Hashes of low-entropy secrets are also secrets and are prohibited.

Residual risk: **high** until capture and tamper tests pass.

## Credential and access separation by role

`ROLE_PERMISSIONS` in `packages/security/src/index.js` is the executable positive grant list. `RoleAuthority` resolves immutable principals from trusted runtime bindings; request data cannot self-assert a role. `assertPermission` denies untrusted, missing, unknown, and unlisted grants. The denial matrix in `packages/security/test/live-authorization.test.js` covers every role.

| Role and runtime key | Only granted permissions | Important denials |
| --- | --- | --- |
| Platform/security administrator (`platform_security_admin`) | Manage role policy, view account/route metadata, revoke accounts | Plaintext sessions, live-test approval/execution, routine writes |
| Session/network custodian (`session_network_custodian`) | Import sessions, provision route secrets, enter expected identity | Write grants, live-test approval, core decrypt, routine writes |
| API caller (`api_caller`) | Caller-scoped reads and separately scoped writes | Session import/export, route secrets, core decrypt, live-test execution |
| Core runtime identity (`core_runtime`) | Core database, one fenced secret decrypt, consume live authorization | Session custody, test approval/execution, arbitrary secret enumeration |
| Platform worker identity (`platform_worker`) | One fenced platform job and its assigned egress | Database, backups, key service, role policy, other accounts |
| Developer (`developer`) | Source, synthetic fixtures, redacted telemetry | All live credentials, live reads/writes, test approval/execution |
| Researcher (`researcher`) | Source, synthetic fixtures, redacted telemetry | All live credentials, live reads/writes, test approval/execution |
| Security reviewer (`security_reviewer`) | Review security evidence and approve a bounded live test | Core decrypt, routine writes, execution of the approved test |
| Backup operator (`backup_operator`) | Ciphertext backup transport | Core database use, service keys, decrypt, security evidence |
| Independent live QA operator (`independent_live_qa`) | Execute one registered and bounded live-test grant | Credential access, routine writes, approval, general production access |

At least two independent authorities are required for a live write proof: one approves the bounded authorization and the independent QA operator executes it. The session custodian must not be the sole write approver. Developers and researchers receive no live session material.

## Live-test authorization model

Live testing is outside ordinary CI and requires a separately authorized task. The authorization record must bind:

- exact environment and immutable build/image digest;
- owner-authorized canary account and expected immutable native identity;
- server-side network route ID;
- named QA operator and independent approver;
- read operations and write operations as separate allowlists;
- exact resource constraints, maximum action counts, and cleanup action;
- start and expiry timestamps, with no renewal by the runtime;
- admitted dependency/SBOM revision and completed deterministic test evidence.

`approveLiveTestGrant` implements this record as an immutable object. It additionally binds the session generation, logical ledger ID, SBOM digest, deterministic-test evidence digest, exact resource constraints, and cleanup operation. It rejects wildcards and generic `read`, `write`, or `all` operation names.

The approval boundary requires an `independent_live_qa` executor and a `security_reviewer` approver. Their immutable actor IDs must differ. No other role can approve or execute the grant.

`LiveAuthorizationLedger.registerGrant` records the approved grant fingerprint, logical ledger ID, and action limit in SQLite. Only an object issued by the approval boundary can create this durable record. The same authorization ID cannot bind a different fingerprint.

Immediately before dispatch, `authorizeAndRecord` verifies the registered fingerprint and every current request binding. It verifies the environment, artifact, SBOM, test evidence, account, native identity, session generation, route, exact operation, resource constraints, QA operator, time window, ledger, replay state, and action count. One `BEGIN IMMEDIATE` transaction records the action before any secret lease or worker dispatch. Replay remains denied after a process restart.

Default authorization is read-only. Each write class needs explicit approval; a generic “Reddit write” grant is invalid. The core consumes a one-time authorization identifier into the action ledger. It does not consume cookies or approval text from the test operator. Credentials are injected through the secret boundary just in time and are not shown to the operator or retained in test output.

`LiveTestController` accepts only the `core_runtime` role. The API action and a `PENDING` live-authorization action are durable before `SessionRuntime` decrypts the session and route for one versioned command. The command binds the action ID, account, platform, expected identity, generation, route, exact operation, resource constraints, lease ID, fence, and expiry. Dispatch receives only this constructed command; it does not receive a reusable secret lease.

The test stops immediately on wrong identity, revoked/stale generation, challenge, checkpoint, CAPTCHA, rate limit, protocol drift, unexpected redirect/host, policy denial, or `UNKNOWN`. An `UNKNOWN` result is investigated and reconciled read-only; it is never repeated automatically. Evidence contains action IDs, normalized states, native IDs/URLs when safely returned, artifact digest, policy decision IDs, and redacted timestamps—not raw traffic or credentials.

The ledger makes every stop reason terminal for the authorization. A dispatch exception becomes `UNKNOWN`; malformed or secret-like worker evidence becomes `PROTOCOL_DRIFT`. On startup, an incomplete `PENDING` action becomes terminal `UNKNOWN`, the matching API action is synchronized to `UNKNOWN`, and all later actions under the grant remain stopped.

## Dependency and runtime verification gate

Run the repository admission checks:

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 tools/security/check_repository_policy.py
node --test --test-reporter=spec packages/security/test/*.test.js
```

For the release candidate, generate both SPDX JSON SBOMs from the final multi-platform runtime, bind them to the index and per-platform manifest/layer digests, then run:

```bash
python3 tools/security/check_repository_policy.py \
  --sbom path/to/linux-amd64.spdx.json \
  --sbom path/to/linux-arm64.spdx.json
```

The gate denies known browser automation/runtime packages, browser executables in production container definitions and final layers, CDP tooling, known Reddit official-API clients, official OAuth/API endpoints or configuration, and forbidden components in the supplied SBOMs. It also denies incomplete architecture sets, missing digest bindings, and components whose version, source, license, install-script, or installed-content evidence differs from the committed review.

## Blocking engineering findings

The independent review recorded these findings as engineering-owned child issues. Each is also a first-class blocker of the Reddit MVP release issue:

| Finding | Owner | Required closure |
| --- | --- | --- |
| [DYN-35](/DYN/issues/DYN-35) — Block worker SSRF, IPC injection, and route-control bypass | Reddit Adapter Engineer | SG-SEC-007 through SG-SEC-010 evidence for sandboxing, fixed egress, strict IPC, hostile responses, and stop signals. |
| [DYN-36](/DYN/issues/DYN-36) — Enforce credential roles and bounded live-test authorization | Social Git Engineering Lead | Enforced role denial matrix and artifact/account/operation/time-bound independent QA authorization. |
| [DYN-37](/DYN/issues/DYN-37) — Attest the final browser-free production dependency closure | Runtime Packaging Engineer | Exact-image ARM64/AMD64 SBOM and runtime inspection, including transitive components. |
| [DYN-38](/DYN/issues/DYN-38) — Prove SQLite, WAL, backup, and audit-log secrecy | Session Runtime Engineer | Encryption-context and plaintext-canary evidence across persistence, backup, telemetry, and crash sinks. |

## Required release evidence and verdict

The Reddit MVP remains **NO-GO** until all of the following are true:

1. SG-SEC-001 through SG-SEC-012 have implementation and deterministic evidence.
2. All critical release blockers in this threat model are closed by engineering and independently rechecked.
3. The final runtime SBOM and image inspection prove the production closure has no browser runtime and no official-API Reddit client.
4. Database, WAL, backup, logs, audit events, traces, metrics, and crash output pass plaintext-canary inspection.
5. Crash-after-submit kill-point tests prove `UNKNOWN` recovery without automatic replay.
6. Worker sandbox, bounded IPC, fixed egress, SSRF/DNS/redirect, challenge, and rate-limit gates pass.
7. The independent QA plan passes against the immutable integration artifact. Any live proof uses the authorization model above and a separate task.
