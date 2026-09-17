import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { PlatformAdapter } from "../src/adapter.ts";
import {
  createSocialGitHttpServer,
  IdentityHttpController,
  IdentityStore,
  LedgerStore,
  OwnerRedditSessionImportController,
  SocialGitService,
} from "../src/index.ts";
import { tempDatabase } from "./helpers.ts";

class DirectImportAdapter implements PlatformAdapter {
  readonly platform = "reddit";
  actualIdentity = "native-user-2";
  generation = 0;
  capturedSession: Uint8Array | null = null;
  capturedRoute: Uint8Array | null = null;
  revoked = 0;

  nextConnectionGeneration() { this.generation += 1; return this.generation; }
  prepareDirectConnection(input: { session: Uint8Array; networkRoute: { material: Uint8Array } }) {
    this.capturedSession = input.session;
    this.capturedRoute = input.networkRoute.material;
  }
  async capabilities() { return ["profile:read"]; }
  async verifyIdentity() { return { nativeUserId: this.actualIdentity }; }
  async read() { return { nativeId: this.actualIdentity }; }
  async submit() { return { status: "failed" as const, code: "CAPABILITY_UNAVAILABLE", message: "disabled" }; }
  async reconcile() { return { status: "pending" as const }; }
  async revoke() { this.revoked += 1; }
}

class SerializedDirectImportAdapter extends DirectImportAdapter {
  nextGenerationCalls = 0;
  prepareCalls = 0;
  private firstPrepareRelease!: () => void;
  private firstPrepareEnteredResolve!: () => void;
  readonly firstPrepareEntered = new Promise<void>((resolve) => { this.firstPrepareEnteredResolve = resolve; });
  private readonly firstPrepareGate = new Promise<void>((resolve) => { this.firstPrepareRelease = resolve; });

  override nextConnectionGeneration() {
    this.nextGenerationCalls += 1;
    return super.nextConnectionGeneration();
  }

  override async prepareDirectConnection(input: { session: Uint8Array; networkRoute: { material: Uint8Array } }) {
    super.prepareDirectConnection(input);
    this.prepareCalls += 1;
    if (this.prepareCalls === 1) {
      this.firstPrepareEnteredResolve();
      await this.firstPrepareGate;
    }
  }

  releaseFirstPrepare() { this.firstPrepareRelease(); }
}

