import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  bearerAuthenticator,
  createSocialGitHttpServer,
  IdentityHttpController,
  IdentityStore,
  LedgerStore,
  MockRedditAdapter,
  SocialGitService,
  loadRuntimeConfig,
  startSocialGitRuntime,
} from "../src/index.ts";
import { tempDatabase } from "./helpers.ts";

function deterministicRandom() {
  let call = 1;
  return (size: number) => Buffer.alloc(size, call++);
}

test("first-run owner setup has no defaults, hashes credentials, and creates an isolated session", () => {
  const database = tempDatabase();
  let clock = Date.UTC(2026, 8, 16, 12);
  const identity = new IdentityStore(database.path, {
    tenantId: "tenant-alpha",
    now: () => clock,
    randomBytes: deterministicRandom(),
  });
  try {
    assert.deepEqual(identity.setupStatus(), { required: true });
    assert.equal(identity.authenticate("not-a-token"), null);
    const created = identity.createFirstOwner({
      email: " Owner@Example.com ",
      displayName: "Primary Owner",
      password: "long-owner-password-42!",
    });
    assert.deepEqual(identity.setupStatus(), { required: false });
    assert.equal(created.principal.tenantId, "tenant-alpha");
    assert.equal(created.principal.role, "owner");
    assert.deepEqual(created.principal.scopes, ["*"]);
    assert.ok(identity.authenticate(created.token, created.csrfToken));
    assert.throws(() => identity.createFirstOwner({
      email: "second@example.com", displayName: "Second", password: "another-long-password!",
    }), /already been completed/u);
    const user = identity.db.prepare("SELECT email, password_algorithm, password_salt, password_hash FROM identity_users").get() as any;
    assert.equal(user.email, "owner@example.com");
    assert.equal(user.password_algorithm, "scrypt-n32768-r8-p1");
    assert.equal(Buffer.from(user.password_salt).length, 16);
    assert.equal(Buffer.from(user.password_hash).length, 32);
    assert.notEqual(Buffer.from(user.password_hash).toString("utf8"), "long-owner-password-42!");
    clock += 12 * 60 * 60 * 1000 + 1;
    assert.equal(identity.authenticate(created.token, created.csrfToken), null);
  } finally {
    identity.close();
    const bytes = readFileSync(database.path).toString("latin1");
    assert.equal(bytes.includes("long-owner-password-42!"), false);
    assert.equal(bytes.includes("Primary Owner"), true);
    database.cleanup();
  }
});

