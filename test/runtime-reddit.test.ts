import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRuntime } from "@social-git/core";
import { CoreRedditTransportProvider, DirectorySessionSource, type AccountRecord } from "../src/index.ts";

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
