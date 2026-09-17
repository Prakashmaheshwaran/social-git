# Reddit Phase-1 parity audit

Date: 2026-09-17 UTC. Task: [DYN-92](/DYN/issues/DYN-92). Baseline: [DYN-90](/DYN/issues/DYN-90). Main snapshot: `8f46756`.

## Decision

Keep the narrowly isolated Node HTTPS transport, attributed protocol corpus, encrypted session boundary, action ledger, and deterministic safety tests. Extend the public contract and normalizers rather than replacing the adapter wholesale. Do not install reddit-lyr or PRAW as runtime dependencies. Main implements the older bounded MVP, not full Phase-1 parity. No live Reddit requests or writes were performed in this audit; implemented means source plus deterministic evidence, not production acceptance.

## Verified gaps

- Public search and comments accept a cursor but discard it before provider dispatch (`src/reddit-adapter.ts:270`). An offline injected-provider assertion confirmed both omissions.
- Comment normalization keeps only top-level t1 children, discards nested replies and more placeholders, and cannot claim full trees (`packages/reddit-adapter/src/protocol-normalizers.mjs:122`).
- User lookup/content feeds, saved/upvoted reads, edit, subscribe, moderation, and messaging are absent from the main public contract (`src/contract.ts:212`).
- Public feed lacks sort/timeframe selection. Search is link-only and fixes relevance/all; its internal input rejects after (`packages/reddit-adapter/src/protocol-corpus.mjs:208`).

## Verification

- `npm run test:reddit-adapter`: 58 passed, 0 failed.
- `npm run typecheck`: exit 0, no diagnostics.
- `git diff --check`: exit 0.
- Offline search input probe with after: INVALID_REQUEST, unexpected field after. This confirms missing pagination, not a test-suite regression.

This audit is being completed with the endpoint matrix and branch/license evidence below.
