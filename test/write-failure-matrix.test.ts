import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeConfig, startSocialGitRuntime } from "../src/index.ts";
import { REDDIT_CAPABILITIES } from "@social-git/reddit-adapter";

/**
 * Table-driven failure matrix for every production-enabled Reddit write kind.
 *
 * Layer: the executable public boundary (real fixture runtime + HTTP API), the
 * same layer qa/acceptance/service-driver.mjs drives. That layer is where the
 * fixture can inject an outcome per account+operation
 * (src/fixture-reddit-adapter.ts setNextOutcome / setCrashAfterSubmit), so it is
 * the only layer that can assert normalized action state AND account health for
 * every kind without mocking production code.
 *
 * Every cell is either applicable, or marked N/A with an explicit reason. No
 * cell is silently skipped.
 */

const TOKEN = "write-failure-matrix-token";
const OWNED_POST = "t3_owned_fixture";
const OWNED_COMMENT = "t1_owned_fixture";

/**
 * The 12 production-enabled Reddit write kinds. The expected set is derived
 * from the adapter package's own production admission flags (mapped from its
 * operation names to public write kinds), so this table cannot drift from what
 * the product claims to enable.
 */
const ADAPTER_OPERATION_TO_KIND: Readonly<Record<string, string>> = Object.freeze({
  "post.createText": "text_post",
  "post.createLink": "link_post",
  "post.createMedia": "media_post",
  "comment.create": "comment",
  "reply.create": "reply",
  "item.editOwn": "edit",
  "vote.set": "vote",
  "save.set": "save",
  "save.unset": "unsave",
  "subreddit.subscribe": "subscribe",
  "subreddit.unsubscribe": "unsubscribe",
  "item.deleteOwn": "delete",
});

const PRODUCTION_ENABLED_KINDS: readonly string[] = Object.freeze(
  REDDIT_CAPABILITIES
    .filter((capability: { mode: string; productionEnabled: boolean }) => capability.mode === "write" && capability.productionEnabled)
    .map((capability: { operation: string }) => {
      const kind = ADAPTER_OPERATION_TO_KIND[capability.operation];
      assert.ok(kind, `no public write kind is mapped for production-enabled ${capability.operation}`);
      return kind;
    }),
);
const KINDS = Object.freeze([
  { kind: "text_post", body: () => ({ kind: "text_post", subreddit: "qualityassurance", title: "Matrix", text: "Matrix body" }) },
  { kind: "link_post", body: () => ({ kind: "link_post", subreddit: "qualityassurance", title: "Matrix", url: "https://example.test/matrix" }) },
  { kind: "media_post", body: () => ({ kind: "media_post", subreddit: "qualityassurance", title: "Matrix", mediaRef: "core-media:placeholder" }) },
  { kind: "comment", body: () => ({ kind: "comment", postId: OWNED_POST, text: "Matrix comment" }) },
  { kind: "reply", body: () => ({ kind: "reply", commentId: OWNED_COMMENT, text: "Matrix reply" }) },
  { kind: "edit", body: () => ({ kind: "edit", targetId: OWNED_POST, text: "Matrix edit" }) },
  { kind: "vote", body: () => ({ kind: "vote", targetId: OWNED_POST, direction: 1 }) },
  { kind: "save", body: () => ({ kind: "save", targetId: OWNED_POST }) },
  { kind: "unsave", body: () => ({ kind: "unsave", targetId: OWNED_POST }) },
  { kind: "subscribe", body: () => ({ kind: "subscribe", subreddit: "qualityassurance" }) },
  { kind: "unsubscribe", body: () => ({ kind: "unsubscribe", subreddit: "qualityassurance" }) },
  { kind: "delete", body: () => ({ kind: "delete", targetId: OWNED_POST }) },
]);

const ADMITTED_WRITE_OPERATIONS = PRODUCTION_ENABLED_KINDS;

const CELLS = Object.freeze([
  "success",
  "wrongIdentity",
  "challenge",
  "rateLimit",
  "revocation",
  "drift",
  "crashAfterSubmit",
  "reconcile",
  "idempotency",
]);

/**
 * Explicit per-kind, per-cell sub-assertion exclusions. Each entry carries a
 * reason and is asserted to exist only where it is declared here. Nothing is
 * skipped silently.
 */
