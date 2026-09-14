# Independent Reddit session-protocol review

**Review date:** 2026-09-14
**Decision:** No reviewed Reddit session library is safe to adopt unchanged. Use a source-reviewed, exact-commit internal fork for a bounded protocol spike, then expose it only through Social Git's account, identity, policy, action-ledger, and worker boundaries.

## Scope and method

This is an independent review of current repositories and package registries. It does not rely on another researcher's shortlist. I inspected repository source, manifests, tests, commit history, releases, PyPI/npm metadata, and official product documentation. I did not use live credentials, browser automation, or social write operations.

The hard constraints are:

- Production runtime cannot depend on a browser, CDP, Playwright, Selenium, or Chromium.
- An official social-network API cannot be the primary platform integration.
- Every account must be bound to an expected native identity and checked before reads or writes.
- A challenge, checkpoint, CAPTCHA, rate limit, revoked session, wrong account, or protocol drift must stop work.
- A write needs scoped authorization, caller-scoped idempotency, a durable action record, and `UNKNOWN` after submission might have started but cannot be verified.
- Secrets and network-route material belong to encrypted core storage, not library configuration files.

Repository state and registry versions below are a point-in-time snapshot. Source links are pinned to the reviewed commit where the claim depends on code.

## Scoring

Scores are out of 100. The categories deliberately reward safety more than endpoint count.

| Category | Weight | What earns points |
| --- | ---: | --- |
| Session-protocol coverage | 30 | Cookie/session operation, required MVP reads and writes, pagination, session refresh |
| Safety semantics | 25 | Identity validation, challenge/rate-limit classification, safe retry boundary, ownership and revocation checks |
| Results and media | 15 | Native IDs, canonical URLs, typed normalization, staged media upload and completion evidence |
| Maintenance evidence | 15 | Recent protocol commits, deterministic protocol tests, multiple maintainers, releases |
| License and supply chain | 15 | Clear compatible license, registry/source match, immutable dependencies, small auditable graph |

This score ranks research value, not production approval. Any hard-constraint failure blocks direct adoption regardless of total.

## Scored shortlist

