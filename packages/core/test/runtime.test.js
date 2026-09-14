import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  SessionRuntime,
  decodeWorkerMessage,
  encodeWorkerMessage
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x52);
const TEST_ROOT = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  || process.env.PAPERCLIP_SCRATCH_DIR
  || tmpdir();

function expectCode(code) {
  return (error) => error?.code === code;
}

function harness() {
  const directory = mkdtempSync(join(TEST_ROOT, "social-git-core-"));
  const databasePath = join(directory, "core.sqlite");
  let time = 1_800_000_000_000;
  let sequence = 0;
  let nonce = 0;
  return {
    databasePath,
    open() {
      return new SessionRuntime({
        databasePath,
        masterKey: KEY,
        now: () => time,
        randomUUID: () => `lease-${++sequence}`,
        randomBytes: (size) => Buffer.alloc(size, ++nonce)
      });
    },
    advance(milliseconds) {
      time += milliseconds;
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function importAccount(runtime, overrides = {}) {
  return runtime.importExternalSession({
    accountId: "account-a",
    platform: "reddit",
    expectedNativeIdentity: "native-a",
    generation: 1,
    session: Buffer.from("synthetic-session"),
    networkRoute: {
      id: "route-a",
      material: Buffer.from("synthetic-route")
    },
    ...overrides
  });
}

function acquireIdentity(runtime, overrides = {}) {
  return decodeWorkerMessage(runtime.acquireWorkerCommand({
    accountId: "account-a",
    generation: 1,
    requestId: "request-1",
    intent: "identity_validation",
    operation: "identity.current",
    ...overrides
  }));
}

function resultFor(command, overrides = {}) {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.result",
    requestId: command.requestId,
    accountId: command.accountId,
    platform: command.platform,
    generation: command.generation,
    leaseId: command.leaseId,
    fence: command.fence,
    status: "SUCCEEDED",
    observedNativeIdentity: command.expectedNativeIdentity,
    ...overrides
  });
}

function makeHealthy(runtime) {
  importAccount(runtime);
  const identity = acquireIdentity(runtime);
  return runtime.completeWorkerResult({
    accountId: "account-a",
    generation: 1,
    message: resultFor(identity)
  });
}

function acquireWrite(runtime, overrides = {}) {
  return decodeWorkerMessage(runtime.acquireWorkerCommand({
    accountId: "account-a",
    generation: 1,
    requestId: "write-1",
    intent: "write",
    operation: "post.create",
    ...overrides
  }));
}

test("external import uses SQLite WAL and exposes no stored secret material", () => {
  const run = harness();
  const runtime = run.open();
  try {
    const state = importAccount(runtime);
    assert.equal(runtime.diagnostics().journalMode, "wal");
    assert.equal(runtime.diagnostics().schemaVersion, 1);
    assert.equal(state.health, "pending_identity");
    assert.equal(state.networkRouteId, "route-a");
    assert.equal(JSON.stringify(state).includes("synthetic-session"), false);
    assert.equal(JSON.stringify(state).includes("synthetic-route"), false);
    const storageBytes = [run.databasePath, `${run.databasePath}-wal`]
      .filter(existsSync)
      .map((path) => readFileSync(path))
      .reduce((combined, bytes) => Buffer.concat([combined, bytes]), Buffer.alloc(0));
    assert.equal(storageBytes.includes(Buffer.from("synthetic-session")), false);
    assert.equal(storageBytes.includes(Buffer.from("synthetic-route")), false);

    const command = acquireIdentity(runtime);
    assert.equal(Buffer.from(command.sessionBase64, "base64url").toString(), "synthetic-session");
    assert.equal(
      Buffer.from(command.networkRoute.materialBase64, "base64url").toString(),
      "synthetic-route"
    );
    const healthy = runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(command)
    });
    assert.equal(healthy.health, "healthy");
    assert.equal(healthy.refresh, "idle");
    assert.equal(healthy.activeLease, null);
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("wrong identity is recorded atomically and revokes secret material", () => {
  const run = harness();
  const runtime = run.open();
  try {
    importAccount(runtime);
    const command = acquireIdentity(runtime);
    assert.throws(() => runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(command, { observedNativeIdentity: "native-b" })
    }), expectCode("WRONG_IDENTITY"));

    const state = runtime.getAccountState("account-a");
    assert.equal(state.health, "wrong_identity");
    assert.equal(state.revokedThroughGeneration, 1);
    assert.equal(state.networkRouteId, null);
    assert.equal(state.activeLease, null);
    assert.throws(() => acquireIdentity(runtime, { requestId: "request-2" }), expectCode("REVOKED"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("wrong account and stale generation results cannot mutate a lease", () => {
  const run = harness();
  const runtime = run.open();
  try {
    importAccount(runtime);
    const command = acquireIdentity(runtime);
    assert.throws(() => runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(command, { accountId: "account-b" })
    }), expectCode("WRONG_ACCOUNT"));
    assert.throws(() => runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 2,
      message: resultFor(command)
    }), expectCode("STALE_GENERATION"));
    assert.equal(runtime.getAccountState("account-a").activeLease.leaseId, command.leaseId);
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("revocation generations reject stale work and require the exact next import", () => {
  const run = harness();
  const runtime = run.open();
  try {
    importAccount(runtime);
    const revoked = runtime.revokeAccount({ accountId: "account-a", generation: 1 });
    assert.equal(revoked.health, "revoked");
    assert.equal(revoked.revokedThroughGeneration, 1);
    assert.throws(() => acquireIdentity(runtime), expectCode("REVOKED"));
    assert.throws(() => importAccount(runtime), expectCode("STALE_GENERATION"));

    const imported = importAccount(runtime, {
      generation: 2,
      session: Buffer.from("second-session"),
      networkRoute: { id: "route-b", material: Buffer.from("second-route") }
    });
    assert.equal(imported.generation, 2);
    assert.equal(imported.health, "pending_identity");
    assert.equal(imported.networkRouteId, "route-b");
    assert.throws(() => runtime.acquireWorkerCommand({
      accountId: "account-a",
      generation: 1,
      requestId: "old-generation",
      intent: "identity_validation",
      operation: "identity.current"
    }), expectCode("REVOKED"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("a replacement lease fences a concurrent stale completion", () => {
  const run = harness();
  const runtime = run.open();
  try {
    importAccount(runtime);
    const first = acquireIdentity(runtime);
    const second = acquireIdentity(runtime, {
      requestId: "request-2",
      previousLease: { leaseId: first.leaseId, fence: first.fence }
    });
    assert.ok(second.fence > first.fence);
    assert.throws(() => runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(first)
    }), expectCode("STALE_LEASE"));
    const state = runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(second)
    });
    assert.equal(state.health, "healthy");
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("startup recovery abandons crash-interrupted leases and preserves fence monotonicity", () => {
  const run = harness();
  let runtime = run.open();
  try {
    importAccount(runtime);
    const identity = acquireIdentity(runtime);
    runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(identity)
    });
    runtime.requestRefresh({ accountId: "account-a", generation: 1 });
    const first = decodeWorkerMessage(runtime.acquireWorkerCommand({
      accountId: "account-a",
      generation: 1,
      requestId: "refresh-1",
      intent: "refresh",
      operation: "session.refresh"
    }));
    assert.equal(runtime.getAccountState("account-a").refresh, "in_progress");
    runtime.close();

    runtime = run.open();
    const recovered = runtime.getAccountState("account-a");
    assert.equal(recovered.activeLease, null);
    assert.equal(recovered.refresh, "required");
    const second = decodeWorkerMessage(runtime.acquireWorkerCommand({
      accountId: "account-a",
      generation: 1,
      requestId: "refresh-2",
      intent: "refresh",
      operation: "session.refresh"
    }));
    assert.ok(second.fence > first.fence);
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("startup recovery records a crash-interrupted write as unknown", () => {
  const run = harness();
  let runtime = run.open();
  try {
    makeHealthy(runtime);
    acquireWrite(runtime);
    runtime.close();

    runtime = run.open();
    const recovered = runtime.getAccountState("account-a");
    assert.equal(recovered.health, "unknown");
    assert.equal(recovered.refresh, "failed");
    assert.equal(recovered.activeLease, null);
    assert.throws(() => acquireWrite(runtime, { requestId: "write-2" }), expectCode("INVALID_STATE"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("expired leases recover without accepting their result", () => {
  const run = harness();
  const runtime = run.open();
  try {
    importAccount(runtime);
    const command = acquireIdentity(runtime, { leaseTtlMs: 10 });
    run.advance(10);
    assert.equal(runtime.recoverExpiredLeases(), 1);
    assert.equal(runtime.getAccountState("account-a").activeLease, null);
    assert.throws(() => runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(command)
    }), expectCode("STALE_LEASE"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("expired writes become unknown and cannot be retried", () => {
  const run = harness();
  const runtime = run.open();
  try {
    makeHealthy(runtime);
    acquireWrite(runtime, { leaseTtlMs: 10 });
    run.advance(10);
    assert.equal(runtime.recoverExpiredLeases(), 1);
    const recovered = runtime.getAccountState("account-a");
    assert.equal(recovered.health, "unknown");
    assert.equal(recovered.refresh, "failed");
    assert.equal(recovered.activeLease, null);
    assert.throws(() => acquireWrite(runtime, { requestId: "write-2" }), expectCode("INVALID_STATE"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("a late result for an expired write leaves the account unknown", () => {
  const run = harness();
  const runtime = run.open();
  try {
    makeHealthy(runtime);
    const command = acquireWrite(runtime, { leaseTtlMs: 10 });
    run.advance(10);
    assert.throws(() => runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(command)
    }), expectCode("LEASE_EXPIRED"));
    assert.equal(runtime.getAccountState("account-a").health, "unknown");
    assert.throws(() => acquireWrite(runtime, { requestId: "write-2" }), expectCode("INVALID_STATE"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("an in-flight write cannot be replaced with previousLease", () => {
  const run = harness();
  const runtime = run.open();
  try {
    makeHealthy(runtime);
    const first = acquireWrite(runtime);
    assert.throws(() => acquireWrite(runtime, {
      requestId: "write-2",
      previousLease: { leaseId: first.leaseId, fence: first.fence }
    }), expectCode("INVALID_STATE"));
    const state = runtime.getAccountState("account-a");
    assert.equal(state.health, "unknown");
    assert.equal(state.refresh, "failed");
    assert.equal(state.activeLease, null);
    assert.throws(() => acquireWrite(runtime, { requestId: "write-3" }), expectCode("INVALID_STATE"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("malformed stored envelopes fail closed without returning database details", () => {
  const run = harness();
  let runtime = run.open();
  try {
    importAccount(runtime);
    runtime.close();
    const database = new DatabaseSync(run.databasePath);
    database.prepare("UPDATE accounts SET session_envelope = ? WHERE account_id = ?")
      .run(Buffer.from("{}"), "account-a");
    database.close();

    runtime = run.open();
    assert.throws(
      () => acquireIdentity(runtime),
      (error) => error.code === "MALFORMED_ENVELOPE"
        && !error.message.includes("accounts")
        && !error.message.includes("session_envelope")
    );
  } finally {
    runtime.close();
    run.cleanup();
  }
});

test("normalized health results drive explicit refresh and fail-closed states", () => {
  const cases = [
    ["AUTH_FAILURE", "needs_refresh", "required"],
    ["CHALLENGE", "challenged", "failed"],
    ["RATE_LIMITED", "rate_limited", "required"],
    ["PROTOCOL_DRIFT", "protocol_drift", "failed"],
    ["UNKNOWN", "unknown", "failed"]
  ];
  for (const [status, health, refresh] of cases) {
    const run = harness();
    const runtime = run.open();
    try {
      importAccount(runtime);
      const command = acquireIdentity(runtime);
      const state = runtime.completeWorkerResult({
        accountId: "account-a",
        generation: 1,
        message: resultFor(command, {
          status,
          observedNativeIdentity: "native-a"
        })
      });
      assert.equal(state.health, health);
      assert.equal(state.refresh, refresh);
      assert.throws(() => runtime.acquireWorkerCommand({
        accountId: "account-a",
        generation: 1,
        requestId: "unsafe-retry",
        intent: "read",
        operation: "feed.list"
      }), expectCode("INVALID_STATE"));
    } finally {
      runtime.close();
      run.cleanup();
    }
  }
});

test("a worker revocation result deletes custody material and revokes the generation", () => {
  const run = harness();
  const runtime = run.open();
  try {
    importAccount(runtime);
    const command = acquireIdentity(runtime);
    const state = runtime.completeWorkerResult({
      accountId: "account-a",
      generation: 1,
      message: resultFor(command, {
        status: "REVOKED",
        observedNativeIdentity: "native-a"
      })
    });
    assert.equal(state.health, "revoked");
    assert.equal(state.revokedThroughGeneration, 1);
    assert.equal(state.networkRouteId, null);
    assert.throws(() => acquireIdentity(runtime, { requestId: "after-revoke" }), expectCode("REVOKED"));
  } finally {
    runtime.close();
    run.cleanup();
  }
});
