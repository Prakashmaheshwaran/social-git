# Reddit adapter boundary

This package defines the Reddit adapter contract, deterministic fixture worker,
the bounded protocol corpus approved by the library-admission gate, and the
Core-side production session transport. Tests perform no Reddit requests.

The fixture declares the Reddit MVP reads and writes, validates core-issued short-lived session payloads, enforces exact per-operation authorization and caller-scoped idempotency, and normalizes native identifiers, canonical URLs, rate limits, challenges, authentication failures, revocation, ownership failures, and protocol drift.

The worker runs through `@social-git/worker-security` with the Node permission
model, a positive environment allowlist, live permission attestation, and a
kernel sandbox on Darwin. It has no network, filesystem-write, child-process,
worker-thread, or native-addon permission. Core and worker use pre-allocation
length-prefixed byte IPC rather than Node object IPC. Every message is bounded
to 64 KiB and bound to the launched child, request, action, account, server
route, generation, capability, deadline, and sequence. Before storage or return,
each result and submission event must match its operation-specific types,
enums, nullability, semantic bounds, request target, Reddit fullname kind, and
canonical URL. Session material is sent only in a core-decrypted worker
payload. The adapter and worker do not write it to disk, cache it, log it, or
include it in results.

The route identifier is adapter-owned and is never accepted from operation
input, session context, or worker output. The platform-wide stop circuit is in
the dispatch path. Challenge, checkpoint, CAPTCHA, rate limit, wrong identity,
revocation, and protocol drift stop later work even if a caller changes the
account. Worker outcomes use exact per-operation schemas; unknown fields stop
the circuit as protocol drift.

## Admitted protocol corpus

The package adapts only endpoint mappings and required response normalizers
from `reddit-lyr` manifest version `0.1.1` at commit
`87ec32aff905923ecd156e7951c168adfdf6fac1`. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for exact source blobs,
digests, and the MIT notice.

The exact-item ownership lookup and media phase shapes are supported by a
separate source review of PRAW `8.0.3` at commit
`fdc29bb103ad652eea6740c77c2be099d1c1357e`. The notice and protocol corpus pin
all four reviewed Git blobs and SHA-256 digests. PRAW remains protocol evidence
only: it is not a runtime dependency, its OAuth transport is not used, and it
does not replace the primary `reddit-lyr` session-protocol corpus.

`buildRedditProtocolRequest` produces immutable, transport-neutral request
descriptors. Write descriptors are marked `SINGLE_ATTEMPT` and never contain a
session or modhash. The isolated worker adds session material only at dispatch
time. It emits a bound submission event before a write can become ambiguous; a
later worker exit therefore returns `UNKNOWN` and is never retried
automatically.

No upstream package, retry loop, session store, browser-cookie import, daemon,
MCP/CLI layer, or application-level transitive dependency is included. The
production connector uses only the built-in HTTPS client from the exact Node.js
runtime pinned by the repository.

## Capability status

The fixture simulates the complete requested contract. The production path
enables every mapped read and write after the Core session connector and fixed
route authority are configured. Media is enabled only through the Core phased
worker provider. A bind-only session provider keeps it disabled with
`CORE_MEDIA_PHASE_TRANSPORT_REQUIRED`.

Phase-1 reads include current and named-user profiles, subreddit metadata,
home/subreddit listings, posts, bounded nested comments, search, named-user
submitted/comment listings, and the validated identity's saved/upvoted mixed
item listings. Listing cursors are passed through unchanged as opaque native
values. Sort/timeframe controls are allowlisted. Nested comment `more`
placeholders are returned as non-expandable metadata; the unreviewed expansion
route is explicitly unsupported. See `../../docs/reddit-read-discovery.md`.

Admitted writes include text, link, and Core-phased image posts; comments and
replies; caller-owned edits; vote, unvote, save, and unsave; subreddit
subscribe and unsubscribe; and caller-owned deletion. Each ordinary mutation
is single-attempt. Private messages remain unsupported because the reviewed
compose route provides no verifiable native result. See
`../../docs/reddit-write-surface.md`.

`RedditSessionTransport` is permanently bound to one tenant, account, route,
and generation. `createRedditSessionConnector` is a Core-only factory: cookies
and the CSRF/modhash remain in its closure and never enter route descriptors or
normalized results. Caller-owned post and comment editing and deletion each
perform an exact admitted author lookup before submission and compare the
result with the validated expected identity. Foreign, missing, and malformed
authors fail closed before `/api/editusertext` or `/api/del`.

The supply-chain decision, exact Node.js revision, source checksum, runtime
component inventory, and final-image condition are in
`../../docs/reddit-session-transport-admission.md` and
`../../security/reddit-session-transport-review.json`.

Media writes accept only a caller- and account-bound Core `mediaRef`. Core owns
the durable `reserved` -> `leased` -> `uploaded` -> `submitting` -> `submitted`
-> `processed` state machine. The isolated worker keeps server-issued upload
fields private, uses an exact-host S3 connector with no Reddit cookies, and
waits for bounded evidence only from `wss.redditmedia.com`. Core records the
submit boundary before the single submit call. Every failure at or after that
boundary is `UNKNOWN` and is never retried automatically. The package does not
declare moderation, chat, awards, flair management, collections, crossposts,
account preferences, or any operation outside the exported capability list.

If a write worker exits after it reports that submission started, the adapter returns `UNKNOWN` with `retryPermitted: false`. It caches that result by caller and idempotency key, so the write is not submitted again. `recoverUnknown` performs a separate read-only recovery check; it never repeats the write.

If a worker exits before submission, the fixture returns a retryable
`WORKER_UNAVAILABLE` failure and does not retry by itself. The caller may retry
with the same idempotency key. Challenge, checkpoint, and CAPTCHA stops have
distinct error codes and always require action. Caller-owned editing and
deletion are rejected before submission unless the worker fixture has proved
ownership.

Run the deterministic suite from this directory:

```sh
npm test
```