const CELL_EXCLUSIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "media_post.idempotency": Object.freeze({
    crossCaller:
      "A media reference is minted caller-scoped by Core (media_assets.caller_id); a second caller reusing the same mediaRef is rejected with 422 before dispatch, so the caller-scoped-independence leg cannot use the same body.",
  }),
});

const CELL_TODOS: Readonly<Record<string, string>> = Object.freeze({});

test("matrix covers exactly the production-enabled Reddit write kinds", () => {
  assert.deepEqual(
    KINDS.map(({ kind }) => kind).sort(),
    [...PRODUCTION_ENABLED_KINDS].sort(),
    "the matrix must list every production-enabled Reddit write kind and no others",
  );
  for (const { kind } of KINDS) {
    for (const cell of CELLS) {
      const reason = CELL_EXCLUSIONS[`${kind}.${cell}`]?.crossCaller ?? CELL_EXCLUSIONS[`${kind}.${cell}`]?.reason;
      assert.ok(
        reason === undefined || (typeof reason === "string" && reason.length > 0),
        `${kind}.${cell} exclusion must carry an explicit reason`,
      );
    }
  }
  // Every declared exclusion must name a real kind and cell, so a typo cannot
  // quietly disable a cell.
  const validCells = new Set(KINDS.flatMap(({ kind }) => CELLS.map((cell) => `${kind}.${cell}`)));
  for (const key of [...Object.keys(CELL_EXCLUSIONS), ...Object.keys(CELL_TODOS)]) {
    assert.ok(validCells.has(key), `exclusion/todo references an unknown matrix cell: ${key}`);
  }
});

test("write failure matrix: every production-enabled Kind × cell", async (t) => {
  const fixture = runtimeFiles();
  const runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  const request = httpClient(runtime.url);
  try {
    for (const entry of KINDS) {
      for (const cell of CELLS) {
        const cellKey = `${entry.kind}.${cell}`;
        const todo = CELL_TODOS[cellKey];
        await t.test(cellKey, { todo }, async () => {
          await runCell(request, fixture, entry, cell);
        });
      }
    }
  } finally {
    await runtime.close();
    fixture.close();
  }
});

async function runCell(request: Http, fixture: Fixture, entry: KindEntry, cell: string) {
  const account = await connectAccount(request, fixture);

  switch (cell) {
    case "success": return assertSuccessCell(request, account, entry);
    case "wrongIdentity": return assertWrongIdentityCell(request, fixture, entry);
    case "challenge": return assertPlatformStopCell(request, account, entry, "challenge", "CHALLENGE_REQUIRED");
    case "rateLimit": return assertPlatformStopCell(request, account, entry, "rate_limit", "RATE_LIMITED");
    case "revocation": return assertPlatformStopCell(request, account, entry, "revoked", "SESSION_REVOKED");
    case "drift": return assertPlatformStopCell(request, account, entry, "protocol_drift", "PROTOCOL_DRIFT");
    case "crashAfterSubmit": return assertCrashAfterSubmitCell(request, account, entry);
    case "reconcile": return assertReconcileCell(request, account, entry);
    case "idempotency": return assertIdempotencyCell(request, account, entry);
    default: throw new Error(`Unhandled matrix cell ${cell}`);
  }
}

// (a) success with native id / canonical URL where the platform supplies one.
async function assertSuccessCell(request: Http, account: Account, entry: KindEntry) {
  const before = await platformCalls(request, entry.kind);
  const response = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `success-${entry.kind}`);
  assert.equal(response.createStatus, 202, `${entry.kind} must be accepted for dispatch`);
  assert.equal(response.action.state, "succeeded", `${entry.kind} must confirm: ${JSON.stringify(response.action.error ?? {})}`);
  assert.equal(typeof response.action.result?.nativeId, "string");
  assert.match(response.action.result.nativeId, /^t[0-9]_[a-z0-9]+$/u);
  assert.equal(typeof response.action.result?.canonicalUrl, "string");
  assert.match(new URL(response.action.result.canonicalUrl).hostname, /(^|\.)reddit\.com$/u);
  assert.equal(await platformCalls(request, entry.kind), before + 1, `${entry.kind} must dispatch exactly once`);

  const health = await request(`/v1/accounts/${account.accountId}`, { method: "GET" });
  assert.equal(health.body.account.connectionHealth, "healthy");
  assert.equal(health.body.account.actionRequiredReason, null);
}

