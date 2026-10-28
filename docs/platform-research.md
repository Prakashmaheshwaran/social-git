# Platform Adapter Research

Research date: 2026-10-27. Scope: protocol and supply-chain assessment of
Instagram, YouTube, and LinkedIn as potential Social Git platforms.

**This document is research, not admission.** No platform described here is
admitted, implemented, or supported. A GO-WITH-SCOPE verdict below is a
permission to *start* the source/licence review described in
[`platform-adapter-checklist.md`](platform-adapter-checklist.md) — never a claim
of live support or parity. Every platform still requires the full admission
checklist, deterministic contract and protocol-drift tests, and a separately
authorized live proof before any capability is enabled. None of that has
happened for Instagram, YouTube, or LinkedIn.

All work behind this document was read-only: `gh api`, `gh search`, `npm view`,
`curl` against `pypi.org` and `api.github.com`, and repository reads at pinned
commits. No request was sent to instagram.com, youtube.com, googleapis.com, or
linkedin.com. No library was installed or executed.

## Verdicts

| Platform | Verdict | Deciding reason |
| --- | --- | --- |
| Instagram | **GO-WITH-SCOPE** | A maintained MIT corpus exists whose *web* surface accepts an owner-exported browser cookie without a device fingerprint or request signing. Ten operations are feasible; five are deferred. |
| YouTube | **GO-WITH-SCOPE, read-only** | Reads need no attestation. Every write requires executing Google-supplied BotGuard JavaScript in a DOM, which the project's no-browser rule forbids. No write path exists. |
| LinkedIn | **NO-GO** | The library named in earlier research has been deleted (HTTP 404). No licence-clean, maintained corpus implements the write surface. |

---

## Instagram — GO-WITH-SCOPE

### Candidate sources

| Repository | Licence | Pin | Last commit | Disposition |
| --- | --- | --- | --- | --- |
| `subzeroid/instagrapi` (formerly `adw0rd/instagrapi`) | MIT; GitHub reports `NOASSERTION` | tag `3.2.2` → `28f0279648c9bc4676c94e4c5b21bbf16275827e`, released 2026-10-27 | 2026-10-27 | **Primary corpus candidate** |
| `diezo/Ensta` | MIT | repository head (`ensta/WebSession.py`); blob not yet hashed | 2026-09-13 | **Web-surface cross-check** |
| `jlobos/instagram-web-api` | MIT | `e85a0f603e5be9e147606feed73a5057d74c5c60` (`lib/index.js` blob `906057187b86ab6e7a6b10aa669d1a27bd7600f6`) | 2020-08-06 | Historical evidence only (2020 routes) |
| `dilame/instagram-private-api` | MIT | `3a153c4e807049e95d72af67e316d432c2fd1577` | 2024-03-08 | **Reject** — dead, 408 open issues, depends on deprecated `request@2.88.0` |
| `instaloader/instaloader` | MIT | tag `v4.16` → `3338260f5d956e8b0da862c8b535f667ae791841` | 2026-10-26 | Read-only reference; exposes no like/follow/comment methods |
| `subzeroid/aiograpi` | MIT | — | 2026-10-27 | Optional async mirror |

Verified repository facts: `subzeroid/instagrapi` is not archived, has 7,030
stars, and was pushed on 2026-10-27. The tag `3.2.2` dereferences to commit
`28f0279648c9bc4676c94e4c5b21bbf16275827e`. `dilame/instagram-private-api`
carries 408 open issues; `jlobos/instagram-web-api` was last pushed in 2020;
`instaloader/instaloader` has no `def like`, `def follow`, or `def comment`
method in `instaloader/instaloader.py`.

### Licence: MIT with two copyright lines

`instagrapi`'s `LICENSE` (blob `b4477325fefd9c66510b9b6369a7b6ae18258ff7`)
reads:

```
MIT License

Copyright (c) 2023-2026 Mark Subzeroid and instagrapi contributors
Portions of the realtime MQTT implementation are derived from instagram_mqtt:
Copyright (c) 2019 Nerixyz
```

