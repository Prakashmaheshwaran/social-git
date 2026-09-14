# Reddit MVP deterministic acceptance harness

This directory is an independent, black-box acceptance boundary. It does not
contain a Reddit client and it does not make live Reddit requests.

## Evidence classes

- `fixture_self_test` proves that the suite, fixtures, and failure mutations are
  wired correctly. It always reports `NOT_EVALUATED`.
- `deterministic_candidate` exercises an immutable integration candidate against
  an independently controlled platform fixture. It is the only evidence class
  that can report deterministic `GO` or `NO-GO`.
- Live-platform evidence is intentionally outside this harness and outside
  ordinary CI. The future gate is in
  `docs/qa/reddit-mvp-acceptance-plan.md`.

Run the fixture self-test:

```sh
npm run qa:acceptance:fixtures
```

Run an integration candidate after it exists:

```sh
npm run qa:acceptance -- \
  --driver ./path/to/candidate-driver.mjs \
  --candidate-ref git:0123456789abcdef0123456789abcdef01234567 \
  --image-digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --output ./acceptance-result.json
```

The output file is created with exclusive-create semantics. An existing report
is never overwritten. Exit status is `0` for `GO`, `1` for `NO-GO`, and `2` for
configuration errors or a missing candidate.

## Candidate driver contract

The driver module exports `createDriver({ candidateRef, imageDigest })`. It must
return this interface:

```js
{
  metadata: {
    kind: "integration_candidate",
    candidateRef: "git:<40 lowercase hex>",
    imageDigest: "sha256:<64 lowercase hex>"
  },
  reset: async () => {},
  call: async (operation, input, callerContext) => ({ status, body }),
  control: async (command, payload) => {},
  inspect: async (target) => value,
  close: async () => {}
}
```

`call` maps the suite's normalized operations to the candidate's public API.
It must not call core internals or mutate storage directly. `control` drives
only the independent fixture platform, candidate process lifecycle, and
fault-injection boundaries. `inspect` reads evidence from external collectors.

Supported control commands:

- `platform-session`: register a synthetic fixture session and native identity.
- `seed-owned`: seed fixture ownership used to prove deletion boundaries.
- `next-platform-outcome`: set one rate, challenge, checkpoint, CAPTCHA, or
  protocol-drift response.
- `crash-after-submit`: terminate the candidate after dispatch may have started
  and before confirmation is durable.
- `restart`: restart the candidate while preserving its durable state.
- `reconciliation-outcome`: set the independent lookup result for an `UNKNOWN`
  action.

Supported inspection targets:

- `platform-calls`: immutable fixture-server trace with operation, account, and
  route identifiers, but no session or route material.
- `logs` and `audit-events`: captured candidate output used for redaction checks.
- `storage-records`: sanitized storage inspection proving distinct encrypted
  session and route records with purpose, account, generation, and nonce binding.
- `production-image`: inventory made from the exact OCI digest or image tar, not
  from the candidate's self-report. It includes source digest, dependencies,
  files, commands, processes, and browser executable findings.

Normalized operations are declared in `contract.mjs`. Responses use one of:

```js
{ status: 200, body: { data: { /* read or account result */ } } }
{ status: 200, body: { result: { actionId, state, nativeId, canonicalUrl } } }
{ status: 400, body: { error: { code, message } } }
```

The driver may translate the candidate's route names and HTTP status codes, but
it must preserve the candidate response body and observed behavior. A driver
must never fabricate native IDs, canonical URLs, action states, calls, logs, or
image inventory.

`service-driver.mjs` is the black-box driver for the executable gateway. It uses
only authenticated HTTP routes on the running candidate and its explicit
fixture-only control boundary. It never imports service modules or calls Core,
ledger, adapter, or worker methods. Configure it with:

- `SOCIAL_GIT_CANDIDATE_URL`: running fixture-mode gateway URL.
- `SOCIAL_GIT_QA_TOKEN`: token whose configured principal has
  `fixture:control`.
- `SOCIAL_GIT_QA_IMAGE_INVENTORY`: independently produced inventory JSON whose
  source digest matches `--image-digest`.
- `SOCIAL_GIT_QA_RESTART_URL`: external candidate supervisor endpoint used for
  real restart scenarios.

The driver refuses to invent image inventory or simulate a process restart.
Those dependencies must be supplied by the release environment.

`restart-supervisor.mjs` supplies the required loopback-only restart endpoint for a named candidate container. Set `SOCIAL_GIT_QA_CONTAINER` to the validated container name and `SOCIAL_GIT_QA_TOKEN_SHA256` to the lowercase SHA-256 of `SOCIAL_GIT_QA_TOKEN`, then start it as a separate QA process. Use `http://127.0.0.1:8090/restart` as `SOCIAL_GIT_QA_RESTART_URL`. The supervisor passes a fixed argument vector to `docker restart`; it does not use a shell or retain the bearer token.

For a final-image gate, run all eight scenarios with the image runner. Run each
architecture on a Docker daemon of the same native architecture; the runner
rejects emulation. It requires an independently generated, digest-bound
inventory and uses only synthetic fixture sessions.

```sh
npm run qa:acceptance:image -- \
  --image social-git-runtime:release-arm64 \
  --platform linux/arm64 \
  --candidate-ref git:0123456789abcdef0123456789abcdef01234567 \
  --image-digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --inventory ./independent-image-inventory-arm64.json \
  --output ./acceptance-result-arm64.json
```

The runner starts one hardened fixture-mode container with durable storage,
starts a loopback restart supervisor on an ephemeral port, waits for real
readiness after every restart, and removes the temporary container, volume,
keys, and synthetic bearer when it exits. The driver preserves already
observed platform-call evidence across process restarts and projects internal
account UUIDs back to the acceptance contract account IDs.

## Anti-false-positive rules

- The reference driver is only a harness self-test. The runner rejects it as a
  candidate.
- Candidate and production image references must be immutable and must match
  driver metadata and inspected image provenance.
- Required scenarios have no skip state. Any failed assertion yields `NO-GO`.
- An `UNKNOWN` write is never resubmitted automatically, including after a
  restart. Only explicit reconciliation can change its state.
- No live credential, session envelope, route material, MFA value, or social
  mutation belongs in this suite or its result artifact.
