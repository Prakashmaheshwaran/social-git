import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_LEDGER_SCHEMA_VERSION } from "../src/ledger-backup.ts";
import { IDENTITY_SCHEMA_VERSION } from "../src/identity.ts";
import { buildRuntimeReadiness, DIAGNOSTIC_COUNT_LIMIT } from "../src/readiness.ts";
import { SESSION_RUNTIME_SCHEMA_VERSION } from "@social-git/core";

const healthy = {
  mode: "production" as const,
  databases: {
    actions: { migrationVersion: ACTION_LEDGER_SCHEMA_VERSION, journalMode: "wal", integrity: "ok" },
    sessions: { schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION, journalMode: "wal" },
    identity: { schemaVersion: IDENTITY_SCHEMA_VERSION, journalMode: "wal", integrity: "ok" },
  },
  workers: {
    action: { running: true, paused: false, busy: false, processed: 2, failures: 0 },
    webhook: { running: true, paused: false, busy: false, processed: 3, failures: 0 },
    redditReachable: true,
    xReachable: false,
  },
  maintenance: { active: false, activeRequests: 0 },
  counts: { queuedActions: 2, runningActions: 1, unknownActions: 0, webhookPending: 3, webhookExhausted: 1 },
  xAdmission: { requested: false, enabled: false, productionEnabled: false, disabledReasons: ["AUTHORIZED_LIVE_PROOF_MISSING"] },
  certificationGrantActive: false,
};

test("readiness: capability-disabled X is visible but does not make the Reddit product unready", () => {
  const result = buildRuntimeReadiness(healthy);
  assert.equal(result.ready, true);
  assert.equal(result.contractVersion, 1);
  assert.deepEqual((result.checks.workers as any).x, {
    required: false,
    reachable: false,
    state: "unreachable",
    admission: "capability_disabled",
    requested: false,
    enabled: false,
    productionEnabled: false,
    disabledReasons: ["AUTHORIZED_LIVE_PROOF_MISSING"],
  });
});

test("readiness: committed and requested X admission makes worker reachability required", () => {
  const result = buildRuntimeReadiness({
    ...healthy,
    xAdmission: { requested: true, enabled: true, productionEnabled: true, disabledReasons: [] },
  });
  assert.equal(result.ready, false);
  assert.equal((result.checks.workers as any).x.required, true);
  assert.equal((result.checks.workers as any).x.admission, "enabled");
});

test("readiness: X release certification is distinct from product admission and requires its authenticated worker", () => {
  const unavailable = buildRuntimeReadiness({
    ...healthy,
    certificationGrantActive: true,
    releaseCertification: { configured: true, active: true, platform: "x", workerReachable: false },
  });
  assert.equal(unavailable.ready, false);
  assert.equal((unavailable.checks.workers as any).x.required, true);
  assert.equal((unavailable.checks.workers as any).x.productionEnabled, false);
  assert.equal((unavailable.checks as any).writeExecutionMode, "product_with_release_certification");
  assert.deepEqual((unavailable.checks as any).releaseCertification, { configured: true, active: true, platform: "x", workerReachable: false });
  const ready = buildRuntimeReadiness({
    ...healthy, workers: { ...healthy.workers, xReachable: true }, certificationGrantActive: true,
    releaseCertification: { configured: true, active: true, platform: "x", workerReachable: true },
  });
  assert.equal(ready.ready, true);
  assert.equal((ready.checks.workers as any).x.admission, "capability_disabled");
});

test("readiness: configured but not-yet-active or expired release grants do not alter product readiness", () => {
  for (const platform of ["reddit", "x"] as const) {
    const result = buildRuntimeReadiness({ ...healthy, workers: { ...healthy.workers, xReachable: false }, certificationGrantActive: false, releaseCertification: { configured: true, active: false, platform, workerReachable: false } });
    assert.equal(result.ready, true);
    assert.deepEqual((result.checks as any).releaseCertification, { configured: true, active: false, platform, workerReachable: null });
    assert.equal((result.checks as any).writeExecutionMode, "product");
  }
});

test("readiness: required worker drop, schema mismatch, and maintenance each fail closed", () => {
  const dropped = buildRuntimeReadiness({ ...healthy, workers: { ...healthy.workers, redditReachable: false } });
  assert.equal(dropped.ready, false);
  assert.equal((dropped.checks.workers as any).reddit.state, "unreachable");

  const mismatched = buildRuntimeReadiness({
    ...healthy,
    databases: { ...healthy.databases, actions: { ...healthy.databases.actions, migrationVersion: ACTION_LEDGER_SCHEMA_VERSION - 1 } },
  });
  assert.equal(mismatched.ready, false);
  assert.deepEqual((mismatched.checks.databases as any).actions.migration, {
    current: ACTION_LEDGER_SCHEMA_VERSION - 1,
    expected: ACTION_LEDGER_SCHEMA_VERSION,
  });

  const maintenance = buildRuntimeReadiness({
    ...healthy,
    workers: {
      ...healthy.workers,
      action: { ...healthy.workers.action, paused: true },
      webhook: { ...healthy.workers.webhook, paused: true },
    },
    maintenance: { active: true, activeRequests: 4 },
  });
  assert.equal(maintenance.ready, false);
  assert.equal((maintenance.checks.maintenance as any).state, "active");
});

test("readiness: public queue diagnostics are bounded and contain no tenant or record data", () => {
  const result = buildRuntimeReadiness({
    ...healthy,
    counts: { queuedActions: DIAGNOSTIC_COUNT_LIMIT + 40, runningActions: 1, unknownActions: 2, webhookPending: DIAGNOSTIC_COUNT_LIMIT + 1, webhookExhausted: 0 },
  });
  assert.deepEqual((result.checks.backlog as any).actions.queued, { value: DIAGNOSTIC_COUNT_LIMIT, truncated: true });
  assert.deepEqual((result.checks.backlog as any).webhooks.pending, { value: DIAGNOSTIC_COUNT_LIMIT, truncated: true });
  const serialized = JSON.stringify(result);
  for (const prohibited of ["tenantId", "accountId", "callerId", "eventId", "actionId"]) assert.equal(serialized.includes(prohibited), false);
});