GitHub reports `license.spdx_id` as `NOASSERTION` rather than `MIT` precisely
because of the second copyright holder. Both lines must be reproduced verbatim
in `THIRD_PARTY_NOTICES.md` if any corpus is extracted, exactly as the Reddit
notices reproduce the PRAW BSD-2 text. Licence compatibility is not in question;
the notice obligation is.

### Two surfaces, and only one accepts an owner cookie

Instagram exposes two unrelated HTTP APIs with separate capabilities, separate
stop signals, and separate session provenance.

**Web surface — `https://www.instagram.com/api/v1/…`**

- Cookies: `sessionid`, `ds_user_id`, `csrftoken`, `rur`, `mid`, `ig_did`. Ensta
  sets exactly this set domain-scoped to `.instagram.com`; without a domain the
  cookies duplicate and Instagram answers with a redirect or an HTML app shell.
- Headers: `X-IG-App-ID: 936619743392459`, `X-CSRFToken`, `X-Requested-With`,
  optional `X-IG-WWW-Claim` from the `x-ig-set-www-claim` response header.
- The web app id is a published constant: `PUBLIC_WEB_APP_ID` in
  `instagrapi/mixins/public.py` and `IG_APP_ID` in Ensta's
  `ensta/lib/WebHeaders.py` are independently `936619743392459`.
- **No device fingerprint and no cryptographic request signing.** Cookie plus
  CSRF header is sufficient for the routes listed below.

**Mobile private surface — `https://i.instagram.com/api/v1/…`**

- Requires the same cookies plus an `Authorization` value derived from
  `sessionid`/`ds_user_id`, a Pixel 8 Pro Android profile with app version
  `449.0.0.52.84`, and roughly thirty further `X-IG-*` headers including
  `X-IG-Device-ID` and `X-Bloks-Version-Id`.
- The `signed_body=SIGNATURE.{data}` wrapper is a **literal constant prefix**,
  not a cryptographic signature. The real barrier is the TLS/HTTP2 fingerprint
  and device-consistency narrative.

**A browser-exported session belongs to the web surface.** instagrapi documents
this itself — `docs/usage-guide/interactions.md` and `README.md` both state that
a browser/web `sessionid` "can be rejected with `login_required` or invalidated
server-side" by the private mobile API, and recommend a password `login()` plus
`dump_settings()` instead. A password login is out of scope: Social Git never
holds credentials. Therefore **the recommended transport is the web surface
only**, and the capability set is trimmed to what that surface serves.

### Identity verification

1. `GET https://www.instagram.com/api/v1/accounts/edit/web_form_data/` — the
   liveness and identity probe Ensta uses (`WebSession.py`, `authenticated()`).
2. `GET https://www.instagram.com/api/v1/users/{ds_user_id}/info/` — returns
   `user.username`.
3. instagrapi's `login_by_sessionid` parses the leading digits of `sessionid` as
   the user id and asserts they exist. Treat that as a hint only, never as
   verification.

Bind the returned native `pk`/`username` against the immutable expected identity;
a mismatch is `WRONG_ACCOUNT` and a stop.

### Contract mapping

FEASIBLE: a web-surface route with corroboration and no known blocking
behaviour. RISKY: the route exists but a documented failure, token dependency,
or only legacy evidence applies. UNSUPPORTED: not reachable on the admitted
surface.

