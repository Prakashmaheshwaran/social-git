# Product-reset capability matrix

Document version: 1.0.0
Generated: do not hand edit; run `npm run generate:product-docs`.

This matrix is generated from `src/contract.ts`, `packages/reddit-adapter/src/contract.mjs`,
`packages/x-adapter/src/contract.mjs`, `packages/x-adapter/src/admission.mjs`, and
`src/reddit-adapter.ts`. “Implemented” means the deterministic and runtime
boundary exists. It does not substitute for separately authorized live acceptance.

## Reddit

Reddit's listed protocol mappings are admitted for production direct-session
dispatch. They still stop on identity mismatch, challenge, checkpoint, CAPTCHA,
revocation, rate limit, or protocol drift.

| Adapter capability | Mode | Public OpenAPI operation | Fixture | Production | Disabled reason |
| --- | --- | --- | --- | --- | --- |
| `profile.get` | read | `reads.profile` | yes | enabled | — |
| `subreddit.get` | read | `reads.subreddit` | yes | enabled | — |
| `listing.list` | read | `reads.feed` | yes | enabled | — |
| `post.get` | read | `reads.post` | yes | enabled | — |
| `comments.list` | read | `reads.comments` | yes | enabled | — |
| `search.query` | read | `reads.search` | yes | enabled | — |
| `user.get` | read | `reads.userProfile` | yes | enabled | — |
| `user.content` | read | `reads.userContent` | yes | enabled | — |
| `account.saved` | read | `reads.saved` | yes | enabled | — |
| `account.upvoted` | read | `reads.upvoted` | yes | enabled | — |
| `post.createText` | write | `actions.create` | yes | enabled | — |
| `post.createLink` | write | `actions.create` | yes | enabled | — |
| `post.createMedia` | write | `actions.create` | yes | enabled | — |
| `comment.create` | write | `actions.create` | yes | enabled | — |
| `reply.create` | write | `actions.create` | yes | enabled | — |
| `item.editOwn` | write | `actions.create` | yes | enabled | — |
| `vote.set` | write | `actions.create` | yes | enabled | — |
| `save.set` | write | `actions.create` | yes | enabled | — |
| `save.unset` | write | `actions.create` | yes | enabled | — |
| `subreddit.subscribe` | write | `actions.create` | yes | enabled | — |
| `subreddit.unsubscribe` | write | `actions.create` | yes | enabled | — |
| `item.deleteOwn` | write | `actions.create` | yes | enabled | — |

## X

All X contracts are fixture-only. Production dispatch is fail-closed until the
machine-readable admission gates below pass:

- `ENDPOINT_CURRENTNESS_UNPROVEN`
- `CLIENT_TRANSACTION_HEADER_UNPROVEN`
- `AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING`
- `AUTHORIZED_LIVE_READ_PROOF_MISSING`
- `AUTHORIZED_LIVE_WRITE_PROOF_MISSING`

| Adapter capability | Mode | Public OpenAPI operation | Fixture | Production | Live gate status |
| --- | --- | --- | --- | --- | --- |
| `account.identity` | read | `x.account.health` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `profile.get` | read | `x.profiles.get` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `post.get` | read | `x.posts.get` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `thread.get` | read | `x.threads.get` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `timeline.home` | read | `x.timelines.home` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `timeline.user` | read | `x.timelines.user` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `search.query` | read | `x.search` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `notifications.list` | read | `x.notifications.list` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `conversations.list` | read | `x.conversations.list` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `bookmarks.list` | read | `x.bookmarks.list` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `followers.list` | read | `x.followers.list` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `following.list` | read | `x.following.list` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `lists.lookup` | read | `x.lists.lookup` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `lists.memberships` | read | `x.lists.memberships` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `lists.members` | read | `x.lists.members` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `lists.timeline` | read | `x.lists.timeline` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `post.create` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `post.reply` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `post.delete` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `post.like.set` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `post.repost.set` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `profile.follow.set` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `bookmark.set` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `post.media.create` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |
| `message.send` | write | `x.actions.create` | yes | disabled | ENDPOINT_CURRENTNESS_UNPROVEN, CLIENT_TRANSACTION_HEADER_UNPROVEN, AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING, AUTHORIZED_LIVE_READ_PROOF_MISSING, AUTHORIZED_LIVE_WRITE_PROOF_MISSING |

## Explicitly unsupported

Unsupported capabilities have no write/read endpoint and must never be emulated.

| Platform | Capability | Status | Reason |
| --- | --- | --- | --- |
| Reddit | `comment_more_expand` | unsupported | `COMMENT_MORE_EXPANSION_UNSUPPORTED` |
| Reddit | `moderation` | unsupported | `PHASE_1_NOT_ADMITTED` |
| Reddit | `messaging` | unsupported | `NO_VERIFIABLE_NATIVE_RESULT` |
| X | production transport | fixture-only | `ENDPOINT_CURRENTNESS_UNPROVEN`; `CLIENT_TRANSACTION_HEADER_UNPROVEN`; `AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING`; `AUTHORIZED_LIVE_READ_PROOF_MISSING`; `AUTHORIZED_LIVE_WRITE_PROOF_MISSING` |
