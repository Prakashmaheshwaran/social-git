import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, startSocialGitRuntime } from "../src/index.ts";

const TOKEN = "fixture-boundary-token-with-enough-entropy";

test("executable REST and MCP gateway completes the fixture lifecycle and restart replay", async () => {
  const fixture = runtimeFiles();
  let runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    assert.equal((await fetch(`${runtime.url}/healthz`)).status, 200);
    const ready = await fetch(`${runtime.url}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as any).checks.actionWorker, true);

    await fixtureControl(runtime.url, "stage-session", {
      vaultHandle: "session-alpha",
      sessionFixture: "session-alpha-v1",
      nativeIdentity: "fixture_user",
      routeId: "route-alpha",
      syntheticSensitiveFields: {
        cookie: "SYNTHETIC_COOKIE_SENTINEL",
        csrf: "SYNTHETIC_CSRF_SENTINEL",
      },
    });
    const created = await request(runtime.url, "/v1/accounts", {
      method: "POST",
      body: { platform: "reddit", expectedNativeUserId: "fixture_user" },
    });
    assert.equal(created.status, 201);
    const accountId = created.body.account.id;
    const imported = await request(runtime.url, `/v1/accounts/${accountId}/connections`, {
      method: "POST",
      body: { vaultHandle: "session-alpha", generation: 1 },
    });
    assert.equal(imported.status, 200);
    assert.equal(JSON.stringify(imported.body).includes("session-alpha"), false);

    const profile = await request(runtime.url, `/v1/accounts/${accountId}/profile`);
    assert.equal(profile.status, 200);
    assert.match(profile.body.nativeId, /^t2_[a-f0-9]{12}$/u);

    const queued = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST",
      headers: { "idempotency-key": "publish-text-1" },
      body: { kind: "text_post", subreddit: "test", title: "Fixture title", text: "Fixture body" },
    });
    assert.equal(queued.status, 202);
    const completed = await waitForAction(runtime.url, queued.body.action.id, "succeeded");
    assert.equal(completed.result.nativeId.startsWith("t3_"), true);

    const replay = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST",
      headers: { "idempotency-key": "publish-text-1" },
      body: { kind: "text_post", subreddit: "test", title: "Fixture title", text: "Fixture body" },
    });
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.action.id, completed.id);

    const initialized = await mcp(runtime.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(initialized.result.serverInfo.name, "social-git");
    const tools = await mcp(runtime.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(tools.result.tools.some((tool: any) => tool.name === "reddit_action_create"), true);
    const listed = await mcp(runtime.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "social_accounts_list", arguments: { limit: 10 } },
    });
    assert.equal(listed.result.isError, false);
    assert.equal(listed.result.structuredContent.items.length, 1);

    const storage = await fixtureInspect(runtime.url, "storage-records");
    assert.equal(storage.length, 2);
    assert.deepEqual(new Set(storage.map((entry: any) => entry.purpose)), new Set(["session", "network-route"]));
    assert.equal(new Set(storage.map((entry: any) => entry.nonceId)).size, 2);
    assert.equal(JSON.stringify(storage).includes("SYNTHETIC_COOKIE_SENTINEL"), false);
    const observable = JSON.stringify({
      logs: await fixtureInspect(runtime.url, "logs"),
      audit: await fixtureInspect(runtime.url, "audit-events"),
      imported,
      profile,
    });
    assert.equal(observable.includes("SYNTHETIC_COOKIE_SENTINEL"), false);
    assert.equal(observable.includes("SYNTHETIC_CSRF_SENTINEL"), false);

    await runtime.close();
    runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
    const replayAfterRestart = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST",
      headers: { "idempotency-key": "publish-text-1" },
      body: { kind: "text_post", subreddit: "test", title: "Fixture title", text: "Fixture body" },
    });
    assert.equal(replayAfterRestart.body.replayed, true);
    assert.equal(replayAfterRestart.body.action.state, "succeeded");

    const revoked = await request(runtime.url, `/v1/accounts/${accountId}/revoke`, { method: "POST", body: { reason: "test complete" } });
    assert.equal(revoked.status, 200);
    assert.equal((await fixtureInspect(runtime.url, "storage-records")).length, 0);
    const afterRevoke = await request(runtime.url, `/v1/accounts/${accountId}/profile`);
    assert.equal(afterRevoke.body.error.code, "SESSION_REVOKED");
  } finally {
    await runtime.close();
    fixture.close();
  }
});

test("fixture challenge stops at one public platform call and does not retry", async () => {
  const fixture = runtimeFiles();
  const runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    await fixtureControl(runtime.url, "stage-session", {
      vaultHandle: "session-challenge",
      sessionFixture: "session-challenge-v1",
      nativeIdentity: "fixture_user",
      routeId: "route-challenge",
    });
    const created = await request(runtime.url, "/v1/accounts", {
      method: "POST",
      body: { platform: "reddit", expectedNativeUserId: "fixture_user" },
    });
    const accountId = created.body.account.id;
    assert.equal((await request(runtime.url, `/v1/accounts/${accountId}/connections`, {
      method: "POST", body: { vaultHandle: "session-challenge", generation: 1 },
    })).status, 200);
    await fixtureControl(runtime.url, "next-platform-outcome", {
      accountId,
      operation: "read.account-profile",
      outcome: "challenge",
    });
    const failed = await request(runtime.url, `/v1/accounts/${accountId}/profile`);
    assert.equal(failed.body.error.code, "CHALLENGE_REQUIRED");
    const afterFirst = (await fixtureInspect(runtime.url, "platform-calls")).filter((entry: any) => entry.operation === "read.account-profile").length;
    const stopped = await request(runtime.url, `/v1/accounts/${accountId}/profile`);
    assert.equal(stopped.body.error.code, "CHALLENGE_REQUIRED");
    const afterSecond = (await fixtureInspect(runtime.url, "platform-calls")).filter((entry: any) => entry.operation === "read.account-profile").length;
    assert.equal(afterFirst, 1);
    assert.equal(afterSecond, 1);
  } finally {
    await runtime.close();
    fixture.close();
  }
});

test("UNKNOWN action and caller idempotency survive an executable restart without resubmission", async () => {
  const fixture = runtimeFiles();
  let runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    await fixtureControl(runtime.url, "stage-session", {
      vaultHandle: "session-unknown",
      sessionFixture: "session-unknown-v1",
      nativeIdentity: "fixture_user",
      routeId: "route-unknown",
    });
    const created = await request(runtime.url, "/v1/accounts", {
      method: "POST", body: { platform: "reddit", expectedNativeUserId: "fixture_user" },
    });
    const accountId = created.body.account.id;
    await request(runtime.url, `/v1/accounts/${accountId}/connections`, {
      method: "POST", body: { vaultHandle: "session-unknown", generation: 1 },
    });
    await fixtureControl(runtime.url, "crash-after-submit", { accountId, operation: "write.post.text" });
    const input = { kind: "text_post", subreddit: "test", title: "Unknown title", text: "Unknown body" };
    const queued = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST", headers: { "idempotency-key": "unknown-key" }, body: input,
    });
    const unknown = await waitForAction(runtime.url, queued.body.action.id, "UNKNOWN");
    assert.equal(unknown.submissionMayHaveStarted, true);
    const beforeRestartCalls = (await fixtureInspect(runtime.url, "platform-calls"))
      .filter((entry: any) => entry.operation === "write.post.text").length;
    assert.equal(beforeRestartCalls, 1);

    await runtime.close();
    runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
    const replay = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST", headers: { "idempotency-key": "unknown-key" }, body: input,
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.action.state, "UNKNOWN");
    assert.equal((await fixtureInspect(runtime.url, "platform-calls")).filter((entry: any) => entry.operation === "write.post.text").length, 0);
    const reconciled = await request(runtime.url, `/v1/actions/${unknown.id}/reconcile`, { method: "POST", body: {} });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.reconciled, false);
    assert.equal(reconciled.body.action.state, "UNKNOWN");
  } finally {
    await runtime.close();
    fixture.close();
  }
});

test("runtime configuration fails closed before opening a service", () => {
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production" }), /SOCIAL_GIT_MODE is required/);
  assert.throws(() => loadRuntimeConfig({ SOCIAL_GIT_MODE: "fixture", NODE_ENV: "production" }), /Fixture mode requires NODE_ENV=test/);
});

test("production mode does not expose fixture controls and stays write-closed without a live grant", async () => {
  const fixture = runtimeFiles();
  const sessionImportDir = join(fixture.root, "session-imports");
  mkdirSync(sessionImportDir, { mode: 0o700 });
  fixture.environment.NODE_ENV = "production";
  fixture.environment.SOCIAL_GIT_MODE = "production";
  fixture.environment.SOCIAL_GIT_SESSION_IMPORT_DIR = sessionImportDir;
  const runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    const ready = await request(runtime.url, "/readyz");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.checks.actionWorker, false);
    assert.equal(ready.body.checks.productionWritesAuthorized, false);
    const fixtureRoute = await request(runtime.url, "/__fixture/control", {
      method: "POST", body: { command: "reset", payload: {} },
    });
    assert.equal(fixtureRoute.status, 404);

    const created = await request(runtime.url, "/v1/accounts", {
      method: "POST", body: { platform: "reddit", expectedNativeUserId: "reddit:t2_fixture" },
    });
    const denied = await request(runtime.url, `/v1/accounts/${created.body.account.id}/actions`, {
      method: "POST",
      headers: { "idempotency-key": "must-not-queue" },
      body: { kind: "text_post", subreddit: "test", title: "No dispatch", text: "No dispatch" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "FORBIDDEN");
  } finally {
    await runtime.close();
    fixture.close();
  }
});

function runtimeFiles() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-runtime-e2e-"));
  const data = join(root, "data");
  const master = join(root, "master.key");
  const audit = join(root, "audit.key");
  const auth = join(root, "auth.json");
  writeFileSync(master, Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
  writeFileSync(audit, Buffer.alloc(32, 8).toString("base64url"), { mode: 0o600 });
  writeFileSync(auth, JSON.stringify({
    version: 1,
    principals: [{
      tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
      callerId: "fixture-caller",
      scopes: ["*", "fixture:control"],
    }],
  }), { mode: 0o600 });
  const environment = {
    NODE_ENV: "test",
    SOCIAL_GIT_MODE: "fixture",
    SOCIAL_GIT_DATA_DIR: data,
    SOCIAL_GIT_MASTER_KEY_FILE: master,
    SOCIAL_GIT_AUDIT_KEY_FILE: audit,
    SOCIAL_GIT_AUTH_FILE: auth,
    SOCIAL_GIT_HOST: "127.0.0.1",
    SOCIAL_GIT_PORT: "0",
    SOCIAL_GIT_WORKER_INTERVAL_MS: "25",
    SOCIAL_GIT_TENANT_ID: "fixture-tenant",
    SOCIAL_GIT_LEDGER_ID: "fixture-action-ledger",
  } as NodeJS.ProcessEnv;
  return { root, environment, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function request(base: string, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

async function fixtureControl(base: string, command: string, payload: Record<string, unknown>) {
  const result = await request(base, "/__fixture/control", { method: "POST", body: { command, payload } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
}

async function fixtureInspect(base: string, target: string) {
  const result = await request(base, `/__fixture/inspect?target=${encodeURIComponent(target)}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
}

async function mcp(base: string, body: Record<string, unknown>) {
  const result = await request(base, "/mcp", { method: "POST", body });
  assert.equal(result.status, 200);
  return result.body;
}

async function waitForAction(base: string, actionId: string, state: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(base, `/v1/actions/${actionId}`);
    if (response.body.action.state === state) return response.body.action;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Action ${actionId} did not reach ${state}`);
}
