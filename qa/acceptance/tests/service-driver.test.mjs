import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, startSocialGitRuntime } from "../../../src/index.ts";
import { createDriver } from "../service-driver.mjs";
import { runAcceptance } from "../suite.mjs";

const TOKEN = "fixture-candidate-driver-token";
const IMAGE_DIGEST = `sha256:${"7".repeat(64)}`;

test("service candidate driver exercises the executable public boundary", async () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-driver-"));
  const environment = fixtureEnvironment(root);
  const runtime = await startSocialGitRuntime(loadRuntimeConfig(environment));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({ provenance: "independent_inventory", source: { digest: IMAGE_DIGEST } }), { mode: 0o600 });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    SOCIAL_GIT_CANDIDATE_URL: runtime.url,
    SOCIAL_GIT_QA_TOKEN: TOKEN,
    SOCIAL_GIT_QA_IMAGE_INVENTORY: inventoryPath,
  })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  const driver = await createDriver({ candidateRef: `git:${"8".repeat(40)}`, imageDigest: IMAGE_DIGEST });
  try {
    await driver.reset();
    await driver.control("platform-session", { sessionFixture: "session-alpha", nativeIdentity: "qa_alpha" });
    const imported = await driver.call("session.import", {
      accountId: "acct-alpha",
      expectedIdentity: "qa_alpha",
      routeId: "route-alpha",
      sessionFixture: "session-alpha",
    });
    assert.equal(imported.status, 201, JSON.stringify(imported));

    const published = await driver.call("write.post.text", {
      accountId: "acct-alpha",
      subreddit: "qualityassurance",
      title: "Fixture title",
      body: "Fixture body",
    }, {
      callerId: "qa-caller-a",
      idempotencyKey: "publish-one",
      scopes: ["reddit.write.post.text"],
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.result.state, "CONFIRMED");
    assert.equal((await driver.inspect("platform-calls")).filter((entry) => entry.operation === "write.post.text").length, 1);

    await driver.control("crash-after-submit", { accountId: "acct-alpha", operation: "write.comment" });
    const unknown = await driver.call("write.comment", {
      accountId: "acct-alpha",
      targetNativeId: "t3_fixture",
      body: "Uncertain fixture comment",
    }, {
      callerId: "qa-caller-a",
      idempotencyKey: "comment-unknown",
      scopes: ["reddit.write.comment"],
    });
    assert.equal(unknown.status, 202);
    assert.equal(unknown.body.result.state, "UNKNOWN");
    await driver.control("reconciliation-outcome", {
      actionId: unknown.body.result.actionId,
      outcome: "confirmed",
      nativeId: "t1_reconciled_fixture",
      canonicalUrl: "https://www.reddit.com/r/qualityassurance/comments/fixture/reconciled/",
    });
    const reconciled = await driver.call("action.reconcile", { actionId: unknown.body.result.actionId }, { callerId: "qa-caller-a" });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.result.state, "CONFIRMED");
    assert.equal((await driver.inspect("production-image")).source.digest, IMAGE_DIGEST);
  } finally {
    await driver.close();
    await runtime.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("service candidate driver passes the complete public-boundary acceptance suite", async () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-acceptance-"));
  const environment = fixtureEnvironment(root);
  environment.SOCIAL_GIT_PORT = String(await reservePort());
  let runtime = await startSocialGitRuntime(loadRuntimeConfig(environment));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    provenance: "independent_inventory",
    source: { kind: "image_tar", digest: IMAGE_DIGEST },
    browserExecutables: [],
    dependencies: [],
    runtimeFiles: [],
    imageCommands: [],
    runtimeProcesses: [],
  }), { mode: 0o600 });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    SOCIAL_GIT_CANDIDATE_URL: runtime.url,
    SOCIAL_GIT_QA_TOKEN: TOKEN,
    SOCIAL_GIT_QA_IMAGE_INVENTORY: inventoryPath,
  })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  const base = await createDriver({ candidateRef: `git:${"8".repeat(40)}`, imageDigest: IMAGE_DIGEST });
  let callsBeforeRestart = [];
  const driver = {
    ...base,
    async reset() {
      callsBeforeRestart = [];
      return base.reset();
    },
    async control(command, payload) {
      if (command !== "restart") return base.control(command, payload);
      callsBeforeRestart.push(...await base.inspect("platform-calls"));
      await runtime.close();
      runtime = await startSocialGitRuntime(loadRuntimeConfig(environment));
      const ready = await fetch(`${runtime.url}/readyz`, { headers: { connection: "close" } });
      if (!ready.ok) throw new Error(`Restarted candidate was not ready: ${ready.status}`);
    },
    async inspect(target) {
      const current = await base.inspect(target);
      return target === "platform-calls" ? [...callsBeforeRestart, ...current] : current;
    },
  };
  try {
    const report = await runAcceptance(driver);
    assert.equal(report.verdict, "GO", JSON.stringify(report, null, 2));
  } finally {
    await runtime.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an acceptance port");
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

function fixtureEnvironment(root) {
  const master = join(root, "master.key");
  const audit = join(root, "audit.key");
  const auth = join(root, "auth.json");
  writeFileSync(master, Buffer.alloc(32, 17).toString("base64url"), { mode: 0o600 });
  writeFileSync(audit, Buffer.alloc(32, 18).toString("base64url"), { mode: 0o600 });
  writeFileSync(auth, JSON.stringify({
    version: 1,
    principals: [{
      tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
      callerId: "qa-controller",
      scopes: ["*", "fixture:control"],
    }],
  }), { mode: 0o600 });
  return {
    NODE_ENV: "test",
    SOCIAL_GIT_MODE: "fixture",
    SOCIAL_GIT_DATA_DIR: join(root, "data"),
    SOCIAL_GIT_MASTER_KEY_FILE: master,
    SOCIAL_GIT_AUDIT_KEY_FILE: audit,
    SOCIAL_GIT_AUTH_FILE: auth,
    SOCIAL_GIT_HOST: "127.0.0.1",
    SOCIAL_GIT_PORT: "0",
    SOCIAL_GIT_WORKER_INTERVAL_MS: "25",
    SOCIAL_GIT_TENANT_ID: "fixture-tenant",
    SOCIAL_GIT_LEDGER_ID: "fixture-ledger",
  };
}