| # | Operation | Endpoint (surface) | Verdict | Reason |
| --- | --- | --- | --- | --- |
| 1 | own profile get | `GET www/api/v1/accounts/edit/web_form_data/` | FEASIBLE | Cookie+CSRF only; doubles as the identity probe |
| 2 | user profile get | `GET www/api/v1/users/web_profile_info/?username=` with a `users/{pk}/info/` fallback | RISKY | `web_profile_info` returns HTTP 400 for business accounts; needs a dual path |
| 3 | media/post get | `GET i/api/v1/media/{pk}/info/` or web `graphql/query` with a doc_id | RISKY | Native path is mobile-only; the web path is doc_id-versioned |
| 4 | comments list (paginated) | `GET www/api/v1/media/{pk}/comments/` with `min_id`/`max_id` | FEASIBLE | Cursor pagination documented in source; see the masked-challenge case below |
| 5 | user feed | `GET www/api/v1/feed/user/{pk}/?count=` or GraphQL doc_id | RISKY | Ensta documents that the REST form now redirects logged-in sessions to the home page; the working form is a rotating GraphQL doc_id |
| 6 | home timeline | `POST i/api/v1/feed/timeline/` | UNSUPPORTED | Mobile-only route; needs the device/TLS profile a web cookie cannot supply |
| 7 | search users | `GET www/web/search/topsearch/?context=user` | FEASIBLE | Anonymous reachability; `OpenCLI` uses it with only the app-id header |
| 8 | search hashtags | `GET www/web/search/topsearch/?context=hashtag`, or `GET i/api/v1/tags/search/` | FEASIBLE | Web topsearch returns a `hashtags` array |
| 9 | comment create | `POST www/api/v1/web/comments/{pk}/add/`, body `comment_text` | FEASIBLE | Form-encoded plus `X-CSRFToken`; corroborated by Ensta |
| 10 | comment reply | same route plus `replied_to_comment_id` | RISKY | Only 2020-era evidence; unconfirmed on the current web surface |
| 11 | like / unlike | `POST www/api/v1/web/likes/{pk}/like/` and `…/unlike/` | FEASIBLE | Ensta implements both |
| 12 | save / unsave | `POST www/api/v1/web/save/{pk}/save/` and `…/unsave/` | FEASIBLE | Two independent clients implement both |
| 13 | follow / unfollow | `POST www/api/v1/friendships/create/{id}/` and `…/destroy/{id}/` | FEASIBLE | Ensta implements follow; `OpenCLI` implements both |
| 14 | delete own comment | `POST www/api/v1/web/comments/{pk}/delete/{comment_id}/` | RISKY | Only 2020-era evidence. Highest-consequence operation, so unproven is disqualifying pending live proof |
| 15 | photo post create | `POST i.instagram.com/rupload_igphoto/…` then `POST www/api/v1/media/configure/` | RISKY | Multi-phase, roughly forty form fields, and requires `X-Instagram-Ajax` plus `x-ig-www-claim` |

**Candidate admitted set (fixture- and source-admissible only):** identity
verify, own profile get, user profile get (dual path), comments list, search
users, search hashtags, comment create, like/unlike, save/unsave,
follow/unfollow.

**Explicitly deferred**, each with a named disabled reason and
`productionEnabled: false`: home timeline, user feed (until the GraphQL doc_id
path is proven), comment reply, comment delete, media post create.

### Stop signals

| Signal | Where observed | Fail-closed action |
| --- | --- | --- |
| `{"message":"checkpoint_required"}` HTTP 400 | **Not classed in code.** `docs/exceptions.md` documents a `CheckpointRequired` exception, but `instagrapi/exceptions.py` defines 92 classes and none is `CheckpointRequired`. A `checkpoint_required` body falls through the 400 branch to `UnknownError`. | Parse the body directly; stop circuit; human checkpoint required |
| `{"message":"challenge_required"}` | `ChallengeRequired`; `/suspended/` in the challenge URL raises `AccountSuspended` instead | Stop; no retry; never invoke `challenge_resolve` |
| `{"message":"feedback_required"}` | `FeedbackRequired`, message augmented with `feedback_message` | Freeze that account **and** that action type |
| `{"message":"login_required"}` HTTP 403 | `LoginRequired` | Session `REVOKED`; require re-export |
| `two_factor_required` | `TwoFactorRequired` | Stop |
| `consent_required`, `geoblock_required` | Documented in `docs/exceptions.md`; **no classes in code** | Parse the body; stop |
| HTTP 429 | `ClientThrottledError` | Stop |
| HTTP 401 | `ClientUnauthorizedError` | `REVOKED` |
| **HTTP 404 with a bare `Not Found` body** | instagrapi reclassifies this as a **masked challenge** on comment routes — "IG returns the bare body `Not Found` … Surface it as `ChallengeRequired`" | Must be reproduced. A naive worker would report `NOT_FOUND` and continue |
| `error_type == "sentry_block"` | `SentryBlock` | Stop |
| `error_type == "rate_limit_error"` | `RateLimitError` | Stop |
| `error_type == "needs_upgrade"` | `ClientNeedsUpgradeError` | **Protocol drift** → retire the pinned corpus |
| `"Please wait a few minutes"` | `PleaseWaitFewMinutes` | Stop, long cooldown |
| `"The username you entered doesn't appear to belong to an account"` | Reclassified as `ProxyAddressIsBlocked`; the source comment says Instagram has blocked the caller's IP | Stop; do **not** treat as "user not found" |
| HTTP redirect to `/accounts/login/` on a data request | Ensta raises `RateLimitedError` on 301/302/303/307/308 and on `payload.require_login` | Stop |
| HTML app shell instead of JSON | Ensta documents the current web behaviour; instaloader requires `lsd`/`fb_dtsg` from the start page | Treat non-JSON as challenge or drift, never as empty data |

