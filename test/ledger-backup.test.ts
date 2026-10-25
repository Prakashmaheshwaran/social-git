import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createActionLedgerBackup,
  restoreActionLedgerBackup,
  validateActionLedgerDatabase,
} from "../src/ledger-backup.ts";
import { LedgerStore } from "../src/persistence.ts";

test("action ledger backup: encrypted round trip preserves idempotency and audit state", async () => {
  const directory = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-ledger-backup-"));
  const sourcePath = join(directory, "actions.sqlite");
  const backupPath = join(directory, "actions.backup");
  const restoredPath = join(directory, "restored.sqlite");
  const key = Buffer.alloc(32, 0x42);
  try {
    const store = new LedgerStore(sourcePath, { ledgerId: "ledger-backup-test" });
    const account = store.createAccount({ platform: "reddit", expectedNativeUserId: "native-user", callerId: "caller" });
    const created = store.createAction({
      callerId: "caller",
      accountId: account.id,
      idempotencyKey: "durable-key",
      request: { kind: "save", targetId: "post-1" },
    });
    store.close();

    const metadata = await createActionLedgerBackup({
      databasePath: sourcePath,
      backupPath,
      backupKey: key,
      ledgerId: "ledger-backup-test",
    });
    assert.equal(metadata.schemaVersion, 9);
    assert.equal(readFileSync(backupPath).includes(Buffer.from("durable-key")), false);
    restoreActionLedgerBackup({
      backupPath,
      destinationPath: restoredPath,
      backupKey: key,
      ledgerId: "ledger-backup-test",
    });
    const anchor = validateActionLedgerDatabase(restoredPath, "ledger-backup-test");
    anchor.fill(0);
    const restored = new LedgerStore(restoredPath, { ledgerId: "ledger-backup-test" });
    const replay = restored.createAction({
      callerId: "caller",
      accountId: account.id,
      idempotencyKey: "durable-key",
      request: { targetId: "post-1", kind: "save" },
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.action.id, created.action.id);
    restored.close();
  } finally {
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("action ledger backup: tampering and wrong ledger identity fail closed", async () => {
  const directory = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-ledger-tamper-"));
  const sourcePath = join(directory, "actions.sqlite");
  const backupPath = join(directory, "actions.backup");
  const tamperedPath = join(directory, "tampered.backup");
  const key = Buffer.alloc(32, 0x43);
  try {
    new LedgerStore(sourcePath, { ledgerId: "ledger-a" }).close();
    await createActionLedgerBackup({ databasePath: sourcePath, backupPath, backupKey: key, ledgerId: "ledger-a" });
    const tampered = readFileSync(backupPath);
    const tamperIndex = Math.floor(tampered.length / 2);
    tampered[tamperIndex] = tampered[tamperIndex]! ^ 1;
    writeFileSync(tamperedPath, tampered, { mode: 0o600 });
    assert.throws(() => restoreActionLedgerBackup({
      backupPath: tamperedPath,
      destinationPath: join(directory, "tampered.sqlite"),
      backupKey: key,
      ledgerId: "ledger-a",
    }));
    assert.throws(() => restoreActionLedgerBackup({
      backupPath,
      destinationPath: join(directory, "wrong-ledger.sqlite"),
      backupKey: key,
      ledgerId: "ledger-b",
    }));
  } finally {
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
