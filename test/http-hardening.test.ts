import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { bearerAuthenticator, createSocialGitHttpServer, LedgerStore, MockRedditAdapter, SocialGitService } from "../src/index.ts";
import { READINESS_CACHE_TTL_MS } from "../src/http.ts";
import { allScopes } from "./helpers.ts";

function startServer(overrides: Record<string, unknown> = {}) {
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()] });
  const server = createSocialGitHttpServer({
    service,
    authenticate: bearerAuthenticator(new Map([["test-token", { callerId: "hardening", scopes: allScopes }]])),
    ...overrides,
  } as any);
  return { store, service, server };
}

async function listen(server: any) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function expectApiSecurityHeaders(headers: Headers, label: string) {
  assert.equal(headers.get("cache-control"), "no-store", `${label} cache-control`);
  assert.equal(headers.get("x-content-type-options"), "nosniff", `${label} nosniff`);
  assert.equal(headers.get("referrer-policy"), "no-referrer", `${label} referrer`);
  assert.equal(headers.get("x-frame-options"), "DENY", `${label} frame`);
  assert.equal(headers.get("content-security-policy"), null, `${label} must not send HTML CSP on JSON`);
}

test("API JSON responses carry no-store/nosniff/no-referrer/frame-deny without HTML CSP", async () => {
  const { store, server } = startServer();
  const base = await listen(server);
  try {
    const healthz = await fetch(`${base}/healthz`);
    assert.equal(healthz.status, 200);
    expectApiSecurityHeaders(healthz.headers, "healthz");
    assert.match(healthz.headers.get("content-type") ?? "", /application\/json/u);

    const openapi = await fetch(`${base}/openapi.json`);
    assert.equal(openapi.status, 200);
    expectApiSecurityHeaders(openapi.headers, "openapi");

    const denied = await fetch(`${base}/v1/accounts`);
    assert.equal(denied.status, 401);
    expectApiSecurityHeaders(denied.headers, "error json");
    assert.equal((await denied.json() as any).error.code, "UNAUTHENTICATED");

    const missing = await fetch(`${base}/v1/not-real`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(missing.status, 404);
    expectApiSecurityHeaders(missing.headers, "not found");
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

test("oversized Content-Length is rejected early with 413 and connection close", async () => {
  const { store, server } = startServer();
  const base = await listen(server);
  try {
    const address = server.address() as any;
    const port = address.port;
    // Declare 300k but send a tiny body: early reject must not require the full upload.
    const early: { status: number; headers: any; body: string } = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/accounts", method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json", "content-length": "300000" } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ platform: "reddit" }));
    });
    assert.equal(early.status, 413);
    assert.equal(early.headers["connection"], "close");
    assert.match(early.body, /Request body exceeds/u);
    assert.equal(early.headers["x-content-type-options"], "nosniff");
    assert.equal(early.headers["content-security-policy"], undefined);

    // Server must still serve the next request on a fresh connection (no desync).
    const healthz = await fetch(`${base}/healthz`);
    assert.equal(healthz.status, 200);
    assert.equal((await healthz.json() as any).status, "ok");
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

test("oversized streamed body is terminated safely with 413", async () => {
  const { store, server } = startServer();
  const base = await listen(server);
  try {
    const address = server.address() as any;
    const port = address.port;
    const streamed: { status: number; headers: any; body: string } = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/accounts", method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.on("error", reject);
      req.write(`{"platform":"reddit","pad":"`);
      req.write("x".repeat(300_000));
      req.end(`"}`);
    });
    assert.equal(streamed.status, 413);
    assert.equal(streamed.headers["connection"], "close");

    const healthz = await fetch(`${base}/healthz`);
    assert.equal(healthz.status, 200);
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

test("server applies conservative connection bounds", async () => {
  const { store, server } = startServer();
  try {
    assert.equal((server as any).keepAliveTimeout, 5_000);
    assert.equal((server as any).headersTimeout, 5_000);
    assert.equal((server as any).requestTimeout, 15_000);
    assert.equal((server as any).timeout, 15_000);
    assert.equal((server as any).maxRequestsPerSocket, 100);
    assert.equal((server as any).maxConnections, 200);
    assert.equal(typeof (server as any).closeIdleConnections, "function");
    assert.equal(typeof (server as any).closeAllConnections, "function");
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

test("unauthenticated /readyz is cached briefly without changing its contract", async () => {
  let calls = 0;
  const { store, server } = startServer({
    readiness: async () => {
      calls += 1;
      return { ready: true, contractVersion: 7, checks: { probe: calls } };
    },
  });
  const base = await listen(server);
  try {
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/readyz`)));
    for (const response of concurrent) {
      assert.equal(response.status, 200);
      expectApiSecurityHeaders(response.headers, "readyz");
    }
    const bodies = await Promise.all(concurrent.map((response) => response.json() as Promise<any>));
    for (const body of bodies) {
      assert.equal(body.status, "ready");
      assert.equal(body.contractVersion, 7);
    }
    assert.equal(calls, 1);

    const cached = await fetch(`${base}/readyz`);
    assert.equal(cached.status, 200);
    assert.deepEqual(await cached.json(), bodies[0]);
    assert.equal(calls, 1);

    await new Promise((resolve) => setTimeout(resolve, READINESS_CACHE_TTL_MS + 150));
    const refreshed = await fetch(`${base}/readyz`);
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json() as any).checks.probe, 2);
    assert.equal(calls, 2);
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});
