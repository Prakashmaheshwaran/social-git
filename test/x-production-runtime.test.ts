import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { MAX_WORKER_MESSAGE_BYTES, SessionRuntime, decodeWorkerMessage, encodeWorkerMessage, type WorkerCommand } from "@social-git/core";
import { XContractError } from "@social-git/x-adapter";
import type { AccountRecord, ActionRecord, MediaFlowRecord } from "../src/persistence.ts";
import {
  CoreXTransportProvider,
  ProductionXCommandDispatcher,
  RemoteXCommandDispatcher,
  XRuntimeError,
  evaluateCommittedXRuntimeAdmission,
  type XAdmissionDecision,
} from "../src/runtime-x.ts";
import { ProductionXPlatformAdapter } from "../src/x-production-adapter.ts";
import { DisabledXPlatformAdapter } from "../src/x-adapter.ts";
import { createXWorkerHttpServer } from "../src/x-worker-http.ts";
import { X_COMMAND_MAC_CONTEXT, XCommandMacSigner } from "../src/x-ipc-auth.ts";

const ADMITTED_FOR_TEST: XAdmissionDecision = Object.freeze({ requested: true, enabled: true, productionEnabled: true, disabledReasons: [] });
const X_COMMAND_KEY = Buffer.alloc(32, 0xb7);
const account = {
  id: "x-account",
  platform: "x",
  expectedNativeUserId: "100",
  actualNativeUserId: null,
  label: null,
  status: "disconnected",
  connectionHealth: "disconnected",
  actionRequiredReason: null,
  healthGeneration: 0,
  lastVerifiedAt: null,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
} satisfies AccountRecord;

test("operator configuration alone cannot activate the five-gate production-disabled X transport", async () => {
  const decision = evaluateCommittedXRuntimeAdmission(true);
  assert.equal(decision.requested, true);
  assert.equal(decision.enabled, false);
  assert.equal(decision.productionEnabled, false);
  assert.deepEqual(decision.disabledReasons, [
    "ENDPOINT_CURRENTNESS_UNPROVEN",
    "CLIENT_TRANSACTION_HEADER_UNPROVEN",
    "AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING",
    "AUTHORIZED_LIVE_READ_PROOF_MISSING",
    "AUTHORIZED_LIVE_WRITE_PROOF_MISSING",
  ]);
  let called = false;
  const server = createXWorkerHttpServer({ admission: decision, dispatcher: { ready: async () => true, execute: async () => { called = true; throw new Error("must not dispatch"); } } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/dispatch`, { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json() as any).disabledReasons, decision.disabledReasons);
    assert.equal(called, false);
  } finally { server.close(); await once(server, "close"); }
});

test("an operator-disabled deployment never advertises future committed X capabilities as available", async () => {
  const adapter = new DisabledXPlatformAdapter(undefined, { enabled: false, disabledReasons: [] });
  const details = await adapter.capabilityDetails(account);
  assert.equal(details.length, 25);
  assert.ok(details.every((entry) => entry.productionEnabled === false && entry.status === "disabled"));
  assert.ok(details.every((entry) => entry.disabledReason === "OPERATOR_DISABLED"));
  assert.deepEqual(await adapter.capabilities(account), []);
});

test("X worker rejects unsigned, tampered, and replayed command envelopes before dispatch", async () => {
  let calls = 0;
  const server = createXWorkerHttpServer({
    admission: ADMITTED_FOR_TEST,
    commandKey: X_COMMAND_KEY,
    now: () => 1_800_000_000_000,
    dispatcher: { ready: async () => true, execute: async () => { calls += 1; throw new Error("synthetic malformed command"); } },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/dispatch`;
  const signer = new XCommandMacSigner(X_COMMAND_KEY, { now: () => 1_800_000_000_000, nonce: () => Buffer.alloc(24, 9) });
  try {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    const original = Buffer.from("{}");
    const headers = signer.headers(original, X_COMMAND_MAC_CONTEXT.dispatchRequest);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers }, body: "[]" })).status, 401);
    assert.equal(calls, 0);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers }, body: original })).status, 400);
    assert.equal(calls, 1);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers }, body: original })).status, 401);
    assert.equal(calls, 1);
    original.fill(0);
  } finally { signer.close(); server.close(); await once(server, "close"); }
});

