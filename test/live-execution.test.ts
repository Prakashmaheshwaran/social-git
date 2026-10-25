import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRuntime, decodeWorkerMessage, encodeWorkerMessage } from "@social-git/core";
import {
  LiveAuthorizationLedger,
  LiveOutcome,
  Permission,
  Role,
  RoleAuthority,
  StopReason,
  approveLiveTestGrant,
  assertPermission,
  type LiveTestGrant,
} from "@social-git/security";
import {
  BoundedLiveActionExecutor,
  LedgerStore,
  MockRedditAdapter,
  SocialGitService,
} from "../src/index.ts";
import { allScopes, principal } from "./helpers.ts";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const ARTIFACT = `sha256:${"a".repeat(64)}`;
const SBOM = `sha256:${"b".repeat(64)}`;
const TEST_EVIDENCE = `sha256:${"c".repeat(64)}`;
const AUTHORITY = new RoleAuthority([
  { actorId: "qa-live", role: Role.INDEPENDENT_LIVE_QA },
  { actorId: "security-review", role: Role.SECURITY_REVIEWER },
  { actorId: "core-runtime", role: Role.CORE_RUNTIME },
]);
const QA = AUTHORITY.principalFor("qa-live");
const APPROVER = AUTHORITY.principalFor("security-review");
const CORE = AUTHORITY.principalFor("core-runtime");

test("integrated live write records both ledgers before a trusted fenced command leases secrets", async () => {
  const fixture = await integratedFixture();
  try {
    let dispatched = 0;
    const executor = fixture.executor(async (...args) => {
      dispatched += 1;
      assert.equal(args.length, 1);
      const command = decodeWorkerMessage(args[0]);
      const action = fixture.store.getActionInternal(fixture.actionId);
      assert.equal(action.submissionMayHaveStarted, true);
      assert.deepEqual(
        fixture.authorizationLedger.actionState(fixture.grant.authorizationId, fixture.actionId),
        { state: "PENDING", outcome: null },
      );
      assert.equal(command.type, "social-git.worker.command");
      assert.equal(command.accountId, fixture.accountId);
      assert.equal(command.platform, "reddit");
      assert.equal(command.generation, 1);
      assert.equal(command.expectedNativeIdentity, "reddit:t2_expected");
      assert.equal(command.networkRoute.id, "route-canary");
      assert.equal(command.operation, "reddit.comment.create");
      assert.deepEqual(command.payload, {
        action: { kind: "comment", postId: "post-1", text: "canary comment" },
        resourceConstraints: { max_body_bytes: "256", post_id: "post-1" },
      });
      return resultFor(args[0], "SUCCEEDED", {
        nativeId: "t1_integrated",
        canonicalUrl: "https://www.reddit.com/comments/post-1/_/t1_integrated/",
      });
    });
    const service = fixture.service(executor, false);
    const completed = await service.runNextAction();
    assert.equal(dispatched, 1);
    assert.equal(completed?.state, "succeeded");
    assert.deepEqual(completed?.result, {
      nativeId: "t1_integrated",
      canonicalUrl: "https://www.reddit.com/comments/post-1/_/t1_integrated/",
    });
    assert.deepEqual(
      fixture.authorizationLedger.actionState(fixture.grant.authorizationId, fixture.actionId),
      { state: "SUCCEEDED", outcome: LiveOutcome.SUCCEEDED },
    );
    assert.equal(JSON.stringify(completed).includes("session-cookie-sentinel"), false);
  } finally {
    fixture.close();
  }
});