| Rank | Candidate | Coverage | Safety | Results/media | Maintenance | License/supply chain | Total | Disposition |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | [`reddit-lyr`](https://github.com/ishan-parihar/reddit-lyr/tree/87ec32aff905923ecd156e7951c168adfdf6fac1) | 27 | 5 | 8 | 5 | 3 | **48** | Best endpoint corpus; internal-fork spike only |
| 2 | [`reddit-mcp-noapi`](https://github.com/iris-alights/reddit-mcp/tree/ed0858c0813e50a140719f73cb92ac9390d1b939) | 21 | 5 | 9 | 4 | 8 | **47** | Useful response-extraction reference; not a runtime dependency |
| 3 | [`rdt-cli`](https://github.com/public-clis/rdt-cli/tree/5e4fb3720d5c174e976cd425ccc3b879d52cac66) | 16 | 8 | 8 | 8 | 7 | **47** | Best read/parser/test reference; MVP write coverage is incomplete |
| 4 | [`leog25/reddit-cli`](https://github.com/leog25/reddit-cli/tree/0d28512d12cf302802ae6df6d4889b95a4ef4d0b) | 16 | 7 | 8 | 6 | 5 | **42** | Test-rich reference with a registry-name collision |
| 5 | [`reddipy`](https://github.com/misterzaidxpy/reddipy/tree/39b1154f344d5cc396173e2db4e22ed2f07111c8) | 10 | 4 | 7 | 6 | 7 | **34** | Read-only scraper reference; not an MVP base |

No candidate reaches a production threshold. `reddit-lyr` ranks first only because it exposes the widest protocol surface. Its safety and provenance gaps are severe enough that an unchanged install is prohibited.

## Candidate findings

### 1. `reddit-lyr`: broadest protocol corpus, unsafe execution semantics

The source implements listings, post/comment reads, search, account data, text/link submission, comment/reply, edit/delete, vote, save, inbox, and moderation over Reddit's web JSON/form endpoints. It obtains a modhash from `/api/me.json` and includes it in form writes. Read responses are flattened and retain Reddit IDs, fullnames, permalinks, and cursors ([client](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/scraping/api_client.py#L173-L336), [normalizer](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/normalizer.py#L10-L189)).

It is not safe as shipped:

- Cookie presence is called authentication; there is no comparison against an expected account identity ([authentication](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/authentication.py#L5-L40)).
- Cookies are written as plaintext JSON without restrictive permissions or encryption ([session storage](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/session_state.py#L53-L74)).
- One retry loop covers every HTTP method. It retries 429, 5xx, and broad exceptions, including writes. A response loss after Reddit accepted a submission can therefore create a duplicate ([request loop](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/scraping/api_client.py#L52-L126)).
- Challenge/checkpoint/CAPTCHA responses are not first-class. Most errors collapse to authentication failure or a generic API error ([error mapping](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/error_handler.py#L10-L50)).
- A post can return `ok: true` with an ID of `unknown`; a comment returns the parent ID instead of the new comment ID. Canonical Reddit URLs are absent from write results ([submit wrapper](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/tools/submit.py#L6-L52), [comment wrapper](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/tools/comments.py#L6-L25)).
- There is no Reddit media upload implementation.
- The manifest declares version `0.1.1`, but [PyPI's `reddit-lyr` project URL](https://pypi.org/project/reddit-lyr/) returned 404 during review. The manifest also has an unpinned VCS dependency on `obscura-core`, plus open-ended runtime ranges ([manifest](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/pyproject.toml#L5-L19)).
- The repository has one recorded contributor. The checked-in tests concentrate on CLI output helpers rather than session, protocol, failure, or crash-after-submit behavior.

**Use:** Mine endpoint shapes and normalizer fields. If selected for a spike, fork the exact reviewed commit, remove its persistence/bootstrap code, remove mutable VCS dependencies, split read and write transports, and replace all write-result and retry behavior before any live proof.

### 2. `reddit-mcp-noapi`: smallest useful write reference, no production guardrails

This project uses a Reddit web session against `old.reddit.com`. It covers post/listing/search reads plus inbox, comment/reply, text/link submission, vote, and delete. Its best contribution is response extraction: the comment path attempts to return the created comment ID and canonical permalink, while submit returns Reddit's created fullname and URL when supplied ([write implementation](https://github.com/iris-alights/reddit-mcp/blob/ed0858c0813e50a140719f73cb92ac9390d1b939/reddit_mcp/reddit.py#L414-L530)). The [`reddit-mcp-noapi` PyPI release](https://pypi.org/project/reddit-mcp-noapi/) matches source version `0.1.2`.

Blocking gaps:

- Session JSON is plaintext and is not permission-hardened ([storage](https://github.com/iris-alights/reddit-mcp/blob/ed0858c0813e50a140719f73cb92ac9390d1b939/reddit_mcp/reddit.py#L21-L64)).
- Login trusts the cached username and proves only that a modhash was scraped; later operations do not bind the live native identity to the expected account ([login](https://github.com/iris-alights/reddit-mcp/blob/ed0858c0813e50a140719f73cb92ac9390d1b939/reddit_mcp/reddit.py#L67-L126)).
- It has no rate-limit budget, no challenge/checkpoint class, no action ledger, no ownership precheck for delete, and no durable idempotency.
- Its duplicate-comment check asks whether this account has ever replied to the target. That is not caller-scoped idempotency: it can reject a legitimate second reply and cannot recover a crash with precise action identity.
- Missing write data can still become success: the comment fallback is `success: true` with null identifiers, and submit can return raw data as success ([write implementation](https://github.com/iris-alights/reddit-mcp/blob/ed0858c0813e50a140719f73cb92ac9390d1b939/reddit_mcp/reddit.py#L446-L530)).
- There are no checked-in tests. The repository has one recorded contributor and three commits at review time.
- The Unlicense is explicit, but legal review should decide whether a public-domain dedication plus fallback terms meets company policy ([license](https://github.com/iris-alights/reddit-mcp/blob/ed0858c0813e50a140719f73cb92ac9390d1b939/LICENSE)).

**Use:** Retain only the native-result extraction idea and fixture shapes. Do not retain its secret store, identity model, or success fallbacks.

### 3. `rdt-cli`: strongest read model and test corpus, narrow write surface

`rdt-cli` has typed post/comment/listing/profile models with Reddit IDs, fullnames, permalinks, and pagination cursors ([models](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/models.py#L9-L114)). It also separates read and write transports, merges response cookies, parses `Retry-After`, and probes `/api/me.json` for identity and modhash ([transports](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/transports.py#L27-L170), [identity probe](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/client.py#L302-L330)). Its 168 statically counted test functions are the largest relevant Reddit test corpus in this shortlist.

Blocking gaps:

- MVP writes stop at comment, vote, save/unsave, and subscribe/unsubscribe. Text/link/media submit and caller-owned delete are missing ([write methods](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/client.py#L332-L352)).
- The transport retries network errors, 5xx, and 429 for reads and writes through the same base loop. A write with an ambiguous transport result is not changed to `UNKNOWN` ([transport](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/transports.py#L85-L142)).
- Session capability is inferred from cookie/modhash presence. The identity probe exposes a username but never compares it with an account-bound expected identity. A failed probe can preserve a nominal read capability ([session](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/session.py#L46-L82), [test](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/tests/test_client.py#L21-L29)).
- Credential files get mode `0600`, which is better than peers, but remain plaintext. A seven-day timer attempts browser refresh and falls back to stale cookies ([auth](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/auth.py#L22-L114)).
- There is no explicit challenge/checkpoint/CAPTCHA or protocol-drift result.
- Source says `0.4.2`, while [PyPI](https://pypi.org/project/rdt-cli/) exposed `0.4.1`. Source declares Apache-2.0 but the reviewed repository has no root license file. The repository has one recorded contributor and its latest source push was 2026-03-21.

**Use:** Prefer its response models, parser fixtures, session probe, and read/write conceptual split over its transport policy or credential store.

### 4. `leog25/reddit-cli`: useful tests, ambiguous package provenance

This client has essentially the same MVP subset as `rdt-cli`: strong listing/post/comment parsing and only vote, save, subscribe, and comment writes ([repository](https://github.com/leog25/reddit-cli/tree/0d28512d12cf302802ae6df6d4889b95a4ef4d0b)). It has 288 statically counted test functions, but the repository history had only two commits, one recorded contributor, and no protocol update after 2026-04-28.

The source package calls itself `reddit-cli` version `0.0.1`, while [PyPI's `reddit-cli`](https://pypi.org/project/reddit-cli/) is an unrelated version `0.1` uploaded in 2017. This package-name collision makes casual installation unsafe. Runtime ranges are not exact pins ([manifest](https://github.com/leog25/reddit-cli/blob/0d28512d12cf302802ae6df6d4889b95a4ef4d0b/pyproject.toml)).

**Use:** Consult extra fixtures only after checking their provenance against `rdt-cli`; do not consume the package name.

### 5. `reddipy`: read-only and proxy-oriented

`reddipy` normalizes public content and has tests, but it has no Social Git MVP writes. Its documentation encourages randomized proxy rotation and saving a session in plaintext, neither of which fits stable per-account route binding or core-owned encrypted custody ([repository](https://github.com/misterzaidxpy/reddipy/tree/39b1154f344d5cc396173e2db4e22ed2f07111c8), [PyPI](https://pypi.org/project/reddipy/)).

**Use:** None for the write path. Some public listing fixtures may help drift tests.

## Explicit exclusions and disagreements

### Browser/CDP clients are disqualified, not fallback candidates

[`agents-io/reddit-unofficial-api`](https://github.com/agents-io/reddit-unofficial-api/tree/0dd6284cd8ee133c58c90561525a680246e86cc2) executes requests inside a logged-in Chrome tab through CDP. That directly violates the production-runtime boundary, supports only the active browser account, and has no tests. It must not enter the runtime or worker image even though its advertised operation list is broad.

### PRAW and snoowrap are contract oracles, not primary integrations

I disagree with selecting a mature official API wrapper merely because it has wider coverage:

- [PRAW 8.0.3](https://pypi.org/project/praw/) is current and well maintained, but its configuration targets Reddit's OAuth endpoint; it violates the “not official API as primary integration” constraint ([source](https://github.com/praw-dev/praw/blob/9cc63575b683c61cc907e8cb24a023be4ce18974/praw/praw.ini#L13-L16)).
- [snoowrap 1.23.0](https://www.npmjs.com/package/snoowrap) also requires Reddit OAuth client credentials, and its source repository is archived ([source](https://github.com/not-an-aardvark/snoowrap/blob/fdf5c2af0443cfc3e6ee544445aaa46e602d4f1b/README.md#L61-L79)).

They remain useful for normalized field names, API-shaped fixtures, and media protocol research. They must not be linked into the primary production adapter.

### Endpoint count does not outweigh write correctness

`reddit-lyr`'s 50-plus endpoint claim is not proof of safe coverage. Its protocol tests do not cover auth failure, wrong identity, challenge, revocation, rate limit, idempotency, crash-after-submit, or `UNKNOWN` recovery. An implementation that returns success without a created native ID is less usable than a smaller implementation that fails closed.

### Automatic backoff is not automatically safe

Retrying GET after a network failure can be reasonable. Retrying POST after the request might have reached Reddit is unsafe. Both `reddit-lyr` and `rdt-cli` use shared retry loops across method classes. Social Git must decide retries from operation metadata and action state, not inherit a library default.

### “Per-account workers” is our architecture, not a claim about Unipile internals

Unipile's public docs expose account-scoped APIs, account-specific proxy behavior, status events, and reconnect semantics. They do not prove its internal process topology. The worker model below is an inference and a Social Git design choice.

## Reddit protocol implications

### Session and identity

The reviewed clients converge on a small web-session protocol: a Reddit session cookie authenticates `www` or `old` JSON/form requests, and a modhash/CSRF value obtained from the authenticated identity response authorizes classic form writes. That mechanism belongs inside a Reddit adapter worker, but custody belongs to core.

Required Social Git flow:

1. The external onboarding surface imports a session and sends it directly to core's secret-ingest boundary.
2. Core encrypts a versioned session envelope with purpose/account/generation binding and a fresh nonce. The adapter never writes a credential file.
3. A worker decrypts one generation in memory, calls a cheap identity operation, and compares the returned native user ID and normalized username with the account's immutable expected identity.
4. A mismatch yields `WRONG_ACCOUNT`, destroys the worker copy, and permits no read or write.
5. A refreshed session becomes a new generation. Old workers cannot commit results after their generation is superseded.

Username alone should be display metadata. Prefer Reddit's stable native user ID as the binding key when the response supplies it.

### Reads and normalization

Reddit's classic listings are `data.children[].data` with `after`/`before` cursors. The reusable result contract should preserve:

- `platform`, `resourceType`, native bare ID, native fullname, and canonical URL;
- the platform cursor unchanged in an opaque adapter cursor;
- author native ID/name when supplied;
- timestamps, deleted/tombstone state, and raw capability-specific fields in a bounded `platformData` extension;
- an optional raw-response digest and protocol version for drift evidence, never the unbounded raw object.

Do not force LinkedIn URNs, Instagram numeric PKs, YouTube video/channel IDs, and Reddit fullnames into one fake global-ID syntax. A shared `NativeRef` can carry platform-specific ID kind and value.

### Writes and `UNKNOWN`

Every write must pass through this action state machine:

`AUTHORIZED -> PREPARED -> SUBMITTING -> SUCCEEDED | FAILED | UNKNOWN`

- Core owns authorization, caller-scoped idempotency, and the durable transition to `SUBMITTING` before dispatch.
- The adapter declares whether an operation is read-only, safely repeatable, conditionally repeatable, or non-repeatable.
- Once bytes may have been sent, network failure, timeout, worker crash, 5xx, or an unparseable success response becomes `UNKNOWN`; no automatic retry.
- `SUCCEEDED` requires the created/affected native ID plus canonical URL when Reddit supplies one. A placeholder, target ID returned as a created ID, or empty 2xx is not success.
- Recovery is operation-specific: look up a created item using known native evidence, compare content/author/time bounds, or require independent QA/operator adjudication. Absence from an eventually consistent listing is not immediate proof of failure.
- Delete first verifies that the item's author native identity matches the bound account and records the target snapshot.

### Media is a separate protocol state machine

None of the shortlisted session clients implements Reddit media posts. PRAW's source is useful only as protocol evidence: it leases an upload, posts bytes to object storage, submits the post, and may wait on a WebSocket redirect. Its own exception text acknowledges that a WebSocket failure can occur after the post was created ([upload lease](https://github.com/praw-dev/praw/blob/9cc63575b683c61cc907e8cb24a023be4ce18974/praw/models/media.py#L110-L214), [submit/finalize](https://github.com/praw-dev/praw/blob/9cc63575b683c61cc907e8cb24a023be4ce18974/praw/models/reddit/subreddit/subreddit.py#L597-L634)).

Model media as durable phases rather than one `submit()` call:

`VALIDATED -> LEASED -> BYTES_UPLOADED -> SUBMITTING -> PROCESSING -> SUCCEEDED | FAILED | UNKNOWN`

Each phase stores only non-secret provider references and digests. An expired lease can be reacquired before submission; a failure after post submission cannot be replayed automatically. Text and link posts can ship before media, but the API must explicitly mark media unsupported until the session protocol is source-reviewed, contract-tested, and independently live-proven.

## Shared architecture without a lowest common denominator

Core should share lifecycle and safety, not erase platform behavior.

| Core abstraction | Shared invariant | Adapter-specific extension |
| --- | --- | --- |
| `AccountBinding` | Expected native identity, status, session generation | Reddit user fullname; LinkedIn member URN/products; Instagram user PK/device; YouTube channel/account index |
| `EncryptedSession` | Core custody, generation, expiry hints, audit | Cookie set, tokens, device state, CSRF material, client context |
| `NetworkRouteBinding` | Sticky per account/generation; encrypted at rest | Proxy country/IP affinity, TLS/client profile |
| `CapabilityDescriptor` | Operation name, read/write class, auth level, limits | Platform-only capabilities and parameters remain explicit |
| `WorkerLease` | One account/generation owner; versioned bounded messages; no DB access | Language/runtime chosen for the reviewed library |
| `ActionRecord` | Authorization, caller idempotency, attempt, state, evidence | Platform recovery query and result parser |
| `NativeRef` | Platform, type, ID kind/value, canonical URL | Fullname, URN, PK/code, video/channel ID |
| `MediaTransfer` | Durable phases, digests, size/MIME validation, `UNKNOWN` boundary | Lease/S3, rupload/configure, resumable upload/finalize |
| `NormalizedError` | Stable class and retry policy | Preserve provider error code/status in bounded metadata |
| `PlatformEvent` | Event ID, account ID, type, timestamp, payload version | Provider webhook/poll cursor and platform payload |

A minimal adapter contract should include `capabilities()`, `validateIdentity()`, `executeRead()`, `prepareWrite()`, `submitWrite()`, `recoverWrite()`, `refreshSession()`, and `normalizeEvent()`. Core decides whether an operation is authorized and whether a retry is allowed; the adapter reports evidence and never retries a write on its own.

### Per-account worker isolation

- Serialize writes per account while permitting bounded read concurrency under a shared rate budget.
- Pin worker messages to account ID, session generation, adapter version, and protocol schema version.
- Keep database and key access out of workers. Workers receive one scoped decrypted session and return size-bounded normalized results/evidence.
- Drain a worker on challenge, checkpoint, CAPTCHA, rate limit, wrong identity, revocation, session replacement, or drift. Do not “warm” the account by generating unrelated activity.
- Apply backpressure before dispatch. A library's sleeps are not a global or per-account scheduler.

## Future-adapter evidence

### LinkedIn

[`linkedin-private-api`](https://github.com/eilonmore/linkedin-private-api/tree/e083f370c331ed643348158b8c64f905de477626) demonstrates that a Voyager client needs a cookie plus CSRF header and that sessions are naturally account-keyed. It also demonstrates what not to copy: plaintext `sessions.json`, password login inside runtime, and no validated identity binding ([login source](https://github.com/eilonmore/linkedin-private-api/blob/e083f370c331ed643348158b8c64f905de477626/src/core/login.ts#L10-L134)). Its latest protocol source push was 2023-05-01 even though repository metadata changed later.

The current Python [`linkedin-api`](https://pypi.org/project/linkedin-api/) documentation explicitly says LinkedIn challenges are not handled and identifies 2FA and rate limiting as known triggers ([source snapshot](https://github.com/nsandman/linkedin-api/blob/c75a3cb4538de5a02d66251221096dd4b0d3a3de/README.md#L86-L123)). Therefore `CHALLENGE` is a first-class stop state, not a generic 401 and not an automatic relogin loop. LinkedIn native URNs and product variants must remain platform extensions.

### Instagram

[`instagrapi` 3.0.2](https://pypi.org/project/instagrapi/) is a stronger example of a stateful protocol library. It persists a device/session settings bundle, validates a loaded session, exposes explicit challenge handlers, and separates byte upload from media configuration. It covers photos, videos, albums, reels, and stories ([reviewed source](https://github.com/subzeroid/instagrapi/tree/e6a21e8d79e71c78519ada9a15cd63f2ccf58652), [auth](https://github.com/subzeroid/instagrapi/blob/e6a21e8d79e71c78519ada9a15cd63f2ccf58652/instagrapi/mixins/auth.py#L675-L755), [challenge](https://github.com/subzeroid/instagrapi/blob/e6a21e8d79e71c78519ada9a15cd63f2ccf58652/instagrapi/mixins/challenge.py#L39-L105), [photo upload](https://github.com/subzeroid/instagrapi/blob/e6a21e8d79e71c78519ada9a15cd63f2ccf58652/instagrapi/mixins/photo.py#L254-L348)).

Reusable lesson: encrypt and version the whole device/session bundle; do not reduce it to “a cookie.” Keep challenge handling at the onboarding boundary. Treat upload and configure as distinct durable actions even if the library retries configure internally. The library is MIT and active, but it still requires exact pinning, source review, and Social Git's safety wrapper before adoption.

### YouTube

[`youtubei.js` 18.0.0](https://www.npmjs.com/package/youtubei.js) is an active MIT Innertube client with a small runtime dependency graph. Its session supports cookie/SAPISID authorization, account index, delegated page identity, and multiple client contexts ([HTTP client](https://github.com/LuanRT/YouTube.js/blob/d252b36f7e0bf5926a52a589a73d4aa6392a9683/src/utils/HTTPClient.ts#L115-L140)). Its Studio upload explicitly separates start/resumable lease, byte upload/finalize, and create-video metadata ([Studio](https://github.com/LuanRT/YouTube.js/blob/d252b36f7e0bf5926a52a589a73d4aa6392a9683/src/core/clients/Studio.ts#L142-L240)).

Reusable lesson: an account can expose multiple selectable native identities or channels. Bind both the provider account and selected channel/page identity. Media state machines need platform-specific phases beneath the shared `MediaTransfer` envelope.

## Hosted onboarding and account lifecycle reference

Unipile is an architectural reference only. It must not be a dependency or integration.

Useful externally visible patterns from its official documentation are:

- Generate a short-lived hosted-auth URL from the backend, correlate it with an internal user/account reference, and receive a callback after connection ([Hosted Auth](https://developer.unipile.com/docs/hosted-auth)).
- Keep a stable account record with status and expose multiple accounts through an account-scoped API ([connection methods](https://developer.unipile.com/docs/connect-accounts), [list accounts](https://developer.unipile.com/v2.0/reference/listaccounts)).
- Treat connection as dynamic. Emit explicit disconnected/errored/running states and reconnect the existing account rather than creating a replacement ([status lifecycle](https://developer.unipile.com/v2.0/docs/status-lifecycle)).
- Reject reconnection when the provider identity does not match the existing account. This is the same invariant as Social Git's expected-identity binding ([status lifecycle](https://developer.unipile.com/v2.0/docs/status-lifecycle)).
- Route sensitive providers through account-specific proxy configuration and surface proxy failure separately from credential failure ([proxies](https://developer.unipile.com/v2.0/docs/proxys)).
- Publish account and resource events with event IDs, account IDs, provider, type, time, and typed payloads. Sign webhook deliveries over the raw body and timestamp ([event types](https://developer.unipile.com/v2.0/reference/event-types-1), [webhook security](https://developer.unipile.com/v2.0/docs/configure-a-webhook)).

Social Git should implement these shapes with its own core and adapters. The bootstrap surface can be browser-based only when a human must connect or refresh a session; the service runtime remains browser-free. Reconnect must create a new encrypted session generation for the same account only after identity revalidation.

## Recommended decision and gates

1. **Do not install any shortlisted Reddit package directly in production.**
2. **Start a bounded internal fork/spike from `reddit-lyr` commit `87ec32a`** because it supplies the broadest session-protocol corpus. Use `rdt-cli` models/fixtures and `reddit-mcp-noapi` native-result parsing as independent cross-checks. Do not combine their persistence or retry code.
3. **Remove all onboarding, secret storage, browser-cookie extraction, MCP, CLI, and generic retry layers from the worker build.** The browser may exist only in a separate human bootstrap surface.
4. **Pin the fork and every transitive dependency by immutable version and hash.** Replace the unpinned VCS dependency. Record source and license review for the exact commit.
5. **Ship Reddit capabilities incrementally.** Reads first; then vote/save; then comment/reply; then text/link submit and caller-owned delete. Keep media explicitly unsupported until its multi-phase protocol passes the same gates.
6. **Require deterministic contract tests** for success, auth failure, wrong identity, challenge/checkpoint/CAPTCHA, rate limit, revocation, protocol drift, idempotency conflict/replay, crash before submit, crash after possible submit, `UNKNOWN` recovery, and native-ID/canonical-URL extraction.
7. **Use independent QA for authorized live acceptance.** Ordinary research/development tasks receive no live social credentials and perform no mutations.

The central disagreement with a “pick the library with the most endpoints” strategy is deliberate: these projects are valuable protocol evidence, but Social Git's production correctness comes from core-owned identity, custody, policy, action lifecycle, and isolation—not from trusting a CLI or MCP server's success boolean.

## Primary-source index

- Reddit session candidates: [`reddit-lyr`](https://github.com/ishan-parihar/reddit-lyr/tree/87ec32aff905923ecd156e7951c168adfdf6fac1), [`rdt-cli`](https://github.com/public-clis/rdt-cli/tree/5e4fb3720d5c174e976cd425ccc3b879d52cac66), [`reddit-mcp-noapi`](https://github.com/iris-alights/reddit-mcp/tree/ed0858c0813e50a140719f73cb92ac9390d1b939), [`reddit-cli`](https://github.com/leog25/reddit-cli/tree/0d28512d12cf302802ae6df6d4889b95a4ef4d0b), [`reddipy`](https://github.com/misterzaidxpy/reddipy/tree/39b1154f344d5cc396173e2db4e22ed2f07111c8), [browser/CDP exclusion](https://github.com/agents-io/reddit-unofficial-api/tree/0dd6284cd8ee133c58c90561525a680246e86cc2).
- Registries: [`rdt-cli` on PyPI](https://pypi.org/project/rdt-cli/), [`reddit-mcp-noapi` on PyPI](https://pypi.org/project/reddit-mcp-noapi/), [`reddipy` on PyPI](https://pypi.org/project/reddipy/), [`PRAW` on PyPI](https://pypi.org/project/praw/), [`snoowrap` on npm](https://www.npmjs.com/package/snoowrap).
- Future libraries: [`linkedin-private-api`](https://github.com/eilonmore/linkedin-private-api/tree/e083f370c331ed643348158b8c64f905de477626), [`linkedin-api`](https://github.com/nsandman/linkedin-api/tree/c75a3cb4538de5a02d66251221096dd4b0d3a3de), [`instagrapi`](https://github.com/subzeroid/instagrapi/tree/e6a21e8d79e71c78519ada9a15cd63f2ccf58652), [`youtubei.js`](https://github.com/LuanRT/YouTube.js/tree/d252b36f7e0bf5926a52a589a73d4aa6392a9683).
- Media reference only: [`PRAW` media upload source](https://github.com/praw-dev/praw/tree/9cc63575b683c61cc907e8cb24a023be4ce18974).
- Hosted lifecycle reference only: [provider accounts](https://developer.unipile.com/v2.0/docs/provider-accounts), [hosted authentication](https://developer.unipile.com/v2.0/docs/authenticate-with-hosted-auth), [account lifecycle](https://developer.unipile.com/v2.0/docs/status-lifecycle), [events](https://developer.unipile.com/v2.0/reference/event-types-1), [webhook verification](https://developer.unipile.com/v2.0/docs/configure-a-webhook).