**Library behaviours that must be excluded from any adapted corpus.** Each
violates the no-retry, no-challenge-solving, or fail-closed rule:

1. `private_request` retries after `ClientRequestTimeout` following a 60-second
   sleep, and after `ClientIncompleteReadError` following 2 seconds. A retried
   POST body is a potential double write.
2. `private_request` auto-invokes `challenge_resolve` when `with_challenge_flow`
   is set.
3. `public_request` loops over `retries_count` with `time.sleep`.
4. `private_request` sleeps before every non-login request and applies
   `delay_range`. Acceptable as pacing, but must not be inherited as a hidden
   queue.

### Honest risk

The maintainer's own README states that private-API automation "is fragile in
production because account trust, proxies, device state, challenges, and rate
limits can change independently of the library", that a hosted provider may be
a better fit for production infrastructure, and that the project "is best
suited for testing, research, and controlled internal automation". The project
also runs an affiliate programme and links a commercial SaaS — no licence
impact, but it colours the "safe in production" advice.

Documented ban and flag evidence in the issue tracker includes an account
banned after a single follow (2023), a suspension despite paid proxies (2024),
and an open 2026 report where followers/following silently returns **0 rows** on
every code path for accounts whose private API returns a checkpoint. A
gateway must convert that silent-empty result into `PROTOCOL_DRIFT`.

A safe adapter should enforce, as our own conservative choices — Instagram
publishes no limits, so any specific threshold is unverified:

- One account to one pinned egress identity; abort on any resolved-address change.
- Read polling at a multi-minute interval per account per endpoint family; at
  most one request in flight per account.
- Writes: hard per-account daily caps with a **separate bucket per action type**,
  because `feedback_required` is issued per action type.
- Freeze on the first `feedback_required`, `PleaseWaitFewMinutes`, or HTTP 429
  for hours, with manual re-enable.
- No bulk follow/like loops and no automated new-account warmup.
- Treat silent-empty results as `PROTOCOL_DRIFT`.
- Restrict to the **web** surface so the TLS fingerprint is a plain Node HTTPS
  client hitting a surface that expects browser cookies.

---

## YouTube — GO-WITH-SCOPE, read-only

**Recommendation: a read-only platform. Every write operation is a hard NO-GO.**

### Candidate sources

| Source | Revision | Licence | Verdict |
| --- | --- | --- | --- |
| `LuanRT/YouTube.js` (npm `youtubei.js`) | v18.3.0 → `204715b6acfb063dc306d8677e36fdbf09f293c5` | MIT | Primary corpus candidate |
| `yt-dlp/yt-dlp` | `f264a6cbd1f630894da0f368df00f8aae50140e0` | Unlicense | Supporting evidence only, rejected as primary |
| `LuanRT/BgUtils` | v4.0.3 → `f39a04173c6af1056c39a9a72c8f04bc86b5cfd2` | MIT | Rejected; documents the attestation requirement |
| `pytube/pytube` | last push 2024-08-15 | **Unlicense** — not MIT | Rejected; unmaintained |
| `jdepoix/youtube-transcript-api` | — | MIT | Rejected; transcripts only |

