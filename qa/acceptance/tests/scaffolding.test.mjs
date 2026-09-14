import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { candidateVerdict } from "../contract.mjs";
import { createFixtureDriver } from "../fixtures/reference-driver.mjs";
import { SCENARIOS, runAcceptance } from "../suite.mjs";

const manifest = JSON.parse(await readFile(
  new URL("../coverage-manifest.json", import.meta.url),
  "utf8",
));

const REQUIRED_CONTROLS = [
  "accounts.multi_account_isolation",
  "accounts.expected_identity",
  "accounts.network_routes",
  "sessions.import",
  "sessions.refresh",
  "sessions.validate",
  "sessions.revoke",
  "reads.account_profile",
  "reads.subreddit_metadata",
  "reads.feed_listing",
  "reads.post",
  "reads.comments",
  "reads.search",
  "writes.text_post",
  "writes.link_post",
  "writes.media_post",
  "writes.comment",
  "writes.reply",
  "writes.vote",
  "writes.save",
  "writes.unsave",
  "writes.delete_caller_owned",
  "results.native_identifiers",
  "results.canonical_urls",
  "writes.scoped_authorization",
  "writes.deletion_boundaries",
  "actions.caller_scoped_idempotency",
  "actions.restart_recovery",
  "actions.concurrency",
  "errors.rate_limit",
  "errors.challenge_checkpoint_captcha",
  "errors.revoked_session",
  "errors.protocol_drift",
  "actions.crash_after_submit",
  "actions.unknown_no_automatic_retry",
  "actions.explicit_unknown_recovery",
  "security.session_route_encryption_at_rest",
  "security.log_redaction",
  "packaging.no_browser_runtime",
];

test("coverage manifest maps every required control to an executable scenario", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.evidenceClass, "deterministic_fixture");
  const scenarioNames = SCENARIOS.map(([name]) => name);
  assert.deepEqual(manifest.scenarios, scenarioNames);

  const controlIds = manifest.controls.map(({ id }) => id);
  assert.equal(new Set(controlIds).size, controlIds.length, "control ids must be unique");
  assert.deepEqual([...controlIds].sort(), [...REQUIRED_CONTROLS].sort());
  for (const control of manifest.controls) {
    assert.equal(control.required, true);
    assert.ok(scenarioNames.includes(control.scenario), `${control.id} has no executable scenario`);
  }
});

test("reference fixtures exercise every scenario without issuing a candidate verdict", async () => {
  const report = await runAcceptance(createFixtureDriver());
  assert.equal(report.evidenceClass, "fixture_self_test");
  assert.equal(report.verdict, "NOT_EVALUATED");
  assert.deepEqual(
    report.scenarios.map(({ name, status }) => ({ name, status })),
    SCENARIOS.map(([name]) => ({ name, status: "PASS" })),
  );
});

for (const mutation of [
  { name: "wrong account route", faults: { wrongRoute: true }, scenario: "accounts-sessions-routes" },
  { name: "automatic retry after UNKNOWN", faults: { retryUnknown: true }, scenario: "crash-after-submit-and-unknown" },
  { name: "sensitive log leak", faults: { leakSecrets: true }, scenario: "secret-log-redaction" },
  { name: "browser dependency", faults: { browserDependency: true }, scenario: "production-image-no-browser" },
]) {
  test(`suite detects ${mutation.name}`, async () => {
    const report = await runAcceptance(createFixtureDriver({ faults: mutation.faults }));
    const result = report.scenarios.find(({ name }) => name === mutation.scenario);
    assert.equal(result.status, "FAIL");
    assert.equal(report.verdict, "NOT_EVALUATED");
  });
}

test("verdict gate requires an immutable integration candidate and image", () => {
  const passing = [{ name: "required", status: "PASS" }];
  const candidate = {
    kind: "integration_candidate",
    candidateRef: `git:${"b".repeat(40)}`,
    imageDigest: `sha256:${"c".repeat(64)}`,
  };
  assert.equal(candidateVerdict(candidate, passing), "GO");
  assert.equal(candidateVerdict(candidate, []), "NO-GO");
  assert.equal(candidateVerdict(candidate, [{ name: "required", status: "FAIL" }]), "NO-GO");
  assert.equal(candidateVerdict({ ...candidate, candidateRef: "main" }, passing), "NO-GO");
  assert.equal(candidateVerdict({ ...candidate, imageDigest: "latest" }, passing), "NO-GO");
  assert.equal(candidateVerdict({ ...candidate, kind: "fixture_self_test" }, passing), "NOT_EVALUATED");
});

test("candidate runner refuses the reference fixture driver", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../run-candidate.mjs", import.meta.url)),
    "--driver",
    fileURLToPath(new URL("../fixtures/reference-driver.mjs", import.meta.url)),
    "--candidate-ref",
    `git:${"d".repeat(40)}`,
    "--image-digest",
    `sha256:${"e".repeat(64)}`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing verdict: driver is not an integration_candidate/);
  assert.equal(result.stdout, "");
});
