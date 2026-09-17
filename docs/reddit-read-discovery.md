# Reddit Phase-1 read and discovery surface

Status: implemented with deterministic fixtures; live Reddit acceptance is still a separately authorized release gate.

All operations use the admitted owner-session `node:https` transport. They do not use Reddit's official API, OAuth clients, browsers, CAPTCHA solving, retry camouflage, or live credentials in tests. Every request remains bound to the tenant, account, route lease, session generation, and identity validated by `profile.get`.

## Supported operations

| Public operation | Adapter operation | Native route | Pagination and controls |
| --- | --- | --- | --- |
| Connected profile | `profile.get` | `/api/me.json` | Identity validation and rate metadata |
| Subreddit metadata | `subreddit.get` | `/r/{name}/about.json` | Target-bound |
| Home or subreddit feed | `listing.list` | `/{sort}.json`, `/r/{name}/{sort}.json` | `after`, limit, sort; timeframe for top/controversial |
| Post | `post.get` | `/comments/{id}.json` | Exact post target check |
| Comment tree | `comments.list` | `/comments/{id}.json` | `after`, limit, sort; bounded nested replies |
| Search | `search.query` | `/search.json`, `/r/{name}/search.json` | `after`, limit, subreddit, sort, timeframe |
| User profile | `user.get` | `/user/{name}/about.json` | Exact username check |
| User posts/comments | `user.content` | `/user/{name}/{submitted|comments}.json` | `after`, limit, sort, timeframe, author check |
| Saved items | `account.saved` | `/user/{validated identity}/saved.json` | `after`, limit; mixed post/comment DTOs |
| Upvoted items | `account.upvoted` | `/user/{validated identity}/upvoted.json` | `after`, limit; mixed post/comment DTOs |

The public REST and MCP contracts expose the same operations. Native `after` values are passed through unchanged and must be treated by callers as opaque cursors. A response includes the next cursor only when Reddit supplied one. No cursor is synthesized.

## Comment trees and `more`

Comment replies are normalized recursively with a maximum depth of 10 and a total budget of 500 tree nodes. Unknown child kinds, malformed native IDs, cross-post thread responses, invalid URLs, excessive depth, and excessive node counts are protocol drift and stop the session circuit.

Reddit `more` placeholders are retained as bounded metadata (`parentNativeId`, count, and child native IDs). They are deliberately marked `expandable: false` with `COMMENT_MORE_EXPANSION_UNSUPPORTED`. Phase 1 does not call an unreviewed expansion route and never fabricates missing comments.

## Capability and health discovery

`GET /v1/accounts/{accountId}/capabilities` and `social_capabilities_list` return supported capability names plus an `unsupportedCapabilities` reason map. `identity_health:read` is the combined, existing `connections.get` health record and identity-validated `reads.profile` probe; it is not a background social request.

Explicit Phase-1 read exclusions are comment-placeholder expansion, moderation, and messaging. Caller-owned edit plus subreddit subscribe/unsubscribe are admitted writes; see [`reddit-write-surface.md`](reddit-write-surface.md). Media remains disabled when the Core phased media transport is absent. Unsupported features are reported, not emulated.

## Failure behavior

- 401/revocation, wrong identity, checkpoint, challenge, CAPTCHA, rate limit, destination-policy failure, and response drift fail closed through the existing shared stop circuit.
- Rate-limit headers are normalized into `limit`, `remaining`, and `resetAt` and carried in public read results when Reddit supplies them.
- Read transport failures are never converted to empty success.
- Tests use fixed fixtures only and make no live social requests.