Verified: `repos/LuanRT/YouTube.js/git/ref/tags/v18.3.0` resolves to
`204715b6acfb063dc306d8677e36fdbf09f293c5`, and npm's `gitHead` for
`youtubei.js@18.3.0` matches exactly. The repository is not archived, has 5,398
stars and 80 open issues. Its runtime dependencies are declared with caret
ranges — `fflate ^0.8.2`, `@bufbuild/protobuf ^2.0.0`, `meriyah ^7.3.1` — which
fails exact version pinning as-is. `meriyah` exists to parse Google's player
JavaScript for n/sig challenge solving and must be excluded from any extracted
corpus.

### Why writes fail

Maintainer statement in issue #1165:

> "For every engagement action (like/dislike/subscribe), YouTube sends a command
> to run a BotGuard challenge. You have to run that challenge in a convincing way
> for the action to stay, and your account has to be a 'trusted' account (not
> shadow banned from commenting, etc)."

Maintainer statement in issue #878:

> "I believe you'll only get shadow banned if your account has a 'low
> reputation'. If you need comments on such accounts to stay up, you'll have to
> run the attestation command returned by the `createComment` function."

and, on how: "You can use something like BgUtils (ideally in a real browser) to
get a BotGuard response."

Satisfying the challenge means fetching `bgChallenge.interpreterJavascript` from
the response and executing it, which BgUtils does inside a `jsdom` window. That
is two independent rule violations: it requires a browser-like DOM, which is the
substance of the no-browser rule, and it is arbitrary remote code supplied by
Google at request time inside the worker. No checklist gate can approve that.

The failure mode is also silent. A like returns HTTP 200 and is later removed by
the platform — a write reporting success without a verified native result, which
is exactly what the Reddit admission decision's requirement 6 forbids.

**Premium is not a write path.** yt-dlp's `not_required_for_premium` flag applies
to **streaming (GVS) PO tokens**, not to BotGuard engagement attestation. The
flag appears on `GvsPoTokenPolicy` entries in yt-dlp's `WEB_PO_TOKEN_POLICIES`
and governs media streaming only. There is no exemption for engagement actions.

### Reads need no PO token

For the admitted read scope, no token is required:

- yt-dlp defines `_PoTokenContext` with `PLAYER`, `GVS`, and `SUBS`.
- `GVS` (streaming) is `required=True` for WEB over HTTPS and DASH. Social Git
  never streams media, so this never applies.
- `PLAYER` policy for web is `PlayerPoTokenPolicy(required=False)`.
- `SUBS` is not required.

Metadata, feeds, search, and comments are reachable with a SAPISIDHASH cookie
session and no attestation. That is the recommended scope.

### Session protocol

Authorization header, from `src/utils/Utils.ts`:

```
SAPISIDHASH <unix_timestamp>_<sha1("<unix_timestamp> <SAPISID> https://www.youtube.com")>
```

yt-dlp additionally emits `SAPISID1PHASH` from `__Secure-1PAPISID` and
`SAPISID3PHASH` from `__Secure-3PAPISID`, falls back to `__Secure-3PAPISID`
when `SAPISID` is absent, and uses `LOGIN_INFO` presence as the revocation
canary because `__Secure-3PAPISID` survives cookie rotation.

Required headers: `Authorization`, `Cookie`, `X-Goog-AuthUser`,
`X-Origin: https://www.youtube.com`, `X-Goog-Visitor-Id`,
`X-Youtube-Client-Version`, `X-Youtube-Client-Name`, and on server runtimes
`Origin` and `User-Agent`.

**Identity binding gap.** `account/accounts_list` returns account items with
`account_name`, `account_photo`, `is_selected`, `channel_handle`, and similar
fields — but **no channel ID**. Core needs an immutable native identifier.
The remedy is to follow the selected account with one bounded `browse` read on
the channel and match the `UC…` channel ID; a handle is mutable and can only be
advisory.

