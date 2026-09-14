import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionRuntime,
  decodeWorkerMessage,
  encodeWorkerMessage
} from "@social-git/core";
import {
  AuthorizationError,
  AuthorizationErrorCode,
  LiveAuthorizationLedger,
  LiveOutcome,
  LiveTestController,
  Permission,
  ROLE_PERMISSIONS,
  Role,
  RoleAuthority,
  StopReason,
  approveLiveTestGrant,
  assertPermission
} from "../src/index.js";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const ARTIFACT = `sha256:${"a".repeat(64)}`;
const SBOM = `sha256:${"b".repeat(64)}`;
const TEST_EVIDENCE = `sha256:${"c".repeat(64)}`;
const AUTHORITY = new RoleAuthority([
  { actorId: "qa-operator-7", role: Role.INDEPENDENT_LIVE_QA },
  { actorId: "qa-other", role: Role.INDEPENDENT_LIVE_QA },
  { actorId: "security-reviewer-4", role: Role.SECURITY_REVIEWER },
  { actorId: "core-runtime", role: Role.CORE_RUNTIME },
  { actorId: "custodian-1", role: Role.SESSION_NETWORK_CUSTODIAN }
]);
const QA = AUTHORITY.principalFor("qa-operator-7");
const APPROVER = AUTHORITY.principalFor("security-reviewer-4");
const CORE = AUTHORITY.principalFor("core-runtime");

function grantInput(overrides = {}) {
  return {
    authorizationId: "live-auth-1",
    ledgerId: "action-ledger-1",
    environment: "production-canary",
    artifactDigest: ARTIFACT,
    sbomDigest: SBOM,
    testEvidenceDigest: TEST_EVIDENCE,
    canaryAccountId: "account-canary-1",
    expectedNativeIdentity: "reddit:t2_expected",
    sessionGeneration: 8,
    routeId: "route-3",
    readOperations: ["reddit.profile.get"],
    writeOperations: ["reddit.comment.create", "reddit.comment.delete"],
    resourceConstraints: {
      max_body_bytes: "256",
      subreddit: "socialgit_canary"
    },
    cleanupOperation: "reddit.comment.delete",
    actionLimit: 2,
    notBefore: NOW - 60_000,
    expiresAt: NOW + 600_000,
    ...overrides
  };
}

function grant(overrides = {}, actors = { qaOperator: QA, approver: APPROVER }) {
  return approveLiveTestGrant(grantInput(overrides), actors);
}

function request(overrides = {}) {
  return {
    actionId: "action-1",
    ledgerId: "action-ledger-1",
    environment: "production-canary",
    artifactDigest: ARTIFACT,
    sbomDigest: SBOM,
    testEvidenceDigest: TEST_EVIDENCE,
    canaryAccountId: "account-canary-1",
    observedNativeIdentity: "reddit:t2_expected",
    sessionGeneration: 8,
    routeId: "route-3",
    operation: "reddit.comment.create",
    resourceConstraints: {
      max_body_bytes: "256",
      subreddit: "socialgit_canary"
    },
    executor: QA,
    ...overrides
  };
}

