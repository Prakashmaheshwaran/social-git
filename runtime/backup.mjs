#!/usr/bin/env node

import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MAX_BACKUP_RETENTION_MS,
  SESSION_RUNTIME_SCHEMA_VERSION,
  SessionRuntime,
  restoreEncryptedBackup,
} from "@social-git/core";
import {
  ACTION_LEDGER_SCHEMA_VERSION,
  createActionLedgerBackup,
  restoreActionLedgerBackup,
  validateActionLedgerDatabase,
} from "../src/ledger-backup.ts";
import {
  createIdentityBackup,
  restoreIdentityBackup,
  validateIdentityDatabase,
} from "../src/identity-backup.ts";
import {
  createAuthenticatedBackupSetManifest,
  verifyAuthenticatedBackupSetManifest,
  writeAuthenticatedBackupSetManifest,
  writeRestoreSetReceipt,
} from "../src/backup-set.ts";

const operation = process.argv[2];
const options = parseOptions(process.argv.slice(3));

try {
  if (operation === "set-create") {
    const backupKey = readKey(options, "backup-key-file");
    try {
      const directory = absolute(options, "directory");
      const manifest = createAuthenticatedBackupSetManifest({
        directory,
        setName: text(options, "set-name"),
        tenantId: text(options, "tenant-id"),
        ledgerId: text(options, "ledger-id"),
        backupKey,
      });
      writeAuthenticatedBackupSetManifest(directory, manifest);
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", setId: manifest.setId, set: manifest.id })}\n`);
    } finally { backupKey.fill(0); }
  } else if (operation === "set-verify") {
    const backupKey = readKey(options, "backup-key-file");
    try {
      const manifest = verifyAuthenticatedBackupSetManifest({
        directory: absolute(options, "directory"),
        setName: text(options, "set-name"),
        tenantId: text(options, "tenant-id"),
        ledgerId: text(options, "ledger-id"),
        backupKey,
      });
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", setId: manifest.setId, set: manifest.id })}\n`);
    } finally { backupKey.fill(0); }
  } else if (operation === "set-restore") {
    const backupKey = readKey(options, "backup-key-file");
    const auditKey = readKey(options, "audit-key-file");
    const sourceDirectory = absolute(options, "directory");
    const destinationDirectory = absolute(options, "output-directory");
    try {
      const setName = text(options, "set-name");
      const tenantId = text(options, "tenant-id");
      const ledgerId = text(options, "ledger-id");
      const manifest = verifyAuthenticatedBackupSetManifest({ directory: sourceDirectory, setName, tenantId, ledgerId, backupKey });
      rmSync(destinationDirectory, { recursive: true, force: true });
      mkdirSync(destinationDirectory, { mode: 0o700 });
      restoreEncryptedBackup({
        backupPath: join(sourceDirectory, "sessions.backup"), destinationPath: join(destinationDirectory, "sessions.sqlite"),
        backupKey, tenantId, schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION,
      });
      restoreActionLedgerBackup({
        backupPath: join(sourceDirectory, "actions.backup"), destinationPath: join(destinationDirectory, "actions.sqlite"), backupKey, ledgerId, auditKey,
      });
      restoreIdentityBackup({
        backupPath: join(sourceDirectory, "identity.backup"), destinationPath: join(destinationDirectory, "identity.sqlite"), backupKey, tenantId, auditKey,
      });
      writeRestoreSetReceipt({ restoreDirectory: destinationDirectory, sourceDirectory, manifest, backupKey });
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", setId: manifest.setId, set: manifest.id })}\n`);
    } catch (error) {
      rmSync(destinationDirectory, { recursive: true, force: true });
      throw error;
    } finally { backupKey.fill(0); auditKey.fill(0); }
  } else if (operation === "identity-create") {
    const backupKey = readKey(options, "backup-key-file");
    const auditKey = readKey(options, "audit-key-file");
    try {
      const metadata = await createIdentityBackup({
        databasePath: absolute(options, "database"),
        backupPath: absolute(options, "output"),
        backupKey,
        tenantId: text(options, "tenant-id"),
        auditKey,
      });
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", backupId: metadata.backupId })}\n`);
    } finally {
      backupKey.fill(0);
      auditKey.fill(0);
    }
  } else if (operation === "identity-restore") {
    const backupKey = readKey(options, "backup-key-file");
    const auditKey = readKey(options, "audit-key-file");
    try {
      const metadata = restoreIdentityBackup({
        backupPath: absolute(options, "backup"),
        destinationPath: absolute(options, "database"),
        backupKey,
        tenantId: text(options, "tenant-id"),
        auditKey,
      });
      chmodSync(absolute(options, "database"), 0o600);
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", backupId: metadata.backupId })}\n`);
    } finally {
      backupKey.fill(0);
      auditKey.fill(0);
    }
  } else if (operation === "identity-validate") {
    const auditKey = readKey(options, "audit-key-file");
    try {
      const anchor = validateIdentityDatabase(absolute(options, "database"), text(options, "tenant-id"), auditKey);
      anchor.fill(0);
    } finally { auditKey.fill(0); }
    process.stdout.write(`${JSON.stringify({ operation, status: "ok" })}\n`);
  } else if (operation === "ledger-create") {
    const backupKey = readKey(options, "backup-key-file");
    const auditKey = readKey(options, "audit-key-file");
    try {
      const metadata = await createActionLedgerBackup({
        databasePath: absolute(options, "database"),
        backupPath: absolute(options, "output"),
        backupKey,
        ledgerId: text(options, "ledger-id"),
        auditKey,
      });
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", backupId: metadata.backupId })}\n`);
    } finally {
      backupKey.fill(0);
      auditKey.fill(0);
    }
  } else if (operation === "ledger-restore") {
    const backupKey = readKey(options, "backup-key-file");
    const auditKey = readKey(options, "audit-key-file");
    try {
      const metadata = restoreActionLedgerBackup({
        backupPath: absolute(options, "backup"),
        destinationPath: absolute(options, "database"),
        backupKey,
        ledgerId: text(options, "ledger-id"),
        auditKey,
      });
      chmodSync(absolute(options, "database"), 0o600);
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", backupId: metadata.backupId })}\n`);
    } finally {
      backupKey.fill(0);
      auditKey.fill(0);
    }
  } else if (operation === "ledger-validate") {
    const auditKey = readKey(options, "audit-key-file");
    try {
      const anchor = validateActionLedgerDatabase(
        absolute(options, "database"),
        text(options, "ledger-id"),
        ACTION_LEDGER_SCHEMA_VERSION,
        auditKey,
      );
      anchor.fill(0);
    } finally { auditKey.fill(0); }
    process.stdout.write(`${JSON.stringify({ operation, status: "ok", schemaVersion: ACTION_LEDGER_SCHEMA_VERSION })}\n`);
  } else if (operation === "create") {
    const masterKey = readKey(options, "master-key-file");
    const auditKey = readKey(options, "audit-key-file");
    const backupKey = readKey(options, "backup-key-file");
    const runtime = new SessionRuntime({
      databasePath: absolute(options, "database"),
      tenantId: text(options, "tenant-id"),
      masterKey,
      auditKey,
    });
    try {
      const metadata = runtime.createEncryptedBackup({
        backupPath: absolute(options, "output"),
        backupKey,
        expiresAt: Date.now() + MAX_BACKUP_RETENTION_MS,
      });
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", backupId: metadata.backupId })}\n`);
    } finally {
      runtime.close();
      masterKey.fill(0);
      auditKey.fill(0);
      backupKey.fill(0);
    }
  } else if (operation === "restore") {
    const backupKey = readKey(options, "backup-key-file");
    try {
      const metadata = restoreEncryptedBackup({
        backupPath: absolute(options, "backup"),
        destinationPath: absolute(options, "database"),
        backupKey,
        tenantId: text(options, "tenant-id"),
        schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION,
      });
      chmodSync(absolute(options, "database"), 0o600);
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", backupId: metadata.backupId })}\n`);
    } finally {
      backupKey.fill(0);
    }
  } else if (operation === "validate") {
    const masterKey = readKey(options, "master-key-file");
    const auditKey = readKey(options, "audit-key-file");
    const runtime = new SessionRuntime({
      databasePath: absolute(options, "database"),
      tenantId: text(options, "tenant-id"),
      masterKey,
      auditKey,
    });
    try {
      const diagnostics = runtime.diagnostics();
      if (diagnostics.schemaVersion !== SESSION_RUNTIME_SCHEMA_VERSION) throw new Error("unexpected schema version");
      process.stdout.write(`${JSON.stringify({ operation, status: "ok", schemaVersion: diagnostics.schemaVersion })}\n`);
    } finally {
      runtime.close();
      masterKey.fill(0);
      auditKey.fill(0);
    }
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ operation, status: "failed", error: "backup operation failed" })}\n`);
  process.exitCode = 1;
}

function parseOptions(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || parsed.has(name.slice(2))) {
      throw new TypeError("backup arguments are invalid");
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function text(values, name) {
  const value = values.get(name);
  if (!value || value.length > 4096) throw new TypeError(`--${name} is required`);
  return value;
}

function absolute(values, name) {
  const value = text(values, name);
  if (resolve(value) !== value) throw new TypeError(`--${name} must be absolute`);
  return value;
}

function readKey(values, name) {
  const path = absolute(values, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 || (stat.mode & 0o077) !== 0) {
    throw new TypeError(`--${name} must be a private regular file`);
  }
  const encoded = readFileSync(path, "utf8").trim();
  const key = Buffer.from(encoded, "base64url");
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || key.length !== 32 || key.toString("base64url") !== encoded) {
    key.fill(0);
    throw new TypeError(`--${name} must contain a canonical 32-byte base64url key`);
  }
  return key;
}

function usage() {
  process.stderr.write(
    "usage: backup.mjs {set-create|set-verify|set-restore|create|restore|validate|identity-create|identity-restore|identity-validate|ledger-create|ledger-restore|ledger-validate} [--set-name NAME --directory PATH --output-directory PATH] [--tenant-id ID|--ledger-id ID] --database PATH [--output PATH|--backup PATH] [--master-key-file PATH --audit-key-file PATH] --backup-key-file PATH\n",
  );
}
