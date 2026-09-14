# Reddit library admission decision

Decision date: 2026-09-14

Gate: [DYN-31](/DYN/issues/DYN-31)

Reviewed evidence:

- [DYN-27](/DYN/issues/DYN-27), `docs/reddit-library-admission.md` at commit
  `5527d600f9d0675d79c49ef78f8041848c6f5346`
- [DYN-28](/DYN/issues/DYN-28), `docs/independent-protocol-review.md` at commit
  `3c0f9bb8a65db0395d7a66d0e842d8007b47675d`

## Decision

**Admit no reviewed upstream package unchanged.** No package currently satisfies
Social Git's production requirements for session custody, expected-identity
binding, write safety, native results, challenge handling, multi-account
isolation, dependency provenance, and Reddit MVP coverage.

The smallest approved library-reuse path is a bounded, attributed source
extraction from
[`ishan-parihar/reddit-lyr`](https://github.com/ishan-parihar/reddit-lyr) at
commit
[`87ec32aff905923ecd156e7951c168adfdf6fac1`](https://github.com/ishan-parihar/reddit-lyr/commit/87ec32aff905923ecd156e7951c168adfdf6fac1),
whose manifest declares version `0.1.1`. Integration may reuse only the reviewed
`RedditAPIClient` endpoint mappings and the normalizers needed by the Social Git
adapter. The adapter engineer must not install, import, or copy the upstream
application, daemon, MCP/CLI layer, browser-cookie import, session persistence,
global dependency cache, generic retry loop, or unpinned dependency graph.

This is a source-corpus admission, not a package admission. It does not admit
`reddit-lyr==0.1.1` as an installable dependency, because no such PyPI release
existed at review time and the upstream manifest contains an unpinned VCS
dependency. It also does not admit `curl_cffi` or any other transport. The
adapter engineer owns the bounded integration after this decision.

Offline fixture and contract work for [DYN-31](/DYN/issues/DYN-31) may proceed
under this decision. A live or production Reddit connection remains separately
gated by all requirements below, an independently authorized QA task, and a
documented Reddit permission/agreement plus legal review. Account-owner consent
alone is not sufficient permission to operate the protocol.

## License result

The selected `reddit-lyr` revision contains an MIT license. The bounded source
extraction is license-compatible only if the copied material keeps the required
copyright and MIT license notice and its provenance remains pinned to the full
commit above. This decision does not approve any transitive dependency: each
runtime dependency still needs an exact version or immutable revision, hashes,
source and license review, supported-platform loading evidence, and contract
tests.

The license result is therefore:

- **Selected source:** MIT; acceptable for bounded attributed reuse.
- **Selected upstream package/application:** rejected.
- **Selected transport and transitive dependency set:** none admitted.
- **Service authorization:** not established by the source license and still
  required before live use.

## Source-review result

Both reviews independently selected the same exact `reddit-lyr` commit as the
broadest browser-free session-protocol corpus. The useful seam accepts an
injected cookie map, lazily creates a direct HTTP session, implements the main
listing and normalization paths, and contains mappings for text/link submit,
comment/reply, vote, save/unsave, edit, and delete.

The DYN-27 source-only proof pinned source blob
`1a18f05cb12c80094826365557f06dda7953a499` and verified seven write-route
mappings on macOS arm64 with CPython 3.11.15 and Linux arm64 with CPython
3.11.13. It installed no dependency, substituted a fail-closed transport stub,
created no HTTP session, and used no credential. This proves the selected source
shape only. It does not prove that `curl_cffi` loads on a target host, that the
routes are accepted by Reddit, or that the code is safe for production.

The upstream package fails source review as a production dependency because it:

- retries state-changing requests after ambiguous network, 5xx, and parsing
  failures instead of returning `UNKNOWN`;
- persists plaintext cookies and exposes browser/file bootstrap paths;
- does not bind the live native identity to the expected account;
- has no complete challenge, checkpoint, CAPTCHA, revocation, wrong-account, or
  protocol-drift taxonomy;
- can report write success without a verified created native identifier and
  canonical Reddit URL;
- uses application-level global client state and does not guarantee per-account
  session and route isolation;
- lacks media upload and the required protocol-safety test suite; and
- has open dependency ranges, an unpinned VCS dependency, misleading import
  documentation, and CI that can turn test failure into success.

### DYN-65 supporting-source addendum

The primary decision above is unchanged. To close only the exact-item ownership
and media protocol gaps, the bounded corpus additionally admits source evidence
from PRAW `8.0.3` at commit
[`fdc29bb103ad652eea6740c77c2be099d1c1357e`](https://github.com/praw-dev/praw/commit/fdc29bb103ad652eea6740c77c2be099d1c1357e),
released on 2026-08-12 under BSD-2-Clause. The review pins four exact Git blobs
and SHA-256 digests in `packages/reddit-adapter/src/protocol-corpus.mjs` for the
endpoint table, media lease/upload parsing, image submit/process flow, and
`Reddit.info` exact-item read.

This is supporting protocol evidence only. PRAW remains rejected as the primary
integration and is not installed, imported, vendored as a package, or linked at
runtime. Its OAuth/API client, credential configuration, HTTP transport,
session handling, and retry behavior remain excluded. The application runtime
dependency closure is therefore unchanged.

## Required capability gaps

The bounded integration must close these gaps before the corresponding
capability can be production-enabled:

1. Core must supply one decrypted, account-bound, generation-bound session to
   an isolated worker. The adapter must not discover or persist credentials.
2. The worker must call an authenticated identity operation and match the native
   user ID and normalized username to the immutable expected identity before any
   read or write. A mismatch is `WRONG_ACCOUNT` and stops the worker.
3. Core must own scoped authorization, caller-scoped idempotency, the durable
   action ledger, and the transition to `SUBMITTING` before dispatch.
4. Safe-read retry must be separate from write submission. After write bytes may
   have been sent, a timeout, disconnect, worker crash, 5xx, or unparseable
   response is `UNKNOWN` and must not retry automatically.
5. Rate limit, challenge, checkpoint, CAPTCHA, revoked session, wrong identity,
   and protocol drift must be distinct normalized stop results.
6. Success must include the affected or created native ID and the canonical URL
   when Reddit supplies it. Placeholder IDs, parent IDs returned as created IDs,
   missing write data, and unverified 2xx responses are not success.
7. Caller-owned post and comment deletion must verify the target author's
   native identity through an admitted bounded read before submission and
   preserve an action snapshot for recovery. DYN-65 implements the exact-item
   read and fails closed for foreign or unverifiable owners.
8. Each account/session generation/network route must run in an isolated worker
   with versioned, size-bounded messages and no database access. Cookie jars,
   CSRF/modhash values, limiters, and connection pools must not cross accounts.
9. A reviewed route-bound transport must be selected and pinned independently.
   If `curl_cffi` is considered, supported-platform wheel signing/loading and
   all transitive source, license, hash, and failure behavior must be verified.
10. Media must remain declared unsupported until a separately reviewed,
    multi-phase lease/upload/submit/process flow handles ambiguous completion
    without replay. DYN-65 satisfies this condition with Core-managed media,
    durable phases, exact-host upload/process authorities, and an atomic submit
    boundary; bind-only providers still keep the capability disabled.
11. Deterministic tests must cover success, auth failure, wrong identity,
    challenge/checkpoint/CAPTCHA, rate limit, revocation, protocol drift,
    idempotency conflict/replay, crash before submit, crash after possible
    submit, `UNKNOWN` recovery, and native-ID/canonical-URL extraction.

Text/link submit, comment/reply, vote, save/unsave, and delete mappings could be
implemented behind the disabled-by-default capability contract while these
requirements were open. Media is now declared only by the phased Core worker
provider that supplies the DYN-65 controls; a direct transport cannot advertise
or execute it.

## Rejected alternatives

### `reddit-mcp-noapi==0.1.2`

Source revision:
[`ed0858c0813e50a140719f73cb92ac9390d1b939`](https://github.com/iris-alights/reddit-mcp/commit/ed0858c0813e50a140719f73cb92ac9390d1b939).
The source and PyPI release are available under the Unlicense, but the package
is rejected as a dependency. It has plaintext session files, a process-global
client, blocking requests behind async-shaped methods, no expected-identity
binding, no central rate/challenge stop policy, no durable idempotency or action
ledger, ambiguous success fallbacks, no tests, and no save/unsave or media
support. Its native-result extraction and fixtures may be consulted as a
reference only; no code or runtime dependency is admitted by this decision.

### `rdt-cli` source `0.4.2`

Source revision:
[`5e4fb3720d5c174e976cd425ccc3b879d52cac66`](https://github.com/public-clis/rdt-cli/commit/5e4fb3720d5c174e976cd425ccc3b879d52cac66).
The source declares Apache-2.0, but the reviewed repository has no root license
file and PyPI stopped at `0.4.1`. The candidate is rejected as the foundation
because it lacks text/link/media submission and deletion, retries ambiguous
writes, stores sessions in plaintext, has no expected-identity comparison, and
does not classify challenge or protocol drift. Its response models, parser
fixtures, identity probe, and conceptual read/write split may be used as
behavioral references only.

### `leog25/reddit-cli` and `reddipy`

`leog25/reddit-cli` revision
[`0d28512d12cf302802ae6df6d4889b95a4ef4d0b`](https://github.com/leog25/reddit-cli/commit/0d28512d12cf302802ae6df6d4889b95a4ef4d0b)
is rejected because its MVP write surface is incomplete, its history is very
small, its dependencies are not exactly pinned, and its `reddit-cli` package
name collides with an unrelated PyPI project.

`reddipy` revision
[`39b1154f344d5cc396173e2db4e22ed2f07111c8`](https://github.com/misterzaidxpy/reddipy/commit/39b1154f344d5cc396173e2db4e22ed2f07111c8)
is rejected because it is read-only, encourages randomized proxy rotation, and
uses plaintext session persistence. It provides no production write path.

### Browser and official-API clients

Chrome/CDP, Playwright, Selenium, and other browser-driven projects are
categorically rejected from the service runtime. Official-API wrappers such as
PRAW and snoowrap are rejected as the primary integration because they require
Reddit OAuth/API credentials. PRAW `8.0.3` at the exact addendum commit is used
only as source-reviewed protocol evidence; it is not linked into the primary
adapter.

## Handoff to the adapter engineer

The adapter engineer may now implement the fixture worker and the bounded
source extraction at the pinned commit. They must keep the reusable surface
small, retain MIT attribution, exclude every rejected upstream layer, and leave
unproven capabilities disabled. No dependency is vendored and no credential or
live Reddit request is used by this decision.