function withLedger(operation) {
  const directory = mkdtempSync(join(tmpdir(), "social-git-security-"));
  const databasePath = join(directory, "live-authorization.sqlite");
  const ledger = new LiveAuthorizationLedger(databasePath);
  try {
    return operation(ledger, databasePath);
  } finally {
    ledger.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function expectCode(code, operation) {
  assert.throws(
    operation,
    (error) => error instanceof AuthorizationError && error.code === code
  );
}

function register(ledger, approved) {
  ledger.registerGrant(approved, NOW - 120_000);
  return approved;
}

test("the role denial matrix prevents every role from crossing its boundary", () => {
  const denied = {
    [Role.PLATFORM_SECURITY_ADMIN]: [
      Permission.IMPORT_SESSION,
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.CALL_SCOPED_WRITE,
      Permission.EXECUTE_APPROVED_LIVE_TEST
    ],
    [Role.SESSION_NETWORK_CUSTODIAN]: [
      Permission.APPROVE_LIVE_TEST,
      Permission.CALL_SCOPED_WRITE,
      Permission.DECRYPT_FENCED_JOB_SECRET
    ],
    [Role.API_CALLER]: [
      Permission.IMPORT_SESSION,
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.EXECUTE_APPROVED_LIVE_TEST
    ],
    [Role.CORE_RUNTIME]: [
      Permission.IMPORT_SESSION,
      Permission.APPROVE_LIVE_TEST,
      Permission.EXECUTE_APPROVED_LIVE_TEST
    ],
    [Role.PLATFORM_WORKER]: [
      Permission.USE_CORE_DATABASE,
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.MANAGE_ROLE_POLICY
    ],
    [Role.DEVELOPER]: [
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.PROVISION_ROUTE_SECRET,
      Permission.CALL_SCOPED_WRITE,
      Permission.EXECUTE_APPROVED_LIVE_TEST
    ],
    [Role.RESEARCHER]: [
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.PROVISION_ROUTE_SECRET,
      Permission.CALL_SCOPED_WRITE,
      Permission.EXECUTE_APPROVED_LIVE_TEST
    ],
    [Role.SECURITY_REVIEWER]: [
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.CALL_SCOPED_WRITE,
      Permission.EXECUTE_APPROVED_LIVE_TEST
    ],
    [Role.BACKUP_OPERATOR]: [
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.USE_CORE_DATABASE,
      Permission.REVIEW_SECURITY_EVIDENCE
    ],
    [Role.INDEPENDENT_LIVE_QA]: [
      Permission.DECRYPT_FENCED_JOB_SECRET,
      Permission.CALL_SCOPED_WRITE,
      Permission.APPROVE_LIVE_TEST
    ]
  };

  assert.deepEqual(Object.keys(denied).sort(), Object.values(Role).sort());
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), Object.values(Role).sort());
  const matrixAuthority = new RoleAuthority(
    Object.values(Role).map((role) => ({ actorId: `actor-${role}`, role }))
  );
  for (const [role, permissions] of Object.entries(denied)) {
    for (const permission of permissions) {
      expectCode(
        AuthorizationErrorCode.ROLE_DENIED,
        () => assertPermission(matrixAuthority.principalFor(`actor-${role}`), permission)
      );
    }
  }
});

test("developers and researchers have no live credentials or live mutation authority", () => {
  const livePermissions = new Set([
    Permission.IMPORT_SESSION,
    Permission.PROVISION_ROUTE_SECRET,
    Permission.DECRYPT_FENCED_JOB_SECRET,
    Permission.CALL_SCOPED_READ,
    Permission.CALL_SCOPED_WRITE,
    Permission.APPROVE_LIVE_TEST,
    Permission.EXECUTE_APPROVED_LIVE_TEST
  ]);
  for (const role of [Role.DEVELOPER, Role.RESEARCHER]) {
    assert.equal(ROLE_PERMISSIONS[role].some((value) => livePermissions.has(value)), false);
  }
});

test("request data cannot self-assert a privileged role", () => {
  expectCode(
    AuthorizationErrorCode.ROLE_DENIED,
    () => assertPermission(
      { actorId: "untrusted", role: Role.CORE_RUNTIME },
      Permission.DECRYPT_FENCED_JOB_SECRET
    )
  );
  assert.throws(
    () => new RoleAuthority([
      { actorId: "same-actor", role: Role.SECURITY_REVIEWER },
      { actorId: "same-actor", role: Role.INDEPENDENT_LIVE_QA }
    ]),
    TypeError
  );
});

test("a live-test executor cannot approve the same grant", () => {
  const separateAuthority = new RoleAuthority([
    { actorId: QA.actorId, role: Role.SECURITY_REVIEWER }
  ]);
  const samePersonApprover = separateAuthority.principalFor(QA.actorId);
  expectCode(
    AuthorizationErrorCode.INVALID_GRANT,
    () => grant({}, { qaOperator: QA, approver: samePersonApprover })
  );
});

test("a session custodian cannot approve a live test", () => {
  const custodian = AUTHORITY.principalFor("custodian-1");
  expectCode(
    AuthorizationErrorCode.ROLE_DENIED,
    () => grant({}, { qaOperator: QA, approver: custodian })
  );
});

test("approved grants are immutable and reject broad operations", () => {
  const approved = grant();
  assert.equal(Object.isFrozen(approved), true);
  assert.equal(Object.isFrozen(approved.writeOperations), true);
  assert.equal(Object.isFrozen(approved.resourceConstraints), true);
  assert.throws(() => { approved.actionLimit = 10; }, TypeError);
  assert.throws(() => grant({ writeOperations: ["reddit.write.all"] }), TypeError);
});

test("the ledger rejects a grant that did not cross the approval boundary", () => {
  withLedger((ledger) => {
    const forged = JSON.parse(JSON.stringify(grant()));
    expectCode(
      AuthorizationErrorCode.INVALID_GRANT,
      () => ledger.registerGrant(forged, NOW - 120_000)
    );
  });
});