**Critical:** `Session.ts` sets `logged_in = !!cookie`, which is presence only
and never validated against the platform. Core must not trust that flag for
identity or auth state.

### Endpoint mapping

| Contract operation | InnerTube endpoint(s) | Verdict |
| --- | --- | --- |
| channel/profile get | `browse` with `browseId=UC…` | FEASIBLE |
| video get (metadata) | `player` + `next` | FEASIBLE — player PO token optional for metadata; no media streaming |
| comments list + continuation | `next` with a continuation token | FEASIBLE |
| search | `search` | FEASIBLE |
| home feed | `browse` `FEwhat_to_watch` | FEASIBLE |
| subscriptions feed | `browse` `FEsubscriptions` | FEASIBLE — requires login |
| comment create / reply | `comment/create_comment` | NEEDS-PO-TOKEN — BotGuard attestation |
| like / dislike / remove rating | `like/like`, `like/dislike`, `like/removelike` | NEEDS-PO-TOKEN — silent removal |
| subscribe / unsubscribe | `subscription/subscribe`, `subscription/unsubscribe` | NEEDS-PO-TOKEN |
| edit own comment | none in corpus | UNSUPPORTED — no edit path |
| delete own comment | none in corpus | UNSUPPORTED — absent from corpus |
| playlist save | `browse/edit_playlist` | NEEDS-PO-TOKEN — engagement-class write |

### Stop signals

| Stop state | Wire evidence |
| --- | --- |
| Bot challenge | `playabilityStatus.status = "LOGIN_REQUIRED"` with reason "Sign in to confirm you're not a bot"; `FormatUtils.ts` throws `error_type: 'LOGIN_REQUIRED'` |
| CAPTCHA required | `errorScreen.playerCaptchaViewModel` present |
| Consent redirect | A redirect to `consent.youtube.com`, or a `SOCS` cookie not beginning with `CAA` |
| Rate limited | HTTP 429 or 403 |
| Session revoked | HTTP 401 on an authenticated call, plus `LOGIN_INFO` disappearing after having been present |
| Wrong identity | The selected channel ID does not equal the expected identity |
| Protocol drift | Missing expected renderer fields or an unrecognised `playabilityStatus.status` |

The library performs no consent-cookie bootstrap. Core must not treat an
authenticated session as consent-complete by assumption.

### Top risks

1. **The write surface is unattainable.** No compliant path exists for any write.
   This permanently diverges from the Reddit MVP contract and must be stated to
   users, not hidden as "coming soon".
2. **Shadowban is undetectable failure.** Writes return 200 and silently vanish.
3. **Identity binding gap.** `accounts_list` omits the channel ID, so binding
   needs a second bounded read, and handles are mutable.
4. **Supply-chain fragility.** Single-maintainer concentration, caret-ranged
   dependencies, and a JavaScript-parsing dependency imply high protocol drift.
5. **Transport defaults violate the egress rule.** The library follows redirects
   and references multiple hosts including staging, sandbox, `music.youtube.com`,
   and `upload.youtube.com`. An in-house transport must reject redirects and pin
   to `www.youtube.com` only.

Upstream test coverage is thin and live-network dependent, so it provides no
deterministic fixtures to reuse.

---

## LinkedIn — NO-GO

### Candidate sources

| Repository | Licence | Pin | Last commit | Disposition |
| --- | --- | --- | --- | --- |
| `tomquirk/linkedin-api` | MIT (declared in the sdist) | **repository deleted — HTTP 404** | last PyPI upload 2024-11-07 | **Reject** — no source of record |
| `EseToni/open-linkedin-api` | MIT | `5feee360ec26719d07d5e67638045e751b48a74c` | 2025-04-17 | Reject as runtime source; protocol evidence only |
| `eisbaw/linkedin-rs` | **none declared** — `repos/eisbaw/linkedin-rs/license` returns 404 | `a7c8b40699d2cfa73aa3b1be665e505922070190` | 2026-03-27 | Reject as corpus (unlicensed); unadmitted map only |
| `eilonmore/linkedin-private-api` | MIT | `e083f370c331ed643348158b8c64f905de477626` | 2023-05-01 | Reject — dead, 40 open issues |
| `nsandman/linkedin-api` | MIT | `c75a3cb4538de5a02d66251221096dd4b0d3a3de` | 2019-07-25 | Reject — dead |