test("optional certification grants claim only their canary lane while normal product writes continue", async () => {
  const fixture = await integratedFixture({ actionLimit: 3 });
  try {
    let certificationDispatches = 0;
    const executor = fixture.executor(async (command) => {
      certificationDispatches += 1;
      return resultFor(command, "SUCCEEDED", {
        nativeId: "t1_certified",
        canonicalUrl: "https://www.reddit.com/comments/post-1/_/t1_certified/",
      });
    });
    const service = fixture.service(executor, false);
    const { account: productAccount } = await service.createAccount(principal, {
      platform: "reddit",
      expectedNativeUserId: "reddit:t2_expected",
    });
    await service.importConnection(principal, productAccount.id, { vaultHandle: "vault://product", generation: 1 });
    const product = await service.enqueueAction(principal, productAccount.id, "product-vote", {
      kind: "vote", targetId: "t3_product", direction: 1,
    });

    assert.equal(executor.route(fixture.store.getActionInternal(fixture.actionId)), "certification");
    assert.equal(executor.route(fixture.store.getActionInternal(product.action.id)), "product");
    assert.equal(executor.route({
      ...fixture.store.getActionInternal(fixture.actionId),
      request: { kind: "comment", postId: "post-outside-grant", text: "must be denied" },
    }), "deny");
    assert.equal(executor.route({
      ...fixture.store.getActionInternal(product.action.id),
      accountId: "x-account",
      kind: "x_post_create",
      request: { kind: "x_post_create", text: "not a Reddit grant action" },
    }), "product");

    assert.equal((await service.runNextAction())?.state, "succeeded");
    assert.equal((await service.runNextAction())?.state, "succeeded");
    assert.equal(certificationDispatches, 1);
    assert.equal(fixture.adapter.submitCount, 1);
    assert.deepEqual(fixture.adapter.seenWriteKinds, ["vote"]);

    const canaryViolation = await service.enqueueAction(principal, fixture.accountId, "canary-outside-grant", {
      kind: "vote", targetId: "t3_canary", direction: 1,
    });
    assert.equal(executor.route(fixture.store.getActionInternal(canaryViolation.action.id)), "deny");
    const denied = await service.runNextAction();
    assert.equal(denied?.state, "failed");
    assert.equal(fixture.adapter.submitCount, 1, "a canary grant violation must not fall through to the product adapter");
    assert.equal(certificationDispatches, 1);
  } finally {
    fixture.close();
  }
});

test("integrated live media persists each real worker phase and the submit boundary", async () => {
  const fixture = await integratedFixture({ media: true });
  try {
    const operations: string[] = [];
    const executeCommand = async (serialized: Uint8Array) => {
      const command = decodeWorkerMessage(serialized);
      assert.equal(command.type, "social-git.worker.command");
      const payload = command.payload as any;
      operations.push(command.operation);
      const flow = fixture.store.db.prepare("SELECT phase FROM media_action_flows WHERE action_id=?").get(fixture.actionId) as any;
      const expectedPhase: Record<string, string> = {
        "reddit.post.media.lease": "reserved",
        "reddit.post.media.upload": "leased",
        "reddit.post.media.submit": "submitting",
        "reddit.post.media.process": "submitted",
      };
      assert.equal(flow.phase, expectedPhase[command.operation]);
      assert.equal(
        fixture.store.getActionInternal(fixture.actionId).submissionMayHaveStarted,
        ["reddit.post.media.submit", "reddit.post.media.process"].includes(command.operation),
      );
      if (command.operation === "reddit.post.media.lease") {
        assert.equal(payload.filename, "canary.png");
        return { message: resultFor(serialized, "SUCCEEDED"), platformResult: { native: null, data: { ticket: "live-ticket" } } };
      }
      if (command.operation === "reddit.post.media.upload") {
        assert.equal(payload.ticket, "live-ticket");
        assert.equal(Buffer.from(payload.dataBase64, "base64").length, 12);
        return { message: resultFor(serialized, "SUCCEEDED"), platformResult: { native: null, data: { ticket: "live-ticket" } } };
      }
      if (command.operation === "reddit.post.media.submit") {
        assert.deepEqual(payload, { ticket: "live-ticket", subreddit: "test", title: "Canary media" });
        return { message: resultFor(serialized, "SUCCEEDED"), platformResult: { native: null, data: { ticket: "live-ticket" } } };
      }
      assert.equal(command.operation, "reddit.post.media.process");
      const native = {
        nativeId: "t3_media_canary",
        canonicalUrl: "https://www.reddit.com/r/test/comments/media_canary/title/",
      };
      return { message: resultFor(serialized, "SUCCEEDED", native), platformResult: { native, data: { created: true } } };
    };
    const service = fixture.service(fixture.executor(
      async () => { throw new Error("the complete media command must not be dispatched"); },
      executeCommand,
    ), false);
    const completed = await service.runNextAction();
    assert.equal(completed?.state, "succeeded");
    assert.deepEqual(operations, [
      "reddit.post.media.lease",
      "reddit.post.media.upload",
      "reddit.post.media.submit",
      "reddit.post.media.process",
    ]);
    const flow = fixture.store.db.prepare("SELECT phase FROM media_action_flows WHERE action_id=?").get(fixture.actionId) as any;
    assert.equal(flow.phase, "processed");
  } finally {
    fixture.close();
  }
});