test("expired, premature, and wrongly bound grants fail closed", () => {
  const cases = [
    [AuthorizationErrorCode.EXPIRED, { expiresAt: NOW }, {}, NOW],
    [AuthorizationErrorCode.NOT_YET_VALID, { notBefore: NOW + 1 }, {}, NOW],
    [AuthorizationErrorCode.WRONG_ENVIRONMENT, {}, { environment: "staging" }, NOW],
    [AuthorizationErrorCode.WRONG_ARTIFACT, {}, { artifactDigest: `sha256:${"d".repeat(64)}` }, NOW],
    [AuthorizationErrorCode.WRONG_SBOM, {}, { sbomDigest: `sha256:${"d".repeat(64)}` }, NOW],
    [AuthorizationErrorCode.WRONG_TEST_EVIDENCE, {}, { testEvidenceDigest: `sha256:${"d".repeat(64)}` }, NOW],
    [AuthorizationErrorCode.WRONG_ACCOUNT, {}, { canaryAccountId: "account-other" }, NOW],
    [AuthorizationErrorCode.WRONG_IDENTITY, {}, { observedNativeIdentity: "reddit:t2_other" }, NOW],
    [AuthorizationErrorCode.STALE_GENERATION, {}, { sessionGeneration: 7 }, NOW],
    [AuthorizationErrorCode.WRONG_ROUTE, {}, { routeId: "route-other" }, NOW],
    [AuthorizationErrorCode.WRONG_OPERATOR, {}, { executor: AUTHORITY.principalFor("qa-other") }, NOW],
    [AuthorizationErrorCode.WRONG_OPERATION, {}, { operation: "reddit.post.create" }, NOW],
    [AuthorizationErrorCode.WRONG_RESOURCE, {}, { resourceConstraints: { subreddit: "other" } }, NOW],
    [AuthorizationErrorCode.WRONG_LEDGER, {}, { ledgerId: "action-ledger-other" }, NOW]
  ];

  for (const [code, grantChanges, requestChanges, now] of cases) {
    withLedger((ledger) => {
      const approved = register(ledger, grant(grantChanges));
      expectCode(
        code,
        () => ledger.authorizeAndRecord(approved, request(requestChanges), now)
      );
    });
  }
});

test("replayed actions and over-limit actions fail closed", () => {
  withLedger((ledger) => {
    const approved = register(ledger, grant({ actionLimit: 1 }));
    const decision = ledger.authorizeAndRecord(approved, request(), NOW);
    ledger.complete(decision, LiveOutcome.SUCCEEDED, NOW);
    expectCode(
      AuthorizationErrorCode.REPLAYED,
      () => ledger.authorizeAndRecord(approved, request(), NOW)
    );
    expectCode(
      AuthorizationErrorCode.OVER_LIMIT,
      () => ledger.authorizeAndRecord(approved, request({ actionId: "action-2" }), NOW)
    );
  });
});

test("the authorization identifier stays bound to one immutable grant", () => {
  withLedger((ledger) => {
    const originalGrant = register(ledger, grant());
    ledger.authorizeAndRecord(originalGrant, request(), NOW);
    const alteredGrant = grant({ actionLimit: 3 });
    expectCode(
      AuthorizationErrorCode.REPLAYED,
      () => ledger.authorizeAndRecord(alteredGrant, request({ actionId: "action-2" }), NOW)
    );
  });
});

