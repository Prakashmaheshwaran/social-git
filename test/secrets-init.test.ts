import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../runtime/secrets-init.mjs", import.meta.url);

test("secret initialization is private, distinct, and idempotent", () => {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-secrets-"));
  chmodSync(directory, 0o700);
  try {
    const first = run(directory);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { status: "ok", created: 3, existing: 0 });
    const values = ["master-key", "audit-key", "backup-key"].map((name) => {
      const path = join(directory, name);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      return readFileSync(path, "utf8").trim();
    });
    assert.equal(new Set(values).size, 3);
    assert.ok(values.every((value) => Buffer.from(value, "base64url").length === 32));

    const second = run(directory);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), { status: "ok", created: 0, existing: 3 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("secret initialization fails closed on an invalid existing key", () => {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-secrets-invalid-"));
  chmodSync(directory, 0o700);
  try {
    writeFileSync(join(directory, "master-key"), "not-a-valid-key\n", { mode: 0o600 });
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("not-a-valid-key"), false);
    assert.deepEqual(JSON.parse(result.stderr), { status: "failed", error: "secret initialization failed" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(directory: string) {
  return spawnSync(process.execPath, [script.pathname], {
    env: { ...process.env, SOCIAL_GIT_SECRETS_DIR: directory },
    encoding: "utf8",
  });
}
