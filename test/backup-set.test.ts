import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRuntime, restoreEncryptedBackup } from "@social-git/core";
import {
  createAuthenticatedBackupSetManifest,
  sha256File,
  verifyAuthenticatedBackupSetManifest,
  writeAuthenticatedBackupSetManifest,
  writeRestoreSetReceipt,
} from "../src/backup-set.ts";
import { createIdentityBackup, restoreIdentityBackup } from "../src/identity-backup.ts";
import { IdentityStore } from "../src/identity.ts";
import { createActionLedgerBackup, restoreActionLedgerBackup } from "../src/ledger-backup.ts";
import { LedgerStore } from "../src/persistence.ts";

const tenantId = "restore-test-tenant";
const ledgerId = "restore-test-ledger";

test("backup set manifest authenticates one complete context and rejects mixed, missing, foreign, expired, and tampered sets", async () => {
  const fixture = await backupFixture();
  try {
    const manifest = verifyAuthenticatedBackupSetManifest({ directory: fixture.setA, setName: "set-a", tenantId, ledgerId, backupKey: fixture.backupKey });
    assert.equal(manifest.databaseCount, 3);

    assert.throws(() => verifyAuthenticatedBackupSetManifest({ directory: fixture.setA, setName: "set-a", tenantId: "foreign", ledgerId, backupKey: fixture.backupKey }));
    assert.throws(() => verifyAuthenticatedBackupSetManifest({ directory: fixture.setA, setName: "set-a", tenantId, ledgerId, backupKey: fixture.backupKey, now: Date.parse(manifest.expiresAt) }));

    const manifestPath = join(fixture.setA, "manifest.json");
    const originalManifest = readFileSync(manifestPath);
    const parsed = JSON.parse(originalManifest.toString("utf8"));
    parsed.completedAt = new Date(Date.parse(parsed.completedAt) + 1).toISOString();
    writeFileSync(manifestPath, JSON.stringify(parsed), { mode: 0o600 });
    assert.throws(() => verifyAuthenticatedBackupSetManifest({ directory: fixture.setA, setName: "set-a", tenantId, ledgerId, backupKey: fixture.backupKey }));
    writeFileSync(manifestPath, originalManifest, { mode: 0o600 });

    const actionPath = join(fixture.setA, "actions.backup");
    const savedAction = join(fixture.root, "actions.saved");
    renameSync(actionPath, savedAction);
    assert.throws(() => verifyAuthenticatedBackupSetManifest({ directory: fixture.setA, setName: "set-a", tenantId, ledgerId, backupKey: fixture.backupKey }));
    copyFileSync(join(fixture.setB, "actions.backup"), actionPath);
    chmodSync(actionPath, 0o600);
    assert.throws(() => verifyAuthenticatedBackupSetManifest({ directory: fixture.setA, setName: "set-a", tenantId, ledgerId, backupKey: fixture.backupKey }));
    renameSync(savedAction, actionPath);
    assert.equal(verifyAuthenticatedBackupSetManifest({ directory: fixture.setA, setName: "set-a", tenantId, ledgerId, backupKey: fixture.backupKey }).setId, manifest.setId);
  } finally { fixture.close(); }
});

test("restore promotion rolls back a pre-commit crash, rolls forward a committed crash, and rejects replay", async () => {
  const fixture = await backupFixture();
  try {
    const dataDir = join(fixture.root, "live");
    const restoreRoot = join(fixture.root, "restore");
    mkdirSync(dataDir, { mode: 0o700 });
    mkdirSync(restoreRoot, { mode: 0o700 });
    const old = new Map<string, string>();
    for (const name of databaseFiles()) {
      const path = join(dataDir, name);
      writeFileSync(path, `old:${name}`, { mode: 0o600 });
      old.set(name, sha256File(path));
    }
    const restoreA = join(restoreRoot, "set-a");
    restoreSet(fixture.setA, restoreA, "set-a", fixture);
    const environment = promotionEnvironment(fixture, dataDir, restoreRoot);
    const crashed = spawnSync(process.execPath, [join(process.cwd(), "runtime/promote-restore.mjs"), "set-a"], {
      env: { ...environment, SOCIAL_GIT_RESTORE_FAULT: "after-publish-3" }, encoding: "utf8",
    });
    assert.equal(crashed.status, 86, crashed.stderr);
    const recovered = spawnSync(process.execPath, [join(process.cwd(), "runtime/promote-restore.mjs"), "--recover-only"], { env: environment, encoding: "utf8" });
    assert.equal(recovered.status, 0, recovered.stderr);
    for (const name of databaseFiles()) assert.equal(sha256File(join(dataDir, name)), old.get(name), name);

    const promoted = spawnSync(process.execPath, [join(process.cwd(), "runtime/promote-restore.mjs"), "set-a"], { env: environment, encoding: "utf8" });
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal(existsSync(join(dataDir, "restore-promotion.json")), false);
    restoreSet(fixture.setA, restoreA, "set-a", fixture);
    const replay = spawnSync(process.execPath, [join(process.cwd(), "runtime/promote-restore.mjs"), "set-a"], { env: environment, encoding: "utf8" });
    assert.equal(replay.status, 1, "replaying a successfully promoted set must fail closed");

    const restoreB = join(restoreRoot, "set-b");
    restoreSet(fixture.setB, restoreB, "set-b", fixture);
    const committedCrash = spawnSync(process.execPath, [join(process.cwd(), "runtime/promote-restore.mjs"), "set-b"], {
      env: { ...environment, SOCIAL_GIT_RESTORE_FAULT: "after-commit" }, encoding: "utf8",
    });
    assert.equal(committedCrash.status, 86, committedCrash.stderr);
    const expected = new Map(databaseFiles().map((name) => [name, sha256File(join(restoreB, name))]));
    const rollForward = spawnSync(process.execPath, [join(process.cwd(), "runtime/promote-restore.mjs"), "--recover-only"], { env: environment, encoding: "utf8" });
    assert.equal(rollForward.status, 0, rollForward.stderr);
    for (const name of databaseFiles()) assert.equal(sha256File(join(dataDir, name)), expected.get(name), name);
    assert.equal(existsSync(join(dataDir, "restore-promotion.json")), false);
  } finally { fixture.close(); }
});

