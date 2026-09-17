# X read/write contract foundation

Status: fixture-complete, production-disabled. This work implements product contracts and a strict
synthetic protocol corpus; it does not claim current X private-protocol compatibility.

## Capability matrix

| Operation | REST / MCP | Fixture | Production | Notes |
| --- | --- | --- | --- | --- |
| Account identity/health | `/v1/accounts/{accountId}/x/health` / `x_account_health` | Enabled | Disabled | Bound identity; terminal auth/access/rate signals |
| Profile lookup | `/x/profiles/{username}` / `x_profile_get` | Enabled | Disabled | Normalized public profile DTO |
| Post lookup | `/x/posts/{postId}` / `x_post_get` | Enabled | Disabled | Numeric native ID and X canonical URL required |
| Thread lookup | `/x/posts/{postId}/thread` / `x_thread_get` | Enabled | Disabled | One bounded page; opaque cursor |
| Home timeline | `/x/timelines/home` / `x_home_timeline_list` | Enabled | Disabled | One bounded page; no auto-pagination |
| User timeline | `/x/timelines/users/{username}` / `x_user_timeline_list` | Enabled | Disabled | One bounded page |
| Search | `/x/search` / `x_search` | Enabled | Disabled | One bounded post page |
| Notifications | `/x/notifications` / `x_notifications_list` | Enabled | Disabled | Normalized notification DTO |
| Conversations | `/x/conversations` / `x_conversations_list` | Enabled | Disabled | Summary metadata only, no message bodies beyond last-message fixture text |
| Bookmarks | `/x/bookmarks` / `x_bookmarks_list` | Enabled | Disabled | Account-scoped fixture contract |

All writes use `POST /v1/accounts/{accountId}/x/actions` or MCP `x_action_create`, require
`social:write` plus a caller-scoped idempotency key, and return a durable action record.

| Write operation | Action kind | Fixture | Production | Notes |
| --- | --- | --- | --- | --- |
| Create text post | `x_post_create` | Enabled | Disabled | Bounded text; normalized post ID/URL |
| Reply | `x_reply_create` | Enabled | Disabled | Numeric parent post ID and bounded text |
| Delete post | `x_post_delete` | Enabled | Disabled | Fixture proves caller-owned deletion only |
| Like state | `x_like_set` | Enabled | Disabled | Explicit boolean state; no toggle ambiguity |
| Repost state | `x_repost_set` | Enabled | Disabled | Explicit boolean state; no toggle ambiguity |
| Follow state | `x_follow_set` | Enabled | Disabled | Explicit boolean state for numeric user ID |
| Bookmark state | `x_bookmark_set` | Enabled | Disabled | Explicit boolean state; no toggle ambiguity |
| Media post | `x_media_post` | Enabled | Disabled | Uses Core-owned bounded media reference and phase ledger |
| Direct message | `x_direct_message` | Enabled | Disabled | Numeric recipient ID and bounded text |

The catalog is discoverable before connection at `GET /v1/platforms/x/capabilities` and through
`social_platform_capabilities`. Every entry carries `fixtureEnabled`, `productionEnabled`, `status`,
and `disabledReason`. Account-scoped discovery remains available after fixture connection.

## Safety and stability

- Core retains tenant authorization, account/session generation, connection custody, audit, and
  normalized public projection. The X package receives no raw cookie or session envelope.
- The package contains no HTTP/socket client, browser dependency, TLS impersonation, account pool,
  retry loop, challenge solver, password/MFA path, proxy rotation, or live endpoint/query map.
- Responses are bounded to 1 MiB, pages to 100 items, cursors to 512 characters, known DTO fields
  only, and `x.com`/`twitter.com` canonical hosts. Unknown keys or entity variants are drift.
- 401, 403, 429, zero remaining rate budget, partial/malformed payloads, repeated cursors, and
  changed operation wrappers stop the operation; they never become empty success.
- Successful DTOs expose normalized rate-limit observations without raw headers. The transport is
  responsible for one request only and may not sleep, retry, switch accounts, or paginate itself.
- Writes are serialized per account through Core, are content-bound to the caller's idempotency key,
  and verify the expected native identity before each execution. Submission ambiguity is durable
  `UNKNOWN`; reconciliation is read-only and never repeats a write.
- Media remains in Core custody and is bound to caller and account. Fixture media execution records
  reserve, lease, upload, submit, and process phases without returning binary content.

## Production admission gaps

Production reads remain disabled until a separately authorized task supplies: an immutable source
revision and transitive license/security review; compatibility without fingerprint/TLS
impersonation; an isolated direct-HTTP worker and egress policy; exact endpoint/query-map provenance;
authorized live identity and one-page proofs for each enabled operation; terminal challenge/rate and
drift proofs; write-specific ownership/idempotency/ambiguity proofs; and deployment evidence that no
browser or prohibited fallback can load. Fixture write contracts are not evidence of current live X
compatibility, and no production X read or write is enabled by this foundation.
