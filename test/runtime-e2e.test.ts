import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeWorkerMessage, encodeWorkerMessage, restoreEncryptedBackup, SESSION_RUNTIME_SCHEMA_VERSION, type WorkerCommand } from "@social-git/core";
import { loadRuntimeConfig, startSocialGitRuntime } from "../src/index.ts";
import { restoreActionLedgerBackup } from "../src/ledger-backup.ts";
import { restoreIdentityBackup } from "../src/identity-backup.ts";
import { RuntimeMaintenanceGate } from "../src/maintenance.ts";
import { REDDIT_COMMAND_MAC_CONTEXT, RedditCommandMacSigner, RedditCommandMacVerifier } from "../src/reddit-ipc-auth.ts";

const TOKEN = "fixture-boundary-token-with-enough-entropy";
const REDDIT_COMMAND_KEY = Buffer.alloc(32, 11);

test("owner web backups create one restorable bound set and reject API keys, paths, missing CSRF, and concurrent jobs", async () => {
  const fixture = runtimeFiles();
  const originalRunExclusive = RuntimeMaintenanceGate.prototype.runExclusive;
  const enteredBackup = Promise.withResolvers<void>();
  const releaseBackup = Promise.withResolvers<void>();
  let holdNextBackup = true;
  RuntimeMaintenanceGate.prototype.runExclusive = async function <T>(options: {
    pause: () => Promise<void>;
    resume: () => void;
    task: () => Promise<T> | T;
  }): Promise<T> {
    if (holdNextBackup) {
      holdNextBackup = false;
      enteredBackup.resolve();
      await releaseBackup.promise;
    }
    return originalRunExclusive.call(this, options) as Promise<T>;
  };
  let runtime: Awaited<ReturnType<typeof startSocialGitRuntime>> | undefined;
  try {
    runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
    const setup = await browserRequest(runtime.url, "/v1/setup/owner", {
      method: "POST",
      body: { email: "backup-owner@example.com", displayName: "Backup Owner", password: "backup-owner-password!" },
    });
    assert.equal(setup.status, 201);
    const ownerCookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
    const csrf = setup.body.csrfToken as string;

    const createdKey = await browserRequest(runtime.url, "/v1/control-plane/api-keys", {
      method: "POST", cookie: ownerCookie, csrf, body: { name: "not-a-backup-operator", scopes: ["accounts:read"] },
    });
    assert.equal(createdKey.status, 201);
    const apiKeyDenied = await browserRequest(runtime.url, "/v1/control-plane/backups", {
      authorization: `Bearer ${createdKey.body.secret}`,
    });
    assert.equal(apiKeyDenied.status, 401);
    const provisioned = await browserRequest(runtime.url, "/v1/control-plane/members", {
      method: "POST", cookie: ownerCookie, csrf,
      body: { email: "backup-member@example.com", displayName: "Backup Member", password: "backup-member-password!", role: "member" },
    });
    assert.equal(provisioned.status, 201);
    const memberLogin = await browserRequest(runtime.url, "/v1/auth/login", {
      method: "POST", body: { email: "backup-member@example.com", password: "backup-member-password!" },
    });
    assert.equal(memberLogin.status, 200);
    const memberCookie = memberLogin.headers.get("set-cookie")!.split(";", 1)[0]!;
    const memberCsrf = memberLogin.body.csrfToken as string;
    const memberBackupRead = await browserRequest(runtime.url, "/v1/control-plane/backups", { cookie: memberCookie });
    assert.equal(memberBackupRead.status, 403);
    assert.equal(memberBackupRead.body.error.code, "FORBIDDEN");
    const memberBackupCreate = await browserRequest(runtime.url, "/v1/control-plane/backups", {
      method: "POST", cookie: memberCookie, csrf: memberCsrf, body: {},
    });
    assert.equal(memberBackupCreate.status, 403);
    assert.equal((await browserRequest(runtime.url, "/v1/control-plane/upgrades/status", { cookie: memberCookie })).status, 403);
    assert.equal((await browserRequest(runtime.url, "/v1/control-plane/backups", { cookie: ownerCookie })).status, 200);
    assert.equal((await browserRequest(runtime.url, "/v1/control-plane/backups", {
      method: "POST", cookie: ownerCookie, body: {},
    })).status, 401);
    const rejectedPath = await browserRequest(runtime.url, "/v1/control-plane/backups", {
      method: "POST", cookie: ownerCookie, csrf, body: { path: "/tmp/escape", name: "chosen" },
    });
    assert.equal(rejectedPath.status, 422);
    assert.match(rejectedPath.body.error.message, /does not accept paths, names, or options/u);

    const started = await browserRequest(runtime.url, "/v1/control-plane/backups", {
      method: "POST", cookie: ownerCookie, csrf, body: {},
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.match(started.body.backup.id, /^backup-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u);
    await enteredBackup.promise;
    const concurrent = await browserRequest(runtime.url, "/v1/control-plane/backups", {
      method: "POST", cookie: ownerCookie, csrf, body: {},
    });
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.error.code, "BACKUP_IN_PROGRESS");
    releaseBackup.resolve();

    let summary: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await browserRequest(runtime.url, "/v1/control-plane/backups", { cookie: ownerCookie });
      summary = listed.body.items.find((item: any) => item.id === started.body.backup.id);
      if (summary?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(summary.status, "ready", JSON.stringify(summary));
    assert.equal(summary.databaseCount, 3);
    assert.ok(summary.sizeBytes > 0);
    const publicText = JSON.stringify(summary);
    assert.equal(publicText.includes("fixture-tenant"), false);
    assert.equal(publicText.includes("fixture-action-ledger"), false);
    assert.equal(publicText.includes("/"), false);

    const backupDirectory = join(fixture.root, "data", "backups", summary.id);
    for (const file of ["sessions.backup", "actions.backup", "identity.backup", "manifest.json"]) {
      assert.equal(existsSync(join(backupDirectory, file)), true);
    }
    const restoreDirectory = join(fixture.root, "restored");
    mkdirSync(restoreDirectory, { mode: 0o700 });
    const backupKey = Buffer.alloc(32, 9);
    try {
      restoreEncryptedBackup({
        backupPath: join(backupDirectory, "sessions.backup"),
        destinationPath: join(restoreDirectory, "sessions.sqlite"),
        backupKey,
        tenantId: "fixture-tenant",
        schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION,
      });
      restoreActionLedgerBackup({
        backupPath: join(backupDirectory, "actions.backup"),
        destinationPath: join(restoreDirectory, "actions.sqlite"),
        backupKey,
        auditKey: Buffer.alloc(32, 8),
        ledgerId: "fixture-action-ledger",
      });
      restoreIdentityBackup({
        backupPath: join(backupDirectory, "identity.backup"),
        destinationPath: join(restoreDirectory, "identity.sqlite"),
        backupKey,
        auditKey: Buffer.alloc(32, 8),
        tenantId: "fixture-tenant",
      });
    } finally { backupKey.fill(0); }

    const upgrade = await browserRequest(runtime.url, "/v1/control-plane/upgrades/status", { cookie: ownerCookie });
    assert.deepEqual(
      { status: upgrade.status, channel: upgrade.body.channel, automation: upgrade.body.automation, latestVersion: upgrade.body.latestVersion },
      { status: 200, channel: "manual", automation: "unavailable", latestVersion: null },
    );
    assert.equal((await browserRequest(runtime.url, "/v1/control-plane/upgrades/status", {
      method: "POST", cookie: ownerCookie, csrf, body: {},
    })).status, 405);
  } finally {
    releaseBackup.resolve();
    RuntimeMaintenanceGate.prototype.runExclusive = originalRunExclusive;
    await runtime?.close();
    fixture.close();
  }
});

test("executable REST and MCP gateway completes the fixture lifecycle and restart replay", async () => {
  const fixture = runtimeFiles();
  let runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    assert.equal((await fetch(`${runtime.url}/healthz`)).status, 200);
    const ready = await fetch(`${runtime.url}/readyz`);
    assert.equal(ready.status, 200);
    const readiness = await ready.json() as any;
    assert.equal(readiness.contractVersion, 1);
    assert.equal(readiness.checks.actionWorker, true);
    assert.equal(readiness.checks.workers.reddit.state, "fixture_embedded");
    assert.equal(readiness.checks.workers.x.admission, "capability_disabled");

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

test("production owner and scoped API key writes use the isolated worker without a certification grant", async () => {
  const fixture = runtimeFiles();
  const sessionImportDir = join(fixture.root, "session-imports");
  mkdirSync(sessionImportDir, { mode: 0o700 });
  const worker = await productionWorkerFixture();
  fixture.environment.NODE_ENV = "production";
  fixture.environment.SOCIAL_GIT_MODE = "production";
  fixture.environment.SOCIAL_GIT_SESSION_IMPORT_DIR = sessionImportDir;
  fixture.environment.SOCIAL_GIT_SESSION_COOKIE_SECURE = "false";
  fixture.environment.SOCIAL_GIT_REDDIT_WORKER_URL = worker.url;
  delete fixture.environment.SOCIAL_GIT_AUTH_FILE;
  const runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    const ready = await request(runtime.url, "/readyz", { headers: { authorization: "" } });
    assert.equal(ready.status, 200);
    assert.equal(ready.body.checks.actionWorker, true);
    assert.equal(ready.body.checks.productWritesReady, true);
    assert.equal(ready.body.checks.certificationGrantActive, false);
    assert.equal(ready.body.checks.writeExecutionMode, "product");
    assert.equal(ready.body.contractVersion, 1);
    assert.equal(ready.body.checks.databases.actions.ready, true);
    assert.equal(ready.body.checks.databases.sessions.ready, true);
    assert.equal(ready.body.checks.databases.identity.ready, true);
    assert.equal(ready.body.checks.workers.reddit.state, "reachable");
    assert.equal(ready.body.checks.workers.x.required, false);
    assert.equal(ready.body.checks.workers.x.admission, "capability_disabled");
    assert.equal(typeof ready.body.checks.workers.x.reachable, "boolean");
    assert.equal(ready.body.checks.workers.webhook.ready, true);
    assert.equal(ready.body.checks.maintenance.state, "idle");
    const fixtureRoute = await request(runtime.url, "/__fixture/control", {
      method: "POST", headers: { authorization: "" }, body: { command: "reset", payload: {} },
    });
    assert.equal(fixtureRoute.status, 404);

    const setup = await request(runtime.url, "/v1/setup/owner", {
      method: "POST",
      headers: { authorization: "" },
      body: { email: "owner@example.com", displayName: "Owner", password: "owner-password-42!" },
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    const ownerCookie = (setup.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const ownerHeaders = { authorization: "", cookie: ownerCookie, "x-csrf-token": setup.body.csrfToken };
    const apiKey = await request(runtime.url, "/v1/control-plane/api-keys", {
      method: "POST",
      headers: ownerHeaders,
      body: {
        name: "production-writer",
        scopes: ["accounts:read", "accounts:write", "connections:write", "social:read", "social:write", "actions:read"],
      },
    });
    assert.equal(apiKey.status, 201, JSON.stringify(apiKey.body));
    const apiHeaders = { authorization: `Bearer ${apiKey.body.secret}` };
    const created = await request(runtime.url, "/v1/accounts", {
      method: "POST", headers: ownerHeaders,
      body: { platform: "reddit", expectedNativeUserId: "reddit:t2_fixture" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const accountId = created.body.account.id;
    writeProductionImport(sessionImportDir, "production-session");
    const imported = await request(runtime.url, `/v1/accounts/${accountId}/connections`, {
      method: "POST",
      headers: apiHeaders,
      body: { vaultHandle: "production-session", generation: 1 },
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));

    const input = { kind: "text_post", subreddit: "test", title: "Production title", text: "Production body" };
    const queued = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST", headers: { ...apiHeaders, "idempotency-key": "production-write-1" }, body: input,
    });
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    const completed = await waitForAction(runtime.url, queued.body.action.id, "succeeded", apiHeaders);
    assert.match(completed.result.nativeId, /^t3_production_/u);
    assert.equal(worker.writes.length, 1);
    assert.deepEqual(worker.writes[0], {
      tenantId: "fixture-tenant",
      accountId,
      platform: "reddit",
      generation: 1,
      intent: "write",
      operation: "post.createText",
    });

    const replay = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST", headers: { ...apiHeaders, "idempotency-key": "production-write-1" }, body: input,
    });
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.action.id, completed.id);
    assert.equal(worker.writes.length, 1);

    worker.dropNextWrite();
    const uncertain = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST",
      headers: { ...ownerHeaders, "idempotency-key": "production-write-unknown" },
      body: { ...input, title: "Unknown result" },
    });
    assert.equal(uncertain.status, 202, JSON.stringify(uncertain.body));
    const unknown = await waitForAction(runtime.url, uncertain.body.action.id, "UNKNOWN", {
      authorization: "", cookie: ownerCookie,
    });
    assert.equal(unknown.submissionMayHaveStarted, true);
    assert.equal(worker.writes.length, 2);
    const unknownReplay = await request(runtime.url, `/v1/accounts/${accountId}/actions`, {
      method: "POST",
      headers: { ...ownerHeaders, "idempotency-key": "production-write-unknown" },
      body: { ...input, title: "Unknown result" },
    });
    assert.equal(unknownReplay.body.replayed, true);
    assert.equal(unknownReplay.body.action.state, "UNKNOWN");
    assert.equal(worker.writes.length, 2, "UNKNOWN must not auto-resubmit");

    const xCapabilities = await request(runtime.url, "/v1/platforms/x/capabilities", { headers: apiHeaders });
    assert.equal(xCapabilities.status, 200, JSON.stringify(xCapabilities.body));
    assert.equal(xCapabilities.body.details.every((entry: any) => entry.productionEnabled === false), true);
    assert.equal(worker.commands.some((entry) => entry.platform === "x"), false);

    await worker.close();
    const unavailable = await request(runtime.url, "/readyz", { headers: { authorization: "" } });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.checks.actionWorker, true);
    assert.equal(unavailable.body.checks.redditWorker, false);
    assert.equal(unavailable.body.checks.productWritesReady, false);
    assert.equal(unavailable.body.checks.certificationGrantActive, false);
    assert.equal(unavailable.body.checks.workers.reddit.state, "unreachable");
  } finally {
    await runtime.close();
    await worker.close();
    fixture.close();
  }
});

test("production web control plane serves responsive safe assets and keeps X visibly fail-closed", async () => {
  const fixture = runtimeFiles();
  const sessionImportDir = join(fixture.root, "session-imports");
  mkdirSync(sessionImportDir, { mode: 0o700 });
  fixture.environment.NODE_ENV = "production";
  fixture.environment.SOCIAL_GIT_MODE = "production";
  fixture.environment.SOCIAL_GIT_SESSION_IMPORT_DIR = sessionImportDir;
  const runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    const page = await fetch(`${runtime.url}/app/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
    const [view, client, styles] = await Promise.all([
      fetch(`${runtime.url}/app/assets/view.js`).then((response) => response.text()),
      fetch(`${runtime.url}/app/assets/client.js`).then((response) => response.text()),
      fetch(`${runtime.url}/app/assets/styles.css`).then((response) => response.text()),
    ]);
    const browserAssets = `${view}\n${client}`;
    assert.match(view, /X \(encrypted custody only\)/u);
    assert.match(view, /Execution unavailable/u);
    assert.match(browserAssets, /\/x-session/u);
    assert.doesNotMatch(browserAssets, /vault:\/\/staged\/reference/u);
    assert.doesNotMatch(browserAssets, /(?:localStorage|sessionStorage)/u);
    assert.match(styles, /@media \(max-width: 820px\)/u);
    assert.match(styles, /@media \(max-width: 620px\)/u);

    const xCatalog = await request(runtime.url, "/v1/platforms/x/capabilities");
    assert.equal(xCatalog.status, 200);
    assert.equal(xCatalog.body.details.every((detail: any) => detail.productionEnabled === false), true);
    assert.equal(xCatalog.body.details.every((detail: any) => detail.disabledReasons.length > 0), true);
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
  const backup = join(root, "backup.key");
  const redditCommand = join(root, "reddit-command.key");
  const xCommand = join(root, "x-command.key");
  const auth = join(root, "auth.json");
  writeFileSync(master, Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
  writeFileSync(audit, Buffer.alloc(32, 8).toString("base64url"), { mode: 0o600 });
  writeFileSync(backup, Buffer.alloc(32, 9).toString("base64url"), { mode: 0o600 });
  writeFileSync(redditCommand, Buffer.alloc(32, 11).toString("base64url"), { mode: 0o600 });
  writeFileSync(xCommand, Buffer.alloc(32, 10).toString("base64url"), { mode: 0o600 });
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
    SOCIAL_GIT_BACKUP_KEY_FILE: backup,
    SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE: redditCommand,
    SOCIAL_GIT_X_COMMAND_KEY_FILE: xCommand,
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

async function browserRequest(base: string, path: string, options: {
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

async function waitForAction(base: string, actionId: string, state: string, headers?: Record<string, string>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(base, `/v1/actions/${actionId}`, { ...(headers ? { headers } : {}) });
    if (response.body.action.state === state) return response.body.action;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Action ${actionId} did not reach ${state}`);
}

function writeProductionImport(directory: string, handle: string) {
  const session = Buffer.from(JSON.stringify({
    cookies: { reddit_session: "synthetic-session-cookie" },
    csrfToken: "synthetic-csrf-token",
    userAgent: "social-git-production-test/1.0",
  })).toString("base64url");
  const route = Buffer.from(JSON.stringify({ kind: "direct" })).toString("base64url");
  writeFileSync(join(directory, `${handle}.json`), JSON.stringify({
    sessionBase64: session,
    networkRoute: { id: "route-production", materialBase64: route },
  }), { mode: 0o600 });
}

async function productionWorkerFixture() {
  const commands: Array<Pick<WorkerCommand, "tenantId" | "accountId" | "platform" | "generation" | "intent" | "operation">> = [];
  const writes: typeof commands = [];
  let writeNumber = 0;
  let dropWrite = false;
  const signer = new RedditCommandMacSigner(REDDIT_COMMAND_KEY);
  const verifier = new RedditCommandMacVerifier(REDDIT_COMMAND_KEY);
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/readyz") {
      const empty = Buffer.alloc(0);
      assert.equal(verifier.verify(request.headers, empty, REDDIT_COMMAND_MAC_CONTEXT.readinessRequest), true);
      const body = Buffer.from(JSON.stringify({ version: 1, role: "reddit-worker", status: "ready", inFlight: 0, requestNonce: request.headers["x-social-git-command-nonce"] }));
      response.writeHead(200, { "content-type": "application/json", "content-length": body.length, ...signer.headers(body, REDDIT_COMMAND_MAC_CONTEXT.response(200)) });
      response.end(body);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      try {
        assert.equal(verifier.verify(request.headers, body, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), true);
        const command = decodeWorkerMessage(body);
        assert.equal(command.type, "social-git.worker.command");
        const observed = {
          tenantId: command.tenantId,
          accountId: command.accountId,
          platform: command.platform,
          generation: command.generation,
          intent: command.intent,
          operation: command.operation,
        };
        commands.push(observed);
        if (command.intent === "write") {
          writes.push(observed);
          writeNumber += 1;
          if (dropWrite) {
            dropWrite = false;
            request.socket.destroy();
            return;
          }
        }
        const native = command.intent === "write"
          ? {
              nativeId: `t3_production_${writeNumber}`,
              canonicalUrl: `https://www.reddit.com/r/test/comments/production_${writeNumber}/title/`,
            }
          : { nativeId: command.expectedNativeIdentity.replace(/^reddit:/u, "") };
        const message = encodeWorkerMessage({
          version: 1,
          type: "social-git.worker.result",
          requestId: command.requestId,
          tenantId: command.tenantId,
          accountId: command.accountId,
          platform: command.platform,
          generation: command.generation,
          leaseId: command.leaseId,
          fence: command.fence,
          status: "SUCCEEDED",
          observedNativeIdentity: command.expectedNativeIdentity,
          nativeId: native.nativeId,
          ...(native.canonicalUrl ? { canonicalUrl: native.canonicalUrl } : {}),
        });
        const responseBody = Buffer.from(JSON.stringify({
          version: 1,
          requestNonce: request.headers["x-social-git-command-nonce"],
          messageBase64: Buffer.from(message).toString("base64url"),
          platformResult: { native, data: { accepted: true } },
        }));
        response.writeHead(200, { "content-type": "application/json", "content-length": responseBody.length, ...signer.headers(responseBody, REDDIT_COMMAND_MAC_CONTEXT.response(200)) });
        response.end(responseBody, () => responseBody.fill(0));
        message.fill(0);
      } finally {
        body.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1/dispatch`,
    commands,
    writes,
    dropNextWrite() { dropWrite = true; },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      signer.close(); verifier.close();
    },
  };
}
