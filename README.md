# Social Git

Social Git is a self-hosted, library-backed gateway for managing multiple social accounts through owner-authorized web sessions.

The Reddit-first MVP will expose a stable REST API for account/session management, reads, and explicitly authorized interactions. Platform adapters use pinned protocol libraries; the production runtime does not use browser automation or official social-network APIs.

Status: project bootstrap and dependency admission research.

## Security policy package

`packages/security` implements the default-deny service roles and bounded live-test grants. Its SQLite ledger binds each approved grant and records every action before just-in-time secret lease issuance.

Run its deterministic tests with:

```bash
node --test --test-reporter=spec packages/security/test/*.test.js
```
