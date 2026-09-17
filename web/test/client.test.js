import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, ControlPlaneUnavailableError, SocialGitClient } from "../client.js";

test("typed client builds a real overview without sending auth to readiness", async () => {
  const calls = [];
  const client = new SocialGitClient({ token: "secret-token-value", fetchImpl: async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    if (url === "/v1/accounts?limit=100") return json({ items: [{ id: "a1", platform: "reddit", expectedNativeUserId: "u1", actualNativeUserId: "u1", label: "Main", status: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], nextCursor: null });
    if (url === "/v1/accounts/a1/connection") return json({ connection: { accountId: "a1", generation: 2, status: "active", connectedAt: "2026-01-01T00:00:00Z", revokedAt: null } });
    if (url === "/v1/audit-events?limit=12") return json({ items: [], nextCursor: null });
    if (url === "/readyz") return json({ status: "ready", checks: { worker: true } });
    return json({ error: { code: "NOT_FOUND", message: "No route" } }, 404);
  }});
  const result = await client.getOverview();
  assert.equal(result.accounts[0].label, "Main");
  assert.equal(result.connections.a1.generation, 2);
  assert.equal(result.health.ready, true);
  assert.equal(calls.find((call) => call.url === "/readyz").authorization, null);
  assert.ok(calls.filter((call) => call.url !== "/readyz").every((call) => call.authorization === "Bearer secret-token-value"));
});

test("unfinished control-plane routes are isolated as an actionable capability error", async () => {
  const client = new SocialGitClient({ token: "secret-token-value", fetchImpl: async () => json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404) });
  await assert.rejects(client.listApiKeys(), (error) => {
    assert.ok(error instanceof ControlPlaneUnavailableError);
    assert.equal(error.feature, "API key management");
    return true;
  });
});

test("API errors preserve safe request correlation without exposing response internals", async () => {
  const client = new SocialGitClient({ token: "secret-token-value", fetchImpl: async () => json({ error: { code: "RATE_LIMITED", message: "Try again later." } }, 429, { "x-request-id": "req-17" }) });
  await assert.rejects(client.listAccounts(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual({ code: error.code, status: error.status, requestId: error.requestId, message: error.message }, { code: "RATE_LIMITED", status: 429, requestId: "req-17", message: "Try again later." });
    return true;
  });
});

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