test("integrated live media makes processing loss UNKNOWN without a second submit", async () => {
  const fixture = await integratedFixture({ media: true });
  try {
    const operations: string[] = [];
    const executeCommand = async (serialized: Uint8Array) => {
      const command = decodeWorkerMessage(serialized);
      assert.equal(command.type, "social-git.worker.command");
      operations.push(command.operation);
      if (command.operation === "reddit.post.media.process") {
        return { message: resultFor(serialized, "UNKNOWN"), error: new Error("processing disconnected") };
      }
      return { message: resultFor(serialized, "SUCCEEDED"), platformResult: { native: null, data: { ticket: "live-ticket" } } };
    };
    const service = fixture.service(fixture.executor(
      async () => { throw new Error("the complete media command must not be dispatched"); },
      executeCommand,
    ), false);
    assert.equal((await service.runNextAction())?.state, "UNKNOWN");
    assert.equal(operations.filter((operation) => operation === "reddit.post.media.submit").length, 1);
    assert.equal(await service.runNextAction(), null);
    assert.equal(operations.filter((operation) => operation === "reddit.post.media.submit").length, 1);
    const flow = fixture.store.db.prepare("SELECT phase FROM media_action_flows WHERE action_id=?").get(fixture.actionId) as any;
    assert.equal(flow.phase, "submitted");
  } finally {
    fixture.close();
  }
});

test("two-restart crash recovery makes both ledgers UNKNOWN and blocks every later grant action", async () => {
  const fixture = await integratedFixture({ actionLimit: 3 });
  const databasePaths = fixture.paths;
  let dispatched = 0;
  try {
    const service = fixture.service(fixture.executor(async () => {
      dispatched += 1;
      throw new Error("dispatch must not start");
    }), false);
    await assert.rejects(
      () => service.runNextAction({ crashAfterRecord: true }),
      /simulated crash after live authorization record/,
    );
    assert.equal(dispatched, 0);
    assert.equal(fixture.store.getActionInternal(fixture.actionId).submissionMayHaveStarted, false);
  } finally {
    fixture.close(false);
  }

  const firstRecoveryLedger = new LiveAuthorizationLedger(databasePaths.authorization);
  try {
    assert.deepEqual(firstRecoveryLedger.startupRecovery, { unknown: 1 });
    assert.deepEqual(
      firstRecoveryLedger.actionState(fixture.grant.authorizationId, fixture.actionId),
      { state: "UNKNOWN", outcome: StopReason.UNKNOWN },
    );
    assert.deepEqual(firstRecoveryLedger.unknownActionIds("action-ledger-1"), [fixture.actionId]);
  } finally {
    firstRecoveryLedger.close();
  }

  const store = new LedgerStore(databasePaths.action, { ledgerId: "action-ledger-1" });
  const authorizationLedger = new LiveAuthorizationLedger(databasePaths.authorization);
  const sessionRuntime = sessionRuntimeFor(databasePaths.session, false);
  const adapter = new MockRedditAdapter("reddit:t2_expected");
  try {
    const recoveredGrant = approvedGrant(fixture.accountId, 3);
    const executor = new BoundedLiveActionExecutor({
      ledger: authorizationLedger,
      grant: recoveredGrant,
      executor: QA,
      coreActor: CORE,
      sessionRuntime,
      deployment: deploymentEvidence(),
      now: () => NOW,
      dispatch: async () => {
        dispatched += 1;
        throw new Error("stopped authorization must not dispatch");
      },
    });
    const service = new SocialGitService({ store, adapters: [adapter], liveActionExecutor: executor });
    assert.deepEqual(authorizationLedger.startupRecovery, { unknown: 0 });
    assert.deepEqual(authorizationLedger.unknownActionIds("action-ledger-1"), [fixture.actionId]);
    assert.deepEqual(service.startupRecovery, { requeued: 0, unknown: 1 });
    assert.equal((await service.getAction(principal, fixture.actionId)).action.state, "UNKNOWN");

    for (const suffix of ["one", "two"]) {
      const later = await service.enqueueAction(
        { callerId: principal.callerId, scopes: allScopes },
        fixture.accountId,
        `after-crash-${suffix}`,
        { kind: "comment", postId: "post-1", text: "must not dispatch" },
      );
      const stopped = await service.runNextAction();
      assert.equal(later.action.state, "queued");
      assert.equal(stopped?.state, "action_required");
    }
    assert.equal(dispatched, 0);
  } finally {
    sessionRuntime.close();
    authorizationLedger.close();
    store.close();
    rmSync(databasePaths.root, { recursive: true, force: true });
  }
});

