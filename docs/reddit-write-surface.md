# Reddit admitted write surface

Status: implemented with deterministic fixtures; live Reddit acceptance remains a separately authorized release gate.

Every operation uses the admitted owner-session direct-HTTPS boundary. It does not use Reddit's official API or OAuth, a browser, CAPTCHA or MFA automation, TLS impersonation, account pools, or automatic mutation retries. Core continues to own tenant and account selection, encrypted session custody, identity validation, route leases, exact live authorization, durable action and idempotency state, and the shared account stop circuit.

## Capability matrix

| Public action kind | Adapter operation | Native route or phase | Admission and result rule |
| --- | --- | --- | --- |
| `text_post` | `post.createText` | `POST /api/submit` | Confirmed only with native `t3_` ID and canonical URL |
| `link_post` | `post.createLink` | `POST /api/submit` | Confirmed only with native `t3_` ID and canonical URL |
| `media_post` | `post.createMedia` | lease, exact-host image upload, `POST /api/submit`, bounded WSS evidence | Available only through the Core phased media provider; confirmed only with native `t3_` ID and canonical URL |
| `comment` | `comment.create` | `POST /api/comment` | Exact `t3_` parent; confirmed only with native `t1_` ID and canonical URL |
| `reply` | `reply.create` | `POST /api/comment` | Exact `t1_` parent; confirmed only with native `t1_` ID and canonical URL |
| `edit` | `item.editOwn` | ownership read, then `POST /api/editusertext` | `t1_` or `t3_`; denied before submission unless author matches the validated identity |
| `vote` | `vote.set` | `POST /api/vote` | Direction is exactly `-1`, `0`, or `1`; `0` is unvote |
| `save` | `save.set` | `POST /api/save` | Exact `t1_` or `t3_` target |
| `unsave` | `save.unset` | `POST /api/unsave` | Exact `t1_` or `t3_` target |
| `subscribe` | `subreddit.subscribe` | subreddit metadata read, then `POST /api/subscribe` with `action=sub` | Result is bound to the verified `t5_` subreddit and canonical URL |
| `unsubscribe` | `subreddit.unsubscribe` | subreddit metadata read, then `POST /api/subscribe` with `action=unsub` | Result is bound to the verified `t5_` subreddit and canonical URL |
| `delete` | `item.deleteOwn` | ownership read, then `POST /api/del` | `t1_` or `t3_`; denied before submission unless author matches the validated identity |

The REST surface is `POST /v1/accounts/{accountId}/actions` with a caller-scoped `Idempotency-Key`. MCP exposes the same schema and dispatcher as `reddit_action_create`. OpenAPI is generated from that shared contract, so REST and MCP accept the same action variants and return the same durable action states and normalized errors.

## DYN-117 production execution admission

The default production stack starts the sequential Core action worker and admits the matrix above for an authenticated owner or API key with `social:write`; it does not require a QA live-test grant. The worker receives only Core-issued commands bound to tenant, account, expected identity, session generation, network route, lease, and fence. `test/runtime-e2e.test.ts` proves the normal production path with a one-time encrypted session import, synthetic private worker HTTP boundary, owner and scoped API-key calls, one native command for an idempotent action, durable `UNKNOWN` after a dropped post-submit response, no automatic resubmission, and fixture-only X remaining disabled.

An optional bounded grant is retained solely for certification. Its exact canary lane uses the independent authorization ledger. Other accounts and operations continue through the product adapter; canary actions that violate grant operation, identity, generation, route, or resource bindings fail closed rather than bypass the grant. `test/live-execution.test.ts` covers this mixed mode deterministically.

## Safety and failure behavior

- Each ordinary mutation makes one native POST attempt. The phased media state machine also makes each phase once and records the submit boundary before the native submit.
- A transport loss, timeout, 5xx, malformed response, or worker exit after submission may have started becomes durable `UNKNOWN` with `retryPermitted: false`. Core never automatically resubmits it.
- Exact durable claim fencing prevents a stale worker claim from committing state. Caller/account/input idempotency conflicts fail closed.
- Edit and delete perform a bounded ownership read first. Foreign, missing, malformed, or unverifiable authors return `NOT_CALLER_OWNED` without a mutation request.
- Subscribe and unsubscribe bind the requested name to verified subreddit metadata before the mutation, preventing a response from claiming a different target.
- Challenge, checkpoint, CAPTCHA, MFA, wrong identity, revocation, rate limiting, and protocol drift open the account stop circuit. None is bypassed or solved.
- Action fields are allowlisted and bounded. Edit text is limited to 40,000 UTF-8 bytes at the adapter boundary and the Core API imposes its public schema limits before dispatch.
- Normalized successes contain only operation-specific native IDs, canonical URLs, exact result data, and rate-limit metadata. Cookies, CSRF values, upload fields, and other session material cannot appear in results.

## Explicitly unsupported

| Feature | Reason |
| --- | --- |
| Private messages / compose | The reviewed session corpus shows `/api/compose`, but does not provide a verifiable native message ID or canonical result. Returning success would fabricate confirmation, so capability discovery reports `NO_VERIFIABLE_NATIVE_RESULT`. |
| Inbox mutations, chat, moderation, flair, awards, collections, crossposts, and account preferences | No bounded operation and strict result contract has been admitted. Capability discovery reports unsupported rather than emulating them. |
| Automatic ownership inference | Only exact admitted author reads are accepted; ambiguous ownership is denied. |

## Evidence boundary

The edit and subscription forms are bounded extractions from the pinned `reddit-lyr` source recorded in `packages/reddit-adapter/THIRD_PARTY_NOTICES.md` and `src/protocol-corpus.mjs`. Ownership lookup and media phases use the separately pinned PRAW protocol evidence documented there. These sources are evidence only: neither project is installed as a runtime dependency, and no live Reddit calls, sessions, credentials, or mutations are used by the test suite.