// (b) wrong native identity stops before any submission.
async function assertWrongIdentityCell(request: Http, fixture: Fixture, entry: KindEntry) {
  const account = await connectAccount(request, fixture, {
    expectedIdentity: "fixture_user",
    stagedIdentity: "synthetic_impostor",
  });
  // The connection itself must already refuse the mismatched identity.
  assert.equal(account.connectStatus, 409);
  assert.equal(account.connectBody.error.code, "WRONG_IDENTITY");

  const before = await platformCalls(request, entry.kind);
  const response = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `wrong-identity-${entry.kind}`);
  assert.equal(response.action, null, `${entry.kind} must not be dispatched for a wrong-identity account`);
  assert.equal(response.createBody.error.code, "WRONG_IDENTITY");
  assert.equal(await platformCalls(request, entry.kind), before, `${entry.kind} must not reach the platform`);

  const health = await request(`/v1/accounts/${account.accountId}`, { method: "GET" });
  assert.equal(health.body.account.connectionHealth, "action_required");
  assert.equal(health.body.account.actionRequiredReason, "WRONG_IDENTITY");
}

// (c) challenge / rate limit / revocation / protocol drift stop the action and
// move account health to the matching normalized state.
async function assertPlatformStopCell(
  request: Http,
  account: Account,
  entry: KindEntry,
  outcome: string,
  expectedCode: string,
) {
  const before = await platformCalls(request, entry.kind);
  const configured = await request("/__fixture/control", {
    method: "POST",
    body: { command: "next-platform-outcome", payload: { accountId: account.accountId, operation: operationName(entry.kind), outcome } },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const response = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `${outcome}-${entry.kind}`);
  assert.equal(response.createStatus, 202);
  assert.ok(["failed", "action_required"].includes(response.action.state), `${entry.kind} ${outcome} must stop, got ${response.action.state}`);
  assert.equal(response.action.error?.code, expectedCode);
  assert.ok(response.action.result == null, `${entry.kind} ${outcome} must not return a native result`);
  assert.equal(await platformCalls(request, entry.kind), before + 1, `${entry.kind} ${outcome} must not retry automatically`);

  // Replaying the same idempotency key must not dispatch again.
  const replay = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `${outcome}-${entry.kind}`);
  assert.deepEqual(replay.action, response.action);
  assert.equal(await platformCalls(request, entry.kind), before + 1, `${entry.kind} ${outcome} replay must not dispatch again`);

  const health = await request(`/v1/accounts/${account.accountId}`, { method: "GET" });
  const expectedReason = ({ CHALLENGE_REQUIRED: "CHALLENGE_REQUIRED", RATE_LIMITED: "RATE_LIMITED", SESSION_REVOKED: "SESSION_REVOKED", PROTOCOL_DRIFT: "PROTOCOL_DRIFT" } as Record<string, string>)[expectedCode]!;
  assert.equal(health.body.account.actionRequiredReason, expectedReason);
  assert.equal(
    health.body.account.connectionHealth,
    expectedCode === "SESSION_REVOKED" ? "revoked" : "action_required",
    `${entry.kind} ${outcome} must reflect ${expectedReason} in account health`,
  );
}

// (d) crash after the submit boundary yields UNKNOWN and never auto-retries.
async function assertCrashAfterSubmitCell(request: Http, account: Account, entry: KindEntry) {
  const before = await platformCalls(request, entry.kind);
  const configured = await request("/__fixture/control", {
    method: "POST",
    body: { command: "crash-after-submit", payload: { accountId: account.accountId, operation: operationName(entry.kind) } },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const response = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `crash-${entry.kind}`);
  assert.equal(response.createStatus, 202);
  assert.equal(response.action.state, "UNKNOWN", `${entry.kind} crash after submit must be UNKNOWN`);
  assert.equal(response.action.submissionMayHaveStarted, true);
  assert.ok(response.action.result == null, `${entry.kind} UNKNOWN must not expose an unverified native result`);
  assert.equal(await platformCalls(request, entry.kind), before + 1, `${entry.kind} must submit once then stop`);

  // Replaying the same key must not resubmit, and must return the same UNKNOWN action.
  const replay = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `crash-${entry.kind}`);
  assert.equal(replay.action.id, response.action.id);
  assert.equal(replay.action.state, "UNKNOWN");
  assert.equal(await platformCalls(request, entry.kind), before + 1, `${entry.kind} UNKNOWN must never be retried automatically`);
}

