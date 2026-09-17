import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { bearerAuthenticator, createMcpTools, createSocialGitHttpServer, DisabledXPlatformAdapter, LedgerStore, SocialGitService, XFixturePlatformAdapter } from "../src/index.ts";
import { allScopes, principal } from "./helpers.ts";

test("X fixture adapter preserves account binding and exposes exact admission matrix", async () => {
  const store = new LedgerStore(":memory:");
  const adapter = new XFixturePlatformAdapter();
  const service = new SocialGitService({ store, adapters: [adapter] });
  adapter.stageSession({ vaultHandle: "fixture:x:one", nativeIdentity: "100" });
  const { account } = await service.createAccount(principal, { platform: "x", expectedNativeUserId: "100" });
  await service.importConnection(principal, account.id, { vaultHandle: "fixture:x:one", generation: 1 });
  const capabilities = await service.listCapabilities(principal, account.id);
  assert.equal(capabilities.platform, "x");
  assert.equal(capabilities.capabilities.length, 10);
  assert.ok(capabilities.details?.every((item) => item.productionEnabled === false && item.fixtureEnabled === true));
  await service.closeAdapters();
  store.close();
});

test("REST and MCP expose every X read/discovery contract with normalized rate visibility", async () => {
  const store = new LedgerStore(":memory:");
  const adapter = new XFixturePlatformAdapter();
  adapter.stageSession({ vaultHandle: "fixture:x:http", nativeIdentity: "100" });
  const service = new SocialGitService({ store, adapters: [adapter] });
  const server = createSocialGitHttpServer({ service, authenticate: bearerAuthenticator(new Map([["x-token", { callerId: "x-caller", scopes: allScopes }]])) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const catalog = await request(base, "/v1/platforms/x/capabilities");
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.details.length, 10);
    assert.ok(catalog.body.details.every((item: any) => item.productionEnabled === false));
    const created = await request(base, "/v1/accounts", { method: "POST", body: { platform: "x", expectedNativeUserId: "100" } });
    const accountId = created.body.account.id;
    assert.equal((await request(base, `/v1/accounts/${accountId}/connections`, { method: "POST", body: { vaultHandle: "fixture:x:http", generation: 1 } })).status, 200);
    const checks = [
      [`/v1/accounts/${accountId}/x/health`, false],
      [`/v1/accounts/${accountId}/x/profiles/fixture_profile`, false],
      [`/v1/accounts/${accountId}/x/posts/300`, false],
      [`/v1/accounts/${accountId}/x/posts/300/thread`, true],
      [`/v1/accounts/${accountId}/x/timelines/home`, true],
      [`/v1/accounts/${accountId}/x/timelines/users/fixture_owner`, true],
      [`/v1/accounts/${accountId}/x/search?query=fixture`, true],
      [`/v1/accounts/${accountId}/x/notifications`, true],
      [`/v1/accounts/${accountId}/x/conversations`, true],
      [`/v1/accounts/${accountId}/x/bookmarks`, true],
    ] as const;
    for (const [path, paged] of checks) {
      const result = await request(base, path);
      assert.equal(result.status, 200, path);
      assert.equal(paged ? result.body.items.length : typeof result.body.nativeId, paged ? 1 : "string", path);
      assert.equal(result.body.rateLimit.remaining, 49, path);
      assert.equal(JSON.stringify(result.body).includes("cookie"), false);
    }
    const tools = createMcpTools(service);
    for (const name of ["x_account_health", "x_profile_get", "x_post_get", "x_thread_get", "x_home_timeline_list", "x_user_timeline_list", "x_search", "x_notifications_list", "x_conversations_list", "x_bookmarks_list"]) {
      assert.ok(tools.some((tool) => tool.name === name), name);
    }
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

test("wrong identity, revoked, access, rate and drift fail closed without retry or raw data", async () => {
  for (const [scenario, expectedCode] of [["revoked", "SESSION_REVOKED"], ["access_denied", "CHALLENGE_REQUIRED"], ["rate_limited", "RATE_LIMITED"], ["protocol_drift", "PROTOCOL_DRIFT"]] as const) {
    const store = new LedgerStore(":memory:");
    const adapter = new XFixturePlatformAdapter();
    const vaultHandle = `fixture:x:${scenario}`;
    adapter.stageSession({ vaultHandle, nativeIdentity: "100" });
    const service = new SocialGitService({ store, adapters: [adapter] });
    const { account } = await service.createAccount(principal, { platform: "x", expectedNativeUserId: "100" });
    await service.importConnection(principal, account.id, { vaultHandle, generation: 1 });
    adapter.setScenario(vaultHandle, scenario);
    await assert.rejects(() => service.read(principal, account.id, "x.account.health", { kind: "x_account_health" }), (error: any) => error.code === expectedCode);
    store.close();
  }
  const store = new LedgerStore(":memory:");
  const adapter = new XFixturePlatformAdapter();
  adapter.stageSession({ vaultHandle: "fixture:x:wrong", nativeIdentity: "999" });
  const service = new SocialGitService({ store, adapters: [adapter] });
  const { account } = await service.createAccount(principal, { platform: "x", expectedNativeUserId: "100" });
  await assert.rejects(() => service.importConnection(principal, account.id, { vaultHandle: "fixture:x:wrong", generation: 1 }), (error: any) => error.code === "WRONG_IDENTITY");
  store.close();
});

test("production placeholder reports unsupported and performs no network access", async () => {
  const adapter = new DisabledXPlatformAdapter();
  const account = { id: "a", platform: "x", expectedNativeUserId: "100" } as any;
  assert.deepEqual(await adapter.capabilities(account), []);
  assert.ok((await adapter.capabilityDetails(account)).every((item) => item.productionEnabled === false));
  await assert.rejects(() => adapter.read({ account, vaultHandle: "opaque", request: { kind: "x_account_health" } }), (error: any) => error.code === "CAPABILITY_UNAVAILABLE");
});

async function request(base: string, path: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: "Bearer x-token", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() as any };
}
