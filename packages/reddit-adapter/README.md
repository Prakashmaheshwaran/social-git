# Reddit adapter boundary

This package defines the Reddit adapter contract, deterministic fixture worker,
and the bounded protocol corpus approved by the library-admission gate. It has
no runtime dependency and performs no HTTP requests.

The fixture declares the Reddit MVP reads and writes, validates core-issued short-lived session payloads, enforces exact per-operation authorization and caller-scoped idempotency, and normalizes native identifiers, canonical URLs, rate limits, challenges, authentication failures, revocation, ownership failures, and protocol drift.

The worker runs in a separate child process with a minimal environment and bounded 64 KiB messages. Session material is sent only in a core-decrypted worker payload. The adapter and worker do not write it to disk, cache it, log it, or include it in results. The fixture worker has no database module or database environment.

## Admitted protocol corpus

The package adapts only endpoint mappings and required response normalizers
from `reddit-lyr` manifest version `0.1.1` at commit
`87ec32aff905923ecd156e7951c168adfdf6fac1`. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for exact source blobs,
digests, and the MIT notice.

`buildRedditProtocolRequest` produces immutable, transport-neutral request
descriptors. Write descriptors are marked `SINGLE_ATTEMPT` and never contain a
session or modhash. A future isolated worker must add worker-owned session
material only at dispatch time and must return `UNKNOWN` after any ambiguous
submission.

No upstream package, HTTP transport, retry loop, session store, browser-cookie
import, daemon, MCP/CLI layer, or transitive dependency is included.

## Capability status

The fixture simulates the complete requested contract, including the future
media shape. Every production capability is disabled until an independent
transport is admitted and live use is separately authorized. Text/link posts,
comments/replies, votes, save/unsave, and caller-owned deletion have admitted
route mappings but no enabled production transport. Media has no admitted
mapping and remains explicitly unsupported with
`disabledReason: "MEDIA_FLOW_NOT_ADMITTED"`.

Fixture media writes accept only a core-managed `mediaRef`; raw upload bytes do
not cross this contract. The package does not declare moderation, chat, awards,
flair management, collections, crossposts, account preferences, or any
operation outside the exported capability list.

If a write worker exits after it reports that submission started, the adapter returns `UNKNOWN` with `retryPermitted: false`. It caches that result by caller and idempotency key, so the write is not submitted again. `recoverUnknown` performs a separate read-only recovery check; it never repeats the write.

If a worker exits before submission, the fixture returns a retryable
`WORKER_UNAVAILABLE` failure and does not retry by itself. The caller may retry
with the same idempotency key. Challenge, checkpoint, and CAPTCHA stops have
distinct error codes and always require action. Caller-owned deletion is
rejected before submission unless the worker fixture has proved ownership.

Run the deterministic suite from this directory:

```sh
npm test
```