test("secret-like, oversized, and non-canonical worker evidence is discarded", async () => {
  const cases = [
    { nativeId: "session-cookie-sentinel", canonicalUrl: "https://www.reddit.com/item?token=secret-sentinel" },
    { nativeId: "x".repeat(129), canonicalUrl: "https://www.reddit.com/item/" },
    { nativeId: "t1_safe", canonicalUrl: "https://example.com/not-canonical" },
  ];
  for (const evidence of cases) {
    const fixture = await integratedFixture();
    try {
      const service = fixture.service(fixture.executor(async (command) => resultFor(command, "SUCCEEDED", evidence)), false);
      const completed = await service.runNextAction();
      assert.equal(completed?.state, "failed");
      assert.equal((completed?.error as { code?: string }).code, StopReason.PROTOCOL_DRIFT);
      const persisted = JSON.stringify({
        action: fixture.store.getActionInternal(fixture.actionId),
        audit: fixture.store.listAuditEvents({ limit: 100 }),
      });
      assert.equal(persisted.includes("secret-sentinel"), false);
      assert.equal(persisted.includes("session-cookie-sentinel"), false);
      assert.equal(persisted.includes("example.com"), false);
      assert.equal(persisted.includes("x".repeat(129)), false);
    } finally {
      fixture.close();
    }
  }
});

