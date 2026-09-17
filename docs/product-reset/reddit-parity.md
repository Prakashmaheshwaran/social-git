# Reddit Phase-1 parity audit

Date: 2026-09-17 UTC. Task: [DYN-92](/DYN/issues/DYN-92). Baseline: [DYN-90](/DYN/issues/DYN-90). Main snapshot: `8f46756`.

## Decision

Keep the narrowly isolated Node HTTPS transport, attributed protocol corpus, encrypted session boundary, action ledger, and deterministic safety tests. Extend the public contract and normalizers rather than replacing the adapter wholesale. Do not install reddit-lyr or PRAW as runtime dependencies. Main implements the older bounded MVP, not full Phase-1 parity. No live Reddit requests or writes were performed in this audit; implemented means source plus deterministic evidence, not production acceptance.

## DYN-108 implementation update

The Phase-1 read/discovery gaps identified below are now implemented on the DYN-108 branch: cursor propagation for feeds, comments, search, user content, saved, and upvoted listings; sort/timeframe controls; bounded nested comment trees; safe `more` placeholders; user profile/content; authenticated saved/upvoted feeds; public rate-limit metadata; capability discovery; and matching REST, OpenAPI, and MCP contracts. Target and author checks fail closed on cross-scope native responses.

See [`../reddit-read-discovery.md`](../reddit-read-discovery.md) for the endpoint matrix and deliberate exclusions. Live acceptance remains pending; these claims are source plus deterministic fixture evidence only.

## Baseline gaps addressed by DYN-108

- Public search and comments previously accepted a cursor but discarded it before provider dispatch.
- Comment normalization previously kept only top-level t1 children and discarded nested replies and `more` placeholders.
- User lookup/content feeds and saved/upvoted reads were absent. Edit, subscribe, moderation, and messaging remain explicitly unsupported for Phase 1.
- Public feeds previously lacked sort/timeframe selection, and search fixed relevance/all while rejecting `after`.

## Verification

- `npm run test:reddit-adapter`: 58 passed, 0 failed.
- `npm run typecheck`: exit 0, no diagnostics.
- `git diff --check`: exit 0.
- Offline search input probe with after: INVALID_REQUEST, unexpected field after. This confirms missing pagination, not a test-suite regression.

This audit is being completed with the endpoint matrix and branch/license evidence below.
