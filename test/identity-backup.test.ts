import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IdentityStore } from "../src/identity.ts";
import { createIdentityBackup, restoreIdentityBackup, validateIdentityDatabase } from "../src/identity-backup.ts";

test("identity backup encrypts, restores, and preserves the first owner", async () => {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-identity-backup-"));
  chmodSync(directory, 0o700);
  const database = join(directory, "identity.sqlite");
  const encrypted = join(directory, "identity.backup");
  const restored = join(directory, "restored.sqlite");
  const backupKey = Buffer.alloc(32, 0x41);
  try {
    const store = new IdentityStore(database, { tenantId: "tenant-test" });
    store.createFirstOwner({ email: "owner@example.test", displayName: "Owner", password: "unique-password-123!" });
    store.close();

    await createIdentityBackup({ databasePath: database, backupPath: encrypted, backupKey, tenantId: "tenant-test" });
    assert.equal(readFileSync(encrypted).includes(Buffer.from("owner@example.test")), false);
    restoreIdentityBackup({ backupPath: encrypted, destinationPath: restored, backupKey, tenantId: "tenant-test" });
    validateIdentityDatabase(restored, "tenant-test").fill(0);

    const recovered = new IdentityStore(restored, { tenantId: "tenant-test" });
    assert.equal(recovered.setupStatus().required, false);
    assert.equal(recovered.login({ email: "owner@example.test", password: "unique-password-123!" })?.principal.role, "owner");
    recovered.close();
  } finally {
    backupKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("identity restore rejects tampering", async () => {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-identity-tamper-"));
  chmodSync(directory, 0o700);
  const database = join(directory, "identity.sqlite");
  const encrypted = join(directory, "identity.backup");
  const backupKey = Buffer.alloc(32, 0x42);
  try {
    new IdentityStore(database, { tenantId: "tenant-test" }).close();
    await createIdentityBackup({ databasePath: database, backupPath: encrypted, backupKey, tenantId: "tenant-test" });
    const tampered = readFileSync(encrypted);
    const index = Math.floor(tampered.length / 2);
    tampered[index] = (tampered[index] ?? 0) ^ 1;
    writeFileSync(encrypted, tampered, { mode: 0o600 });
    assert.throws(() => restoreIdentityBackup({
      backupPath: encrypted,
      destinationPath: join(directory, "restored.sqlite"),
      backupKey,
      tenantId: "tenant-test",
    }));
  } finally {
    backupKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
