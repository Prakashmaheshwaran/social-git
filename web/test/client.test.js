import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, ControlPlaneUnavailableError, SocialGitClient } from "../client.js";

test("owner setup uses same-origin cookies while CSRF remains client-private", async () => {
  const calls = [];
  const client = new SocialGitClient({ fetchImpl: async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), credentials: init?.credentials, csrf: headers.get("x-csrf-token"), authorization: headers.get("authorization") });
    if (url === "/v1/setup/status") return json({ required: true });
    if (url === "/v1/setup/owner") return json({ authenticated: true, csrfToken: "csrf-private-setup-value", expiresAt: "2026-09-17T00:00:00Z", tenantId: "tenant-1", role: "owner" }, 201);
    if (url === "/v1/accounts") return json({ account: { id: "a1" } }, 201);
    if (url === "/v1/auth/logout") return json({ loggedOut: true });
    return json({ error: { code: "NOT_FOUND", message: "No route" } }, 404);
  }});

  assert.deepEqual(await client.getSetupStatus(), { required: true });
  const session = await client.createOwner({ email: "owner@example.com", displayName: "Owner", password: "owner-password-42!" });
  assert.deepEqual(session, { authenticated: true, expiresAt: "2026-09-17T00:00:00Z", tenantId: "tenant-1", role: "owner" });
  assert.equal(JSON.stringify(session).includes("csrf-private"), false);
  assert.equal(client.hasMutationSession(), true);
  await client.createAccount({ platform: "reddit", expectedNativeUserId: "native-1" });
  await client.logout();

  assert.ok(calls.every((call) => call.credentials === "same-origin"));
  assert.ok(calls.every((call) => call.authorization === null));
  assert.equal(calls.find((call) => call.url === "/v1/setup/owner").csrf, null);
  assert.equal(calls.find((call) => call.url === "/v1/accounts").csrf, "csrf-private-setup-value");
  assert.equal(calls.find((call) => call.url === "/v1/auth/logout").csrf, "csrf-private-setup-value");
  assert.equal(client.hasMutationSession(), false);
});

test("a restored HttpOnly session can read but must reauthenticate before mutation", async () => {
  const calls = [];
  const client = new SocialGitClient({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), credentials: init?.credentials });
    if (url === "/v1/auth/session") return json({ authenticated: true, tenantId: "tenant-1", role: "owner" });
    throw new Error("mutation must fail before fetch");
  }});
  assert.deepEqual(await client.getSession(), { authenticated: true, tenantId: "tenant-1", role: "owner" });
  await assert.rejects(client.createAccount({ platform: "reddit", expectedNativeUserId: "native-1" }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "CSRF_REQUIRED");
    return true;
  });
  assert.deepEqual(calls, [{ url: "/v1/auth/session", credentials: "same-origin" }]);
});