test("owner HTTP login, CSRF enforcement, logout, and generic failure behavior", async () => {
  const database = tempDatabase();
  const identity = new IdentityStore(database.path, {
    tenantId: "tenant-alpha",
    now: () => Date.UTC(2026, 8, 16, 12),
  });
  const controller = new IdentityHttpController(identity, false);
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()], tenantId: "tenant-alpha" });
  const server = createSocialGitHttpServer({
    service,
    identity: controller,
    authenticate: (request) => controller.authenticateRequest(request),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const status = await json(base, "/v1/setup/status");
    assert.equal(status.body.required, true);
    const setup = await json(base, "/v1/setup/owner", {
      method: "POST",
      body: { email: "owner@example.com", displayName: "Owner", password: "owner-password-42!" },
    });
    assert.equal(setup.status, 201);
    assert.equal(setup.body.tenantId, "tenant-alpha");
    assert.equal(JSON.stringify(setup.body).includes("owner-password"), false);
    const setupCookie = cookie(setup.headers);
    assert.match(setupCookie, /^social_git_session=/u);
    assert.match(setup.headers.get("set-cookie") ?? "", /HttpOnly/u);
    assert.match(setup.headers.get("set-cookie") ?? "", /SameSite=Strict/u);

    const missingCsrf = await json(base, "/v1/accounts", {
      method: "POST", cookie: setupCookie,
      body: { platform: "reddit", expectedNativeUserId: "native-1" },
    });
    assert.equal(missingCsrf.status, 401);
    const created = await json(base, "/v1/accounts", {
      method: "POST", cookie: setupCookie, csrf: setup.body.csrfToken,
      body: { platform: "reddit", expectedNativeUserId: "native-1" },
    });
    assert.equal(created.status, 201);

    const failedLogin = await json(base, "/v1/auth/login", {
      method: "POST", body: { email: "owner@example.com", password: "wrong-password-value!" },
    });
    assert.equal(failedLogin.status, 401);
    assert.equal(failedLogin.body.error.message, "Email or password is incorrect.");
    const login = await json(base, "/v1/auth/login", {
      method: "POST", body: { email: "owner@example.com", password: "owner-password-42!" },
    });
    assert.equal(login.status, 200);
    const loginCookie = cookie(login.headers);
    const session = await json(base, "/v1/auth/session", { cookie: loginCookie });
    assert.deepEqual(session.body, { authenticated: true, tenantId: "tenant-alpha", role: "owner" });
    const logout = await json(base, "/v1/auth/logout", {
      method: "POST", cookie: loginCookie, csrf: login.body.csrfToken, body: {},
    });
    assert.equal(logout.status, 200);
    assert.equal((await json(base, "/v1/auth/session", { cookie: loginCookie })).status, 401);
    assert.deepEqual(
      identity.listAuditEvents().map((event: any) => event.eventType),
      ["owner.created", "auth.login_failed", "auth.login_succeeded", "auth.logout"],
    );
  } finally {
    server.close();
    await once(server, "close");
    identity.close();
    store.close();
    database.cleanup();
  }
});

test("tenant API keys store only hashes, expose one-time secrets, rotate atomically, and audit lifecycle", () => {
  const database = tempDatabase();
  let clock = Date.UTC(2026, 8, 16, 12);
  const identity = new IdentityStore(database.path, {
    tenantId: "tenant-alpha",
    now: () => clock,
    randomBytes: deterministicRandom(),
  });
  let firstSecret = "";
  let rotatedSecret = "";
  try {
    const owner = identity.createFirstOwner({
      email: "owner@example.com", displayName: "Owner", password: "owner-password-42!",
    }).principal;
    const created = identity.createApiKey(owner, {
      name: " Read automation ", scopes: ["social:read", "accounts:read"],
    });
    firstSecret = created.secret;
    assert.match(firstSecret, /^sgk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u);
    assert.match(created.apiKey.prefix, /^sgk_[A-Za-z0-9_-]{12}_$/u);
    assert.equal(created.apiKey.name, "Read automation");
    assert.deepEqual(created.apiKey.scopes, ["accounts:read", "social:read"]);
    assert.equal(created.apiKey.lastUsedAt, null);
    const stored = identity.db.prepare("SELECT secret_hash, key_prefix, scopes_json FROM identity_api_keys WHERE id = ?")
      .get(created.apiKey.id) as any;
    assert.equal(Buffer.from(stored.secret_hash).length, 32);
    assert.equal(String(stored.key_prefix), created.apiKey.prefix.slice(4, -1));
    assert.equal(JSON.stringify(stored).includes(firstSecret), false);
    assert.throws(() => identity.createApiKey(owner, { name: "wild", scopes: ["*"] }), /unsupported scope/u);

    clock += 5_000;
    const principal = identity.authenticateApiKey(firstSecret);
    assert.equal(principal?.tenantId, "tenant-alpha");
    assert.equal(principal?.callerId, `api-key:${created.apiKey.id}`);
    assert.deepEqual(principal?.scopes, ["accounts:read", "social:read"]);
    assert.equal(identity.listApiKeys(owner)[0]?.lastUsedAt, new Date(clock).toISOString());

    clock += 5_000;
    const rotated = identity.rotateApiKey(owner, created.apiKey.id);
    rotatedSecret = rotated.secret;
    assert.equal(rotated.revokedApiKeyId, created.apiKey.id);
    assert.notEqual(rotatedSecret, firstSecret);
    assert.equal(rotated.apiKey.rotatedFromId, created.apiKey.id);
    assert.equal(identity.authenticateApiKey(firstSecret), null);
    assert.ok(identity.authenticateApiKey(rotatedSecret));
    assert.deepEqual(identity.listApiKeys(owner).map((key) => key.id), [rotated.apiKey.id]);
    const revoked = identity.revokeApiKey(owner, rotated.apiKey.id);
    assert.ok(revoked.revokedAt);
    assert.equal(identity.authenticateApiKey(rotatedSecret), null);
    assert.deepEqual(identity.listApiKeys(owner), []);
    assert.deepEqual(
      identity.listAuditEvents().map((event: any) => event.eventType),
      ["owner.created", "api_key.created", "api_key.rotated", "api_key.revoked"],
    );
    const auditJson = JSON.stringify(identity.listAuditEvents());
    assert.equal(auditJson.includes(firstSecret), false);
    assert.equal(auditJson.includes(rotatedSecret), false);
  } finally {
    identity.close();
    const bytes = readFileSync(database.path).toString("latin1");
    if (firstSecret) assert.equal(bytes.includes(firstSecret), false);
    if (rotatedSecret) assert.equal(bytes.includes(rotatedSecret), false);
    database.cleanup();
  }
});