### The corrections that matter

**`tomquirk/linkedin-api` no longer exists.** `gh api
repos/tomquirk/linkedin-api` returns `Not Found (HTTP 404)`, and
`curl https://github.com/tomquirk/linkedin-api` returns `404`. The user account
`tomquirk` still exists; the repository is absent from it. PyPI's
`linkedin-api==2.3.1` sdist (sha256
`07ab020440a049e48e6c55d6b61fbab049480225ec8a82f14e5c077ae7ecc984`, uploaded
2024-11-07, not yanked) still resolves and still advertises the dead homepage.
`EseToni/open-linkedin-api`'s description calls it "the now-private
linkedin-api".

**Earlier research had the technical verdict backwards.** It claimed the library
"uses official LinkedIn API, not direct session transport". The opposite is
true: the 2.3.1 sdist sets `API_BASE_URL = f"{LINKEDIN_BASE_URL}/voyager/api"`,
and the README says "Do you mean the *legit LinkedIn API*? **NO!** To retrieve
structured data, the LinkedIn Website uses a service they call **Voyager**."
The correct rejection reason is that the repository is gone, the code is stale,
and it has no write-side content-creation coverage — not that it uses the
official API. The verified `EseToni/open-linkedin-api` client shows the same
`/voyager/api` base and the `x-restli-protocol-version: 2.0.0` header.

### Protocol facts

- Base `https://www.linkedin.com`, prefix `/voyager/api/`.
- Auth is **cookie-only with no refresh**: `li_at` plus `JSESSIONID` echoed as
  `Csrf-Token`. There is no token refresh mechanism; a 401 is terminal.
- **Mobile-only requirements a web cookie cannot satisfy:** `X-LI-Track` device
  telemetry plus `X-UDID` on every request, over a Cronet transport whose TLS
  fingerprint is Chromium's. `linkedin-rs` concedes its own Rust client does not
  match.
- Rest.li query encoding is not standard percent-encoding; reserved characters
  are hex-escaped across two layers.
- Identity verification is genuinely good: `GET /voyager/api/me` returns
  `plainId` and `miniProfile`.

Reads and identity are tractable. The blocker is scope, not protocol.

### Contract mapping

| # | Operation | Verdict | Reason |
| --- | --- | --- | --- |
| 1 | own profile get | FEASIBLE | Clean, confirmed in client code |
| 2 | profile get | RISKY | Legacy route returns HTTP 410 Gone; the current path is GraphQL with a rotating `queryId` |
| 3 | feed | RISKY | V2 is app-only; the legacy path is unproven against the current web |
| 4 | post get | RISKY | No dedicated single-post GET; requires exact Rest.li list encoding |
| 5 | comments list | FEASIBLE | Implemented in both candidate libraries |
| 6 | search people | RISKY | An open issue reports an empty list regardless of input — the same silent-failure class as Instagram's 0-row bug |
| 7 | post create (text) | UNSUPPORTED | Neither library implements it; evidence is only APK decompilation in an unlicensed repository |
| 8 | comment create | UNSUPPORTED | No implementation in any licence-clean source |
| 9 | react / unreact | RISKY | React works; modern unreact is a GraphQL-only mutation unimplemented in both libraries |
| 10 | delete own post | UNSUPPORTED | No admitted implementation |

Five of ten required operations are UNSUPPORTED and three more are RISKY. The
write half — the point of a gateway — is entirely missing.

### Stop signals

