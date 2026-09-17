# X direct-session production candidate

Date: 2026-09-17 UTC. Task: DYN-116.

## Verdict

**Candidate boundary implemented; production admission denied.** All 19 existing
X contracts remain fixture-enabled and production-disabled. The machine-readable
decision is `X_TRANSPORT_ADMISSION` in `packages/x-adapter/src/admission.mjs`.
The failing gates are:

- `ENDPOINT_CURRENTNESS_UNPROVEN`
- `CLIENT_TRANSACTION_HEADER_UNPROVEN`
- `AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING`
- `AUTHORIZED_LIVE_READ_PROOF_MISSING`
- `AUTHORIZED_LIVE_WRITE_PROOF_MISSING`

The transaction algorithm itself is implemented and deterministic. The second
reason means compatibility with X's current server-side validation is not live
proven; it does not mean the implementation is absent.

## Source-corpus decision

`unclecode/twikit@6a73ab97f4de09f79139f6308c9fb80029a9f5f7`
is admitted only as an immutable MIT source corpus. It is not a runtime
dependency and no Python source is vendored or executed. Exact Git blob and
SHA-256 evidence is exported by `X_PROTOCOL_SOURCE`; the full MIT notice is in
`packages/x-adapter/THIRD_PARTY_NOTICES.md` and copied into the runtime image.

The current alternative metadata from DYN-93 was refreshed on 2026-09-17:

| Candidate | Latest reviewed revision | DYN-116 consequence |
| --- | --- | --- |
| PawiX25/twifork | `5a4fc255fdf76997bc9ddc19eb314be9c823aaf1` | Newer/broader, but documented impersonation and challenge surfaces remain inadmissible. |
| vladkens/twscrape | `55ac729f39fbbe46e316746a55627a9ed920112c` | Active reads, but account-pool rotation/retry semantics conflict with single-account stop behavior. |
| unclecode/twikit | `6a73ab97f4de09f79139f6308c9fb80029a9f5f7` | Narrowest auditable repair corpus; selected for extraction, not execution. |
| d60/twikit | `c3b7220866f8582009fe2d1155b6fe92192a2711` | Latest reviewed change is documentation-only and lacks the fork's 2026 chunk parser repair. |
| twitter-api-client | `c150f1a3492ce3db15b954f2bc18b4976500a73b` | Too stale for a volatile private protocol. |
| TweeterPy | `266503de017ef6615819b6fdc20dd722d7c39f54` | Read-oriented and its required transport dependency is outside the admitted boundary. |

## Candidate boundary

- Core remains owner of encrypted session material, expected native identity,
  tenant/account/session generation, route binding, policy, durable action and
  idempotency state.
- The candidate accepts exactly two cookies: `auth_token` and `ct0`. No browser
  cookie extraction, login, password, email, MFA, or raw session return exists.
- Fixed egress targets are `x.com`, `api.x.com`, `upload.x.com`, and the exact
  required static-asset host `abs.twimg.com`. DNS is resolved for every request,
  private/metadata addresses are denied, redirects are denied, and descriptors
  are origin-relative.
- Home HTML is capped at 256 KiB and ondemand asset text at 1 MiB. Regex matches,
  decoded key length, key indices, frame rows, iterations, timestamp, and output
  are bounded. JavaScript is never evaluated or dynamically loaded as code.
- Every product operation produces one explicit bounded protocol request/page;
  pagination is caller-driven. Transaction bootstrap is one home document plus
  one pinned ondemand asset request per candidate transport generation.
- Auth, access/challenge, rate limit, unknown variants, repeated cursors, and
  partial errors fail closed. Raw bodies, headers, cookies, and upstream objects
  never escape normalization.
- Writes are single-attempt. A disconnect after dispatch is `UNKNOWN`, with no
  automatic retry/resubmit. Existing Core durable claim fencing and idempotency
  remain authoritative.
- Media is modeled as bounded `INIT -> APPEND -> FINALIZE -> submit` phases.
  Each phase is exact and account/generation-bound; production stays disabled
  until authorized proof covers the complete phase boundary.

## Exact capability matrix

| Contract | Candidate mapping | Fixture | Production |
| --- | --- | --- | --- |
| `account.identity` | account settings | enabled | disabled |
| `profile.get` | `UserByScreenName` | enabled | disabled |
| `post.get` | `TweetResultByRestId` | enabled | disabled |
| `thread.get` | `TweetDetail` | enabled | disabled |
| `timeline.home` | `HomeTimeline` | enabled | disabled |
| `timeline.user` | `UserTweets` | enabled | disabled |
| `search.query` | `SearchTimeline` | enabled | disabled |
| `notifications.list` | notifications all | enabled | disabled |
| `conversations.list` | DM inbox initial state | enabled | disabled |
| `bookmarks.list` | `Bookmarks` | enabled | disabled |
| `post.create` | `CreateTweet` | enabled | disabled |
| `post.reply` | `CreateTweet` reply variables | enabled | disabled |
| `post.delete` | `DeleteTweet` | enabled | disabled |
| `post.like.set` | `FavoriteTweet` / `UnfavoriteTweet` | enabled | disabled |
| `post.repost.set` | `CreateRetweet` / `DeleteRetweet` | enabled | disabled |
| `profile.follow.set` | friendships create / destroy | enabled | disabled |
| `bookmark.set` | `CreateBookmark` / `DeleteBookmark` | enabled | disabled |
| `post.media.create` | upload phases plus `CreateTweet` | enabled | disabled |
| `message.send` | DM new | enabled | disabled |

## Runtime and policy state

The image now contains the source notice and the dependency-free X adapter.
Compose defines a separate `x-worker` UID/container/network and `x-egress`
network (`twitter-egress`). Its health endpoint reports the machine admission decision; dispatch
returns `X_TRANSPORT_NOT_ADMITTED` without accepting session material while any
gate is false. Repository and image policies forbid all reviewed X client
packages from appearing in runtime manifests or SBOMs.

No live X call, browser, official developer API, OAuth flow, TLS/fingerprint
impersonation, proxy, account rotation, challenge/MFA automation, or push was
used by this work.
