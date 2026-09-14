# Social Git Reddit MVP threat model

Status: security design review; release verdict **NO-GO** until the release gates in this document have implementation evidence.

Review date: 2026-09-14

Reviewed baseline: `d602f94` (`chore: bootstrap Social Git architecture`)

## Scope and review limits

This review covers the Reddit-first service described by `README.md` and `AGENTS.md`: a multi-tenant core, encrypted account sessions and network routes, isolated platform workers, stable REST and MCP surfaces, a durable action ledger, SQLite storage, backups, and an external human session-bootstrap process.

The reviewed baseline contains no application source, package manifest, lockfile, container image, or software bill of materials (SBOM). Consequently, this review can define mandatory controls and add a dependency-policy regression gate, but it cannot attest that a future production dependency closure or runtime image is browser-free or free of clients for Reddit's official API. That attestation is a release gate, not an assumption.

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
| SG-SEC-012 | Production dependencies are exactly pinned and source-reviewed; the final artifact SBOM is denied if it contains browser automation/runtime packages or an official-API Reddit client. | Admission record, hashes/lockfile, SBOM tied to image digest, and `tools/security/check_repository_policy.py --sbom ...`. |

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

Residual risk: **critical release blocker** until the authorization denial matrix and runtime identities are implemented.

### TM-04 — worker compromise and IPC injection

A compromised dependency or malicious response controls the worker and attempts database access, arbitrary egress, confused-deputy IPC, oversized-message denial of service, or false success.

- Run workers outside the core trust boundary with no database path, encryption key, admin socket, sibling process access, or reusable credentials.
- Authenticate/localize the IPC peer, frame messages with a strict maximum before allocation, validate schemas with unknown-field rejection, bind request/action/generation, and fence late or duplicate results.
- Core decides tenant, account, route, authorization, and state transition. Worker-reported URLs, identifiers, errors, rate data, and success are normalized and validated.

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
- Circuit-break on rate/challenge/checkpoint signals. Do not rotate accounts or routes to continue the operation.

Residual risk: **critical release blocker** until network-policy and DNS/redirect tests pass.

### TM-07 — request replay, collision, and crash-after-submit

Concurrent callers reuse an idempotency key or a crash makes submission outcome ambiguous, causing duplicate social actions.

- Canonicalize and hash the authorized request. Atomically insert a ledger record with the fully scoped uniqueness key before dispatch.
- Same scope/key plus same hash returns the original action; a different hash fails. Different callers, tenants, accounts, or operations do not alias.
- Persist a pre-dispatch state and transition to `dispatch_started` before crossing the worker boundary. After that transition, timeout, worker death, core crash, lost IPC, or malformed confirmation yields `UNKNOWN`.
- Reconciliation is read-only, separately bounded, and cannot silently turn absence into permission to retry.

Residual risk: **critical release blocker** until concurrency and every kill point are deterministic tests.

### TM-08 — dependency or build compromise

A direct/transitive package introduces a browser runtime, official Reddit API client, credential exfiltration, install script, typosquat, or compromised release.

- Admit dependencies only after source, maintainer, release, license, transitive, and install-script review. Pin exact versions and integrity hashes; generate reproducible lockfiles and an SBOM.
- Build with network disabled after dependency fetch where practical. Run as non-root with a read-only image and no compilers/package managers in the runtime stage.
- Apply the repository admission test in this change and scan the final runtime SBOM. The SBOM must be tied to the exact image digest; scanning only direct manifest entries is insufficient.

Current finding: the baseline has no production dependency graph or image, so absence is **not verified**. This is a blocking release finding.

### TM-09 — malicious or drifting platform responses

Reddit or an on-path service returns oversized, recursive, malformed, deceptive, active-content, or schema-drifted data.

- Bound compressed and decompressed bytes, JSON depth, collection length, string length, redirect count, and total time before parsing or storage.
- Normalize only allowlisted fields. Validate native identifiers and canonical URLs; never render returned HTML in an operator surface without separate sanitization.
- Unknown required fields, incompatible schema, impossible identity, or changed write confirmation becomes `PROTOCOL_DRIFT`/`UNKNOWN` and opens the circuit breaker.

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
- Use canary-secret tests on every error and state transition. Hashes of low-entropy secrets are also secrets and are prohibited.

Residual risk: **high** until capture and tamper tests pass.

## Credential and access separation by role

| Role | May access | Must not access |
| --- | --- | --- |
| Platform/security administrator | Role policy, key references, account/route metadata, revocation controls | Plaintext sessions, routine write authority, developer tooling with live credentials |
| Session/network custodian | External bootstrap output, session import, route secret provisioning, expected identity entry | Write grants, code deployment, audit deletion, bulk session export |
| Core runtime identity | SQLite, one purpose-scoped key operation, selected session/route decrypt for a fenced job | Build credentials, control-plane admin, arbitrary secret enumeration |
| Platform worker identity | One short-lived job/session/route capability and required egress | SQLite/WAL/backups, key service, other accounts, general network, control-plane APIs |
| API caller | Explicit tenant/account read scopes and separately granted write scopes | Session import/export, route secrets, operations not named by scope |
| Developer or researcher | Source, synthetic fixtures, redacted telemetry, local test keys | Live social credentials, production database/backups, live social actions |
| Security reviewer | Policy/configuration, SBOM, audit metadata, synthetic evidence | Session decrypt, routine live writes, approval and execution of the same live test |
| Backup operator | Ciphertext database backup and restore transport | Service encryption keys, plaintext verification data |
| Independent live QA operator | One approved canary task, artifact, account, route, operation set, and time window | General production access, developer credentials, unapproved mutations, credential export |

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

Default authorization is read-only. Each write class needs explicit approval; a generic “Reddit write” grant is invalid. The core consumes a one-time authorization identifier into the action ledger. It does not consume cookies or approval text from the test operator. Credentials are injected through the secret boundary just in time and are not shown to the operator or retained in test output.

The test stops immediately on wrong identity, revoked/stale generation, challenge, checkpoint, CAPTCHA, rate limit, protocol drift, unexpected redirect/host, policy denial, or `UNKNOWN`. An `UNKNOWN` result is investigated and reconciled read-only; it is never repeated automatically. Evidence contains action IDs, normalized states, native IDs/URLs when safely returned, artifact digest, policy decision IDs, and redacted timestamps—not raw traffic or credentials.

## Dependency and runtime verification gate

Run the repository admission checks:

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 tools/security/check_repository_policy.py
```

For the release candidate, generate a CycloneDX or SPDX JSON SBOM from the final runtime image and bind it to the image digest, then run:

```bash
python3 tools/security/check_repository_policy.py --sbom path/to/runtime.sbom.json
```

The gate denies known browser automation/runtime packages, browser executables in production container definitions, known Reddit official-API clients, official OAuth/API endpoints in production source, and forbidden components in the supplied SBOM. It is an admission defense, not a replacement for source review and final-image inspection.

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