// (e) reconciling an UNKNOWN action verifies it without resubmitting.
async function assertReconcileCell(request: Http, account: Account, entry: KindEntry) {
  const configured = await request("/__fixture/control", {
    method: "POST",
    body: { command: "crash-after-submit", payload: { accountId: account.accountId, operation: operationName(entry.kind) } },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const crashed = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `reconcile-${entry.kind}`);
  assert.equal(crashed.action.state, "UNKNOWN");
  const afterSubmit = await platformCalls(request, entry.kind);
  const submitted = afterSubmit;
  assert.ok(submitted >= 1, `${entry.kind} must have submitted before reconcile`);

  // An unresolved reconcile keeps the action UNKNOWN and must not resubmit.
  await request("/__fixture/control", {
    method: "POST",
    body: { command: "reconciliation-outcome", payload: { actionId: crashed.action.id, outcome: "not_found" } },
  });
  const unresolved = await request(`/v1/actions/${crashed.action.id}/reconcile`, { method: "POST", body: {} });
  assert.equal(unresolved.status, 200, JSON.stringify(unresolved.body));
  assert.equal(unresolved.body.reconciled, false);
  assert.equal(unresolved.body.action.state, "UNKNOWN");
  assert.equal(await platformCalls(request, entry.kind), afterSubmit, `${entry.kind} unresolved reconcile must not resubmit`);

  // A confirmed reconciliation verifies the action without a new submission.
  const nativeId = expectedReconciledNativeId(entry.kind);
  await request("/__fixture/control", {
    method: "POST",
    body: {
      command: "reconciliation-outcome",
      payload: { actionId: crashed.action.id, outcome: "confirmed", nativeId, canonicalUrl: reconciledCanonicalUrl(entry.kind, nativeId) },
    },
  });
  const reconciled = await request(`/v1/actions/${crashed.action.id}/reconcile`, { method: "POST", body: {} });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.reconciled, true);
  assert.equal(reconciled.body.action.state, "succeeded");
  assert.equal(reconciled.body.action.result?.nativeId, nativeId);
  assert.equal(
    await platformCalls(request, entry.kind),
    afterSubmit,
    `${entry.kind} reconcile must verify without an additional platform submission`,
  );

  const replay = await dispatch(request, account.accountId, await bodyFor(request, account.accountId, entry), `reconcile-${entry.kind}`);
  assert.equal(replay.action.state, "succeeded");
  assert.equal(replay.action.result?.nativeId, nativeId);
  assert.equal(await platformCalls(request, entry.kind), afterSubmit, `${entry.kind} reconciled replay must not resubmit`);
}

