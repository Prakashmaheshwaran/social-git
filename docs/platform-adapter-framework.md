# Platform Adapter Framework

This document defines how a new social platform adapter is added to Social Git.
It describes the code as it exists today, verified against the repository at the
commit that introduced the shared worker and session-import modules.

Advertising a capability and admitting one are different acts. Nothing in this
document authorizes live support; see
[`platform-adapter-checklist.md`](platform-adapter-checklist.md) for the gates.

## The two halves of an adapter

An adapter is not one module. It is two layers with different rules:

1. **`packages/<platform>-adapter/`** — the protocol layer. Per-platform work:
   request builders, response normalizers, the session transport, the fixture
   corpus, and the capability array. This stays platform-specific; measured
   similarity between the Reddit and X packages is low precisely because it is
   real protocol code.
2. **`src/` integration** — the Core boundary. Adapter bridges, worker bootstrap,
   worker HTTP, IPC authentication, session import, and every shared registry the
   Core consults.

A new platform touches roughly 65–70 files. Most of the `src/` scaffolding is
duplicated between Reddit and X, and the shared modules below have already
absorbed the largest of those duplicates.

## Package structure

The package layout that actually exists. Names matter: several plausible-sounding
files do not exist.

```
packages/<platform>-adapter/
├── package.json            # workspaces member; engines.node 26.9.0; export "." → src/index.mjs
├── README.md
├── THIRD_PARTY_NOTICES.md  # copied into the runtime image; attested by digest
├── src/
│   ├── index.mjs           # public barrel
│   ├── index.d.ts          # hand-maintained declarations
│   ├── contract.mjs        # capability array + contract error + fixture assertions
│   ├── protocol-corpus.mjs # pinned request builders
│   ├── protocol-normalizers.mjs   # fixture normalization + entity field allowlists
│   ├── session-connector.mjs      # header/cookie construction, caller-header rejection
│   ├── session-transport.mjs      # identity check + single-attempt writes
│   ├── validation.mjs             # bounded input validation
│   └── worker-result-schema.mjs   # per-operation result schemas
└── test/
    └── *.test.mjs
```

Reality checks that contradict older drafts of this document:

- `packages/reddit-adapter/src/admission.mjs` **does not exist**. Reddit's
  admission facts live in `contract.mjs` as per-capability `productionEnabled`
  flags derived from `protocolMapping`.
- `normalizer.mjs` and `transport.mjs` **do not exist** in either package. The
  real names are `protocol-normalizers.mjs` + `production-normalizers.mjs`, and
  `session-transport.mjs`.
- The X package adds `admission.mjs`, `production-normalizers.mjs`,
  `fixture-corpus.mjs`, `recorded-corpus.mjs`, `transaction-id.mjs`, and
  `index.d.mts`. The Reddit package instead has `fixture-adapter.mjs`,
  `fixture-worker.mjs`, and `messaging-admission.mjs`. Per-platform modules are
  not a fixed list; the mandatory set is `index`, `contract`, and enough of the
  rest to satisfy the contract tests.

## Capability definition

Capabilities are an **array**, not an object keyed by operation. The Reddit array
is `REDDIT_CAPABILITIES`; X is `X_CAPABILITIES`. Each entry is frozen and has this
shape:

```javascript
{
  operation: "profile.get",
  mode: "read",                     // "read" | "write"
  authorizationScope: "reddit.read.profile",
  fixtureEnabled: true,
  protocolMapping: "MAPPED",        // Reddit: "MAPPED" | "UNSUPPORTED"
  productionEnabled: true,          // Reddit derives this from protocolMapping
  disabledReason: null,             // Reddit: a single reason or null
  // X additionally carries:
  summary, status, transportCandidate, admissionSchema, disabledReasons: [...]
}
```

Reddit builds the array from two input lists — admitted capabilities and
messaging candidates — and derives `productionEnabled` from whether the protocol
mapping is `MAPPED`. X builds one array of 25 entries, all `productionEnabled:
false`, each carrying its full `disabledReasons` list.

Every capability must map to a public operation. The mapping is hand-maintained
in `scripts/product-reset-docs.ts` as `redditPublicOperation` /
`xPublicOperation`, and `capabilityMappingErrors()` validates both directions:
a capability without a mapping fails, and a stale mapping entry fails. A new
platform needs a new hand-written mapping table in that script.

## Admission gates

The X package's `admission.mjs` is the reference shape. It is not
`{ productionEnabled, disabledReasons }` — it is thirteen committed boolean gates
plus derived reasons:

```javascript
const gates = Object.freeze({
  immutableSourceRevision: true,
  mitNoticeRecorded: true,
  noRuntimeDependency: true,
  standardDirectHttpOnly: true,
  boundedSyntheticCorpus: true,
  coreSessionCustody: true,
  isolatedWorkerBoundary: true,
  pureClientTransactionGenerator: true,
  exactEndpointCurrentness: false,
  clientTransactionHeaderProven: false,
  authorizedLiveIdentityProof: false,
  authorizedLiveReadProof: false,
  authorizedLiveWriteProof: false,
});
```

`disabledReasons` is **derived**, never hand-listed: each failed gate maps
through `reasonByGate` to a stable reason string, and anything unmapped becomes
`GATE_FAILED:<name>`. The exported record also carries `schema`,
`sourceRevision`, `sourceRole`, `runtimeDependency`, and
`candidateBoundaryImplemented`. Operators can request the transport
(`evaluateXTransportAdmission(true)`) and still get `enabled: false` until the
committed `productionEnabled` flips in a reviewed source commit.

A Reddit-style platform has no `admission.mjs`; its per-capability flags carry
the same information.

## Shared modules

Three modules now exist on this branch and absorb the code that used to be
copied per platform. A new platform binds to them instead of duplicating them.

### `src/platform-command-mac.ts`

`createPlatformCommandMac({ platformId, displayName, contextCheck })` returns
`{ context, readCommandKeyFile, Signer, Verifier }`. `platformId` supplies the
HMAC domain `social-git.<platformId>-command/v1` and **is part of the wire
format** — it must never change. `displayName` only appears in operator-facing
error text. `contextCheck` is `"eager"` (X validates the caller context before
the timestamp and nonce work) or `"deferred"` (Reddit validates it only when the
MAC input is composed); the difference is observable error ordering, so it is
preserved rather than unified.

Minimal per-platform binding — `src/reddit-ipc-auth.ts` in full:

```typescript
const mac = createPlatformCommandMac({ platformId: "reddit", displayName: "Reddit", contextCheck: "deferred" });
export const REDDIT_COMMAND_MAC_CONTEXT = mac.context;
export const readRedditCommandKeyFile = mac.readCommandKeyFile;
export const RedditCommandMacSigner = mac.Signer;
export const RedditCommandMacVerifier = mac.Verifier;
```

`x-ipc-auth.ts` is byte-identical except for `platformId: "x"`,
`displayName: "X"`, and `contextCheck: "eager"`.

### `src/platform-worker-http.ts`

Shared worker HTTP primitives, all of which are behaviourally identical between
platforms: `createIsolatedWorkerServer`, `boundedWorkerBody`,
`discardBoundedBody`, `writeWorkerBuffer`, `writeWorkerJson`, `endAndWipe`, and
`oneHeader`.

What deliberately stays in the platform module: readiness semantics, admission
handling, failure sanitisation, and status codes. Two divergences are held
explicitly rather than unified: `wipeOnFinish` (Reddit wipes a response body when
the response finishes, X only on close/error) and the disabled-path readiness
behaviour.

Minimal per-platform wiring — the import block of `src/x-worker-http.ts`:

```typescript
import { X_COMMAND_MAC_CONTEXT, XCommandMacSigner, XCommandMacVerifier } from "./x-ipc-auth.ts";
import {
  boundedWorkerBody, createIsolatedWorkerServer, discardBoundedBody,
  oneHeader, writeWorkerBuffer, writeWorkerJson, type WorkerMacAuth,
} from "./platform-worker-http.ts";

export function createXWorkerHttpServer(options: { admission: XAdmissionDecision; dispatcher?: XCommandDispatcher; commandKey?: Uint8Array; now?: () => number }) {
  // ... platform-specific routing, then:
  const server = createIsolatedWorkerServer({ async handle(request, response, state) { /* ... */ } });
}
```

A new platform's `src/<p>-worker-http.ts` should import those helpers and never
re-implement body bounding, signing, or buffer wiping.

### `src/owner-session-import.ts`

`createOwnerSessionImportController({ path, platformLabel, schema, importSession })`
returns a controller class with the historic public constructor
`(service, authenticateOwner)` and the `ownsPath` / `handle` pair Core expects.
It owns every invariant that must not vary: bearer rejection, the
`Sec-Fetch-Site: same-origin` requirement, `application/json`, owner-role
enforcement, `content-length` preflight, the 24 KiB streaming bound, chunk
wiping, and error mapping. It also exports `exactSessionObject` and
`boundedSessionText` for schema modules.

Minimal per-platform wiring — the whole of `src/reddit-session-import.ts` beyond
its parser:

```typescript
const PATH = /^\/v1\/control-plane\/accounts\/([^/]+)\/reddit-session$/u;
const KEYS = ["version", "platform", "expectedNativeUserId", "redditSessionCookie", "csrfToken"] as const;

export const OwnerRedditSessionImportController = createOwnerSessionImportController<SocialGitService>({
  path: PATH,
  platformLabel: "Reddit",
  schema: { parse: parseRedditSession },
  async importSession(service, owner, accountId, material) {
    const result = await service.importOwnerRedditSession(owner, accountId, material);
    return { status: 201, body: result };
  },
});
```

X is the same with an extra decision: its `importSession` returns `202` while
the transport is unadmitted and `201` once an admitted adapter verifies the
generation.

`src/runtime.ts` registers controllers in a list — one entry per platform, order
preserved, each owning its own pathname. `src/http.ts` needs **no change**: its
`ownerSessionImport` option is already a platform-agnostic
`{ ownsPath, handle }` pair.

## Transport requirements

- Standard HTTP/HTTPS only; no browser automation, no CDP.
- Fixed egress to known platform hosts; reject proxies, redirects, private and
  metadata addresses; bounded deadlines and streamed-data limits.
- Session material encrypted at rest in Core custody with purpose, account, and
  generation binding.
- Worker isolation: no database access, no secret custody, separate UID,
  separate command and egress networks.

## Normalization

- Return bounded DTOs only; never expose raw library objects.
- Include native IDs and canonical URLs when the platform supplies them.
- Redact secret-like values.
- Normalize errors to the shared stop states: challenge, checkpoint, CAPTCHA,
  rate limit, wrong identity, revocation, protocol drift.
- A silent-empty result where metadata implies otherwise is protocol drift, not
  an empty success.

## Worker isolation