test("identity migration upgrades the owner-only schema in place without losing its audit trail", () => {
  const database = tempDatabase();
  const initial = new IdentityStore(database.path, { tenantId: "tenant-alpha" });
  initial.createFirstOwner({
    email: "owner@example.com", displayName: "Owner", password: "owner-password-42!",
  });
  initial.close();
  const legacy = new DatabaseSync(database.path);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TABLE identity_api_keys;
    DELETE FROM identity_schema_migrations WHERE version = 2;
    ALTER TABLE identity_audit_events RENAME TO identity_audit_events_v2;
    CREATE TABLE identity_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      actor_user_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'owner.created', 'auth.login_succeeded', 'auth.login_failed',
        'auth.logout', 'auth.session_rejected'
      )),
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rejected')),
      occurred_at INTEGER NOT NULL,
      details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object')
    ) STRICT;
    INSERT INTO identity_audit_events
    SELECT * FROM identity_audit_events_v2;
    DROP TABLE identity_audit_events_v2;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  legacy.close();
  const upgraded = new IdentityStore(database.path, { tenantId: "tenant-alpha" });
  try {
    assert.equal((upgraded.db.prepare("SELECT MAX(version) AS version FROM identity_schema_migrations").get() as any).version, 2);
    assert.deepEqual(upgraded.listAuditEvents().map((event: any) => event.eventType), ["owner.created"]);
    const owner = upgraded.login({ email: "owner@example.com", password: "owner-password-42!" })?.principal;
    assert.ok(owner);
    const created = upgraded.createApiKey(owner, { name: "post-upgrade", scopes: ["accounts:read"] });
    assert.ok(upgraded.authenticateApiKey(created.secret));
  } finally {
    upgraded.close();
    database.cleanup();
  }
});