test("X intent admission rejects before bootstrap and admitted readiness requires an authenticated versioned body", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-git-x-intent-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 11), auditKey: Buffer.alloc(32, 12) });
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "intent-secret", ct0: "intent-csrf" } }));
  const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  let bootstraps = 0;
  const dispatcher = new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, bootstrap: async () => { bootstraps += 1; throw new Error("must not bootstrap"); } });
  runtime.importExternalSession({ accountId: account.id, platform: "x", expectedNativeIdentity: "100", generation: 1, session, networkRoute: { id: "x-direct", material: route } });
  const command = runtime.acquireWorkerCommand({ accountId: account.id, generation: 1, requestId: "wrong-intent", intent: "identity_validation", operation: "post.create", payload: { text: "no" } });
  try {
    await assert.rejects(dispatcher.execute(command), (error: any) => error.code === "POLICY_DENIED");
    assert.equal(bootstraps, 0);
    const disabled = createXWorkerHttpServer({ admission: { ...ADMITTED_FOR_TEST, enabled: false }, commandKey: X_COMMAND_KEY });
    disabled.listen(0, "127.0.0.1"); await once(disabled, "listening");
    const address = disabled.address(); assert.ok(address && typeof address === "object");
    const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${address.port}/v1/dispatch`, X_COMMAND_KEY);
    assert.equal(await remote.ready(), false);
    remote.close(); disabled.close(); await once(disabled, "close");
  } finally { command.fill(0); session.fill(0); route.fill(0); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("harvested X readiness responses cannot satisfy a foreign or stale Core challenge", async () => {
  const clock = 1_800_000_000_000;
  const worker = createXWorkerHttpServer({
    admission: ADMITTED_FOR_TEST,
    commandKey: X_COMMAND_KEY,
    now: () => clock,
    dispatcher: { ready: async () => true, execute: async () => { throw new Error("not used"); } },
  });
  worker.listen(0, "127.0.0.1"); await once(worker, "listening");
  const workerAddress = worker.address(); assert.ok(workerAddress && typeof workerAddress === "object");
  const harvester = new XCommandMacSigner(X_COMMAND_KEY, { now: () => clock, nonce: () => Buffer.alloc(24, 1) });
  const empty = Buffer.alloc(0);
  const harvested = await fetch(`http://127.0.0.1:${workerAddress.port}/readyz`, {
    headers: { ...harvester.headers(empty, X_COMMAND_MAC_CONTEXT.readinessRequest) },
  });
  const harvestedBody = Buffer.from(await harvested.arrayBuffer());
  const harvestedHeaders = Object.fromEntries(harvested.headers);
  worker.close(); await once(worker, "close"); harvester.close();

  const replay = createServer((_request, response) => {
    response.writeHead(harvested.status, harvestedHeaders);
    response.end(harvestedBody);
  });
  replay.listen(0, "127.0.0.1"); await once(replay, "listening");
  const replayAddress = replay.address(); assert.ok(replayAddress && typeof replayAddress === "object");
  const url = `http://127.0.0.1:${replayAddress.port}/v1/dispatch`;
  const foreign = new RemoteXCommandDispatcher(url, X_COMMAND_KEY, { now: () => clock, nonce: () => Buffer.alloc(24, 2) });
  const stale = new RemoteXCommandDispatcher(url, X_COMMAND_KEY, { now: () => clock + 30_001, nonce: () => Buffer.alloc(24, 3) });
  try {
    assert.equal(await foreign.ready(), false);
    assert.equal(await stale.ready(), false);
  } finally {
    foreign.close(); stale.close(); replay.close(); await once(replay, "close"); harvestedBody.fill(0); empty.fill(0);
  }
});