| Signal | Evidence | Action |
| --- | --- | --- |
| **HTTP 999** | LinkedIn's "Request denied", served to blocked clients for existing and non-existing profiles alike | Stop circuit. **Never** map to 404/NOT_FOUND — that is the exact documented bug this status causes |
| Redirect to `/checkpoint/…` | Auth-flow documentation | Stop; human required |
| Redirect to `/authwall` | Same family | Stop |
| `{"login_result":"CHALLENGE"}` HTTP 401 | `ChallengeException` in the client library | Stop |
| **CSRF/JSESSIONID rotation mid-session** | An open issue reports that sending a connection request invalidates `JSESSIONID` for all later calls | Treat as revocation; re-verify identity before any further call |
| HTTP 401 | The app logs out when `li_at` is present | `REVOKED` |
| HTTP 429 | No client-side handling exists at all | Stop |
| HTTP 410 | Open issue on the legacy profile route | Protocol drift → retire the route |
| Empty result where metadata implies otherwise | Open search issue | `PROTOCOL_DRIFT`, not empty |

**Disqualifying corpus behaviours:** `default_evade()` sleeps a random 2–5
seconds on every fetch and post, with the docstring "A catch-all method to try
and evade suspension from Linkedin" — an evasion primitive on the write path, not
pacing. Writes also return inverted booleans with no native result, e.g.
`return res.status_code != 201`, which cannot satisfy the verified created
native identifier requirement.

### Honest risk

Challenge frequency is unfixable by the project: the README in both libraries
says "Linkedin will throw you a curve ball in the form of a Challenge URL. We
currently don't handle this, and so you're kinda screwed." Write risk exceeds
read risk, and `linkedin-rs` warns that posting, commenting, and connection
requests "may trigger additional validation, CAPTCHA challenges, or rate
limiting that read-only operations do not". Session fragility is structural, not
a bug: no token refresh, a terminal 401, and mid-session CSRF mutation mean a
long-lived multi-account gateway would spend most of its lifecycle in
re-authentication, which requires the owner to be present. Account-restriction
risk is unquantified because no maintained browser-free client exists, so nobody
accumulates the evidence.

**Reason for NO-GO, stated precisely:** no licence-clean, maintained corpus
exists; the library named in our earlier research has been deleted; five of ten
required operations have no implementation anywhere admissible; and the only
protocol map is unlicensed and single-commit. This is a source-availability
judgement under the AGENTS.md gate, not a difficulty judgement.

**Re-open conditions:** (a) a maintained MIT or Apache-2.0 Voyager corpus
appears that implements the content-creation and comment-create mutations, with
a licence and more than one contributor; (b) it documents the mid-session CSRF
rotation behaviour; (c) a live identity proof against a real owner session is
separately authorized for QA. Until (a), even the read-only subset is not worth
building on a 2022 codebase carrying an open 410 and an open empty-search bug.

---

## Ranking for implementation order

1. **Instagram** — the only one of the three that clears the supply-chain gate at
   all: a live MIT corpus under weekly release with browser-free transports, web
   surface routes corroborated by a second independent current source, and around
   ten feasible operations on a surface an owner's exported browser cookie was
   minted for. Its stop signals are enumerable strings a fail-closed worker can
   parse itself, including one the library gets wrong and one it handles only via
   a special case. Its risks are real but operational.
2. **YouTube, read-only** — a strong corpus, a clean read protocol with no
   attestation, and an identity binding gap that costs one extra bounded read.
   The write surface is permanently closed.
3. **LinkedIn** — defer. A clean identity endpoint and a well-specified wire
   protocol sitting on a dead ecosystem, a deleted source of record, an
   unlicensed single-commit reference, and no write implementations at all.

## What research does not authorize

- No platform above has passed source review, corpus extraction, contract tests,
  protocol-drift tests, or supply-chain review.
- No platform above has a committed corpus, a pinned `THIRD_PARTY_NOTICES.md`
  entry, or a capability array in any adapter package.
- No platform above has any live evidence. Live acceptance belongs to an
  independent QA role and requires a separately authorized task, per `AGENTS.md`.
- Research verdicts here never substitute for the admission checklist in
  [`platform-adapter-checklist.md`](platform-adapter-checklist.md).