test("every terminal live worker outcome stops the persisted grant and later actions", async () => {
  const outcomes = [
    [StopReason.CHALLENGE, "CHALLENGE"],
    [StopReason.CHECKPOINT, "CHECKPOINT"],
    [StopReason.CAPTCHA, "CAPTCHA"],
    [StopReason.RATE_LIMIT, "RATE_LIMITED"],
    [StopReason.WRONG_IDENTITY, "SUCCEEDED"],
    [StopReason.REVOKED_SESSION, "REVOKED"],
    [StopReason.PROTOCOL_DRIFT, "PROTOCOL_DRIFT"],
    [StopReason.UNEXPECTED_REDIRECT, "UNEXPECTED_REDIRECT"],
    [StopReason.POLICY_DENIED, "POLICY_DENIED"],
    [StopReason.UNKNOWN, "UNKNOWN"],
  ] as const;

  for (const [outcome, status] of outcomes) {
    const fixture = await integratedFixture({ authorizationId: `live-${outcome.toLowerCase()}`, actionLimit: 2 });
    try {
      let dispatches = 0;
      const service = fixture.service(fixture.executor(async (command) => {
        dispatches += 1;
        return resultFor(command, status, {}, outcome === StopReason.WRONG_IDENTITY ? "reddit:t2_wrong" : undefined);
      }), false);
      const first = await service.runNextAction();
      assert.equal(dispatches, 1);
      assert.equal(
        fixture.authorizationLedger.actionState(fixture.grant.authorizationId, fixture.actionId)?.outcome,
        outcome,
      );
      assert.equal(first?.state, outcome === StopReason.UNKNOWN ? "UNKNOWN"
        : ([StopReason.CHALLENGE, StopReason.CHECKPOINT, StopReason.CAPTCHA, StopReason.WRONG_IDENTITY, StopReason.REVOKED_SESSION] as readonly string[]).includes(outcome)
          ? "action_required" : "failed");

      await service.enqueueAction(principal, fixture.accountId, `later-${outcome}`, {
        kind: "comment", postId: "post-1", text: "later",
      });
      const later = await service.runNextAction();
      assert.equal(later?.state, "action_required", `later action after ${outcome}: ${JSON.stringify(later)}`);
      assert.equal(dispatches, 1);
    } finally {
      fixture.close();
    }
  }
});

async function integratedFixture(options: { authorizationId?: string; actionLimit?: number; media?: boolean } = {}) {
  const root = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-integrated-"));
  const paths = {
    root,
    action: join(root, "actions.sqlite"),
    authorization: join(root, "authorization.sqlite"),
    session: join(root, "sessions.sqlite"),
  };
  const store = new LedgerStore(paths.action, { ledgerId: "action-ledger-1" });
  const adapter = new MockRedditAdapter("reddit:t2_expected");
  const setupService = new SocialGitService({ store, adapters: [adapter], recoverOnStart: false });
  const { account } = await setupService.createAccount(principal, {
    platform: "reddit",
    expectedNativeUserId: "reddit:t2_expected",
  });
  await setupService.importConnection(principal, account.id, { vaultHandle: "vault://canary", generation: 1 });
  const media = options.media ? await setupService.createMedia(principal, account.id, {
    filename: "canary.png",
    mimeType: "image/png",
    dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64"),
  }) : null;
  const queued = await setupService.enqueueAction(principal, account.id, "live-action", options.media ? {
    kind: "media_post", subreddit: "test", title: "Canary media", mediaRef: media!.media.mediaRef,
  } : {
    kind: "comment", postId: "post-1", text: "canary comment",
  });
  const sessionRuntime = sessionRuntimeFor(paths.session, true, account.id);
  const authorizationLedger = new LiveAuthorizationLedger(paths.authorization);
  const grant = options.media
    ? approvedMediaGrant(account.id, media!.media.mediaRef, options.actionLimit ?? 2, options.authorizationId)
    : approvedGrant(account.id, options.actionLimit ?? 2, options.authorizationId);
  authorizationLedger.registerGrant(grant, NOW - 120_000);

  const executor = (
    dispatch: (command: Uint8Array) => Promise<string | Uint8Array> | string | Uint8Array,
    executeCommand?: (command: Uint8Array) => Promise<{ message: Uint8Array; platformResult?: any; error?: any }>,
  ) => new BoundedLiveActionExecutor({
    ledger: authorizationLedger,
    grant,
    executor: QA,
    coreActor: CORE,
    sessionRuntime,
    deployment: deploymentEvidence(),
    dispatch,
    ...(executeCommand ? { executeCommand } : {}),
    now: () => NOW,
  });

  return {
    paths,
    store,
    adapter,
    accountId: account.id,
    actionId: queued.action.id,
    mediaRef: media?.media.mediaRef,
    sessionRuntime,
    authorizationLedger,
    grant,
    executor,
    service: (liveActionExecutor: BoundedLiveActionExecutor, recoverOnStart = false) => new SocialGitService({
      store, adapters: [adapter], liveActionExecutor, recoverOnStart,
    }),
    close(cleanup = true) {
      sessionRuntime.close();
      authorizationLedger.close();
      store.close();
      if (cleanup) rmSync(root, { recursive: true, force: true });
    },
  };
}

