import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, startSocialGitRuntime } from "../src/index.ts";
import { REDDIT_CAPABILITIES } from "@social-git/reddit-adapter";

const TOKEN = "reddit-platform-capabilities-token";

test("GET /v1/platforms/reddit/capabilities returns the honest Reddit catalog before connection", async () => {
  const fixture = runtimeFiles();
  const runtime = await startSocialGitRuntime(loadRuntimeConfig(fixture.environment));
  try {
    const response = await fetch(`${runtime.url}/v1/platforms/reddit/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { platform: string; details: Array<Record<string, unknown>> };

    assert.equal(body.platform, "reddit");
    assert.ok(Array.isArray(body.details));

    // The public catalog must be exactly the adapter's declared catalog, in
    // order, so a pre-connection caller cannot be told about a capability the
    // adapter would refuse or miss one it would accept.
    assert.deepEqual(
      body.details.map((entry) => entry.operation),
      REDDIT_CAPABILITIES.map((capability: { operation: string }) => capability.operation),
    );

    const admissionWrites = REDDIT_CAPABILITIES
      .filter((capability: { mode: string; productionEnabled: boolean }) => capability.mode === "write" && capability.productionEnabled)
      .map((capability: { operation: string }) => capability.operation);
    assert.deepEqual(admissionWrites, [
      "post.createText",
      "post.createLink",
      "post.createMedia",
      "comment.create",
      "reply.create",
      "item.editOwn",
      "vote.set",
      "save.set",
      "save.unset",
      "subreddit.subscribe",
      "subreddit.unsubscribe",
      "item.deleteOwn",
    ]);

    const messaging = body.details.filter((entry) => String(entry.operation).startsWith("message."));
    assert.deepEqual(
      messaging.map((entry) => [entry.operation, entry.productionEnabled, entry.disabledReason]),
      [
        ["message.inbox", false, "AUTHORIZED_LIVE_INBOX_PROOF_MISSING"],
        ["message.thread", false, "DIRECT_SESSION_THREAD_MAPPING_UNPROVEN"],
        ["message.send", false, "NO_VERIFIABLE_NATIVE_RESULT"],
        ["message.reply", false, "DIRECT_SESSION_REPLY_MAPPING_UNPROVEN"],
      ],
    );

    for (const entry of body.details) {
      assert.equal(entry.fixtureEnabled, true, `${String(entry.operation)} must remain fixture-enabled`);
      if (entry.productionEnabled === true) {
        assert.equal(entry.disabledReason, null, `${String(entry.operation)} cannot be production-enabled with a reason`);
        assert.equal(entry.protocolMapping, "MAPPED");
      } else {
        assert.equal(typeof entry.disabledReason, "string", `${String(entry.operation)} must state why it is disabled`);
        assert.ok(String(entry.disabledReason).length > 0);
        assert.equal(entry.protocolMapping, "UNSUPPORTED");
      }
    }

    // The catalog is pre-connection discovery: it must not require an account
    // or expose any session material.
    const serialized = JSON.stringify(body);
    for (const forbidden of ["cookie", "csrf", "sessionMaterial", "vaultHandle", "token"]) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `catalog leaked ${forbidden}`);
    }

    const unknown = await fetch(`${runtime.url}/v1/platforms/myspace/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(unknown.status, 502);
    assert.equal((await unknown.json() as any).error.code, "PROTOCOL_DRIFT");
  } finally {
    await runtime.close();
    fixture.close();
  }
});

function runtimeFiles() {
  const root = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-reddit-capabilities-"));
  const master = join(root, "master.key");
  const audit = join(root, "audit.key");
  const backup = join(root, "backup.key");
  const auth = join(root, "auth.json");
  writeFileSync(master, Buffer.alloc(32, 23).toString("base64url"), { mode: 0o600 });
  writeFileSync(audit, Buffer.alloc(32, 24).toString("base64url"), { mode: 0o600 });
  writeFileSync(backup, Buffer.alloc(32, 25).toString("base64url"), { mode: 0o600 });
  writeFileSync(auth, JSON.stringify({
    version: 1,
    principals: [{
      tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
      callerId: "capabilities-caller",
      scopes: ["social:read"],
    }],
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
    SOCIAL_GIT_LEDGER_ID: "fixture-ledger",
  } as NodeJS.ProcessEnv;
  return { root, environment, close: () => rmSync(root, { recursive: true, force: true }) };
}
