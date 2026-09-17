import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRuntime, encodeWorkerMessage } from "@social-git/core";
import { CORE_ERROR_CODES } from "@social-git/reddit-adapter";
import { CoreRedditTransportProvider, DirectorySessionSource, ProductionRedditCommandDispatcher, RemoteRedditCommandDispatcher, type AccountRecord } from "../src/index.ts";

test("remote Reddit dispatcher accepts only bound worker result envelopes", async () => {
  const successMessage = workerResult("SUCCEEDED");
  const failureMessage = workerResult("AUTH_FAILURE");
  const replies = [
    {
      version: 1,
      messageBase64: Buffer.from(successMessage).toString("base64url"),
      platformResult: { native: null, data: { items: [] } },
    },
    {
      version: 1,
      messageBase64: Buffer.from(failureMessage).toString("base64url"),
      failure: {
        name: "RedditTransportError",
        code: CORE_ERROR_CODES.AUTHENTICATION_FAILED,
        message: "The Reddit session is not authenticated",
        retryable: false,
        actionRequired: true,
        submissionMayHaveStarted: false,
      },
    },
    {
      version: 1,
      messageBase64: Buffer.from(successMessage).toString("base64url"),
      platformResult: { native: null, data: { items: [] } },
      failure: {
        name: "RedditTransportError",
        code: CORE_ERROR_CODES.AUTHENTICATION_FAILED,
        message: "conflicting synthetic result",
        retryable: false,
        actionRequired: true,
        submissionMayHaveStarted: false,
      },
    },
  ];
  const server = createServer((request, response) => {
    request.resume();
    const body = Buffer.from(JSON.stringify(replies.shift()));
    response.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const command = dispatcherCommand();
  try {
    const dispatcher = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${port}/v1/dispatch`);
    const success = await dispatcher.execute(command);
    assert.deepEqual(success.platformResult, { native: null, data: { items: [] } });
    const failure = await dispatcher.execute(command);
    assert.equal((failure.error as { code?: string }).code, CORE_ERROR_CODES.AUTHENTICATION_FAILED);
    assert.equal((failure.error as { actionRequired?: boolean }).actionRequired, true);
    await assert.rejects(
      dispatcher.execute(command),
      (error: unknown) => (error as { code?: string }).code === CORE_ERROR_CODES.PROTOCOL_DRIFT,
    );
  } finally {
    command.fill(0);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("production Reddit worker keeps media lease secrets local across the phased protocol", async () => {
  const redditCalls: Array<{ path: string; body: string }> = [];
  const uploads: Array<{ size: number; fields: readonly { name: string; value: string }[] }> = [];
  const dispatcher = new ProductionRedditCommandDispatcher({
    resolver: async () => ["151.101.1.140"],
    sessionConnectorFactory: () => async (request: any) => {
      const path = `${new URL(request.url).pathname}${new URL(request.url).search}`;
      const body = request.body ? Buffer.from(request.body).toString("utf8") : "";
      redditCalls.push({ path, body });
      const response = path === "/api/me.json"
        ? { data: { id: "aliceid", name: "alice", link_karma: 1, comment_karma: 2 } }
        : path === "/api/media/asset.json"
          ? {
            args: {
              action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com",
              fields: [
                { name: "key", value: "fixture/media.png" },
                { name: "policy", value: "signed-policy-must-stay-in-worker" },
                { name: "x-amz-signature", value: "signed-value-must-stay-in-worker" },
              ],
            },
          }
          : path === "/api/submit"
            ? { json: { errors: [], data: { websocket_url: "wss://wss.redditmedia.com/opaque-process" } } }
            : (() => { throw new Error(`unhandled Reddit fixture: ${path}`); })();
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(response)),
        remoteAddress: request.selectedAddress,
      };
    },
    uploadMedia: async (input) => {
      uploads.push({ size: input.data.length, fields: input.fields });
      assert.equal(input.uploadUrl, "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/");
    },
    processMedia: async (input) => {
      assert.equal(input.websocketUrl, "wss://wss.redditmedia.com/opaque-process");
      return {
        native: { nativeId: "t3_media", canonicalUrl: "https://www.reddit.com/r/test/comments/media/title/" },
        data: { created: true, kind: "media_post" },
      };
    },
  });
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const metadata = {
    filename: "fixture.png",
    mimeType: "image/png",
    sizeBytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const lease = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.lease", metadata, "lease"));
  assert.equal(lease.error, undefined);
  const ticket = String((lease.platformResult?.data as any).ticket);
  assert.match(ticket, /^[0-9a-f-]{36}$/u);
  assert.equal(JSON.stringify(lease.platformResult).includes("signed-policy"), false);

  const upload = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.upload", {
    ticket,
    dataBase64: data.toString("base64"),
    sizeBytes: data.length,
    sha256: metadata.sha256,
  }, "upload"));
  assert.equal(upload.error, undefined);
  const submit = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.submit", {
    ticket, subreddit: "test", title: "Media",
  }, "submit"));
  assert.equal(submit.error, undefined);
  const process = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.process", { ticket }, "process"));
  assert.equal(process.error, undefined);
  assert.deepEqual(process.platformResult?.native, {
    nativeId: "t3_media",
    canonicalUrl: "https://www.reddit.com/r/test/comments/media/title/",
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.size, data.length);
  assert.equal(uploads[0]?.fields.some(({ value }) => value.includes("signed-policy")), true);
  assert.equal(redditCalls.filter(({ path }) => path === "/api/media/asset.json").length, 1);
  assert.equal(redditCalls.filter(({ path }) => path === "/api/submit").length, 1);
  assert.equal(new URLSearchParams(redditCalls.find(({ path }) => path === "/api/submit")?.body).get("kind"), "image");
});

test("production Reddit worker reports media processing loss as UNKNOWN without another submit", async () => {
  let submitCalls = 0;
  const dispatcher = new ProductionRedditCommandDispatcher({
    resolver: async () => ["151.101.1.140"],
    sessionConnectorFactory: () => async (request: any) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/submit") submitCalls += 1;
      const response = path === "/api/me.json"
        ? { data: { id: "aliceid", name: "alice" } }
        : path === "/api/media/asset.json"
          ? { args: { action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com", fields: [{ name: "key", value: "fixture/media.png" }] } }
          : { json: { errors: [], data: { websocket_url: "wss://wss.redditmedia.com/opaque-process" } } };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(response)), remoteAddress: request.selectedAddress };
    },
    uploadMedia: async () => undefined,
    processMedia: async () => { throw new Error("synthetic worker loss after submit"); },
  });
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const leased = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.lease", {
    filename: "fixture.png", mimeType: "image/png", sizeBytes: data.length, sha256,
  }, "unknown-lease"));
  const ticket = String((leased.platformResult?.data as any).ticket);
  await dispatcher.execute(mediaWorkerCommand("reddit.post.media.upload", {
    ticket, dataBase64: data.toString("base64"), sizeBytes: data.length, sha256,
  }, "unknown-upload"));
  await dispatcher.execute(mediaWorkerCommand("reddit.post.media.submit", { ticket, subreddit: "test", title: "Media" }, "unknown-submit"));
  const process = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.process", { ticket }, "unknown-process"));
  assert.equal((process.error as any)?.submissionMayHaveStarted, true);
  assert.equal(submitCalls, 1);
});

test("production session import consumes a private file only after encrypted Core persistence", async () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-import-"));
  const imports = join(root, "imports");
  const databasePath = join(root, "sessions.sqlite");
  mkdirSync(imports, { mode: 0o700 });
  const path = join(imports, "reddit-alpha.json");
  const sessionSentinel = "SYNTHETIC_SESSION_NOT_LIVE_8f02";
  const routeSentinel = "SYNTHETIC_ROUTE_NOT_LIVE_31c4";
  writeFileSync(path, JSON.stringify({
    sessionBase64: Buffer.from(JSON.stringify({ cookies: { reddit_session: sessionSentinel }, csrfToken: "synthetic-csrf" })).toString("base64url"),
    networkRoute: {
      id: "direct-route-alpha",
      materialBase64: Buffer.from(JSON.stringify({ kind: "direct", marker: routeSentinel })).toString("base64url"),
    },
  }), { mode: 0o600 });
  const runtime = new SessionRuntime({ databasePath, tenantId: "tenant-test", masterKey: randomBytes(32), auditKey: randomBytes(32) });
  try {
    const provider = new CoreRedditTransportProvider({ runtime, source: new DirectorySessionSource(imports) });
    await provider.importConnection({ account: account(), vaultHandle: "reddit-alpha", generation: 1 });
    assert.equal(existsSync(path), false);
    assert.equal(runtime.getAccountState("account-alpha").health, "pending_identity");

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT session_envelope, route_envelope FROM accounts WHERE account_id = ?").get("account-alpha") as Record<string, unknown>;
      const observable = JSON.stringify({
        session: JSON.parse(Buffer.from(row.session_envelope as Uint8Array).toString("utf8")),
        route: JSON.parse(Buffer.from(row.route_envelope as Uint8Array).toString("utf8")),
      });
      assert.equal(observable.includes(sessionSentinel), false);
      assert.equal(observable.includes(routeSentinel), false);
      assert.notEqual(JSON.parse(observable).session.binding.purpose, JSON.parse(observable).route.binding.purpose);
    } finally {
      database.close();
    }

    provider.revoke({ account: account() });
    const databaseAfterRevoke = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const revoked = databaseAfterRevoke.prepare("SELECT session_envelope, route_envelope FROM accounts WHERE account_id = ?")
        .get("account-alpha") as Record<string, unknown>;
      assert.equal(revoked.session_envelope, null);
      assert.equal(revoked.route_envelope, null);
    } finally {
      databaseAfterRevoke.close();
    }
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct owner upload encrypts in memory and supersedes the prior Core generation without plaintext staging", () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-direct-import-"));
  const databasePath = join(root, "sessions.sqlite");
  const runtime = new SessionRuntime({ databasePath, tenantId: "tenant-test", masterKey: randomBytes(32), auditKey: randomBytes(32) });
  const provider = new CoreRedditTransportProvider({
    runtime,
    source: { consume() { throw new Error("directory source must not be used"); } },
  });
  const firstSecret = "DIRECT_SESSION_SENTINEL_GENERATION_ONE";
  const secondSecret = "DIRECT_SESSION_SENTINEL_GENERATION_TWO";
  try {
    assert.equal(provider.nextConnectionGeneration(account()), 1);
    provider.importDirectConnection({
      account: account(),
      generation: 1,
      session: Buffer.from(JSON.stringify({ cookies: { reddit_session: firstSecret }, csrfToken: "csrf-one" })),
      networkRoute: { id: "reddit-direct", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
    });
    const first = runtime.getAccountState("account-alpha");
    assert.equal(first.generation, 1);
    assert.equal(provider.nextConnectionGeneration(account()), 2);

    provider.importDirectConnection({
      account: account(),
      generation: 2,
      session: Buffer.from(JSON.stringify({ cookies: { reddit_session: secondSecret }, csrfToken: "csrf-two" })),
      networkRoute: { id: "reddit-direct", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
    });
    assert.equal(runtime.getAccountState("account-alpha").generation, 2);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT generation, session_envelope, route_envelope FROM accounts WHERE account_id = ?")
        .get("account-alpha") as Record<string, unknown>;
      const observable = JSON.stringify({
        generation: row.generation,
        session: JSON.parse(Buffer.from(row.session_envelope as Uint8Array).toString("utf8")),
        route: JSON.parse(Buffer.from(row.route_envelope as Uint8Array).toString("utf8")),
      });
      assert.equal(observable.includes(firstSecret), false);
      assert.equal(observable.includes(secondSecret), false);
      assert.equal(observable.includes("csrf-one"), false);
      assert.equal(observable.includes("csrf-two"), false);
    } finally {
      database.close();
    }
    assert.deepEqual(runtime.listAuditEvents().map((event) => event.eventType), ["session.imported", "session.rotated"]);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed one-time source commit revokes imported Core material", async () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-import-rollback-"));
  const session = Buffer.from("synthetic-session");
  const route = Buffer.from("synthetic-route");
  const runtime = new SessionRuntime({
    databasePath: join(root, "sessions.sqlite"),
    tenantId: "tenant-test",
    masterKey: randomBytes(32),
    auditKey: randomBytes(32),
  });
  try {
    const provider = new CoreRedditTransportProvider({
      runtime,
      source: {
        consume() {
          return {
            session,
            networkRoute: { id: "direct-route-alpha", material: route },
            commit() { throw new Error("synthetic commit failure"); },
          };
        },
      },
    });
    await assert.rejects(
      provider.importConnection({ account: account(), vaultHandle: "reddit-alpha", generation: 1 }),
      /synthetic commit failure/,
    );
    assert.equal(runtime.getAccountState("account-alpha").health, "revoked");
    assert.equal(session.every((value) => value === 0), true);
    assert.equal(route.every((value) => value === 0), true);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function account(): AccountRecord {
  return {
    id: "account-alpha",
    platform: "reddit",
    expectedNativeUserId: "reddit:t2_alpha",
    actualNativeUserId: null,
    label: null,
    status: "disconnected",
    connectionHealth: "disconnected",
    actionRequiredReason: null,
    healthGeneration: 0,
    lastVerifiedAt: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
}

function workerResult(status: "SUCCEEDED" | "AUTH_FAILURE") {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.result",
    requestId: "request-1",
    tenantId: "tenant-test",
    accountId: "account-alpha",
    platform: "reddit",
    generation: 1,
    leaseId: "lease-1",
    fence: 1,
    status,
    observedNativeIdentity: "reddit:t2_alpha",
  });
}

function dispatcherCommand() {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.command",
    requestId: "request-1",
    tenantId: "tenant-test",
    accountId: "account-alpha",
    platform: "reddit",
    generation: 1,
    leaseId: "lease-1",
    fence: 1,
    expiresAt: Date.now() + 30_000,
    intent: "read",
    operation: "profile.get",
    expectedNativeIdentity: "reddit:t2_alpha",
    sessionBase64: Buffer.from("synthetic-session").toString("base64url"),
    networkRoute: { id: "direct-route-alpha", materialBase64: Buffer.from("synthetic-route").toString("base64url") },
    payload: {},
  });
}

function mediaWorkerCommand(operation: string, payload: Record<string, unknown>, requestId: string) {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.command",
    requestId,
    tenantId: "tenant-test",
    accountId: "account-alpha",
    platform: "reddit",
    generation: 1,
    leaseId: `lease-${requestId}`,
    fence: 1,
    expiresAt: Date.now() + 30_000,
    intent: "write",
    operation,
    expectedNativeIdentity: "t2_aliceid",
    sessionBase64: Buffer.from(JSON.stringify({ cookies: { reddit_session: "synthetic-not-live" }, csrfToken: "synthetic-modhash" })).toString("base64url"),
    networkRoute: { id: "direct-route-alpha", materialBase64: Buffer.from(JSON.stringify({ kind: "direct" })).toString("base64url") },
    payload,
  });
}
