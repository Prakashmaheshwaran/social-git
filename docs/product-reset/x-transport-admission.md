# X transport admission

Date: 2026-09-17 UTC. Task: [DYN-93](/DYN/issues/DYN-93).

## Decision

**Admit no reviewed package unchanged for production.** Select a fixture-only, fail-closed response boundary for continued development. PawiX25/twifork is the strongest recently maintained broad-coverage research candidate, but is NOT admitted as a runtime dependency. Its documented TLS impersonation path is prohibited, and compatibility without that path has not been established. No source is vendored or installed by this work.

Browserless is necessary but not sufficient. A library can avoid a browser process while still depending on prohibited impersonation, account rotation, or challenge recovery. If essential operations need those behaviors, reject the integration rather than enable them. Owner-provided sessions do not authorize accessing other accounts or bypassing platform restrictions.

## Maintenance and license evidence

Observed GitHub default-branch metadata and PyPI metadata during this review. Dates are UTC; releases and commits are distinct signals, not proof of working endpoints. All six accessible repositories below report MIT; package license compatibility does not approve their transitive dependency closures or platform use.

| Candidate | PyPI release and upload date | Reviewed default-branch commit | Assessment |
| --- | --- | --- | --- |
| vladkens/twscrape | 0.20.1, 2026-08-25 | `55ac729f39fbbe46e316746a55627a9ed920112c`, 2026-08-28 | Active; read-focused; pool rotation conflicts with the boundary. |
| trevorhobenshield/twitter-api-client | 0.10.22, 2024-04-21 | `c150f1a3492ce3db15b954f2bc18b4976500a73b`, 2024-04-21 | Stale for a volatile private protocol; no GitHub releases returned. |
| d60/twikit | 2.3.3, 2025-02-07 | `c3b7220866f8582009fe2d1155b6fe92192a2711`, 2026-03-10 | Latest commit is README-only, not a protocol repair. |
| PawiX25/twifork | 2.4.0, 2026-08-30 | `5a4fc255fdf76997bc9ddc19eb314be9c823aaf1`, 2026-08-31 | Recent parser and request fixes; strongest research candidate, not admitted. |
| unclecode/twikit | Fork release not established | `6a73ab97f4de09f79139f6308c9fb80029a9f5f7`, 2026-05-17 | Auditable changes document; narrower and older repair set. |
| iSarabjitDhiman/TweeterPy | 2.0.17, 2026-06-27 | `266503de017ef6615819b6fdc20dd722d7c39f54`, 2026-07-10 | Recent dependency activity; read-oriented, not full product coverage. |
| twikit-ng / inorilzy/twikit | 2.5.1, 2026-05-29 | Repository API returned 404 | PyPI declares MIT; source continuity and immutable revision not verified. Reject admission. |

No dependency lockfile was changed. In particular, a PyPI version and the reviewed branch SHA are not asserted to be identical source trees.

## Capability comparison

Coverage is upstream-documented, not live-verified. Public-content reads still need an authenticated, authorized account unless explicitly proven otherwise; public content is not the same as anonymous access.

| Candidate | Session input and read scope | Write coverage | Pagination and limit signals | Admission consequence |
| --- | --- | --- | --- | --- |
| twscrape | Cookie import; public profiles, posts, search, lists; account bookmarks. SQLite session pool; account label is not identity verification. | No broad write surface in documented API. | Async generators, raw responses, cursor iteration; rate headers and pool locks, then account switching. | Reject default pool/retry behavior; no account rotation to continue limited work. Optional fingerprint backend and credential extraction are excluded. |
| twitter-api-client | Cookie map/file; public users/posts/search and account home, bookmarks, DMs. Guest support is an old claim, not current evidence. | Posts, replies, quotes, media, likes, follows, bookmarks, deletion, DMs, lists, profile changes. | Automatic pagination and resumable cursors; retry configuration; historic numeric quotas must not be treated as current limits. | Reject stale package; automated verification helpers, raw output and replay behavior are not admitted. |
| Twikit and unclecode fork | Cookie setters/loaders; users/posts/search and account timelines/bookmarks/DMs. | Posts, media, replies, reactions, relationships and DMs. | Result next-page abstraction; typed 429 with reset headers. | Reject unchanged: protocol/parser drift, challenge helpers and broad client surface require isolation. Fork repairs are not endpoint acceptance evidence. |
| twifork | Same cookie surface and broad account reads; README explicitly says guest access does not work. | Broad inherited writes plus Spaces; not all capabilities independently checked. | Cursor repairs, rate-limit remaining/reset properties, typed errors; upstream reports fixes for recursion and duplicate pagination. | Best research candidate, but reject runtime admission: documented impersonation dependency for some paths, optional challenge unlock, and unpinned base dependencies. |
| TweeterPy | Public profile, followers/following, tweets/media are documented; session custody and account-only read coverage not established in this review. | No complete write surface established. | Full cursor/error contract not established; do not infer parity. | Reject: insufficient product coverage and required curl-cffi dependency needs transport review. Multi-account/proxy recommendations are excluded, not proof they are essential. |
| twikit-ng | PyPI claims inherited Twikit behavior; source repository unavailable to this review. | Claims not independently verified. | Not verified. | Reject provenance gap before evaluating runtime behavior. |

## Response stability and exclusions