test("admitted Core and isolated worker execute all 25 X capabilities with bound custody and no resubmission", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-git-x-runtime-"));
  const runtime = new SessionRuntime({
    databasePath: join(root, "sessions.sqlite"),
    tenantId: "tenant-x",
    masterKey: Buffer.alloc(32, 31),
    auditKey: Buffer.alloc(32, 41),
  });
  const calls: Array<{ operation: string; input: Record<string, unknown>; binding: { tenantId: string; accountId: string; routeId: string; generation: number } }> = [];
  let bootstrapCount = 0;
  const dispatcher = new ProductionXCommandDispatcher({
    admission: ADMITTED_FOR_TEST,
    bootstrap: async (input) => {
      bootstrapCount += 1;
      assert.deepEqual(input.binding, { tenantId: "tenant-x", accountId: account.id, routeId: "x-direct", generation: 1 });
      assert.deepEqual(JSON.parse(Buffer.from(input.sessionBytes).toString("utf8")), { cookies: { auth_token: "synthetic-auth", ct0: "synthetic-csrf" } });
      assert.deepEqual(JSON.parse(Buffer.from(input.routeBytes).toString("utf8")), { kind: "direct" });
      const binding = structuredClone(input.binding);
      return {
        async verifyIdentity() { calls.push({ operation: "account.identity", input: {}, binding }); return identity(); },
        async execute(operation, payload) {
          calls.push({ operation, input: structuredClone(payload), binding });
          if (operation === "account.identity") return identity();
          if (operation === "profile.get") return { entity: profile(String(payload.username ?? "fixture_owner")), rateLimit: rate() };
          if (operation === "post.get") return { entity: post(String(payload.postId ?? "300")), rateLimit: rate() };
          if (operation === "lists.lookup") return { entity: { nativeId: String(payload.listId), canonicalUrl: `https://x.com/i/lists/${payload.listId}`, name: "Fixture", visibility: "public" }, rateLimit: rate() };
          if (["thread.get", "timeline.home", "timeline.user", "search.query", "bookmarks.list", "lists.timeline"].includes(operation)) return { items: [post("300")], nextCursor: null, rateLimit: rate() };
          if (["followers.list", "following.list", "lists.members"].includes(operation)) return { items: [profile("fixture_owner")], nextCursor: null, rateLimit: rate() };
          if (operation === "lists.memberships") return { items: [{ nativeId: "800", canonicalUrl: "https://x.com/i/lists/800", name: "Fixture" }], nextCursor: null, rateLimit: rate() };
          if (operation === "notifications.list") return { items: [{ nativeId: "700", notificationType: "mention" }], nextCursor: null, rateLimit: rate() };
          if (operation === "conversations.list") return { items: [{ nativeId: "900", participantNativeIds: ["100", "200"] }], nextCursor: null, rateLimit: rate() };
          return operation === "message.send"
            ? { nativeId: "901", rateLimit: rate() }
            : { nativeId: "600", canonicalUrl: "https://x.com/i/status/600", rateLimit: rate() };
        },
        async executeMediaPhase(phase) {
          calls.push({ operation: `post.media.${phase}`, input: {}, binding });
          if (phase === "init") return { phase: "initialized", mediaId: "500", rateLimit: rate() };
          if (phase === "submit") return { phase: "submitted", nativeId: "601", canonicalUrl: "https://x.com/i/status/601", rateLimit: rate() };
          return { phase: phase === "append" ? "appended" : "finalized", rateLimit: rate() };
        },
      };
    },
    now: () => Date.now(),
  });
  const server = createXWorkerHttpServer({ admission: ADMITTED_FOR_TEST, dispatcher, commandKey: X_COMMAND_KEY });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${address.port}/v1/dispatch`, X_COMMAND_KEY);
  assert.equal(await remote.ready(), true);
  const provider = new CoreXTransportProvider({ runtime, dispatcher: remote });
  const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "synthetic-auth", ct0: "synthetic-csrf" } }));
  const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
    assert.deepEqual(await adapter.verifyIdentity({ account, vaultHandle: "core-custody:x-account" }), { nativeUserId: "100" });
    const reads = [
      { kind: "x_account_health" },
      { kind: "x_profile", username: "fixture_owner" },
      { kind: "x_post", postId: "300" },
      { kind: "x_thread", postId: "300", limit: 25 },
      { kind: "x_home_timeline", limit: 25 },
      { kind: "x_user_timeline", username: "fixture_owner", limit: 25 },
      { kind: "x_search", query: "fixture", limit: 25 },
      { kind: "x_notifications", limit: 25 },
      { kind: "x_conversations", limit: 25 },
      { kind: "x_bookmarks", limit: 25 },
      { kind: "x_followers", userNativeId: "200", limit: 25 },
      { kind: "x_following", userNativeId: "200", limit: 25 },
      { kind: "x_list", listId: "800" },
      { kind: "x_list_memberships", limit: 25 },
      { kind: "x_list_members", listId: "800", limit: 25 },
      { kind: "x_list_timeline", listId: "800", limit: 25 },
    ] as const;
    for (const request of reads) assert.ok(await adapter.read({ account, vaultHandle: "core-custody:x-account", request }));

    const writes = [
      { kind: "x_post_create", text: "fixture" },
      { kind: "x_reply_create", postId: "300", text: "fixture" },
      { kind: "x_post_delete", postId: "300" },
      { kind: "x_like_set", postId: "300", enabled: true },
      { kind: "x_repost_set", postId: "300", enabled: true },
      { kind: "x_follow_set", userNativeId: "200", enabled: true },
      { kind: "x_bookmark_set", postId: "300", enabled: true },
      { kind: "x_direct_message", recipientNativeId: "200", text: "fixture" },
    ] as const;
    let sequence = 0;
    for (const request of writes) {
      const result = await adapter.submit({ account, vaultHandle: "core-custody:x-account", action: action(++sequence), request });
      assert.equal(result.status, "confirmed", request.kind);
    }

    const media = Buffer.from("fixture-image");
    let flow: MediaFlowRecord = { actionId: "media-action", mediaRef: "media-ref", phase: "reserved", workerTicket: null, updatedAt: "2026-09-17T00:00:00.000Z" };
    const mediaResult = await adapter.submit({
      account,
      vaultHandle: "core-custody:x-account",
      action: action(++sequence),
      request: { kind: "x_media_post", text: "fixture", mediaRef: "media-ref" },
      execution: {
        media: { mediaRef: "media-ref", callerId: "caller", accountId: account.id, filename: "fixture.png", mimeType: "image/png", sizeBytes: media.length, sha256: createHash("sha256").update(media).digest("hex"), createdAt: "2026-09-17T00:00:00.000Z", data: media },
        get flow() { return flow; },
        transition(from, to, workerTicket) { assert.equal(flow.phase, from); flow = { ...flow, phase: to, workerTicket }; return flow; },
        beginSubmission(workerTicket) { assert.equal(flow.phase, "uploaded"); flow = { ...flow, phase: "submitting", workerTicket }; return flow; },
      },
    });
    assert.equal(mediaResult.status, "confirmed");
    assert.equal(flow.phase, "processed");
    assert.equal((await adapter.capabilities(account)).length, 25);
    assert.ok(calls.every((call) => call.binding.accountId === account.id && call.binding.generation === 1));
    assert.ok(calls.some((call) => call.operation === "message.send" && call.input.conversationId === "100-200"));
    assert.ok(calls.some((call) => call.operation === "post.get" && call.input.postId === "300"));
    assert.equal(JSON.stringify(calls).includes("synthetic-auth"), false);
    assert.ok(bootstrapCount >= 25);
  } finally {
    session.fill(0); route.fill(0); await adapter.close(); runtime.close(); server.close(); await once(server, "close"); rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous X worker loss is UNKNOWN and never automatically resubmitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-git-x-unknown-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 51), auditKey: Buffer.alloc(32, 61) });
  let submissions = 0;
  const dispatcher = new ProductionXCommandDispatcher({
    admission: ADMITTED_FOR_TEST,
    bootstrap: async () => ({
      async verifyIdentity() { return identity(); },
      async execute(operation) { if (operation === "post.create") { submissions += 1; throw new (await import("@social-git/x-adapter")).XContractError("UNKNOWN", "unverified", { submissionMayHaveStarted: true }); } return identity(); },
      async executeMediaPhase() { throw new Error("not used"); },
    }),
  });
  const server = createXWorkerHttpServer({ admission: ADMITTED_FOR_TEST, dispatcher, commandKey: X_COMMAND_KEY });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${address.port}/v1/dispatch`, X_COMMAND_KEY);
  const provider = new CoreXTransportProvider({ runtime, dispatcher: remote });
  const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "a", ct0: "c" } })); const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
    await adapter.verifyIdentity({ account, vaultHandle: "core" });
    const first = await adapter.submit({ account, vaultHandle: "core", action: action(99), request: { kind: "x_post_create", text: "once" } });
    assert.deepEqual(first, { status: "unknown", message: "The X write result could not be verified." });
    assert.equal(submissions, 1);
    assert.equal(runtime.getAccountState(account.id).health, "unknown");
  } finally { session.fill(0); route.fill(0); await adapter.close(); runtime.close(); server.close(); await once(server, "close"); rmSync(root, { recursive: true, force: true }); }
});