Platform workers must not hold a database handle, backup, import, restore, or
secret mount, must run under a distinct UID (`10002:10002` for the shipped
workers against Core's `10001:10001`), and must exchange only versioned,
size-bounded IPC messages.

## Example: Reddit adapter

- Source corpus: `reddit-lyr` 0.1.1 at `87ec32aff905923ecd156e7951c168adfdf6fac1`,
  with separately pinned PRAW protocol evidence for ownership lookup and media
  phases.
- Licence: MIT plus BSD-2-Clause (PRAW).
- 26 capabilities: 12 read, 14 write. 22 have `productionEnabled: true`; the
  four `message.*` capabilities are fixture-only, each with its own disabled
  reason.
- Tests: 68 in `packages/reddit-adapter/test` across four files.
- Admission: admitted for production through the direct-session transport.

## Example: X adapter

- Source corpus: `unclecode/twikit` at
  `6a73ab97f4de09f79139f6308c9fb80029a9f5f7`, source corpus only, not a runtime
  dependency.
- Licence: MIT.
- 25 capabilities, all fixture-only; 8 of 13 admission gates pass.
- Tests: 16 in `packages/x-adapter/test` across two files.
- Admission: production-disabled. Dispatch returns `X_TRANSPORT_NOT_ADMITTED`.

## Implementation steps

1. **Research** — identify candidate libraries with compatible licences.
2. **Review** — audit source for security and protocol implementation.
3. **Extract** — extract a minimal, fully attributed protocol corpus.
4. **Package** — create `packages/<p>-adapter/` with the modules listed above.
5. **Test** — deterministic tests for every capability, both directions of the
   capability mapping, and every stop state.
6. **Integrate** — the Core edit points below. A platform needs *three* `src/`
   modules at minimum (`<p>-adapter.ts`, `<p>-production-adapter.ts`,
   `runtime-<p>.ts`) plus `<p>-worker-main.ts`, `<p>-worker-http.ts`,
   `<p>-ipc-auth.ts`, and `<p>-session-import.ts`. A platform admitted through
   the two-party release-proof workflow additionally needs `<p>-certification.ts`.
7. **Document** — package `README.md` and `THIRD_PARTY_NOTICES.md`, plus the
   product-reset prose.
8. **Generate** — `npm run generate:openapi` and `npm run generate:product-docs`.
9. **Verify** — `npm run validate:openapi && npm run validate:product-docs`,
   `npm run typecheck`, and a full `npm test`.
10. **Admit** — the admission checklist and, separately, an authorized live proof.

## Mandatory Core edit points

These are the shared files a new platform must change. Missing any one of them
fails at runtime or leaves the platform silently unreachable.

| Path | Change |
| --- | --- |
| `src/adapter.ts` | Add the `<P>ReadRequest` / `<P>WriteRequest` unions and extend `ReadRequest` / `WriteRequest`; add every new kind to `WRITE_KIND_REGISTRY` and `READ_KIND_PLATFORM` and extend `WritePlatform` / `ReadPlatform` (the compiler rejects a missing entry). |
| `src/contract.ts` | Extend the `ContractAvailability.platform` union; both `enum: ["reddit", "x"]` occurrences (the accounts/connection body and the admission-proof body); `WRITE_KINDS`; the `<p>NativeId` schema; the per-platform route definitions; the control-plane path entry. |
| `src/dispatcher.ts` | One `case` per read and write operation. |
| `src/service.ts` | `importOwner<P>Session`; the `platform !== "<p>"` guard; `READ_FIELDS`. Write routing already reads the registry through `platformForWriteKind` and rejects unregistered kinds. |
| `src/runtime.ts` | Construct the adapter(s); register them in the `adapters: [...]` array; append a controller to `ownerSessionImports`; add worker readiness probes and log fields. |
| `src/runtime-config.ts` | `<p>CommandKey`, `<p>WorkerUrl`, transport-requested flag, and cross-key uniqueness assertions. |
| `src/readiness.ts` | `releaseCertification.platform` union, `<p>Reachable`, and the required-ness rule. |
| `src/admission-proof.ts` | Add the platform to `ADMISSION_PROOF_PLATFORMS` if it uses the release-proof workflow, and extend `operationFor` and `writeRequest`. See the migration note below. |
| `src/index.ts` | Export the new modules. |
| `src/http.ts` | **No change needed** — `ownerSessionImport` is already generic. |

Platform-facing packaging and policy files that also need entries:
`packages/worker-security` target policy and header allowlist, `runtime/entrypoint.mjs`,
`runtime/secrets-init.mjs`, `Dockerfile`, the four Compose files,
`scripts/validate-compose.py`, `scripts/validate-self-hosted-compose.py`, the
smoke scripts, `scripts/image-policy.mjs`, `scripts/product-reset-docs.ts`,
`scripts/validate-openapi.ts`, `tools/security/check_repository_policy.py`,
`tools/security/attest_runtime.py`, `tests/test_source_metadata.py`,
`tests/security/test_repository_policy.py`, and the web control plane.

### The `admission_proofs` platform constraint

The `admission_proofs` table constrains `platform` with a `CHECK` generated from
`ADMISSION_PROOF_PLATFORMS` in `src/admission-proof.ts`. Because the table is
created with `CREATE TABLE IF NOT EXISTS`, widening the list alone would leave
existing deployments on the old constraint. `ensureAdmissionProofSchema()` runs
when the coordinator opens the database: it compares the stored DDL with the
current one and, when they differ, rebuilds the table with SQLite's documented
procedure inside one transaction, preserving every row and `rowid`. It refuses
to migrate, leaving the table untouched, if a row carries a platform outside the
new list. `test/admission-platform-migration.test.ts` covers fresh, unchanged,
widened, refused, and restored databases. Adding a platform here is therefore a
one-line change to the list plus the `operationFor` / `writeRequest` branches.

## Platform registration points

Two registrations decide whether a platform is reachable at all. Both are data,
and both fail closed for anything unregistered:

1. **Kind to platform routing.** `WRITE_KIND_REGISTRY` (each write kind's
   platform and whether it uses Core's phased media flow) and
   `READ_KIND_PLATFORM` live in `src/adapter.ts`, a type-only leaf module, so
   Core persistence can use them without an import cycle; `src/contract.ts`
   re-exports them beside `WRITE_KINDS`. Both are declared with `satisfies` over
   the kind unions, so a kind without an entry, or an entry without a kind, is a
   TypeScript error. `platformForWriteKind`, `platformForReadKind`, and
   `isMediaWriteKind` return `undefined`/`false` for unregistered kinds; the
   service rejects such a write with `VALIDATION_FAILED`, and every adapter type
   guard consults the registry instead of a kind's spelling. Kind names no
   longer carry routing meaning; the `x_` prefix is naming only.
   `test/write-kind-registry.test.ts` pins coverage and fail-closed behaviour.
2. **The admission-proof platform constraint.** `ADMISSION_PROOF_PLATFORMS` and
   `ensureAdmissionProofSchema()` in `src/admission-proof.ts`, described above.
   Only platforms that use the two-party release-proof workflow need an entry.

## Constraints

- **No browser automation**: no Playwright, Selenium, Chromium, CDP, or a
  browser-like DOM.
- **No official APIs** as primary transport.
- **No live credentials** in development.
- **No automatic retry**: writes are single-attempt; `UNKNOWN` requires explicit
  reconciliation.
- **Deterministic only**: live proof is a separate QA gate.