Twifork documents moved user fields, missing optional fields, trailing cursors, empty timelines and conversation modules. Its request layer exposes rate headers and raises typed errors but also includes optional unlock and impersonation paths. Twscrape queue_client has retries and account rotation; these are incompatible with a single-account stop-on-limit contract. Older twitter-api-client response examples contain deeply nested private response shapes. None offers a stable product API by itself.

The selected boundary must project only validated fields into versioned product DTOs. Missing required identifiers, unknown variants, partial error responses and changed operation maps must disable affected capabilities, not silently return empty success. Pin and audit each later source change independently. No runtime download of replacement code or query maps is admitted.

Excluded from all candidates: browser processes, browser profile extraction, passwords/email/MFA automation, checkpoint or CAPTCHA solving, account pools/farming, fingerprint spoofing, stealth, proxy rotation to bypass restrictions, and automatic rate-limit recovery. Cookie setters alone are not proof of safe custody. No live credential handling code is included here.

## Selected boundary and proof

`test/x-transport-admission.test.ts` is a self-contained, synthetic response-contract proof. It imports only Node assertion/test modules. It has no HTTP client, endpoint map, cookie input, session discovery, socket, browser, retry loop or dependency import. The `data.timeline` wrapper is deliberately synthetic; it is NOT asserted to be a complete current X endpoint response. It demonstrates a narrow Tweet/cursor projection, not compatibility with any upstream package.

The five tests cover: validated native ID/text projection and explicit empty pages; repeated/duplicate cursor rejection; terminal rate/auth/access signals; malformed, oversized-entry-count, unknown-variant and partial-error rejection; disabled live capabilities and the illustrative post-submission UNKNOWN classification. The last case is a policy assertion, not a durable write-ledger implementation or crash-recovery test. No live X capability is enabled by this proof.

A later implementation must keep Core-owned identity verification, tenant/account/session-generation binding, authorization, durable idempotency and revocation outside any upstream library. The transport must return one bounded page and rate metadata without sleeping, retries or account switching. Challenge/access failures stop the account; unknown protocol variants stop the affected capability. Ambiguous writes require durable UNKNOWN handling, never automatic resubmission. Raw bodies, cookies and sensitive headers must not escape the worker boundary. These are required admission gates, not features claimed to be implemented by this spike.

### Verification

- `node --test test/x-transport-admission.test.ts`: 5 passed, 0 failed on Node v26.3.1.
- `npm run typecheck`: passed (`tsc --noEmit`).
- `node --test test/reddit-adapter.test.ts`: 6 passed, 0 failed (existing regression check).
- No lint script is declared in the root package.json. No upstream package was installed. No credential or live X request was used.

This completes the requested evaluation and fixture proof, not a production X integration. Under the strict exclusions, a production-admissible direct-HTTP dependency remains unproven. The product owner must not advertise X parity from this artifact. No live test is requested or authorized by this decision.

## Evidence access paths

Metadata was obtained from public GitHub repository/commit/release endpoints and PyPI JSON. GitHub CLI was unavailable without authentication; public metadata and raw source were used instead. Source inspection was selective, not an exhaustive dependency or security audit. Registry declarations are license evidence, not a completed legal review.

- [twscrape pinned README](https://github.com/vladkens/twscrape/blob/55ac729f39fbbe46e316746a55627a9ed920112c/readme.md) and [queue behavior](https://github.com/vladkens/twscrape/blob/55ac729f39fbbe46e316746a55627a9ed920112c/twscrape/queue_client.py).
- [twitter-api-client pinned README](https://github.com/trevorhobenshield/twitter-api-client/blob/c150f1a3492ce3db15b954f2bc18b4976500a73b/readme.md).
- [Twikit pinned README](https://github.com/d60/twikit/blob/c3b7220866f8582009fe2d1155b6fe92192a2711/README.md) and [errors](https://github.com/d60/twikit/blob/c3b7220866f8582009fe2d1155b6fe92192a2711/twikit/errors.py).
- [twifork pinned README](https://github.com/PawiX25/twifork/blob/5a4fc255fdf76997bc9ddc19eb314be9c823aaf1/README.md), [client](https://github.com/PawiX25/twifork/blob/5a4fc255fdf76997bc9ddc19eb314be9c823aaf1/twikit/client/client.py), and [dependency manifest](https://github.com/PawiX25/twifork/blob/5a4fc255fdf76997bc9ddc19eb314be9c823aaf1/setup.py).
- [unclecode change history](https://github.com/unclecode/twikit/blob/6a73ab97f4de09f79139f6308c9fb80029a9f5f7/CHANGES.md).
- [TweeterPy README](https://github.com/iSarabjitDhiman/TweeterPy/blob/266503de017ef6615819b6fdc20dd722d7c39f54/README.md) and [dependencies](https://github.com/iSarabjitDhiman/TweeterPy/blob/266503de017ef6615819b6fdc20dd722d7c39f54/requirements.txt).
- Registry records: [twscrape](https://pypi.org/pypi/twscrape/json), [twitter-api-client](https://pypi.org/pypi/twitter-api-client/json), [twikit](https://pypi.org/pypi/twikit/json), [twifork](https://pypi.org/pypi/twifork/json), [twikit-ng](https://pypi.org/pypi/twikit-ng/json), [TweeterPy](https://pypi.org/pypi/tweeterpy/json).
