# Reddit MVP independent QA and acceptance plan

## Decision state

The harness now ships a complete service driver, and
`qa/acceptance/tests/service-driver.test.mjs` runs the full public-boundary suite
against a real fixture-mode runtime to a `GO` verdict. That is **harness
evidence, not a product decision**: the fixture driver is not an immutable
release candidate, and the plan below still requires one immutable git commit
and one immutable production image digest.

The first product decision must name one immutable git commit and one immutable
production image digest. A result for a branch name, tag, mutable image tag, or
fixture driver is invalid.

## Scope and independence

The deterministic gate evaluates the Reddit MVP through the stable API surface.
The candidate runs with a synthetic, owner-authorized session fixture and an
independent protocol fixture. QA controls platform responses, process crashes,
and image inspection outside the candidate. The candidate cannot declare its
own platform trace or packaging result.

The gate does not use live Reddit credentials, official Reddit APIs, browser
automation, or live social mutations. It separates three evidence classes:

1. Harness evidence: the reference fixture and deliberate faulty mutations show
   that passing and failing conditions are detected. Verdict: `NOT_EVALUATED`.
2. Candidate evidence: the immutable integration build runs against deterministic
   fixtures. Verdict: `GO` or `NO-GO`.
3. Live-platform evidence: an independent, separately authorized future task
   uses dedicated accounts. It never changes a deterministic verdict and cannot
   repair a deterministic failure.

## Required deterministic environment

- Exact candidate commit and production OCI digest.
- Disposable database and encrypted storage rooted in a run-specific directory.
- Two synthetic accounts, two expected native identities, two route references,
  and two fixture sessions. Fixture identifiers are not credentials.
- A protocol fixture that records calls and can return success, revocation, rate
  limit, challenge, checkpoint, CAPTCHA, and schema-drift responses.
- A restart controller and a crash point immediately after a write may have been
  dispatched but before confirmation is durable.
- External capture of API responses, audit events, logs, ledger observations,
  platform calls, and an inventory of the exact production image.
- No network route to Reddit or any other social platform.

All artifacts must omit raw session envelopes, cookies, tokens, CSRF values, MFA
values, credentials, and network-route material. Synthetic redaction sentinels
may be used because they have no authentication value.

## Deterministic acceptance matrix

| Scenario | Required proof | Failure result |
| --- | --- | --- |
| Accounts, sessions, routes | Import and validate two accounts; bind each to its expected identity and route; reject a missing route and wrong identity; revoke one without affecting the other; block reads after revocation without a platform call. | `NO-GO` |
| Read contracts | Profile, subreddit metadata, feed, post, comments, and search succeed through the API and return native IDs and canonical Reddit URLs when supplied by the fixture. | `NO-GO` |
| Write contracts and deletion | Text, link, and media posts; comment; reply; vote; save; unsave; and caller-owned delete require exact scopes and idempotency keys. A foreign delete is denied before platform dispatch. Confirmed results include action and native references. | `NO-GO` |
| Idempotency, restart, concurrency | Same caller, operation, account, key, and payload dispatch once and replay one result; changed payload conflicts; another caller has an independent key space; eight concurrent duplicates dispatch once; restart preserves the ledger. | `NO-GO` |
| Fail-closed platform errors | Rate limit, challenge, checkpoint, CAPTCHA, revocation, and protocol drift return normalized read and write errors and cause no automatic retry. | `NO-GO` |
| Crash after submit and `UNKNOWN` | A crash after possible dispatch records durable `UNKNOWN`; the same request after restart returns that action without resubmission; explicit reconciliation may keep `UNKNOWN` or confirm it. | `NO-GO` |
| Secret storage and redaction | Session and route material is encrypted at rest with distinct nonces and purpose, account, and generation binding. API output, application logs, audit events, and sanitized storage inspection contain none of the synthetic session, CSRF, MFA, or route sentinels. | `NO-GO` |
| Production image | External inspection of the exact image digest finds no Playwright, Selenium, Chromium, Chrome, Puppeteer, chromedriver, CDP, browser executable, or browser launch command. | `NO-GO` |

The machine-readable mapping is
`qa/acceptance/coverage-manifest.json`. All listed controls are required and none
can be skipped.

## Execution and decision procedure

1. Build the integration candidate and production image from a clean checkout.
2. Record the full git commit and OCI digest. Do not accept mutable references.
3. Install the candidate driver described in `qa/acceptance/README.md`. The
   driver maps public API operations to the build and control operations to the
   external fixture environment.
4. Isolate outbound networking. Permit only the fixture services required by
   the run.
5. Run `npm run qa:acceptance:fixtures`. Stop if the harness self-test fails.
6. Run `npm run qa:acceptance -- --driver <driver> --candidate-ref <commit>
   --image-digest <digest> --output <new-result-path>`.
7. Preserve the result JSON, fixture call trace, sanitized logs and audits,
   restart/crash trace, and image inventory under one run identifier.
8. Report `GO` only when every required scenario passes. Report `NO-GO` for any
   failed scenario, missing evidence, mutable reference, driver/provenance
   mismatch, or skipped control. With no integration candidate, report no
   decision (`NOT_EVALUATED`).

A rerun is a new evidence set. Never overwrite an earlier result. A fix requires
a new immutable candidate reference and a complete deterministic rerun.

## Minimal future live gate

This gate is intentionally deferred. It requires a separate Paperclip task,
independent QA ownership, explicit approval for every write scope, dedicated test
accounts, and a platform-approved test location. Session bootstrap happens in an
external human-controlled surface. Credentials and session material are never
given to development or recorded in work products.

The live gate uses the same candidate commit and image digest that received
deterministic `GO`:

1. Validate each dedicated account against its expected native identity and
   assigned route.
2. Perform one bounded profile read and one bounded listing read. Confirm native
   IDs, canonical URLs, and normalized stop behavior. Stop immediately on rate,
   challenge, checkpoint, CAPTCHA, identity mismatch, revocation, or drift.
3. In a separately approved write window, use unique idempotency keys and the
   smallest complete mutation chain: one text post, one link post, one media
   post, one comment, one reply, one vote, save then unsave one item, reject one
   cross-account delete before dispatch, and delete only items created by the
   calling test account. Do not retry an unverified submission.
4. Revoke the imported sessions, verify post-revocation denial, and retain only
   sanitized IDs, URLs, action states, and timestamps as evidence.

No part of this future gate is authorized or executed by this plan. A live
failure blocks platform admission even when deterministic tests pass. Live proof
never authorizes broader, recurring, or production social activity.

## Current fixture evidence

Command:

```sh
npm run qa:acceptance:fixtures
```

Expected harness evidence is eight passing tests: one manifest check, one full
reference-fixture run, four deliberate failure mutations, one verdict-gate
check, and one runner refusal check. This evidence must be refreshed after any
harness change. It proves the suite can detect wrong routing, automatic retry
after `UNKNOWN`, secret leakage, and a browser dependency, and that the fixture
driver cannot issue a product verdict. It does not evaluate an integration
candidate.
