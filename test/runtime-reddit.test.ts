import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRuntime, encodeWorkerMessage } from "@social-git/core";
import { CORE_ERROR_CODES } from "@social-git/reddit-adapter";
import { CoreRedditTransportProvider, DirectorySessionSource, RemoteRedditCommandDispatcher, type AccountRecord } from "../src/index.ts";

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
  try {
    const dispatcher = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${port}/v1/dispatch`);
    const success = await dispatcher.execute(Buffer.from("bounded-command"));
    assert.deepEqual(success.platformResult, { native: null, data: { items: [] } });
    const failure = await dispatcher.execute(Buffer.from("bounded-command"));
    assert.equal((failure.error as { code?: string }).code, CORE_ERROR_CODES.AUTHENTICATION_FAILED);
    assert.equal((failure.error as { actionRequired?: boolean }).actionRequired, true);
    await assert.rejects(
      dispatcher.execute(Buffer.from("bounded-command")),
      (error: unknown) => (error as { code?: string }).code === CORE_ERROR_CODES.PROTOCOL_DRIFT,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