test("the one-time action record rejects replay after a process restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "social-git-security-restart-"));
  const databasePath = join(directory, "live-authorization.sqlite");
  const approved = grant();
  let ledger = new LiveAuthorizationLedger(databasePath);
  try {
    ledger.registerGrant(approved, NOW - 120_000);
    const decision = ledger.authorizeAndRecord(approved, request(), NOW);
    ledger.complete(decision, LiveOutcome.SUCCEEDED, NOW);
    ledger.close();
    ledger = new LiveAuthorizationLedger(databasePath);
    const restoredGrant = JSON.parse(JSON.stringify(approved));
    expectCode(
      AuthorizationErrorCode.REPLAYED,
      () => ledger.authorizeAndRecord(restoredGrant, request(), NOW)
    );
  } finally {
    ledger.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a crash after the durable authorization record recovers as terminal UNKNOWN", async () => {
  const directory = mkdtempSync(join(tmpdir(), "social-git-security-crash-record-"));
  const databasePath = join(directory, "live-authorization.sqlite");
  const approved = grant({ actionLimit: 3 });
  let ledger = new LiveAuthorizationLedger(databasePath);
  const runtime = healthyRuntime(directory);
  const actionStore = new RecordingActionStore(ledger);
  try {
    ledger.registerGrant(approved, NOW - 120_000);
    const controller = new LiveTestController(ledger);
    await assert.rejects(
      () => controller.execute(approved, request(), controllerOptions(runtime, actionStore, async () => {
        throw new Error("dispatch must not start");
      }, { crashAfterRecord: true })),
      (error) => error?.code === "SIMULATED_CRASH_AFTER_RECORD"
    );
    assert.deepEqual(ledger.actionState(approved.authorizationId, "action-1"), { state: "PENDING", outcome: null });
    assert.equal(actionStore.started, false);

    ledger.close();
    ledger = new LiveAuthorizationLedger(databasePath);
    assert.deepEqual(ledger.startupRecovery, { unknown: 1 });
    assert.deepEqual(ledger.actionState(approved.authorizationId, "action-1"), { state: "UNKNOWN", outcome: StopReason.UNKNOWN });
    expectCode(
      AuthorizationErrorCode.STOPPED,
      () => ledger.authorizeAndRecord(approved, request({ actionId: "action-2" }), NOW)
    );
  } finally {
    runtime.close();
    ledger.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("every terminal worker stop state stops the grant", async () => {
  for (const [index, reason] of Object.values(StopReason).entries()) {
    const directory = mkdtempSync(join(tmpdir(), `social-git-security-stop-${index}-`));
    const ledger = new LiveAuthorizationLedger(join(directory, "live-authorization.sqlite"));
    const runtime = healthyRuntime(directory);
    try {
      const approved = grant({ authorizationId: `live-auth-${index}` });
      ledger.registerGrant(approved, NOW - 120_000);
      const controller = new LiveTestController(ledger);
      const evidence = await controller.execute(approved, request(), controllerOptions(
        runtime,
        new RecordingActionStore(ledger, approved.authorizationId),
        async (serialized) => workerResult(serialized, reason)
      ));
      assert.equal(evidence.outcome, reason);
      expectCode(
        AuthorizationErrorCode.STOPPED,
        () => ledger.authorizeAndRecord(approved, request({ actionId: "action-2" }), NOW)
      );
    } finally {
      runtime.close();
      ledger.close();
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

test("an unverified dispatch becomes UNKNOWN and is never retried", async () => {
  const directory = mkdtempSync(join(tmpdir(), "social-git-security-unknown-"));
  const ledger = new LiveAuthorizationLedger(join(directory, "live-authorization.sqlite"));
  const runtime = healthyRuntime(directory);
  let calls = 0;
  try {
    const approved = grant();
    ledger.registerGrant(approved, NOW - 120_000);
    const controller = new LiveTestController(ledger);
    const evidence = await controller.execute(approved, request(), controllerOptions(
      runtime,
      new RecordingActionStore(ledger),
      async () => {
        calls += 1;
        throw new Error("lost worker response");
      }
    ));
    assert.equal(evidence.outcome, StopReason.UNKNOWN);
    assert.equal(calls, 1);
    expectCode(
      AuthorizationErrorCode.STOPPED,
      () => ledger.authorizeAndRecord(approved, request({ actionId: "action-2" }), NOW)
    );
  } finally {
    runtime.close();
    ledger.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the command is built from persisted bindings after both durable records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "social-git-security-binding-"));
  const ledger = new LiveAuthorizationLedger(join(directory, "live-authorization.sqlite"));
  const runtime = healthyRuntime(directory);
  const actionStore = new RecordingActionStore(ledger);
  try {
    const approved = grant();
    ledger.registerGrant(approved, NOW - 120_000);
    const controller = new LiveTestController(ledger);
    const evidence = await controller.execute(approved, request(), controllerOptions(
      runtime,
      actionStore,
      async (serialized) => {
        const command = decodeWorkerMessage(serialized);
        assert.equal(actionStore.started, true);
        assert.deepEqual(ledger.actionState(approved.authorizationId, "action-1"), { state: "PENDING", outcome: null });
        assert.equal(command.accountId, approved.canaryAccountId);
        assert.equal(command.platform, approved.platform);
        assert.equal(command.expectedNativeIdentity, approved.expectedNativeIdentity);
        assert.equal(command.generation, approved.sessionGeneration);
        assert.equal(command.networkRoute.id, approved.routeId);
        assert.equal(command.operation, "reddit.comment.create");
        assert.deepEqual(command.payload.resourceConstraints, Object.fromEntries(approved.resourceConstraints));
        return workerResult(serialized, LiveOutcome.SUCCEEDED, {
          nativeId: "t1_native",
          canonicalUrl: "https://www.reddit.com/r/socialgit_canary/comments/native"
        });
      }
    ));
    assert.equal(evidence.outcome, LiveOutcome.SUCCEEDED);
    assert.deepEqual(ledger.actionState(approved.authorizationId, "action-1"), { state: "SUCCEEDED", outcome: LiveOutcome.SUCCEEDED });
  } finally {
    runtime.close();
    ledger.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("secret-like and malformed worker evidence is redacted and stops on protocol drift", async () => {
  const directory = mkdtempSync(join(tmpdir(), "social-git-security-evidence-"));
  const ledger = new LiveAuthorizationLedger(join(directory, "live-authorization.sqlite"));
  const runtime = healthyRuntime(directory);
  try {
    const approved = grant();
    ledger.registerGrant(approved, NOW - 120_000);
    const controller = new LiveTestController(ledger);
    const evidence = await controller.execute(approved, request(), controllerOptions(
      runtime,
      new RecordingActionStore(ledger),
      async (serialized) => workerResult(serialized, LiveOutcome.SUCCEEDED, {
        nativeId: "session-cookie-canary",
        canonicalUrl: "https://www.reddit.com/item?token=synthetic-secret-sentinel"
      })
    ));
    assert.equal(evidence.outcome, StopReason.PROTOCOL_DRIFT);
    assert.equal(evidence.nativeId, null);
    assert.equal(evidence.canonicalUrl, null);
    assert.equal(JSON.stringify(evidence).includes("synthetic-secret-sentinel"), false);
  } finally {
    runtime.close();
    ledger.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

function healthyRuntime(directory) {
  let sequence = 0;
  const runtime = new SessionRuntime({
    databasePath: join(directory, "session-runtime.sqlite"),
    masterKey: Buffer.alloc(32, 7),
    auditKey: Buffer.alloc(32, 8),
    now: () => NOW,
    randomUUID: () => `lease-${++sequence}`
  });
  for (let generation = 1; generation <= 8; generation += 1) {
    runtime.importExternalSession({
      accountId: "account-canary-1",
      platform: "reddit",
      expectedNativeIdentity: "reddit:t2_expected",
      generation,
      session: Buffer.from("session-cookie-canary"),
      networkRoute: { id: "route-3", material: Buffer.from("route-secret-canary") }
    });
  }
  const identityCommand = runtime.acquireWorkerCommand({
    accountId: "account-canary-1",
    generation: 8,
    requestId: `identity-${sequence}`,
    intent: "identity_validation",
    operation: "reddit.identity.current"
  });
  runtime.completeWorkerResult({
    accountId: "account-canary-1",
    generation: 8,
    message: workerResult(identityCommand, LiveOutcome.SUCCEEDED)
  });
  return runtime;
}

function controllerOptions(runtime, actionStore, dispatch, overrides = {}) {
  return {
    now: NOW,
    coreActor: CORE,
    sessionRuntime: runtime,
    actionStore,
    dispatch,
    payload: { kind: "comment", postId: "post-1", text: "canary" },
    ...overrides
  };
}

function workerResult(serializedCommand, outcome, evidence = {}) {
  const command = decodeWorkerMessage(serializedCommand);
  const status = {
    [LiveOutcome.SUCCEEDED]: "SUCCEEDED",
    [StopReason.CHALLENGE]: "CHALLENGE",
    [StopReason.CHECKPOINT]: "CHECKPOINT",
    [StopReason.CAPTCHA]: "CAPTCHA",
    [StopReason.RATE_LIMIT]: "RATE_LIMITED",
    [StopReason.WRONG_IDENTITY]: "SUCCEEDED",
    [StopReason.REVOKED_SESSION]: "REVOKED",
    [StopReason.PROTOCOL_DRIFT]: "PROTOCOL_DRIFT",
    [StopReason.UNEXPECTED_REDIRECT]: "UNEXPECTED_REDIRECT",
    [StopReason.POLICY_DENIED]: "POLICY_DENIED",
    [StopReason.UNKNOWN]: "UNKNOWN"
  }[outcome];
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.result",
    requestId: command.requestId,
    tenantId: command.tenantId,
    accountId: command.accountId,
    platform: command.platform,
    generation: command.generation,
    leaseId: command.leaseId,
    fence: command.fence,
    status,
    observedNativeIdentity: outcome === StopReason.WRONG_IDENTITY
      ? "reddit:t2_wrong"
      : command.expectedNativeIdentity,
    ...evidence
  });
}

class RecordingActionStore {
  started = false;

  constructor(ledger, authorizationId = "live-auth-1") {
    this.ledger = ledger;
    this.authorizationId = authorizationId;
  }

  markSubmissionStarted(actionId) {
    assert.equal(actionId, "action-1");
    assert.deepEqual(this.ledger.actionState(this.authorizationId, actionId), { state: "PENDING", outcome: null });
    this.started = true;
  }
}
