import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { AdapterExecutionError, bearerAuthenticator, createSocialGitHttpServer, LedgerStore, MockRedditAdapter, SocialGitService } from "../src/index.ts";
import { allScopes } from "./helpers.ts";

test("REST contract: auth, account connection, reads, writes, status, and redacted errors", async () => {
  const adapter = new MockRedditAdapter();
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [adapter] });
  const server = createSocialGitHttpServer({ service, authenticate: bearerAuthenticator(new Map([["test-token", { callerId: "http-caller", scopes: allScopes }]])) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const spec = await fetch(`${base}/openapi.json`);
    assert.equal(spec.status, 200);
    assert.equal((await spec.json() as any).openapi, "3.1.0");
    const closedEventIngestion = await request(base, "/v1/adapter-events", {
      method: "POST",
      body: { version: 1, eventId: "public-event", source: "core-action-worker", accountId: "known", type: "action.result", occurredAt: new Date().toISOString(), payload: {} },
    });
    assert.equal(closedEventIngestion.status, 404);
    const denied = await fetch(`${base}/v1/accounts`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json() as any).error.code, "UNAUTHENTICATED");
    const accountResponse = await request(base, "/v1/accounts", { method: "POST", body: { platform: "reddit", expectedNativeUserId: "native-user-1" } });
    assert.equal(accountResponse.status, 201);
    const accountId = accountResponse.body.account.id;
    const connection = await request(base, `/v1/accounts/${accountId}/connections`, { method: "POST", body: { vaultHandle: "vault://http/session", generation: 1 } });
    assert.equal(connection.status, 200);
    assert.equal(JSON.stringify(connection.body).includes("vault://http"), false);
    const refreshed = await request(base, `/v1/accounts/${accountId}/connection/refresh`, { method: "POST", body: { vaultHandle: "vault://http/session-v2", generation: 2 } });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.connection.generation, 2);
    const profile = await request(base, `/v1/accounts/${accountId}/profile`);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.nativeId, "native-user-1");
    const mediaBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const media = await request(base, `/v1/accounts/${accountId}/media`, {
      method: "POST",
      body: { filename: "fixture.png", mimeType: "image/png", dataBase64: mediaBytes.toString("base64") },
    });
    assert.equal(media.status, 201);
    assert.match(media.body.media.mediaRef, /^core-media:/u);
    assert.equal(JSON.stringify(media.body).includes(mediaBytes.toString("base64")), false);
    const mediaAction = await request(base, `/v1/accounts/${accountId}/actions`, {
      method: "POST",
      headers: { "idempotency-key": "http-media" },
      body: { kind: "media_post", subreddit: "test", title: "Media", mediaRef: media.body.media.mediaRef },
    });
    assert.equal(mediaAction.status, 202);
    assert.equal((await service.runNextAction())?.state, "succeeded");
    const missingKey = await request(base, `/v1/accounts/${accountId}/actions`, { method: "POST", body: { kind: "save", targetId: "post-1" } });
    assert.equal(missingKey.status, 422);
    const queued = await request(base, `/v1/accounts/${accountId}/actions`, { method: "POST", headers: { "idempotency-key": "http-key" }, body: { kind: "save", targetId: "post-1" } });
    assert.equal(queued.status, 202);
    assert.equal(queued.body.action.state, "queued");
    await service.runNextAction();
    const status = await request(base, `/v1/actions/${queued.body.action.id}`);
    assert.equal(status.body.action.state, "succeeded");
    adapter.read = async () => { throw new AdapterExecutionError("PROTOCOL_DRIFT", "cookie=secret-value token=do-not-return"); };
    const failure = await request(base, `/v1/accounts/${accountId}/profile`);
    assert.equal(failure.status, 502);
    assert.equal(failure.body.error.code, "PROTOCOL_DRIFT");
    assert.equal(JSON.stringify(failure.body).includes("secret-value"), false);
    adapter.read = async () => { throw new AdapterExecutionError("RATE_LIMITED", "limited", { retryable: true, rateLimit: { remaining: 0, retryAfterSeconds: 45 } }); };
    const limited = await request(base, `/v1/accounts/${accountId}/profile`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "45");
    assert.equal(limited.body.error.rateLimit.remaining, 0);
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

test("web control plane is served by Core with restrictive browser policy", async () => {
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()] });
  const server = createSocialGitHttpServer({ service, authenticate: bearerAuthenticator(new Map()) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const root = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/app/");
    const page = await fetch(`${base}/app/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/u);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
    assert.match(await page.text(), /Social Git/u);
    const script = await fetch(`${base}/app/assets/app.js`);
    assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/u);
    assert.match(await script.text(), /SocialGitClient/u);
    const head = await fetch(`${base}/app/assets/styles.css`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get("content-length")) > 1_000);
    const missingAsset = await fetch(`${base}/app/assets/missing.js`);
    assert.equal(missingAsset.status, 404);
    const missingApi = await fetch(`${base}/v1/not-real`);
    assert.equal(missingApi.status, 404);
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

async function request(base: string, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: "Bearer test-token", ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}
