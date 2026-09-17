import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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
} = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

function cookie(headers: Headers): string {
  return (headers.get("set-cookie") ?? "").split(";", 1)[0]!;
}
