# Social Git working contract

## Product direction

Social Git is a library-backed, session-authenticated, multi-account social interaction gateway.

- Start with a Reddit MVP, then add LinkedIn, Instagram, YouTube, and other platforms through the same adapter contract.
- Expose every supported read and write as a stable, documented API operation.
- Production runtime must not depend on Playwright, Selenium, Chromium, CDP, or visible/headless browser automation.
- Do not use official social-network APIs as the primary platform integration.
- Prefer maintained, source-reviewed libraries that reproduce the platform web/mobile protocol using an owner-authorized session.
- A browser may be used only as an external onboarding/bootstrap surface when a human must obtain or refresh a session; it is not part of the service runtime.

## Safety and session handling

- Never log, commit, attach, or return cookies, credentials, access tokens, CSRF values, MFA codes, or raw session envelopes.
- Encrypt session and network-route material at rest with purpose/account/generation binding and fresh nonces.
- Bind every account to an expected native identity and verify it before reads or writes.
- Stop on challenge, checkpoint, CAPTCHA, rate limit, wrong account, revoked session, or protocol drift.
- Writes require explicit scoped authorization, caller-scoped idempotency, and a durable action ledger.
- Once submission might have started, an unverified result is `UNKNOWN`; never retry automatically.
- Researchers and developers must not receive live social credentials. Live acceptance belongs to an independent QA role and requires a separately authorized task.

## Architecture boundaries

- Core owns accounts, encrypted sessions, network routes, policy, action lifecycle, idempotency, audit events, and normalized errors/results.
- Each platform adapter declares capabilities and implements bounded protocol operations behind the same interface.
- Platform workers run isolated from the database and exchange versioned, size-bounded messages.
- The API layer must not expose library-specific objects or secret material.
- Add a platform only after source/license review, exact version pinning, contract tests, protocol-drift tests, and an authorized live proof.

## Reddit MVP

- Multi-account connect/import, identity validation, refresh/revocation, health.
- Read: account profile, subreddit metadata, feed/listing, post, comments, search.
- Write: text/link/media post, comment/reply, vote, save/unsave, delete the caller-owned item.
- Required output: native identifiers and canonical URLs where the platform supplies them.
- Explicitly document unsupported features; never fabricate parity.

## Engineering defaults

- Inspect before editing; use `rg` for search and `apply_patch` for targeted changes.
- Preserve unrelated and untracked user files.
- Keep commits small and meaningful.
- Add deterministic tests for success, auth failure, wrong identity, challenge, rate limit, revocation, idempotency, crash-after-submit, and `UNKNOWN` recovery.
- No live social mutation from ordinary unit/integration tests.
- Every task must report exact commands and observed results before it is marked done.

