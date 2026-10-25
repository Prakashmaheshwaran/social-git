# Reddit session-protocol library admission

Status: **do not admit an upstream package as a production dependency**

Research date: 2026-09-14

## Decision

No reviewed library clears Social Git's production admission gates. The closest
technical foundation is a bounded extraction from
[`ishan-parihar/reddit-lyr`](https://github.com/ishan-parihar/reddit-lyr) at
revision
[`87ec32aff905923ecd156e7951c168adfdf6fac1`](https://github.com/ishan-parihar/reddit-lyr/commit/87ec32aff905923ecd156e7951c168adfdf6fac1)
(declared version `0.1.1`, MIT). It is the primary candidate because its
source contains an async, browser-free `curl_cffi` client with the broadest
matching read and write surface.

The fallback is
[`iris-alights/reddit-mcp`](https://github.com/iris-alights/reddit-mcp) at
revision
[`ed0858c0813e50a140719f73cb92ac9390d1b939`](https://github.com/iris-alights/reddit-mcp/commit/ed0858c0813e50a140719f73cb92ac9390d1b939)
and PyPI package
[`reddit-mcp-noapi==0.1.2`](https://pypi.org/project/reddit-mcp-noapi/)
(Unlicense). It has text/link submission, comments, votes, and deletion, but is
a weaker base: it is synchronous, keeps a process-global client, has no tests
or CI, and omits save/unsave and media upload.

The currently installed `rdt-cli 0.4.2` is useful as a protocol reference, not
as the adapter foundation. Its upstream revision is
[`5e4fb3720d5c174e976cd425ccc3b879d52cac66`](https://github.com/public-clis/rdt-cli/commit/5e4fb3720d5c174e976cd425ccc3b879d52cac66).
It supports direct session HTTP and the local installation imports from
`rdt_cli.cli`, but it lacks post submission, deletion, and media upload.

This is a technical and source-license recommendation, not permission to
operate against Reddit. Reddit's current
[`User Agreement`](https://redditinc.com/policies/user-agreement) prohibits
scraping without prior written consent and limits automated collection to what
the terms or a separate agreement permit. Its
[`Responsible Builder Policy`](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
requires approval for API data access and prohibits masking the reason for
access. Production use therefore needs a separately documented Reddit
permission/agreement and legal review; owner authorization for an account is
necessary but is not sufficient.

## Admission matrix

| Criterion | Primary: `reddit-lyr` | Fallback: `reddit-mcp-noapi` | Installed reference: `rdt-cli` |
|---|---|---|---|
| Exact source | `0.1.1` / `87ec32a…` | `0.1.2` / `ed0858c…`; PyPI wheel SHA-256 `f8555d814d3ccd214b11c9790fb94909ba38c84e309f16604e07d2dc9cffbd63` | source/installed `0.4.2` / `5e4fb37…`; PyPI stops at `0.4.1` |
| Maintenance | Last source push 2026-08-11; 52 commits; 1 contributor; 1 fork; no tag or GitHub release | Last source push 2026-06-02; 4 commits; 1 contributor; 0 forks; no tag or GitHub release | Last upstream push 2026-03-21; 16 commits; 1 contributor; 59 forks; no GitHub release; open transport/auth issues |
| License/source | MIT file present; source available | Unlicense file present; source and sdist available | Declares Apache-2.0 in package metadata and README, but the repository has no license file and GitHub cannot identify a license |
| Runtime | Browser-free async HTTP through `curl_cffi` Chrome TLS impersonation; browser access is only an optional session bootstrap | Browser-free synchronous `requests`; browser access is only an optional cookie import | Browser-free synchronous `httpx`; browser access is only an optional cookie import |
| Session import | Constructor accepts a cookie map; application layer also reads a daemon/file/browser | Reads a per-directory JSON file or browser cookies | `Credential` accepts a cookie map; CLI also reads a file/browser |
| Identity | Calls `/api/me.json`, but does not bind the returned name to a caller-supplied expected identity | Saves a username and checks for a modhash, but has no expected-identity binding | Gets `/api/me.json` and records a username, but has no expected-identity binding |
| Reads | Profile, subreddit info/rules, listings, feed, post/comments, search, user content, saved items, inbox | Post/comments, listing, search, inbox; no clear subreddit-metadata operation | Profile, subreddit info, listings/feed, post/comments, search, user content, saved/upvoted |
| Text/link post | Yes | Yes | No |
| Media post/upload | **No** | **No** | **No** |
| Comment/reply | Yes | Yes | Yes |
| Vote | Yes | Yes | Yes |
| Save/unsave | Yes | No | Yes |
| Delete own item | Yes, but ownership is not checked locally | Yes, but ownership is not checked locally | No |
| Native ID/canonical URL | Incomplete: submit extracts a fullname; link submit returns the submitted target URL, and comment tools return the parent ID rather than the created comment ID | Best effort for submit/comment; ambiguous responses can be reported as success | Normalized reads only; missing required submit/delete outputs |
| Rate/challenge behavior | Tracks headers and 429, but retries generic failures and 5xx for every method, including POST. Treats most 401/403 as auth and has no challenge/checkpoint/CAPTCHA state | No central rate limiter, challenge classifier, or stop policy | Delays/retries 429, 5xx, timeouts, and network errors for every method, including writes; 403 is only `ForbiddenError` |
| Proxy/network route | No supported adapter-level proxy or route-binding interface | No supported proxy interface | No supported proxy interface |
| Async/concurrency | Async client and per-instance limiter lock; default MCP dependency is a process-global singleton | `async_*` methods call blocking `requests`; server client is global | Synchronous; separate client instances are possible |
| Multi-account isolation | Possible only by constructing lower-level clients directly; not guaranteed by the application layer | Directory convention only; global client prevents safe concurrent account isolation | Possible only by constructing clients directly; CLI persistence is one default account |
| Secret handling | Application helper writes raw cookies as plaintext JSON without setting file mode | Writes raw cookies as plaintext JSON without setting file mode | Writes raw cookies as plaintext JSON with mode `0600`, but without encryption or account/purpose/generation binding |
| Protocol tests | Only CLI-format tests; no read/write, auth, challenge, rate, proxy, or crash-after-submit tests | No tests or CI | Good deterministic read/parser/session suite, but no required submit/delete/media or `UNKNOWN` recovery coverage |
| Verdict | **Reject as a package; extract a small reviewed core only** | **Reject as a package; fallback source reference only** | **Reject as a foundation; retain as a behavioral reference only** |

## Primary-candidate source review

The useful seam is
[`RedditAPIClient`](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/scraping/api_client.py#L28-L126).
It accepts an injected cookie map, creates its network session lazily, and uses
direct Reddit JSON and form endpoints. The source implements the Reddit MVP's
text/link submission, delete, comment/reply, vote, and save/unsave routes in a
compact section
([source](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/scraping/api_client.py#L273-L350)).
It also normalizes the main listing, user, subreddit, post, and comment shapes.

The upstream package must not be admitted unchanged:

- Its generic request loop retries 429, 5xx, network, parse, and other failures
  without separating safe reads from state-changing writes
  ([request loop](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/scraping/api_client.py#L54-L115)).
  If a POST reached Reddit before the connection failed, an automatic retry can
  duplicate the action instead of returning `UNKNOWN`.
- The error taxonomy contains only authentication, rate-limit, session-expired,
  and generic errors
  ([exceptions](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/exceptions.py)).
  Challenge, checkpoint, CAPTCHA, protocol drift, wrong identity, revocation,
  and ambiguous submission are not first-class states.
- The MCP tools can discard native write results. For example, comment/reply
  returns the parent ID, and link submission returns the external target URL,
  not a verified canonical Reddit URL
  ([comment tools](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/tools/comments.py#L6-L45),
  [submit tools](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/tools/submit.py#L6-L52)).
- Its default dependency layer caches one global client
  ([source](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/dependencies.py#L18-L76)),
  and its fallback storage writes raw cookie JSON without encryption or an
  explicit restrictive mode
  ([source](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/reddit_mcp_server/session_state.py#L53-L74)).
- `pyproject.toml` declares broad minimum versions and an unpinned Git
  dependency; only `uv.lock` makes the checkout reproducible
  ([metadata](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/pyproject.toml#L5-L19),
  [lock](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/uv.lock#L938-L940)).
  There is no `reddit-lyr` project on PyPI as of the research date even though
  the README instructs `pipx install reddit-lyr`.
- The README's library import names a module that is absent, describes an
  `httpx.AsyncClient` although the source uses `curl_cffi`, and says app
  credentials are required even though the implementation uses sessions
  ([README](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/README.md#L43-L60),
  [architecture/requirements](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/README.md#L80-L126)).
- CI is green at the selected revision, but the workflow converts test failure
  into success and the repository's tests cover CLI formatting rather than the
  protocol client
  ([workflow](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/.github/workflows/ci.yml),
  [test file](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/tests/test_axi_cli_wrappers.py)).

The README says live text/link/comment, reply, delete, vote, search, and read
operations were verified, while messaging is known to fail
([limitations](https://github.com/ishan-parihar/reddit-lyr/blob/87ec32aff905923ecd156e7951c168adfdf6fac1/README.md#L129-L139)).
Those are upstream claims, not Social Git acceptance results. This task did not
use a live account or mutate Reddit.

## Fallback and installed-backend review

`reddit-mcp-noapi` is source-visible and registry-published. Its core uses a
direct `requests.Session`, accepts saved cookies, reads Reddit JSON, and posts
forms to the legacy session endpoints
([source](https://github.com/iris-alights/reddit-mcp/blob/ed0858c0813e50a140719f73cb92ac9390d1b939/reddit_mcp/reddit.py)).
It is smaller than `reddit-lyr`, but it stores plaintext session JSON, uses a
single global server client, has fake async wrappers around blocking calls, and
has no rate/challenge, proxy, save/unsave, or media implementation. Its README
also explicitly warns that its write mode violates Reddit's terms
([README](https://github.com/iris-alights/reddit-mcp/blob/ed0858c0813e50a140719f73cb92ac9390d1b939/README.md#L44-L56)).

`rdt-cli` is the strongest tested codebase of the three and confirms the
browser-free architecture already works locally. It separates read and write
transports and accepts an injected credential
([client](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/client.py),
 [transports](https://github.com/public-clis/rdt-cli/blob/5e4fb3720d5c174e976cd425ccc3b879d52cac66/rdt_cli/transports.py)).
It is nevertheless incomplete for the MVP and retries ambiguous writes. Its
upstream has had no source commit since March, PyPI provides only `0.4.1`, and
open issues document HTTP transport 403s and session-import failures
([issue 13](https://github.com/public-clis/rdt-cli/issues/13),
 [issue 9](https://github.com/public-clis/rdt-cli/issues/9),
 [issue 10](https://github.com/public-clis/rdt-cli/issues/10)).
Some forks have recent commits, including transport changes, but none adds the
required write surface and safety contract
([forks](https://github.com/public-clis/rdt-cli/network/members)).

The local check was deliberately metadata-only:

```text
command -v rdt              -> ~/.local/bin/rdt (pipx launcher)
rdt --version               -> rdt, version 0.4.2
distribution                -> rdt-cli 0.4.2, Apache-2.0 declaration
entry point                 -> rdt_cli.cli:cli
architecture                -> direct httpx read/write transports
```

No `rdt` account command, Reddit request, credential file read, or session value
inspection occurred.

## Cross-language and excluded-project scan

The package-registry scan covered Python, JavaScript/TypeScript, Rust, and Go.
Maintained conventional clients such as
[`PRAW`](https://pypi.org/project/praw/),
[`Async PRAW`](https://pypi.org/project/asyncpraw/),
[`snoowrap`](https://www.npmjs.com/package/snoowrap),
[`roux`](https://crates.io/crates/roux), and
[`go-reddit/reddit`](https://github.com/go-reddit/reddit) target Reddit's public
or OAuth API, so they fail the required protocol model despite generally better
maintenance. The `reddit` npm package is also an official-API client and was
last published years ago. No registry search found a maintained JavaScript,
Rust, or Go library with the required session-write breadth.

Projects that execute requests in Chrome/CDP or replay actions through
Playwright/Selenium are rejected regardless of feature breadth. This includes
[`agents-io/reddit-unofficial-api`](https://github.com/agents-io/reddit-unofficial-api),
[`tail-fin`](https://crates.io/crates/tail-fin-reddit), and similar browser
drivers. The lone `reddit-lyr` fork is older and does not remedy the admission
gaps
([fork](https://github.com/shanghaiEric/reddit-httpx)). Opaque or
non-source-available candidates were not admitted.

## Smallest reusable strategy

If Reddit permission is obtained, do not depend on the upstream application.
Instead:

1. Copy only the MIT-licensed `RedditAPIClient` endpoint mappings and required
   normalizers from revision `87ec32a…`, retaining the license and attribution.
   Do not copy its daemon, browser import, MCP, global dependency cache, session
   files, or retry policy.
2. Put the copied protocol code behind Social Git's adapter interface. Inject
   an already-decrypted, account-bound session and a route-bound HTTP transport
   from Core. Never let the adapter discover or persist credentials.
3. Split safe-read retry from write submission. A write can retry only before
   submission starts. Any timeout, disconnect, 5xx, malformed response, or
   process crash after submission may have started must return `UNKNOWN` and be
   reconciled through the durable action ledger.
4. Add explicit wrong-identity, revoked-session, rate-limit, challenge,
   checkpoint, CAPTCHA, protocol-drift, and `UNKNOWN` results. Stop the account
   worker on each safety state.
5. Add the missing media-upload protocol and verified native-ID/canonical-URL
   extraction before claiming Reddit MVP parity.
6. Run one isolated worker per account/session/route binding. Keep concurrency
   inside an account-specific limiter; do not share cookie jars, CSRF/modhash,
   rate state, or connection pools across accounts.
7. If the eventual transport still uses `curl_cffi`, pin it exactly, record
   hashes, verify supported-platform wheel signing/loading, review transitive
   source/licenses, and add deterministic contract/drift tests before an
   independently authorized live proof. The admission proof below deliberately
   does not install or load that optional native transport.

This is a small lawful source reuse under MIT; it is not an endorsement of the
upstream session storage or an authorization to use Reddit's service.

## Reproducible no-account proof

Run:

```bash
./scripts/prove-reddit-library-import.sh
```

The script checks out the exact primary revision and imports its
`RedditAPIClient` source with a fail-closed, in-memory stub for its sole
third-party module import, `curl_cffi`. It does **not** install the upstream
project, resolve `uv.lock`, or load native wheels. It replaces the client's POST
method with an in-memory recorder and verifies seven route mappings. The stub
raises if the proof tries to create a transport session. The proof uses a dummy
value, does not read a browser or Social Git session, and makes no request to
Reddit.

The first committed proof was not portable. An independent board run on macOS
exited 1 while loading `_cffi_backend.cpython-313-darwin.so`; macOS rejected the
native module under its code-signing policy. The same original proof happened
to pass on the authoring host, which shows why its unqualified PASS was
incorrect. The source-only replacement removes that native import from the
claim being tested. This is a proof-harness correction, not evidence that
`curl_cffi` is production-admissible on macOS.

Observed from a clean detached worktree on 2026-09-14:

```text
host: macOS 26.5.2 (build 25F84), Darwin 25.5.0, arm64
command: ./scripts/prove-reddit-library-import.sh
source_revision=87ec32aff905923ecd156e7951c168adfdf6fac1
source_blob=1a18f05cb12c80094826365557f06dda7953a499
python_mode=installed interpreter
platform=Darwin arm64
python=3.11.15 (cpython)
dependency_install=none
transport=fail-closed curl_cffi stub
PASS: imported exact RedditAPIClient source and verified seven write route mappings with no HTTP session
```

The same source-only proof also passed in an isolated Linux container:

```text
image: docker.io/library/python:3.11.13-alpine3.22
image digest: sha256:801053a2c35d91edc335c4c478f682de905611fed131007715538c7552d943db
container platform: linux/arm64
command: docker run --rm --platform linux/arm64 -e SOCIAL_GIT_SCRATCH_DIR=/scratch -v "$PWD:/work:ro" -w /work python:3.11.13-alpine3.22 sh -lc 'apk add --no-cache bash git >/dev/null && ./scripts/prove-reddit-library-import.sh'
source_revision=87ec32aff905923ecd156e7951c168adfdf6fac1
source_blob=1a18f05cb12c80094826365557f06dda7953a499
python_mode=installed interpreter
platform=Linux aarch64
python=3.11.13 (cpython)
dependency_install=none
transport=fail-closed curl_cffi stub
PASS: imported exact RedditAPIClient source and verified seven write route mappings with no HTTP session
```

This proves only that the selected source revision is importable and exposes
the claimed route mappings when its transport dependency is replaced. It does
not prove that `curl_cffi` loads on any target host, that Reddit accepts the
routes, or that the library is production-safe. Production admission still
requires a separately pinned and platform-tested transport.
