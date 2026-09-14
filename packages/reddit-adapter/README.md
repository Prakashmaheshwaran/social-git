# Reddit adapter boundary

This package defines the library-independent Reddit adapter contract and a deterministic fixture worker. It intentionally has no Reddit protocol dependency. A library-backed worker can implement the same versioned IPC protocol only after the dependency-admission decision.

The fixture declares the Reddit MVP reads and writes, validates core-issued short-lived session payloads, enforces exact per-operation authorization and caller-scoped idempotency, and normalizes native identifiers, canonical URLs, rate limits, challenges, authentication failures, revocation, ownership failures, and protocol drift.

The worker runs in a separate child process with a minimal environment and bounded 64 KiB messages. Session material is sent only in a core-decrypted worker payload. The adapter and worker do not write it to disk, cache it, log it, or include it in results. The fixture worker has no database module or database environment.

Media writes accept only a core-managed `mediaRef`; raw upload bytes do not cross this contract. The MVP does not declare moderation, chat, awards, flair management, collections, crossposts, account preferences, or any operation outside the exported capability list.

If a write worker exits after it reports that submission started, the adapter returns `UNKNOWN` with `retryPermitted: false`. It caches that result by caller and idempotency key, so the write is not submitted again. `recoverUnknown` performs a separate read-only recovery check; it never repeats the write.

Run the deterministic suite from this directory:

```sh
npm test
```