test("owner Reddit session upload is same-origin, cookie and CSRF bound, bounded, exact, wiped, and generation safe", async () => {
  const identityDatabase = tempDatabase();
  const identity = new IdentityStore(identityDatabase.path, { tenantId: "tenant-alpha" });
  const ownerSession = identity.createFirstOwner({
    email: "owner@example.com",
    displayName: "Owner",
    password: "owner-password-42!",
  });
  const member = identity.provisionUser(ownerSession.principal, {
    email: "member@example.com",
    displayName: "Member",
    password: "member-password-42!",
    role: "member",
  });
  const memberSession = identity.login({ email: member.email, password: "member-password-42!" })!;
  const identityController = new IdentityHttpController(identity, false);
  const adapter = new DirectImportAdapter();
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [adapter], tenantId: "tenant-alpha" });
  const created = await service.createAccount(ownerSession.principal, {
    platform: "reddit",
    expectedNativeUserId: "native-user-1",
  });
  const sessionController = new OwnerRedditSessionImportController(
    service,
    (request) => identityController.authenticateRequest(request, true, false),
  );
  const server = createSocialGitHttpServer({
    service,
    identity: identityController,
    ownerSessionImport: sessionController,
    authenticate: (request) => identityController.authenticateRequest(request),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const path = `/v1/control-plane/accounts/${created.account.id}/reddit-session`;
  const sentinelCookie = "owner-cookie-sentinel-62a1";
  const sentinelCsrf = "reddit-csrf-sentinel-0b4e";
  const valid = {
    version: 1,
    platform: "reddit",
    expectedNativeUserId: "native-user-1",
    redditSessionCookie: sentinelCookie,
    csrfToken: sentinelCsrf,
  };
  const ownerHeaders = {
    cookie: `social_git_session=${ownerSession.token}`,
    "x-csrf-token": ownerSession.csrfToken,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  try {
    assert.equal((await upload(base, path, valid, { ...ownerHeaders, cookie: undefined })).status, 401);
    assert.equal((await upload(base, path, valid, { ...ownerHeaders, "x-csrf-token": undefined })).status, 401);
    assert.equal((await upload(base, path, valid, { ...ownerHeaders, "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await upload(base, path, valid, { ...ownerHeaders, authorization: "Bearer api-key-must-not-work" })).status, 403);
    assert.equal((await upload(base, path, valid, {
      ...ownerHeaders,
      cookie: `social_git_session=${memberSession.token}`,
      "x-csrf-token": memberSession.csrfToken,
    })).status, 403);
    assert.equal((await upload(base, path, { ...valid, cookies: {} }, ownerHeaders)).status, 422);
    const oversized = await fetch(`${base}${path}`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ ...valid, redditSessionCookie: "a".repeat(25 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const mismatch = await upload(base, path, valid, ownerHeaders);
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.text.includes(sentinelCookie), false);
    assert.equal(mismatch.text.includes(sentinelCsrf), false);
    assert.equal(adapter.revoked, 1);
    assert.ok(adapter.capturedSession?.every((byte) => byte === 0));
    assert.ok(adapter.capturedRoute?.every((byte) => byte === 0));
    assert.deepEqual(pickHealth(store.getAccount(created.account.id)), {
      connectionHealth: "action_required",
      actionRequiredReason: "WRONG_IDENTITY",
      healthGeneration: 1,
    });

    adapter.actualIdentity = "native-user-1";
    const accepted = await upload(base, path, valid, ownerHeaders);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.text.includes(sentinelCookie), false);
    assert.equal(accepted.text.includes(sentinelCsrf), false);
    assert.equal((JSON.parse(accepted.text) as any).connection.generation, 2);
    assert.deepEqual(pickHealth(store.getAccount(created.account.id)), {
      connectionHealth: "healthy",
      actionRequiredReason: null,
      healthGeneration: 2,
    });
    assert.ok(adapter.capturedSession?.every((byte) => byte === 0));
    assert.ok(adapter.capturedRoute?.every((byte) => byte === 0));
    const observable = JSON.stringify({
      account: store.getAccount(created.account.id),
      audit: store.listAuditEvents({ limit: 100 }),
    });
    assert.equal(observable.includes(sentinelCookie), false);
    assert.equal(observable.includes(sentinelCsrf), false);
    const healthEvents = store.listAuditEvents({ limit: 100 }).items.filter((event) => event.type === "connection.health.changed");
    assert.equal(healthEvents.length, 4);
    assert.deepEqual(healthEvents.map((event) => event.outcome), ["pending", "action_required", "pending", "succeeded"]);
  } finally {
    server.close();
    await once(server, "close");
    store.close();
    identity.close();
    identityDatabase.cleanup();
  }
});

test("concurrent owner Reddit imports serialize generation, verification, and rollback per account", async () => {
  const adapter = new SerializedDirectImportAdapter();
  adapter.actualIdentity = "native-user-1";
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [adapter], tenantId: "tenant-alpha" });
  const owner = {
    callerId: "owner-1",
    tenantId: "tenant-alpha",
    workspaceId: "tenant-alpha",
    role: "owner" as const,
    scopes: ["accounts:write", "connections:write"],
  };
  const created = await service.createAccount(owner, { platform: "reddit", expectedNativeUserId: "native-user-1" });
  const firstSession = Buffer.from("first-session");
  const firstRoute = Buffer.from("first-route");
  const secondSession = Buffer.from("second-session");
  const secondRoute = Buffer.from("second-route");
  try {
    const first = service.importOwnerRedditSession(owner, created.account.id, {
      expectedNativeUserId: "native-user-1",
      session: firstSession,
      networkRoute: { id: "reddit-direct", material: firstRoute },
    });
    await adapter.firstPrepareEntered;
    const second = service.importOwnerRedditSession(owner, created.account.id, {
      expectedNativeUserId: "native-user-1",
      session: secondSession,
      networkRoute: { id: "reddit-direct", material: secondRoute },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(adapter.nextGenerationCalls, 1);
    assert.equal(adapter.prepareCalls, 1);
    adapter.releaseFirstPrepare();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(({ connection }) => connection.generation), [1, 2]);
    assert.equal(adapter.revoked, 0);
    assert.equal(store.getConnection(created.account.id).generation, 2);
  } finally {
    firstSession.fill(0);
    firstRoute.fill(0);
    secondSession.fill(0);
    secondRoute.fill(0);
    store.close();
  }
});

async function upload(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string | undefined>,
) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function pickHealth(account: ReturnType<LedgerStore["getAccount"]>) {
  return {
    connectionHealth: account.connectionHealth,
    actionRequiredReason: account.actionRequiredReason,
    healthGeneration: account.healthGeneration,
  };
}