test("typed client builds an overview through cookie-authenticated REST", async () => {
  const calls = [];
  const client = new SocialGitClient({ fetchImpl: async (url, init) => {
    calls.push({ credentials: init?.credentials, authorization: new Headers(init?.headers).get("authorization") });
    if (url === "/v1/accounts?limit=100") return json({ items: [{ id: "a1", platform: "reddit", expectedNativeUserId: "u1", actualNativeUserId: "u1", label: "Main", status: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], nextCursor: null });
    if (url === "/v1/accounts/a1/connection") return json({ connection: { accountId: "a1", generation: 2, status: "active", connectedAt: "2026-01-01T00:00:00Z", revokedAt: null } });
    if (url === "/v1/accounts/a1/capabilities") return json({ platform: "reddit", capabilities: ["read.profile"], unsupportedCapabilities: { messaging: "NO_VERIFIABLE_NATIVE_RESULT" } });
    if (url === "/v1/audit-events?limit=12") return json({ items: [], nextCursor: null });
    if (url === "/readyz") return json({ status: "ready", checks: { worker: true } });
    return json({ error: { code: "NOT_FOUND", message: "No route" } }, 404);
  }});
  const result = await client.getOverview();
  assert.equal(result.accounts[0].label, "Main");
  assert.equal(result.connections.a1.generation, 2);
  assert.deepEqual(result.capabilities.a1.capabilities, ["read.profile"]);
  assert.equal(result.capabilities.a1.source, "account");
  assert.equal(result.health.ready, true);
  assert.ok(calls.every((call) => call.credentials === "same-origin" && call.authorization === null));
});

test("X registration inventory stays production-disabled using the exact platform admission reasons", async () => {
  const reasons = ["SOURCE_CURRENTNESS_UNPROVEN", "LIVE_EGRESS_UNPROVEN"];
  let catalogCalls = 0;
  const accounts = [
    { id: "x1", platform: "x", expectedNativeUserId: "42", actualNativeUserId: null, label: "X one", status: "disconnected", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "x2", platform: "x", expectedNativeUserId: "84", actualNativeUserId: null, label: "X two", status: "disconnected", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  ];
  const client = new SocialGitClient({ fetchImpl: async (url) => {
    if (url === "/v1/accounts?limit=100") return json({ items: accounts, nextCursor: null });
    if (url === "/v1/platforms/x/capabilities") { catalogCalls += 1; return json({ platform: "x", details: [{ operation: "x.profile.get", productionEnabled: false, disabledReasons: reasons }] }); }
    if (url === "/v1/accounts/x1/connection" || url === "/v1/accounts/x2/connection") return json({ error: { code: "NOT_FOUND", message: "No connection" } }, 404);
    if (url === "/v1/audit-events?limit=12") return json({ items: [], nextCursor: null });
    if (url === "/readyz") return json({ status: "ready" });
    return json({ error: { code: "NOT_FOUND", message: "No route" } }, 404);
  }});

  const overview = await client.getOverview();
  assert.equal(catalogCalls, 1);
  assert.deepEqual(overview.capabilities.x1.capabilities, []);
  assert.equal(overview.capabilities.x1.unsupportedCapabilities["x.profile.get"], reasons.join(","));
  assert.equal(overview.capabilities.x2.source, "platform");
});

test("session refresh accepts only copy-safe staged filenames and sends the next generation", async () => {
  const calls = [];
  const client = new SocialGitClient({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: init?.body, csrf: new Headers(init?.headers).get("x-csrf-token") });
    if (url === "/v1/auth/login") return json({ authenticated: true, csrfToken: "private-csrf", tenantId: "tenant-1", role: "owner" });
    if (url === "/v1/accounts/a1/connection/refresh") return json({ connection: { accountId: "a1", generation: 3, status: "active" } });
    return json({ error: { code: "NOT_FOUND", message: "No route" } }, 404);
  }});
  await client.login({ email: "owner@example.com", password: "owner-password-42!" });
  await assert.rejects(client.importConnection("a1", { vaultHandle: "vault://staged/reference", generation: 1 }), (error) => error instanceof ApiError && error.code === "VALIDATION_FAILED" && /no path or URI/u.test(error.message));
  await assert.rejects(client.importConnection("a1", { vaultHandle: "reddit-session.json", generation: 1 }), (error) => error instanceof ApiError && error.code === "VALIDATION_FAILED");
  assert.equal(calls.length, 1, "invalid handles must fail before a request is sent");
  await client.refreshConnection("a1", { vaultHandle: "reddit-session-2026-09", generation: 3 });
  assert.deepEqual(JSON.parse(calls[1].body), { vaultHandle: "reddit-session-2026-09", generation: 3 });
  assert.equal(calls[1].csrf, "private-csrf");
});

test("unfinished DYN-106 API-key routes remain an actionable capability boundary", async () => {
  const client = new SocialGitClient({ fetchImpl: async (url) => url === "/v1/auth/login"
    ? json({ authenticated: true, csrfToken: "csrf-private-login-value", tenantId: "tenant-1", role: "owner" })
    : json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404) });
  await client.login({ email: "owner@example.com", password: "owner-password-42!" });
  await assert.rejects(client.listApiKeys(), (error) => {
    assert.ok(error instanceof ControlPlaneUnavailableError);
    assert.equal(error.feature, "API key management");
    return true;
  });
});

test("API errors preserve safe request correlation without exposing response internals", async () => {
  const client = new SocialGitClient({ fetchImpl: async () => json({ error: { code: "RATE_LIMITED", message: "Try again later." } }, 429, { "x-request-id": "req-17" }) });
  await assert.rejects(client.listAccounts(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual({ code: error.code, status: error.status, requestId: error.requestId, message: error.message }, { code: "RATE_LIMITED", status: 429, requestId: "req-17", message: "Try again later." });
    return true;
  });
});

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