// (f) caller-scoped idempotency: same caller+key+body → same action;
//     same key + different body → rejected before dispatch.
async function assertIdempotencyCell(request: Http, account: Account, entry: KindEntry) {
  const firstBody = await bodyFor(request, account.accountId, entry);
  const key = `idem-${entry.kind}`;
  const before = await platformCalls(request, entry.kind);

  const first = await dispatch(request, account.accountId, firstBody, key);
  assert.equal(first.action.state, "succeeded");
  const afterFirst = await platformCalls(request, entry.kind);
  assert.equal(afterFirst, before + 1);

  const duplicate = await dispatch(request, account.accountId, firstBody, key);
  assert.equal(duplicate.action.id, first.action.id, `${entry.kind} must reuse the same action`);
  assert.equal(duplicate.createBody.replayed, true);
  assert.equal(await platformCalls(request, entry.kind), afterFirst, `${entry.kind} duplicate must not dispatch again`);

  const conflicting = await dispatch(request, account.accountId, differentBody(entry), key);
  assert.equal(conflicting.action, null, `${entry.kind} conflicting body must be rejected before dispatch`);
  assert.equal(conflicting.createBody.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(await platformCalls(request, entry.kind), afterFirst, `${entry.kind} conflict must not dispatch`);

  // A different caller with the same key is an independent action. For media
  // this leg is excluded (see CELL_EXCLUSIONS) because a media reference is
  // caller-scoped, so the same body is rejected before dispatch.
  const crossCallerExclusion = CELL_EXCLUSIONS[`${entry.kind}.idempotency`]?.crossCaller;
  if (crossCallerExclusion === undefined) {
    const otherCaller = await dispatch(request, account.accountId, firstBody, key, "matrix-caller-b");
    assert.equal(otherCaller.action.state, "succeeded");
    assert.notEqual(otherCaller.action.id, first.action.id);
    assert.equal(await platformCalls(request, entry.kind), afterFirst + 1, `${entry.kind} must be caller-scoped`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let accountSequence = 0;

async function connectAccount(
  request: Http,
  fixture: Fixture,
  options: { expectedIdentity?: string; stagedIdentity?: string } = {},
): Promise<Account & { connectStatus?: number; connectBody?: any }> {
  accountSequence += 1;
  const sequence = accountSequence;
  const expectedIdentity = options.expectedIdentity ?? "fixture_user";
  const stagedIdentity = options.stagedIdentity ?? expectedIdentity;
  const vaultHandle = `matrix-session-${sequence}`;
  const staged = await request("/__fixture/control", {
    method: "POST",
    body: {
      command: "stage-session",
      payload: { vaultHandle, sessionFixture: `matrix-fixture-${sequence}`, nativeIdentity: stagedIdentity, routeId: `matrix-route-${sequence}` },
    },
  });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));

  const created = await request("/v1/accounts", {
    method: "POST",
    body: { platform: "reddit", expectedNativeUserId: expectedIdentity },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accountId = created.body.account.id;

  const connected = await request(`/v1/accounts/${accountId}/connections`, {
    method: "POST",
    body: { vaultHandle, generation: 1 },
  });

  if (connected.status === 200) {
    const seeded = await request("/__fixture/control", {
      method: "POST",
      body: { command: "seed-owned", payload: { accountId, nativeIds: [OWNED_POST, OWNED_COMMENT] } },
    });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  }

  return { accountId, connectStatus: connected.status, connectBody: connected.body };
}

/**
 * Media writes carry an account-scoped media reference minted by Core. The
 * request body is therefore cached per account+kind so that a replay of the
 * same idempotency key is byte-identical; staging a fresh reference on every
 * call would be a different request and correctly conflict.
 */
const bodyCache = new Map<string, Record<string, unknown>>();

async function bodyFor(request: Http, accountId: string, entry: KindEntry): Promise<Record<string, unknown>> {
  const cacheKey = `${accountId}:${entry.kind}`;
  const cached = bodyCache.get(cacheKey);
  if (cached) return structuredClone(cached);

  const body = entry.body();
  if (entry.kind !== "media_post") {
    bodyCache.set(cacheKey, body);
    return structuredClone(body);
  }
  const staged = await request(`/v1/accounts/${accountId}/media`, {
    method: "POST",
    body: {
      filename: "matrix.png",
      mimeType: "image/png",
      dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64"),
    },
  });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const withMedia = { ...body, mediaRef: staged.body.media.mediaRef };
  bodyCache.set(cacheKey, withMedia);
  return structuredClone(withMedia);
}

function differentBody(entry: KindEntry): Record<string, unknown> {
  const body = entry.body() as Record<string, unknown>;
  for (const field of ["text", "title", "url", "subreddit", "targetId", "commentId", "postId"]) {
    if (typeof body[field] === "string") {
      return { ...body, [field]: field === "url" ? "https://example.test/different" : `${body[field]}-different` };
    }
  }
  if (typeof body.direction === "number") return { ...body, direction: 0 };
  throw new Error(`no mutable field for ${entry.kind}`);
}

async function dispatch(
  request: Http,
  accountId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  callerId = "matrix-caller-a",
): Promise<{ createStatus: number; createBody: any; action: any | null }> {
  const created = await request(`/v1/accounts/${accountId}/actions`, {
    method: "POST",
    body,
    callerId,
    headers: { "idempotency-key": idempotencyKey },
  });
  if (created.status >= 400) return { createStatus: created.status, createBody: created.body, action: null };
  let action = created.body.action;
  for (let attempt = 0; attempt < 200 && action && ["queued", "running"].includes(action.state); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    action = (await request(`/v1/actions/${action.id}`, { method: "GET", callerId })).body.action;
  }
  return { createStatus: created.status, createBody: created.body, action };
}

async function platformCalls(request: Http, kind: string) {
  const inspected = await request(`/__fixture/inspect?target=${encodeURIComponent("platform-calls")}`, { method: "GET" });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  const calls = inspected.body.data;
  assert.ok(Array.isArray(calls), "platform-calls inspection must be an array");
  const operation = operationName(kind);
  return calls.filter((entry: { operation?: string }) => entry.operation === operation).length;
}

/**
 * The public platform operation name the fixture reports for a write kind.
 * Mirrors src/fixture-reddit-adapter.ts publicWriteOperation, which is not a
 * uniform `write.<kind>` transform.
 */
const PUBLIC_OPERATION_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  text_post: "write.post.text",
  link_post: "write.post.link",
  media_post: "write.post.media",
  comment: "write.comment",
  reply: "write.reply",
  edit: "write.edit-own",
  vote: "write.vote",
  save: "write.save",
  unsave: "write.unsave",
  subscribe: "write.subscribe",
  unsubscribe: "write.unsubscribe",
  delete: "write.delete",
});

function operationName(kind: string) {
  const operation = PUBLIC_OPERATION_BY_KIND[kind];
  assert.ok(operation, `no public platform operation is mapped for write kind ${kind}`);
  return operation;
}

function expectedReconciledNativeId(kind: string) {
  return kind === "subscribe" || kind === "unsubscribe"
    ? "t5_reconciled"
    : kind === "comment" || kind === "reply"
      ? "t1_reconciled"
      : "t3_reconciled";
}

function reconciledCanonicalUrl(kind: string, nativeId: string) {
  if (kind === "subscribe" || kind === "unsubscribe") {
    return "https://www.reddit.com/r/qualityassurance/";
  }
  return `https://www.reddit.com/r/qualityassurance/comments/${nativeId.replace(/^t[0-9]_/u, "")}/fixture_post/`;
}

function httpClient(baseUrl: string): Http {
  return async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-fixture-caller-id": options.callerId ?? "matrix-caller-a",
        "x-fixture-scopes": options.scopes ?? "*",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, body: await response.json() as any };
  };
}

