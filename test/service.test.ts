import assert from "node:assert/strict";
import test from "node:test";
import { LedgerStore, MockRedditAdapter, ServiceError, SocialGitService } from "../src/index.ts";
import { allScopes, fixture, principal, tempDatabase, writeRequests } from "./helpers.ts";

test("auth: scopes and policy hooks fail closed", async () => {
  const decisions: string[] = [];
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({
    store,
    adapters: [new MockRedditAdapter()],
    authorizer: { authorize(input) { decisions.push(input.operationId); if (!input.principal.scopes.includes(input.scope)) throw new ServiceError("FORBIDDEN", "Denied by policy."); } },
  });
  await assert.rejects(() => service.createAccount({ callerId: "caller", scopes: [] }, { platform: "reddit", expectedNativeUserId: "native-user-1" }), (error: any) => error.code === "FORBIDDEN");
  assert.deepEqual(decisions, ["accounts.create"]);
  store.close();
});

test("identity: connection import and every read verify the native account binding", async () => {
  const adapter = new MockRedditAdapter("wrong-user");
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [adapter] });
  const { account } = await service.createAccount(principal, { platform: "reddit", expectedNativeUserId: "native-user-1" });
  await assert.rejects(() => service.importConnection(principal, account.id, { vaultHandle: "vault://wrong", generation: 1 }), (error: any) => error.code === "IDENTITY_MISMATCH");
  assert.equal(store.getAccount(account.id).status, "suspended");
  store.close();
});

