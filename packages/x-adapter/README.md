# X adapter foundation

This package is a fixture-only, fail-closed X read/write contract boundary. It has no HTTP client,
browser runtime, credential extractor, retry loop, account pool, TLS impersonation, challenge
solver, or production-enabled operation. `X_CAPABILITIES` is the authoritative admission matrix:
every operation is testable with synthetic fixtures and every production operation is disabled.

The normalized read contract covers identity/health, profiles, post/thread lookup, home/user timelines,
search, notifications, conversation summaries, and bookmarks. It returns one bounded page, an
opaque cursor, and rate-limit observations. Unknown fields, variants, repeated cursors, partial
errors, non-X canonical hosts, malformed identifiers, and oversized bodies fail with
`PROTOCOL_DRIFT`; authentication, access, and rate-limit responses are terminal.

The write contract covers text/media posts, replies, deletion of caller-owned fixture posts, like,
repost, follow and bookmark state, and direct-message send. Writes run only through Core's durable,
caller-scoped action ledger. Fixture outcomes return strict native evidence; ambiguous post-submit
outcomes remain `UNKNOWN` and are never automatically retried. Every write is production-disabled.

Production enablement requires a separately reviewed, pinned direct-HTTP transport and authorized
live proof under `docs/product-reset/x-transport-admission.md`. No operation in this package is
evidence of current X private-protocol compatibility.