function runtimeFiles() {
  const root = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-write-matrix-"));
  const master = join(root, "master.key");
  const audit = join(root, "audit.key");
  const backup = join(root, "backup.key");
  const auth = join(root, "auth.json");
  writeFileSync(master, Buffer.alloc(32, 31).toString("base64url"), { mode: 0o600 });
  writeFileSync(audit, Buffer.alloc(32, 32).toString("base64url"), { mode: 0o600 });
  writeFileSync(backup, Buffer.alloc(32, 33).toString("base64url"), { mode: 0o600 });
  writeFileSync(auth, JSON.stringify({
    version: 1,
    principals: [
      {
        tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
        callerId: "matrix-caller-a",
        scopes: ["*", "fixture:control"],
      },
    ],
  }), { mode: 0o600 });
  const environment = {
    NODE_ENV: "test",
    SOCIAL_GIT_MODE: "fixture",
    SOCIAL_GIT_DATA_DIR: join(root, "data"),
    SOCIAL_GIT_MASTER_KEY_FILE: master,
    SOCIAL_GIT_AUDIT_KEY_FILE: audit,
    SOCIAL_GIT_BACKUP_KEY_FILE: backup,
    SOCIAL_GIT_AUTH_FILE: auth,
    SOCIAL_GIT_HOST: "127.0.0.1",
    SOCIAL_GIT_PORT: "0",
    SOCIAL_GIT_WORKER_INTERVAL_MS: "25",
    SOCIAL_GIT_TENANT_ID: "fixture-tenant",
    SOCIAL_GIT_LEDGER_ID: "fixture-action-ledger",
  } as NodeJS.ProcessEnv;
  return { root, environment, close: () => rmSync(root, { recursive: true, force: true }) };
}

type Http = (
  path: string,
  options?: { method?: string; body?: unknown; callerId?: string; scopes?: string; headers?: Record<string, string> },
) => Promise<{ status: number; body: any }>;

type Account = { accountId: string };

type KindEntry = { kind: string; body: () => Record<string, unknown> };

type Fixture = { root: string; environment: NodeJS.ProcessEnv; close: () => void };