test("owner-managed API keys authenticate REST and MCP alongside legacy bearer auth with bounded rate-limit hooks", async () => {
  const database = tempDatabase();
  let clock = Date.UTC(2026, 8, 16, 12);
  let rateAllowed = true;
  const rateContexts: unknown[] = [];
  const identity = new IdentityStore(database.path, { tenantId: "tenant-alpha", now: () => clock });
  const controller = new IdentityHttpController(identity, false, (context) => {
    rateContexts.push(context);
    return rateAllowed
      ? { allowed: true, limit: 10, remaining: 9 }
      : { allowed: false, limit: 10, remaining: 0, retryAfterSeconds: 30, resetAt: new Date(clock + 30_000).toISOString() };
  });
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()], tenantId: "tenant-alpha" });
  const legacy = bearerAuthenticator(new Map([["legacy-token", {
    callerId: "legacy-service", tenantId: "tenant-alpha", scopes: ["accounts:read"],
  }]]));
  const server = createSocialGitHttpServer({
    service,
    identity: controller,
    authenticate: async (request) => await legacy(request) ?? controller.authenticateApiKeyRequest(request) ?? controller.authenticateRequest(request),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const setup = await json(base, "/v1/setup/owner", {
      method: "POST", body: { email: "owner@example.com", displayName: "Owner", password: "owner-password-42!" },
    });
    const ownerCookie = cookie(setup.headers);
    const missingCsrf = await json(base, "/v1/control-plane/api-keys", {
      method: "POST", cookie: ownerCookie, body: { name: "reader", scopes: ["accounts:read"] },
    });
    assert.equal(missingCsrf.status, 401);
    const invalidScope = await json(base, "/v1/control-plane/api-keys", {
      method: "POST", cookie: ownerCookie, csrf: setup.body.csrfToken,
      body: { name: "unsafe", scopes: ["*"] },
    });
    assert.equal(invalidScope.status, 422);
    const created = await json(base, "/v1/control-plane/api-keys", {
      method: "POST", cookie: ownerCookie, csrf: setup.body.csrfToken,
      body: { name: "reader", scopes: ["accounts:read"] },
    });
    assert.equal(created.status, 201);
    assert.match(created.body.secret, /^sgk_/u);
    const secret = created.body.secret;
    const keyId = created.body.apiKey.id;

    const listed = await json(base, "/v1/control-plane/api-keys", { cookie: ownerCookie });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(JSON.stringify(listed.body).includes(secret), false);
    assert.equal(JSON.stringify(listed.body).includes("secret_hash"), false);
    assert.equal((await json(base, "/v1/control-plane/api-keys", { authorization: `Bearer ${secret}` })).status, 401);

    clock += 1_000;
    const keyRead = await json(base, "/v1/accounts", { authorization: `Bearer ${secret}` });
    assert.equal(keyRead.status, 200);
    const mcpInitialize = await json(base, "/mcp", {
      method: "POST", authorization: `Bearer ${secret}`,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    assert.equal(mcpInitialize.status, 200);
    assert.equal(mcpInitialize.body.result.serverInfo.name, "social-git");
    const keyWrite = await json(base, "/v1/accounts", {
      method: "POST", authorization: `Bearer ${secret}`,
      body: { platform: "reddit", expectedNativeUserId: "native-1" },
    });
    assert.equal(keyWrite.status, 403);
    assert.equal((await json(base, "/v1/accounts", { authorization: "Bearer legacy-token" })).status, 200);
    assert.equal(JSON.stringify(rateContexts).includes(secret), false);
    assert.deepEqual(Object.keys(rateContexts[0] as object).sort(), ["apiKeyId", "keyPrefix", "scopes", "tenantId"]);

    rateAllowed = false;
    const limited = await json(base, "/v1/accounts", { authorization: `Bearer ${secret}` });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "30");
    assert.equal(limited.headers.get("x-ratelimit-limit"), "10");
    assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
    rateAllowed = true;

    const rotated = await json(base, `/v1/control-plane/api-keys/${keyId}/rotate`, {
      method: "POST", cookie: ownerCookie, csrf: setup.body.csrfToken, body: {},
    });
    assert.equal(rotated.status, 201);
    assert.equal((await json(base, "/v1/accounts", { authorization: `Bearer ${secret}` })).status, 401);
    assert.equal((await json(base, "/v1/accounts", { authorization: `Bearer ${rotated.body.secret}` })).status, 200);
    const revoked = await json(base, `/v1/control-plane/api-keys/${rotated.body.apiKey.id}/revoke`, {
      method: "POST", cookie: ownerCookie, csrf: setup.body.csrfToken, body: {},
    });
    assert.equal(revoked.status, 200);
    assert.equal((await json(base, "/v1/accounts", { authorization: `Bearer ${rotated.body.secret}` })).status, 401);
  } finally {
    server.close();
    await once(server, "close");
    identity.close();
    store.close();
    database.cleanup();
  }
});

