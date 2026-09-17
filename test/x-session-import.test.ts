import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionRuntime } from "@social-git/core";
import type { PlatformAdapter } from "../src/adapter.ts";
import {
  createSocialGitHttpServer,
  DisabledXPlatformAdapter,
  IdentityHttpController,
  IdentityStore,
  LedgerStore,
  OwnerXSessionImportController,
  SocialGitService,
} from "../src/index.ts";
import { tempDatabase } from "./helpers.ts";

test("owner X session upload is exact, owner/CSRF bound, encrypted, reconnectable, and fail-closed without network admission", async () => {
  const files = tempDatabase();
  const identity = new IdentityStore(join(files.root, "identity.sqlite"), { tenantId: "tenant-alpha" });
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
  const sessionRuntime = new SessionRuntime({
    databasePath: join(files.root, "sessions.sqlite"),
    tenantId: "tenant-alpha",
    masterKey: randomBytes(32),
    auditKey: randomBytes(32),
  });
  const adapter = new DisabledXPlatformAdapter(sessionRuntime);
  const store = new LedgerStore(join(files.root, "actions.sqlite"));
  const service = new SocialGitService({ store, adapters: [adapter], tenantId: "tenant-alpha" });
  const created = await service.createAccount(ownerSession.principal, { platform: "x", expectedNativeUserId: "123456789" });
  const controller = new OwnerXSessionImportController(
    service,
    (request) => identityController.authenticateRequest(request, true, false),
  );
  const server = createSocialGitHttpServer({
    service,
    identity: identityController,
    ownerSessionImport: controller,
    authenticate: (request) => identityController.authenticateRequest(request),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const path = `/v1/control-plane/accounts/${created.account.id}/x-session`;
  const authToken = "x-auth-sentinel-0d8362";
  const csrfToken = "x-ct0-sentinel-6a9c54";
  const valid = { platform: "x", expectedNativeUserId: "123456789", auth_token: authToken, ct0: csrfToken };
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
    assert.equal((await upload(base, path, valid, { ...ownerHeaders, authorization: "Bearer api-keys-are-forbidden" })).status, 403);
    assert.equal((await upload(base, path, valid, {
      ...ownerHeaders,
      cookie: `social_git_session=${memberSession.token}`,
      "x-csrf-token": memberSession.csrfToken,
    })).status, 403);
    assert.equal((await upload(base, path, { ...valid, password: "must-never-be-accepted" }, ownerHeaders)).status, 422);
    assert.equal((await upload(base, path, { ...valid, platform: "twitter" }, ownerHeaders)).status, 422);
    assert.equal((await upload(base, path, { ...valid, expectedNativeUserId: "@display_name" }, ownerHeaders)).status, 422);
    assert.equal((await upload(base, path, { ...valid, expectedNativeUserId: "999" }, ownerHeaders)).status, 409);
    const oversized = await fetch(`${base}${path}`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ ...valid, auth_token: "a".repeat(25 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const accepted = await upload(base, path, valid, ownerHeaders);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.text.includes(authToken), false);
    assert.equal(accepted.text.includes(csrfToken), false);
    const body = JSON.parse(accepted.text);
    assert.deepEqual(body.admission, { state: "action_required", code: "X_TRANSPORT_NOT_ADMITTED", generation: 1 });
    assert.equal(body.connection, null);
    assert.deepEqual(pickHealth(store.getAccount(created.account.id)), {
      connectionHealth: "action_required",
      actionRequiredReason: "PROTOCOL_DRIFT",
      healthGeneration: 1,
      actualNativeUserId: null,
    });
    assert.throws(() => store.getConnection(created.account.id), (error: any) => error.code === "NOT_FOUND");
    assert.deepEqual(
      { platform: sessionRuntime.getAccountState(created.account.id).platform, generation: sessionRuntime.getAccountState(created.account.id).generation },
      { platform: "x", generation: 1 },
    );

    const replacement = await upload(base, path, {
      ...valid,
      auth_token: "x-auth-replacement-1992",
      ct0: "x-ct0-replacement-72c1",
    }, ownerHeaders);
    assert.equal(replacement.status, 202);
    assert.equal(JSON.parse(replacement.text).admission.generation, 2);
    assert.equal(sessionRuntime.getAccountState(created.account.id).generation, 2);
    assert.equal(store.getAccount(created.account.id).healthGeneration, 2);

    const observable = JSON.stringify({ account: store.getAccount(created.account.id), audit: store.listAuditEvents({ limit: 100 }) });
    assert.equal(observable.includes(authToken), false);
    assert.equal(observable.includes(csrfToken), false);
    assert.equal(observable.includes("X_TRANSPORT_NOT_ADMITTED"), true);
    for (const filename of readdirSync(files.root)) {
      const content = readFileSync(join(files.root, filename));
      assert.equal(content.includes(Buffer.from(authToken)), false, `${filename} contains the auth token`);
      assert.equal(content.includes(Buffer.from(csrfToken)), false, `${filename} contains the ct0 token`);
    }
  } finally {
    server.close();
    await once(server, "close");
    store.close();
    sessionRuntime.close();
    identity.close();
    files.cleanup();
  }
});

test("owner X imports serialize generation and verify identity only after explicit transport admission", async () => {
  const adapter = new AdmittedSerializedXAdapter();
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [adapter], tenantId: "tenant-alpha" });
  const owner = {
    callerId: "owner-1",
    tenantId: "tenant-alpha",
    workspaceId: "tenant-alpha",
    role: "owner" as const,
    scopes: ["accounts:write", "connections:write"],
  };
  const created = await service.createAccount(owner, { platform: "x", expectedNativeUserId: "123456789" });
  const firstSession = Buffer.from("first-session");
  const firstRoute = Buffer.from("first-route");
  const secondSession = Buffer.from("second-session");
  const secondRoute = Buffer.from("second-route");
  try {
    const first = service.importOwnerXSession(owner, created.account.id, {
      expectedNativeUserId: "123456789",
      session: firstSession,
      networkRoute: { id: "x-direct", material: firstRoute },
    });
    await adapter.firstPrepareEntered;
    const second = service.importOwnerXSession(owner, created.account.id, {
      expectedNativeUserId: "123456789",
      session: secondSession,
      networkRoute: { id: "x-direct", material: secondRoute },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(adapter.nextGenerationCalls, 1);
    assert.equal(adapter.prepareCalls, 1);
    assert.equal(adapter.verifyCalls, 0);
    adapter.releaseFirstPrepare();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(({ admission }) => admission), [
      { state: "verified", generation: 1 },
      { state: "verified", generation: 2 },
    ]);
    assert.equal(adapter.verifyCalls, 2);
    assert.equal(store.getConnection(created.account.id).generation, 2);
    assert.deepEqual(pickHealth(store.getAccount(created.account.id)), {
      connectionHealth: "healthy",
      actionRequiredReason: null,
      healthGeneration: 2,
      actualNativeUserId: "123456789",
    });
  } finally {
    firstSession.fill(0);
    firstRoute.fill(0);
    secondSession.fill(0);
    secondRoute.fill(0);
    store.close();
  }
});

class AdmittedSerializedXAdapter implements PlatformAdapter {
  readonly platform = "x";
  readonly directSessionIdentityVerificationAdmitted = true;
  nextGenerationCalls = 0;
  prepareCalls = 0;
  verifyCalls = 0;
  generation = 0;
  private firstPrepareRelease!: () => void;
  private firstPrepareEnteredResolve!: () => void;
  readonly firstPrepareEntered = new Promise<void>((resolve) => { this.firstPrepareEnteredResolve = resolve; });
  private readonly firstPrepareGate = new Promise<void>((resolve) => { this.firstPrepareRelease = resolve; });
  nextConnectionGeneration() { this.nextGenerationCalls += 1; this.generation += 1; return this.generation; }
  async prepareDirectConnection() {
    this.prepareCalls += 1;
    if (this.prepareCalls === 1) { this.firstPrepareEnteredResolve(); await this.firstPrepareGate; }
  }
  releaseFirstPrepare() { this.firstPrepareRelease(); }
  async capabilities() { return []; }
  async verifyIdentity() { this.verifyCalls += 1; return { nativeUserId: "123456789" }; }
  async read() { throw new Error("not used"); }
  async submit() { return { status: "failed" as const, code: "CAPABILITY_UNAVAILABLE", message: "not used" }; }
  async reconcile() { return { status: "pending" as const }; }
  async revoke() {}
}

async function upload(base: string, path: string, body: unknown, headers: Record<string, string | undefined>) {
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
    actualNativeUserId: account.actualNativeUserId,
  };
}