test("reads: mock adapter supplies every Reddit read with native identifiers and canonical URLs", async () => {
  const { service, store, accountId } = await fixture();
  const results = [
    await service.read(principal, accountId, "reads.profile", { kind: "profile" }),
    await service.read(principal, accountId, "reads.subreddit", { kind: "subreddit", subreddit: "test" }),
    await service.read(principal, accountId, "reads.feed", { kind: "feed", limit: 2 }),
    await service.read(principal, accountId, "reads.post", { kind: "post", postId: "post-1" }),
    await service.read(principal, accountId, "reads.comments", { kind: "comments", postId: "post-1", limit: 2 }),
    await service.read(principal, accountId, "reads.search", { kind: "search", query: "contract", limit: 2 }),
  ] as any[];
  for (const result of results) {
    const entities = result.items ?? [result];
    for (const entity of entities) {
      assert.equal(typeof entity.nativeId, "string");
      assert.match(entity.canonicalUrl, /^https:\/\/www\.reddit\.com\//);
    }
  }
  assert.equal(JSON.stringify(results).includes("vault://"), false);
  store.close();
});

test("adapter boundary: library objects and unsafe diagnostics never enter public results", async () => {
  const { service, store, adapter, accountId } = await fixture();
  adapter.read = async () => ({
    nativeId: "post-safe",
    canonicalUrl: "https://www.reddit.com/comments/post-safe/",
    title: "Safe title",
    cookie: "session=must-not-return",
    internalClient: { transport: "library-object" },
  });
  const read = await service.read(principal, accountId, "reads.post", { kind: "post", postId: "post-safe" }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(read).sort(), ["canonicalUrl", "nativeId", "title"]);
  assert.equal(JSON.stringify(read).includes("must-not-return"), false);
  adapter.submit = async () => ({ status: "failed", code: "PLATFORM_REJECTED", message: "cookie=must-not-persist token=also-secret" });
  await service.enqueueAction(principal, accountId, "unsafe-error", { kind: "save", targetId: "post-safe" });
  const failed = await service.runNextAction();
  assert.equal(failed?.state, "failed");
  assert.equal(JSON.stringify(failed).includes("must-not-persist"), false);
  assert.equal(JSON.stringify(store.listAuditEvents({ limit: 100 })).includes("also-secret"), false);
  store.close();
});

test("writes: mock adapter proves every planned Reddit write shape", async () => {
  const { service, store, adapter, accountId } = await fixture();
  for (const [index, request] of writeRequests.entries()) {
    const queued = await service.enqueueAction(principal, accountId, `write-${index}`, request);
    assert.equal(queued.action.state, "queued");
    const completed = await service.runNextAction();
    assert.equal(completed?.state, "succeeded");
    assert.equal(typeof (completed?.result as any).nativeId, "string");
    assert.match((completed?.result as any).canonicalUrl, /^https:\/\/www\.reddit\.com\//);
  }
  assert.deepEqual(adapter.seenWriteKinds, writeRequests.map((request) => request.kind));
  store.close();
});

test("idempotency: keys are durable, caller scoped, and content bound", async () => {
  const { service, store, accountId } = await fixture();
  const first = await service.enqueueAction(principal, accountId, "same-key", { kind: "save", targetId: "post-1" });
  const replay = await service.enqueueAction(principal, accountId, "same-key", { targetId: "post-1", kind: "save" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.action.id, first.action.id);
  await assert.rejects(() => service.enqueueAction(principal, accountId, "same-key", { kind: "unsave", targetId: "post-1" }), (error: any) => error.code === "IDEMPOTENCY_CONFLICT");
  const otherCaller = { callerId: "caller-b", scopes: allScopes };
  const other = await service.enqueueAction(otherCaller, accountId, "same-key", { kind: "save", targetId: "post-1" });
  assert.notEqual(other.action.id, first.action.id);
  await assert.rejects(() => service.getAction(otherCaller, first.action.id), (error: any) => error.code === "NOT_FOUND");
  store.close();
});

test("pagination: account and audit cursors are opaque, stable, and bounded", async () => {
  const { service, store } = await fixture();
  await service.createAccount(principal, { platform: "reddit", expectedNativeUserId: "native-user-2" });
  await service.createAccount(principal, { platform: "reddit", expectedNativeUserId: "native-user-3" });
  const first = await service.listAccounts(principal, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(typeof first.nextCursor, "string");
  const second = await service.listAccounts(principal, { limit: 2, cursor: first.nextCursor! });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  const auditFirst = await service.listAuditEvents(principal, { limit: 2 });
  const auditSecond = await service.listAuditEvents(principal, { limit: 100, cursor: auditFirst.nextCursor! });
  assert.equal(new Set([...auditFirst.items, ...auditSecond.items].map((item) => item.id)).size, auditFirst.items.length + auditSecond.items.length);
  await assert.rejects(() => service.listAccounts(principal, { limit: 2, cursor: "not-a-cursor" }), (error: any) => error.code === "VALIDATION_FAILED");
  store.close();
});

test("restart: queued actions and idempotency records survive process restart", async () => {
  const database = tempDatabase();
  try {
    const first = await fixture({ path: database.path });
    const queued = await first.service.enqueueAction(principal, first.accountId, "restart-key", { kind: "save", targetId: "post-1" });
    first.store.close();
    const store = new LedgerStore(database.path);
    const service = new SocialGitService({ store, adapters: [first.adapter] });
    const replay = await service.enqueueAction(principal, first.accountId, "restart-key", { kind: "save", targetId: "post-1" });
    assert.equal(replay.action.id, queued.action.id);
    assert.equal(replay.action.state, "queued");
    assert.equal((await service.runNextAction())?.state, "succeeded");
    store.close();
  } finally { database.cleanup(); }
});

test("crash-after-submit: restart marks the action UNKNOWN and never retries automatically", async () => {
  const database = tempDatabase();
  try {
    const first = await fixture({ path: database.path });
    const queued = await first.service.enqueueAction(principal, first.accountId, "crash-key", { kind: "comment", postId: "post-1", text: "once" });
    await assert.rejects(() => first.service.runNextAction({ crashAfterSubmit: true }), /simulated crash/);
    assert.equal(first.adapter.submitCount, 1);
    first.store.close();
    const store = new LedgerStore(database.path);
    const service = new SocialGitService({ store, adapters: [first.adapter] });
    assert.deepEqual(service.startupRecovery, { requeued: 0, unknown: 1 });
    assert.equal((await service.getAction(principal, queued.action.id)).action.state, "UNKNOWN");
    assert.equal(await service.runNextAction(), null);
    assert.equal(first.adapter.submitCount, 1);
    first.adapter.setReconciliation(queued.action.id, { status: "confirmed", result: { nativeId: "comment-confirmed", canonicalUrl: "https://www.reddit.com/comments/post-1/_/comment-confirmed/" } });
    const reconciled = await service.reconcileAction(principal, queued.action.id);
    assert.equal(reconciled.action.state, "succeeded");
    assert.equal(first.adapter.submitCount, 1);
    store.close();
  } finally { database.cleanup(); }
});

test("action states: challenge, failure, rate limit, and unknown are normalized without retry", async () => {
  for (const [mode, expected] of [["action_required", "action_required"], ["failed", "failed"], ["rate_limited", "failed"], ["unknown", "UNKNOWN"]] as const) {
    const { service, store, adapter, accountId } = await fixture();
    adapter.mode = mode;
    await service.enqueueAction(principal, accountId, `state-${mode}`, { kind: "vote", targetId: "post-1", direction: 1 });
    const result = await service.runNextAction();
    assert.equal(result?.state, expected);
    assert.equal(adapter.submitCount, 1);
    if (mode === "rate_limited") assert.equal((result?.error as any).rateLimit.retryAfterSeconds, 60);
    store.close();
  }
});

test("revocation: a revoked session stops all later reads and writes", async () => {
  const { service, store, accountId } = await fixture();
  const revoked = await service.revokeAccount(principal, accountId, { reason: "owner request" });
  assert.equal(revoked.connection.status, "revoked");
  await assert.rejects(() => service.read(principal, accountId, "reads.profile", { kind: "profile" }), (error: any) => error.code === "SESSION_REVOKED");
  await assert.rejects(() => service.enqueueAction(principal, accountId, "after-revoke", { kind: "save", targetId: "post-1" }), (error: any) => error.code === "SESSION_REVOKED");
  store.close();
});

test("audit: payloads are bounded and do not retain oversized detail", () => {
  const store = new LedgerStore(":memory:");
  store.audit({ callerId: "caller", type: "redacted.event", outcome: "failed", data: { token: "must-not-persist", safe: "visible" } });
  store.audit({ callerId: "caller", type: "large.event", outcome: "failed", data: { items: Array.from({ length: 50 }, () => ({ detail: "x".repeat(1000) })) } });
  const events = store.listAuditEvents({ limit: 10 }).items;
  assert.equal((events[0]!.data as any).token, "[REDACTED]");
  assert.equal(JSON.stringify(events).includes("must-not-persist"), false);
  const event = events[1]!;
  assert.deepEqual(Object.keys(event.data as object).sort(), ["originalBytes", "sha256", "truncated"]);
  assert.equal((event.data as any).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(event.data)) < 4096);
  store.close();
});