test("service rejects a valid principal from another tenant before data access", async () => {
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()], tenantId: "tenant-alpha" });
  try {
    await assert.rejects(
      () => service.listAccounts({ callerId: "owner:foreign", tenantId: "tenant-beta", scopes: ["*"] }, {}),
      (error: any) => error.code === "FORBIDDEN",
    );
    assert.equal(store.listAccounts().items.length, 0);
  } finally {
    store.close();
  }
});

test("full runtime accepts the first owner without a bearer file and keeps social session material in encrypted Core custody", async () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-owner-runtime-"));
  const data = join(root, "data");
  const master = join(root, "master.key");
  const audit = join(root, "audit.key");
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(master, Buffer.alloc(32, 71).toString("base64url"), { mode: 0o600 });
  writeFileSync(audit, Buffer.alloc(32, 72).toString("base64url"), { mode: 0o600 });
  const runtime = await startSocialGitRuntime(loadRuntimeConfig({
    NODE_ENV: "test",
    SOCIAL_GIT_MODE: "fixture",
    SOCIAL_GIT_DATA_DIR: data,
    SOCIAL_GIT_MASTER_KEY_FILE: master,
    SOCIAL_GIT_AUDIT_KEY_FILE: audit,
    SOCIAL_GIT_TENANT_ID: "tenant-owner-runtime",
    SOCIAL_GIT_HOST: "127.0.0.1",
    SOCIAL_GIT_PORT: "0",
  }));
  try {
    const setup = await json(runtime.url, "/v1/setup/owner", {
      method: "POST",
      body: { email: "owner@example.com", displayName: "Owner", password: "runtime-owner-password!" },
    });
    const browserCookie = cookie(setup.headers);
    const csrf = setup.body.csrfToken;
    const stage = await json(runtime.url, "/__fixture/control", {
      method: "POST", cookie: browserCookie, csrf,
      body: { command: "stage-session", payload: {
        vaultHandle: "owner-session", nativeIdentity: "fixture_owner", routeId: "route-owner",
        syntheticSensitiveFields: { cookie: "OWNER_COOKIE_CANARY", csrf: "OWNER_CSRF_CANARY" },
      } },
    });
    assert.equal(stage.status, 200);
    const account = await json(runtime.url, "/v1/accounts", {
      method: "POST", cookie: browserCookie, csrf,
      body: { platform: "reddit", expectedNativeUserId: "fixture_owner" },
    });
    const connected = await json(runtime.url, `/v1/accounts/${account.body.account.id}/connections`, {
      method: "POST", cookie: browserCookie, csrf,
      body: { vaultHandle: "owner-session", generation: 1 },
    });
    assert.equal(connected.status, 200);
    const stored = await json(runtime.url, "/__fixture/inspect?target=storage-records", { cookie: browserCookie });
    assert.equal(stored.status, 200);
    assert.deepEqual(new Set(stored.body.data.map((entry: any) => entry.purpose)), new Set(["session", "network-route"]));
    assert.equal(JSON.stringify(stored.body).includes("OWNER_COOKIE_CANARY"), false);
    assert.equal(JSON.stringify(stored.body).includes("OWNER_CSRF_CANARY"), false);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function json(base: string, path: string, options: {
  method?: string;
  body?: unknown;
  cookie?: string;
  csrf?: string;
  authorization?: string;
} = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

function cookie(headers: Headers): string {
  return (headers.get("set-cookie") ?? "").split(";", 1)[0]!;
}
