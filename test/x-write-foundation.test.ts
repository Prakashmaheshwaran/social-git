import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  bearerAuthenticator,
  createMcpTools,
  createSocialGitHttpServer,
  LedgerStore,
  MockRedditAdapter,
  SocialGitService,
  XFixturePlatformAdapter,
} from "../src/index.ts";
import { allScopes, principal, tempDatabase } from "./helpers.ts";

const PNG = { filename: "fixture.png", mimeType: "image/png", dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64") };

test("X fixture executes the exact nine-write matrix through the durable action ledger", async () => {
  const fixture = await xFixture();
  try {
    const catalog = await fixture.service.listCapabilities(principal, fixture.accountId);
    assert.equal(catalog.details?.filter((item) => item.mode === "read").length, 16);
    assert.equal(catalog.details?.filter((item) => item.mode === "write").length, 9);
    assert.ok(catalog.details?.every((item) => item.fixtureEnabled === true && item.productionEnabled === false));

    const created = await execute(fixture, "create", { kind: "x_post_create", text: "Fixture post" });
    const postId = String((created.result as any).nativeId);
    const media = await fixture.service.createMedia(principal, fixture.accountId, PNG);
    const writes = [
      { kind: "x_reply_create", postId: "300", text: "Fixture reply" },
      { kind: "x_like_set", postId: "300", enabled: true },
      { kind: "x_repost_set", postId: "300", enabled: true },
      { kind: "x_follow_set", userNativeId: "200", enabled: true },
      { kind: "x_bookmark_set", postId: "300", enabled: true },
      { kind: "x_media_post", text: "Fixture media", mediaRef: media.media.mediaRef },
      { kind: "x_direct_message", recipientNativeId: "200", text: "Fixture message" },
      { kind: "x_post_delete", postId },
    ];
    for (const [index, write] of writes.entries()) {
      const result = await execute(fixture, `write-${index}`, write);
      assert.equal(result.state, "succeeded", write.kind);
      assert.match(String((result.result as any).nativeId), /^\d+$/u, write.kind);
    }
    assert.equal(fixture.adapter.submitCount, 9);
  } finally { fixture.store.close(); }
});

test("X writes enforce platform, input, ownership, and caller-scoped idempotency boundaries", async () => {
  const fixture = await xFixture();
  try {
    await assert.rejects(
      () => fixture.service.enqueueAction(principal, fixture.accountId, "bad-id", { kind: "x_like_set", postId: "not-native", enabled: true }, "x.actions.create"),
      (error: any) => error.code === "VALIDATION_FAILED",
    );
    const denied = await execute(fixture, "not-owned", { kind: "x_post_delete", postId: "999" });
    assert.equal(denied.state, "failed");
    assert.equal((denied.error as any).code, "OWNERSHIP_REQUIRED");
    const first = await fixture.service.enqueueAction(principal, fixture.accountId, "same-x", { kind: "x_like_set", postId: "300", enabled: true }, "x.actions.create");
    const replay = await fixture.service.enqueueAction(principal, fixture.accountId, "same-x", { enabled: true, postId: "300", kind: "x_like_set" }, "x.actions.create");
    assert.equal(replay.replayed, true);
    assert.equal(replay.action.id, first.action.id);
    await fixture.service.runNextAction();
    assert.equal(fixture.adapter.submitCount, 1);
    await assert.rejects(
      () => fixture.service.enqueueAction(principal, fixture.accountId, "same-x", { kind: "x_like_set", postId: "300", enabled: false }, "x.actions.create"),
      (error: any) => error.code === "IDEMPOTENCY_CONFLICT",
    );

    const redditStore = new LedgerStore(":memory:");
    const redditService = new SocialGitService({ store: redditStore, adapters: [new MockRedditAdapter()] });
    const reddit = await redditService.createAccount(principal, { platform: "reddit", expectedNativeUserId: "native-user-1" });
    await redditService.importConnection(principal, reddit.account.id, { vaultHandle: "fixture:reddit", generation: 1 });
    await assert.rejects(
      () => redditService.enqueueAction(principal, reddit.account.id, "cross-platform", { kind: "x_post_create", text: "no" }, "x.actions.create"),
      (error: any) => error.code === "CAPABILITY_UNAVAILABLE",
    );
    redditStore.close();
  } finally { fixture.store.close(); }
});

test("X terminal outcomes and post-submit ambiguity fail closed without automatic retry", async () => {
  for (const [outcome, expected] of [["challenge", "action_required"], ["rate_limited", "failed"], ["unknown", "UNKNOWN"], ["throw_after_submit", "UNKNOWN"]] as const) {
    const fixture = await xFixture();
    try {
      const queued = await fixture.service.enqueueAction(principal, fixture.accountId, `outcome-${outcome}`, { kind: "x_post_create", text: "bounded" }, "x.actions.create");
      fixture.adapter.setNextWriteOutcome(fixture.vaultHandle, outcome);
      const completed = await fixture.service.runNextAction();
      assert.equal(completed?.id, queued.action.id);
      assert.equal(completed?.state, expected, outcome);
      assert.equal(await fixture.service.runNextAction(), null, outcome);
      assert.equal(fixture.adapter.submitCount, 1, outcome);
      if (expected === "UNKNOWN") {
        const reconciled = await fixture.service.reconcileAction(principal, queued.action.id);
        assert.equal(reconciled.reconciled, false);
      }
    } finally { fixture.store.close(); }
  }

  const fixture = await xFixture();
  try {
    const media = await fixture.service.createMedia(principal, fixture.accountId, PNG);
    const queued = await fixture.service.enqueueAction(principal, fixture.accountId, "media-unknown", { kind: "x_media_post", text: "", mediaRef: media.media.mediaRef }, "x.actions.create");
    fixture.adapter.setNextWriteOutcome(fixture.vaultHandle, "unknown");
    assert.equal((await fixture.service.runNextAction())?.state, "UNKNOWN");
    assert.equal(fixture.store.getActionInternal(queued.action.id).submissionMayHaveStarted, true);
    assert.equal(await fixture.service.runNextAction(), null);
  } finally { fixture.store.close(); }
});

test("X crash-after-submit recovers as durable UNKNOWN without a second submit", async () => {
  const database = tempDatabase();
  const vaultHandle = "fixture:x:restart";
  const adapter = new XFixturePlatformAdapter();
  adapter.stageSession({ vaultHandle, nativeIdentity: "100" });
  let store = new LedgerStore(database.path);
  let service = new SocialGitService({ store, adapters: [adapter] });
  try {
    const { account } = await service.createAccount(principal, { platform: "x", expectedNativeUserId: "100" });
    await service.importConnection(principal, account.id, { vaultHandle, generation: 1 });
    const queued = await service.enqueueAction(principal, account.id, "restart-x", { kind: "x_post_create", text: "uncertain" }, "x.actions.create");
    await assert.rejects(() => service.runNextAction({ crashAfterSubmit: true }), /simulated crash after adapter returned/u);
    assert.equal(adapter.submitCount, 1);
    store.close();
    store = new LedgerStore(database.path);
    service = new SocialGitService({ store, adapters: [adapter] });
    assert.equal(service.startupRecovery.unknown, 1);
    assert.equal((await service.getAction(principal, queued.action.id)).action.state, "UNKNOWN");
    assert.equal(await service.runNextAction(), null);
    assert.equal(adapter.submitCount, 1);
  } finally {
    store.close();
    database.cleanup();
  }
});

test("REST, OpenAPI, and MCP expose one consistent X durable action operation", async () => {
  const fixture = await xFixture();
  const server = createSocialGitHttpServer({ service: fixture.service, authenticate: bearerAuthenticator(new Map([["x-write-token", principal]])) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const spec = await (await fetch(`${base}/openapi.json`)).json() as any;
    assert.equal(spec.paths["/v1/accounts/{accountId}/x/actions"].post.operationId, "x.actions.create");
    const first = await request(base, `/v1/accounts/${fixture.accountId}/x/actions`, {
      headers: { "idempotency-key": "rest-x-write" }, body: { kind: "x_like_set", postId: "300", enabled: true },
    });
    assert.equal(first.status, 202);
    assert.equal(first.body.action.state, "queued");
    const replay = await request(base, `/v1/accounts/${fixture.accountId}/x/actions`, {
      headers: { "idempotency-key": "rest-x-write" }, body: { kind: "x_like_set", postId: "300", enabled: true },
    });
    assert.equal(replay.body.replayed, true);
    const tool = createMcpTools(fixture.service).find((candidate) => candidate.name === "x_action_create");
    assert.ok(tool);
    const result = await tool.call({ accountId: fixture.accountId, idempotencyKey: "mcp-x-write", action: { kind: "x_follow_set", userNativeId: "200", enabled: true } }, { principal });
    assert.equal(result.isError, false);
  } finally {
    server.close();
    await once(server, "close");
    fixture.store.close();
  }
});

async function xFixture() {
  const vaultHandle = "fixture:x:writes";
  const store = new LedgerStore(":memory:");
  const adapter = new XFixturePlatformAdapter();
  adapter.stageSession({ vaultHandle, nativeIdentity: "100" });
  const service = new SocialGitService({ store, adapters: [adapter] });
  const { account } = await service.createAccount(principal, { platform: "x", expectedNativeUserId: "100" });
  await service.importConnection(principal, account.id, { vaultHandle, generation: 1 });
  return { adapter, store, service, accountId: account.id, vaultHandle };
}

async function execute(fixture: Awaited<ReturnType<typeof xFixture>>, key: string, action: Record<string, unknown>) {
  const queued = await fixture.service.enqueueAction(principal, fixture.accountId, key, action, "x.actions.create");
  const completed = await fixture.service.runNextAction();
  assert.equal(completed?.id, queued.action.id);
  return completed!;
}

async function request(base: string, path: string, options: { headers?: Record<string, string>; body: unknown }) {
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { authorization: "Bearer x-write-token", "content-type": "application/json", ...options.headers }, body: JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() as any };
}