async function backupFixture() {
  const root = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-backup-set-"));
  chmodSync(root, 0o700);
  const keys = { backupKey: Buffer.alloc(32, 0x31), masterKey: Buffer.alloc(32, 0x32), auditKey: Buffer.alloc(32, 0x33) };
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const sessions = new SessionRuntime({ databasePath: join(source, "sessions.sqlite"), tenantId, masterKey: keys.masterKey, auditKey: keys.auditKey });
  const ledger = new LedgerStore(join(source, "actions.sqlite"), { ledgerId, auditKey: keys.auditKey });
  ledger.createAccount({ platform: "reddit", expectedNativeUserId: "native", callerId: "fixture" });
  ledger.close();
  const identity = new IdentityStore(join(source, "identity.sqlite"), { tenantId, auditKey: keys.auditKey });
  identity.createFirstOwner({ email: "restore@example.test", displayName: "Restore", password: "restore-password-123!" });
  identity.close();
  const createSet = async (name: string, marker: number) => {
    const directory = join(root, "backups", name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    sessions.createEncryptedBackup({ backupPath: join(directory, "sessions.backup"), backupKey: keys.backupKey, expiresAt: Date.now() + 86_400_000 });
    await createActionLedgerBackup({ databasePath: join(source, "actions.sqlite"), backupPath: join(directory, "actions.backup"), backupKey: keys.backupKey, ledgerId, auditKey: keys.auditKey });
    await createIdentityBackup({ databasePath: join(source, "identity.sqlite"), backupPath: join(directory, "identity.backup"), backupKey: keys.backupKey, tenantId, auditKey: keys.auditKey });
    const manifest = createAuthenticatedBackupSetManifest({ directory, setName: name, tenantId, ledgerId, backupKey: keys.backupKey, completedAt: Date.now() + marker });
    writeAuthenticatedBackupSetManifest(directory, manifest);
    return directory;
  };
  const setA = await createSet("set-a", 1);
  const setB = await createSet("set-b", 2);
  sessions.close();
  const keyFiles = { backup: join(root, "backup.key"), master: join(root, "master.key"), audit: join(root, "audit.key") };
  writeFileSync(keyFiles.backup, keys.backupKey.toString("base64url"), { mode: 0o600 });
  writeFileSync(keyFiles.master, keys.masterKey.toString("base64url"), { mode: 0o600 });
  writeFileSync(keyFiles.audit, keys.auditKey.toString("base64url"), { mode: 0o600 });
  return { root, setA, setB, ...keys, keyFiles, close() { keys.backupKey.fill(0); keys.masterKey.fill(0); keys.auditKey.fill(0); rmSync(root, { recursive: true, force: true }); } };
}

function restoreSet(source: string, destination: string, setName: string, fixture: Awaited<ReturnType<typeof backupFixture>>) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const manifest = verifyAuthenticatedBackupSetManifest({ directory: source, setName, tenantId, ledgerId, backupKey: fixture.backupKey });
  restoreEncryptedBackup({ backupPath: join(source, "sessions.backup"), destinationPath: join(destination, "sessions.sqlite"), backupKey: fixture.backupKey, tenantId });
  restoreActionLedgerBackup({ backupPath: join(source, "actions.backup"), destinationPath: join(destination, "actions.sqlite"), backupKey: fixture.backupKey, ledgerId, auditKey: fixture.auditKey });
  restoreIdentityBackup({ backupPath: join(source, "identity.backup"), destinationPath: join(destination, "identity.sqlite"), backupKey: fixture.backupKey, tenantId, auditKey: fixture.auditKey });
  writeRestoreSetReceipt({ restoreDirectory: destination, sourceDirectory: source, manifest, backupKey: fixture.backupKey });
}

function promotionEnvironment(fixture: Awaited<ReturnType<typeof backupFixture>>, dataDir: string, restoreRoot: string) {
  return {
    ...process.env,
    SOCIAL_GIT_TENANT_ID: tenantId,
    SOCIAL_GIT_LEDGER_ID: ledgerId,
    SOCIAL_GIT_DATA_DIR: dataDir,
    SOCIAL_GIT_BACKUP_DIR: join(fixture.root, "backups"),
    SOCIAL_GIT_RESTORE_DIR: restoreRoot,
    SOCIAL_GIT_BACKUP_KEY_FILE: fixture.keyFiles.backup,
    SOCIAL_GIT_MASTER_KEY_FILE: fixture.keyFiles.master,
    SOCIAL_GIT_AUDIT_KEY_FILE: fixture.keyFiles.audit,
  } as NodeJS.ProcessEnv;
}

function databaseFiles() {
  return ["sessions.sqlite", "sessions.sqlite.audit-anchor", "actions.sqlite", "actions.sqlite.audit-anchor", "identity.sqlite", "identity.sqlite.audit-anchor"];
}