test("X media tickets bind tenant/account/generation/route, expire, reject replay, and are single-use at finalize", async () => {
  const media = Buffer.from("m");
  const sha256 = createHash("sha256").update(media).digest("hex");
  let clock = 1_800_000_000_000;
  let appends = 0;
  let finalizes = 0;
  const makeDispatcher = () => new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, now: () => clock, bootstrap: async () => ({
    async verifyIdentity() { return identity(); },
    async execute() { throw new Error("not used"); },
    async executeMediaPhase(phase) {
      if (phase === "init") return { mediaId: "500", rateLimit: rate() };
      if (phase === "append") { appends += 1; return { phase: "appended", rateLimit: rate() }; }
      if (phase === "finalize") { finalizes += 1; throw new XContractError("UNKNOWN", "finalize result lost", { submissionMayHaveStarted: true }); }
      throw new Error("submit must not follow lost finalize");
    },
  }) });
  const initialize = async (dispatcher: ProductionXCommandDispatcher) => {
    const result = await dispatchForTest(dispatcher, xCommand({ operation: "post.media.init", payload: { mimeType: "image/png", sizeBytes: media.length, sha256 } }));
    assert.ok(result.platformResult);
    return String(result.platformResult.data.ticket);
  };
  for (const override of [
    { tenantId: "other-tenant" }, { accountId: "other-account" }, { generation: 2 },
    { networkRoute: { id: "other-route", materialBase64: Buffer.from('{"kind":"direct"}').toString("base64url") } },
  ] satisfies Array<Partial<WorkerCommand>>) {
    const dispatcher = makeDispatcher(); const ticket = await initialize(dispatcher); const before = appends;
    const result = await dispatchForTest(dispatcher, xCommand({ ...override, operation: "post.media.append", payload: { ticket, dataBase64: media.toString("base64") } }));
    assert.equal(result.error?.code, "PROTOCOL_DRIFT"); assert.equal(appends, before);
  }
  {
    const dispatcher = makeDispatcher(); const ticket = await initialize(dispatcher); clock += 5 * 60_000 + 1;
    const result = await dispatchForTest(dispatcher, xCommand({ operation: "post.media.append", payload: { ticket, dataBase64: media.toString("base64") } }));
    assert.equal(result.error?.code, "PROTOCOL_DRIFT"); clock = 1_800_000_000_000;
  }
  {
    const dispatcher = makeDispatcher(); const ticket = await initialize(dispatcher); const before = appends;
    assert.equal((await dispatchForTest(dispatcher, xCommand({ operation: "post.media.append", payload: { ticket, dataBase64: media.toString("base64") } }))).error, undefined);
    assert.equal((await dispatchForTest(dispatcher, xCommand({ operation: "post.media.append", payload: { ticket, dataBase64: media.toString("base64") } }))).error?.code, "PROTOCOL_DRIFT");
    assert.equal(appends, before + 1);
  }
  {
    const dispatcher = makeDispatcher(); const ticket = await initialize(dispatcher);
    await dispatchForTest(dispatcher, xCommand({ operation: "post.media.append", payload: { ticket, dataBase64: media.toString("base64") } }));
    const before = finalizes;
    assert.equal((await dispatchForTest(dispatcher, xCommand({ operation: "post.media.submit", payload: { ticket, text: "fixture" } }))).error?.code, "UNKNOWN");
    assert.equal((await dispatchForTest(dispatcher, xCommand({ operation: "post.media.submit", payload: { ticket, text: "fixture" } }))).error?.code, "PROTOCOL_DRIFT");
    assert.equal(finalizes, before + 1);
  }
  media.fill(0);
});

