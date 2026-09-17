# X adapter foundation

This package contains fixture contracts plus a production-disabled direct-session candidate boundary.
It has no installed upstream client, browser runtime, credential extractor, retry loop, account pool,
TLS impersonation, challenge solver, or production-enabled operation. `X_CAPABILITIES` is the
authoritative admission matrix:
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

The candidate derives request structure from the pinned
`unclecode/twikit@6a73ab97f4de09f79139f6308c9fb80029a9f5f7` source corpus and refreshes
GraphQL identifiers from exact-hashed public X assets recorded in
`X_PUBLIC_PROTOCOL_EVIDENCE`. It injects only Core-custodied `auth_token`/`ct0`,
projects strict DTOs, and includes a bounded pure transaction-ID generator. HTML
and ondemand assets are inert text with fixed byte/regex/time bounds; no script
is evaluated. No upstream package or X asset is installed or executed.

Production enablement still requires complete endpoint/feature/response and
transaction compatibility plus separately authorized live identity/read/write
proof under `docs/product-reset/x-transport-admission.md`.
No operation in this package is evidence of current X private-protocol compatibility.