function approvedMediaGrant(accountId: string, mediaRef: string, actionLimit: number, authorizationId = "live-auth-media"): LiveTestGrant {
  return approveLiveTestGrant({
    authorizationId,
    ledgerId: "action-ledger-1",
    environment: "production-canary",
    artifactDigest: ARTIFACT,
    sbomDigest: SBOM,
    testEvidenceDigest: TEST_EVIDENCE,
    canaryAccountId: accountId,
    expectedNativeIdentity: "reddit:t2_expected",
    sessionGeneration: 1,
    routeId: "route-canary",
    readOperations: [],
    writeOperations: ["reddit.post.media.create"],
    resourceConstraints: { max_title_bytes: "64", media_ref: mediaRef, subreddit: "test" },
    cleanupOperation: "reddit.post.media.create",
    actionLimit,
    notBefore: NOW - 60_000,
    expiresAt: NOW + 600_000,
  }, { qaOperator: QA, approver: APPROVER });
}

function approvedGrant(accountId: string, actionLimit: number, authorizationId = "live-auth-integrated"): LiveTestGrant {
  assertPermission(CORE, Permission.CONSUME_LIVE_AUTHORIZATION);
  return approveLiveTestGrant({
    authorizationId,
    ledgerId: "action-ledger-1",
    environment: "production-canary",
    artifactDigest: ARTIFACT,
    sbomDigest: SBOM,
    testEvidenceDigest: TEST_EVIDENCE,
    canaryAccountId: accountId,
    expectedNativeIdentity: "reddit:t2_expected",
    sessionGeneration: 1,
    routeId: "route-canary",
    readOperations: [],
    writeOperations: ["reddit.comment.create"],
    resourceConstraints: { max_body_bytes: "256", post_id: "post-1" },
    cleanupOperation: "reddit.comment.create",
    actionLimit,
    notBefore: NOW - 60_000,
    expiresAt: NOW + 600_000,
  }, { qaOperator: QA, approver: APPROVER });
}

function deploymentEvidence() {
  return {
    environment: "production-canary",
    artifactDigest: ARTIFACT,
    sbomDigest: SBOM,
    testEvidenceDigest: TEST_EVIDENCE,
  };
}

function sessionRuntimeFor(path: string, initialize: boolean, accountId?: string) {
  let sequence = 0;
  const runtime = new SessionRuntime({
    databasePath: path,
    masterKey: Buffer.alloc(32, 9),
    auditKey: Buffer.alloc(32, 10),
    now: () => NOW,
    randomUUID: () => `lease-${++sequence}`,
  });
  if (initialize) {
    runtime.importExternalSession({
      accountId: accountId!,
      platform: "reddit",
      expectedNativeIdentity: "reddit:t2_expected",
      generation: 1,
      session: Buffer.from("session-cookie-sentinel"),
      networkRoute: { id: "route-canary", material: Buffer.from("route-secret-sentinel") },
    });
    const command = runtime.acquireWorkerCommand({
      accountId: accountId!, generation: 1, requestId: "identity-bootstrap",
      intent: "identity_validation", operation: "reddit.identity.current",
    });
    runtime.completeWorkerResult({
      accountId: accountId!, generation: 1,
      message: resultFor(command, "SUCCEEDED"),
    });
  }
  return runtime;
}

function resultFor(
  serializedCommand: Uint8Array,
  status: string,
  evidence: { nativeId?: string; canonicalUrl?: string } = {},
  observedNativeIdentity?: string,
) {
  const command = decodeWorkerMessage(serializedCommand);
  if (command.type !== "social-git.worker.command") throw new Error("expected a worker command");
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
    observedNativeIdentity: observedNativeIdentity ?? command.expectedNativeIdentity,
    ...evidence,
  } as Parameters<typeof encodeWorkerMessage>[0]);
}