test("X DM participant mapping rejects self and malformed recipients before transport", async () => {
  let sends = 0;
  const dispatcher = new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, bootstrap: async () => ({
    async verifyIdentity() { return identity(); }, async execute() { sends += 1; return { nativeId: "901" }; }, async executeMediaPhase() { throw new Error("not used"); },
  }) });
  for (const recipientNativeId of ["100", "not-numeric"]) {
    const result = await dispatchForTest(dispatcher, xCommand({ operation: "message.send", payload: { recipientNativeId, text: "fixture" } }));
    assert.ok(result.error);
  }
  assert.equal(sends, 0);
});

test("authenticated oversized X worker bodies are rejected before dispatch", async () => {
  let calls = 0;
  const server = createXWorkerHttpServer({ admission: ADMITTED_FOR_TEST, commandKey: X_COMMAND_KEY, dispatcher: { ready: async () => true, execute: async () => { calls += 1; throw new Error("must not dispatch"); } } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const body = Buffer.alloc(MAX_WORKER_MESSAGE_BYTES + 1, 0x61); const signer = new XCommandMacSigner(X_COMMAND_KEY);
  try {
    let status = 0;
    try { status = (await fetch(`http://127.0.0.1:${address.port}/v1/dispatch`, { method: "POST", headers: { ...signer.headers(body, X_COMMAND_MAC_CONTEXT.dispatchRequest) }, body })).status; } catch { /* request destruction is an acceptable bounded rejection */ }
    assert.ok(status === 0 || status === 400 || status === 413);
    assert.equal(calls, 0);
  } finally { body.fill(0); signer.close(); server.close(); await once(server, "close"); }
});

test("beginShutdown during an authenticated dispatch does not leak the in-flight count", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = createXWorkerHttpServer({
    admission: ADMITTED_FOR_TEST,
    commandKey: X_COMMAND_KEY,
    dispatcher: {
      ready: async () => true,
      async execute(serialized) {
        const command = decodeWorkerMessage(serialized);
        assert.equal(command.type, "social-git.worker.command");
        if (command.type !== "social-git.worker.command") throw new Error("invalid command");
        await gate;
        return {
          message: encodeWorkerMessage({
            version: 1, type: "social-git.worker.result", requestId: command.requestId,
            tenantId: command.tenantId, accountId: command.accountId, platform: "x",
            generation: command.generation, leaseId: command.leaseId, fence: command.fence,
            status: "SUCCEEDED", observedNativeIdentity: "100",
          }),
          platformResult: { data: identity(), native: null },
        };
      },
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const command = encodeWorkerMessage(xCommand({ intent: "identity_validation", operation: "account.identity" }));
  const body = Buffer.from(command);
  const signer = new XCommandMacSigner(X_COMMAND_KEY);
  const responsePromise = fetch(`http://127.0.0.1:${address.port}/v1/dispatch`, {
    method: "POST", headers: { ...signer.headers(body, X_COMMAND_MAC_CONTEXT.dispatchRequest) }, body,
  });
  try {
    for (let index = 0; index < 100 && server.diagnostics().inFlight !== 1; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.diagnostics().inFlight, 1);
    server.beginShutdown();
    release();
    assert.equal((await responsePromise).status, 200);
    assert.equal(server.diagnostics().inFlight, 0);
    assert.equal(server.diagnostics().stopping, true);
  } finally {
    release(); command.fill(0); body.fill(0); signer.close(); server.close(); await once(server, "close");
  }
});

test("HTTP reset, non-200, and invalid worker envelopes finalize write leases as UNKNOWN", async () => {
  for (const failure of ["reset", "non-200", "invalid-envelope"] as const) {
    const root = mkdtempSync(join(tmpdir(), `social-git-x-http-${failure}-`));
    const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 71), auditKey: Buffer.alloc(32, 72) });
    const production = new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, bootstrap: async () => ({
      async verifyIdentity() { return identity(); },
      async execute() { return { nativeId: "999", canonicalUrl: "https://x.com/i/status/999", rateLimit: rate() }; },
      async executeMediaPhase() { throw new Error("not used"); },
    }) });
    const responseSigner = new XCommandMacSigner(X_COMMAND_KEY);
    let requests = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
      requests += 1;
      if (requests === 1) {
        const executed = await production.execute(body);
        const requestNonce = request.headers["x-social-git-command-nonce"];
        assert.equal(typeof requestNonce, "string");
        const encoded = Buffer.from(JSON.stringify({ version: 1, requestNonce, messageBase64: Buffer.from(executed.message).toString("base64url"), platformResult: executed.platformResult }));
        response.writeHead(200, { "content-type": "application/json", "content-length": encoded.length, ...responseSigner.headers(encoded, X_COMMAND_MAC_CONTEXT.response(200)) });
        response.end(encoded); executed.message.fill(0); encoded.fill(0); body.fill(0); return;
      }
      body.fill(0);
      if (failure === "reset") { request.socket.destroy(); return; }
      if (failure === "non-200") { response.writeHead(500); response.end("failed"); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${address.port}/v1/dispatch`, X_COMMAND_KEY);
    const provider = new CoreXTransportProvider({ runtime, dispatcher: remote });
    const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
    const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "loss", ct0: "loss-csrf" } }));
    const route = Buffer.from(JSON.stringify({ kind: "direct" }));
    try {
      provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
      assert.deepEqual(await adapter.verifyIdentity({ account, vaultHandle: "core" }), { nativeUserId: "100" });
      const result = await adapter.submit({ account, vaultHandle: "core", action: action(700), request: { kind: "x_post_create", text: "once" } });
      assert.equal(result.status, "unknown", failure);
      const state = runtime.getAccountState(account.id) as any;
      assert.equal(state.health, "unknown", failure);
      assert.equal(state.activeLease, null, failure);
      assert.equal(requests, 2, failure);
    } finally {
      session.fill(0); route.fill(0); remote.close(); responseSigner.close(); server.close(); await once(server, "close"); runtime.close(); rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an authenticated worker-stopping response remains a proven pre-submit failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-git-x-stopping-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 73), auditKey: Buffer.alloc(32, 74) });
  let bootstraps = 0;
  const dispatcher = new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, bootstrap: async () => {
    bootstraps += 1;
    return { async verifyIdentity() { return identity(); }, async execute() { throw new Error("must not submit"); }, async executeMediaPhase() { throw new Error("not used"); } };
  } });
  const server = createXWorkerHttpServer({ admission: ADMITTED_FOR_TEST, dispatcher, commandKey: X_COMMAND_KEY });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${address.port}/v1/dispatch`, X_COMMAND_KEY);
  const provider = new CoreXTransportProvider({ runtime, dispatcher: remote });
  const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "stop", ct0: "stop-csrf" } })); const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
    await adapter.verifyIdentity({ account, vaultHandle: "core" });
    server.beginShutdown();
    const result = await adapter.submit({ account, vaultHandle: "core", action: action(750), request: { kind: "x_post_create", text: "not sent" } });
    assert.equal(result.status, "action_required");
    assert.equal(bootstraps, 1);
    assert.notEqual(runtime.getAccountState(account.id).health, "unknown");
  } finally { session.fill(0); route.fill(0); remote.close(); server.close(); await once(server, "close"); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a harvested stopping response for another request makes the write UNKNOWN and clears its lease", async () => {
  const clock = 1_800_000_000_000;
  const stoppingWorker = createXWorkerHttpServer({
    admission: ADMITTED_FOR_TEST,
    commandKey: X_COMMAND_KEY,
    now: () => clock,
    dispatcher: { ready: async () => true, execute: async () => { throw new Error("must not dispatch"); } },
  });
  stoppingWorker.beginShutdown();
  stoppingWorker.listen(0, "127.0.0.1"); await once(stoppingWorker, "listening");
  const stoppingAddress = stoppingWorker.address(); assert.ok(stoppingAddress && typeof stoppingAddress === "object");
  const harvestedCommand = encodeWorkerMessage(xCommand({ operation: "post.create", payload: { text: "harvest" } }));
  const harvestedRequestBody = Buffer.from(harvestedCommand);
  const harvestSigner = new XCommandMacSigner(X_COMMAND_KEY, { now: () => clock, nonce: () => Buffer.alloc(24, 1) });
  const harvested = await fetch(`http://127.0.0.1:${stoppingAddress.port}/v1/dispatch`, {
    method: "POST",
    headers: { ...harvestSigner.headers(harvestedCommand, X_COMMAND_MAC_CONTEXT.dispatchRequest) },
    body: harvestedRequestBody,
  });
  assert.equal(harvested.status, 503);
  const harvestedBody = Buffer.from(await harvested.arrayBuffer());
  const harvestedHeaders = Object.fromEntries(harvested.headers);
  harvestedCommand.fill(0); harvestedRequestBody.fill(0); harvestSigner.close(); stoppingWorker.close(); await once(stoppingWorker, "close");

  const root = mkdtempSync(join(tmpdir(), "social-git-x-stopping-replay-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 75), auditKey: Buffer.alloc(32, 76) });
  const production = new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, bootstrap: async () => ({
    async verifyIdentity() { return identity(); },
    async execute() { throw new Error("replayed stop must prevent actual submission"); },
    async executeMediaPhase() { throw new Error("not used"); },
  }) });
  const responseSigner = new XCommandMacSigner(X_COMMAND_KEY, { now: () => clock });
  let requests = 0;
  const replay = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
    requests += 1;
    if (requests === 1) {
      const executed = await production.execute(body);
      const requestNonce = request.headers["x-social-git-command-nonce"];
      assert.equal(typeof requestNonce, "string");
      const encoded = Buffer.from(JSON.stringify({ version: 1, requestNonce, messageBase64: Buffer.from(executed.message).toString("base64url"), platformResult: executed.platformResult }));
      response.writeHead(200, { "content-type": "application/json", "content-length": encoded.length, ...responseSigner.headers(encoded, X_COMMAND_MAC_CONTEXT.response(200)) });
      response.end(encoded); executed.message.fill(0); encoded.fill(0); body.fill(0); return;
    }
    body.fill(0);
    response.writeHead(503, harvestedHeaders);
    response.end(harvestedBody);
  });
  replay.listen(0, "127.0.0.1"); await once(replay, "listening");
  const replayAddress = replay.address(); assert.ok(replayAddress && typeof replayAddress === "object");
  let nonce = 1;
  const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${replayAddress.port}/v1/dispatch`, X_COMMAND_KEY, { now: () => clock, nonce: () => Buffer.alloc(24, ++nonce) });
  const provider = new CoreXTransportProvider({ runtime, dispatcher: remote });
  const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "replay", ct0: "replay-csrf" } }));
  const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
    await adapter.verifyIdentity({ account, vaultHandle: "core" });
    const result = await adapter.submit({ account, vaultHandle: "core", action: action(751), request: { kind: "x_post_create", text: "once" } });
    assert.equal(result.status, "unknown");
    const state = runtime.getAccountState(account.id) as any;
    assert.equal(state.health, "unknown");
    assert.equal(state.activeLease, null);
    assert.equal(requests, 2);
  } finally {
    session.fill(0); route.fill(0); harvestedBody.fill(0); remote.close(); responseSigner.close(); replay.close(); await once(replay, "close"); runtime.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a mismatched post-dispatch worker result is UNKNOWN, wipes the Core command, and cannot retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-git-x-mismatch-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 81), auditKey: Buffer.alloc(32, 82) });
  let writes = 0;
  let retained: Uint8Array | undefined;
  const dispatcher = {
    ready: async () => true,
    async execute(serialized: Uint8Array) {
      const command = decodeWorkerMessage(serialized);
      assert.equal(command.type, "social-git.worker.command");
      if (command.type !== "social-git.worker.command") throw new Error("invalid command");
      const identityCall = command.operation === "account.identity";
      if (!identityCall) { writes += 1; retained = serialized; }
      const message = encodeWorkerMessage({
        version: 1, type: "social-git.worker.result", requestId: command.requestId,
        tenantId: identityCall ? command.tenantId : "wrong-tenant", accountId: command.accountId,
        platform: "x", generation: command.generation, leaseId: command.leaseId, fence: command.fence,
        status: identityCall ? "SUCCEEDED" : "POLICY_DENIED", observedNativeIdentity: "100",
      });
      return identityCall
        ? { message, platformResult: { data: identity(), native: null } }
        : { message, error: new XRuntimeError("ACCESS_DENIED", "synthetic denial") };
    },
  };
  const provider = new CoreXTransportProvider({ runtime, dispatcher });
  const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "binding", ct0: "binding-csrf" } }));
  const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
    await adapter.verifyIdentity({ account, vaultHandle: "core" });
    const first = await adapter.submit({ account, vaultHandle: "core", action: action(800), request: { kind: "x_post_create", text: "once" } });
    assert.equal(first.status, "unknown");
    assert.equal(writes, 1);
    assert.ok(retained && [...retained].every((byte) => byte === 0));
    const second = await adapter.submit({ account, vaultHandle: "core", action: action(800), request: { kind: "x_post_create", text: "once" } });
    assert.notEqual(second.status, "confirmed");
    assert.equal(writes, 1);
    assert.equal(runtime.getAccountState(account.id).health, "unknown");
  } finally { session.fill(0); route.fill(0); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("observed X identity drift reaches Core and revokes encrypted custody", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-git-x-identity-drift-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 83), auditKey: Buffer.alloc(32, 84) });
  const dispatcher = new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, bootstrap: async () => ({
    async verifyIdentity() { throw new XContractError("WRONG_IDENTITY", "wrong identity", { observedNativeIdentity: "999" }); },
    async execute() { throw new Error("not used"); }, async executeMediaPhase() { throw new Error("not used"); },
  }) });
  const provider = new CoreXTransportProvider({ runtime, dispatcher });
  const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "drift", ct0: "drift-csrf" } })); const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
    await assert.rejects(adapter.verifyIdentity({ account, vaultHandle: "core" }));
    assert.equal(runtime.getAccountState(account.id).health, "wrong_identity");
  } finally { session.fill(0); route.fill(0); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("X delete ownership preflight rejects a mismatched ID or author before mutation", async () => {
  for (const mismatch of ["id", "author"] as const) {
    const root = mkdtempSync(join(tmpdir(), `social-git-x-delete-${mismatch}-`));
    const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-x", masterKey: Buffer.alloc(32, 85), auditKey: Buffer.alloc(32, 86) });
    let deletes = 0;
    const dispatcher = new ProductionXCommandDispatcher({ admission: ADMITTED_FOR_TEST, bootstrap: async () => ({
      async verifyIdentity() { return identity(); },
      async execute(operation, payload) {
        if (operation === "post.get") return { entity: post(mismatch === "id" ? "301" : String(payload.postId), mismatch === "author" ? "999" : "100"), rateLimit: rate() };
        if (operation === "post.delete") deletes += 1;
        return { nativeId: "300", canonicalUrl: "https://x.com/i/status/300", rateLimit: rate() };
      },
      async executeMediaPhase() { throw new Error("not used"); },
    }) });
    const provider = new CoreXTransportProvider({ runtime, dispatcher });
    const adapter = new ProductionXPlatformAdapter(provider, ADMITTED_FOR_TEST);
    const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "delete", ct0: "delete-csrf" } })); const route = Buffer.from(JSON.stringify({ kind: "direct" }));
    try {
      provider.importDirectConnection({ account, generation: 1, session, networkRoute: { id: "x-direct", material: route } });
      await adapter.verifyIdentity({ account, vaultHandle: "core" });
      const result = await adapter.submit({ account, vaultHandle: "core", action: action(900), request: { kind: "x_post_delete", postId: "300" } });
      assert.equal(result.status, "failed", mismatch);
      assert.equal(deletes, 0, mismatch);
    } finally { session.fill(0); route.fill(0); runtime.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

let commandSequence = 0;
function xCommand(overrides: Partial<WorkerCommand>): WorkerCommand {
  return {
    version: 1, type: "social-git.worker.command", requestId: `direct-${++commandSequence}`,
    tenantId: "tenant-x", accountId: account.id, platform: "x", generation: 1,
    leaseId: `lease-${commandSequence}`, fence: commandSequence, expiresAt: 1_900_000_000_000,
    intent: "write", operation: "post.create", expectedNativeIdentity: "100",
    sessionBase64: Buffer.from('{"cookies":{"auth_token":"synthetic","ct0":"synthetic-csrf"}}').toString("base64url"),
    networkRoute: { id: "x-direct", materialBase64: Buffer.from('{"kind":"direct"}').toString("base64url") },
    payload: {}, ...overrides,
  };
}
async function dispatchForTest(dispatcher: ProductionXCommandDispatcher, command: WorkerCommand) {
  const encoded = encodeWorkerMessage(command);
  try { return await dispatcher.execute(encoded); } finally { encoded.fill(0); }
}

function identity() { return { entity: { nativeId: "100", username: "fixture_owner", displayName: "Fixture", canonicalUrl: "https://x.com/fixture_owner" }, rateLimit: rate() }; }
function profile(username: string) { return { nativeId: username === "fixture_owner" ? "100" : "200", username, displayName: "Fixture", canonicalUrl: `https://x.com/${username}` }; }
function post(nativeId: string, authorNativeId = "100") { return { nativeId, authorNativeId, text: "fixture", canonicalUrl: `https://x.com/fixture_owner/status/${nativeId}` }; }
function rate() { return { limit: 50, remaining: 49, resetAt: "2033-05-18T03:33:20.000Z" }; }
function action(sequence: number): ActionRecord { return { id: `action-${sequence}`, callerId: "caller", accountId: account.id, idempotencyKey: `idem-${sequence}`, kind: "x", state: "running", submissionMayHaveStarted: false, result: null, error: null, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" }; }
