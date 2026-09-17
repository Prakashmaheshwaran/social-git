#!/usr/bin/env node

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SESSION_RUNTIME_SCHEMA_VERSION } from "@social-git/core";
import { validateActionLedgerDatabase } from "../src/ledger-backup.ts";
import { validateIdentityDatabase } from "../src/identity-backup.ts";
import { atomicWritePrivate, fsyncDirectory, sha256File, verifyAuthenticatedBackupSetManifest, verifyRestoreSetReceipt } from "../src/backup-set.ts";

const setName = process.argv[2];
const tenantId = process.env.SOCIAL_GIT_TENANT_ID ?? "default";
const ledgerId = process.env.SOCIAL_GIT_LEDGER_ID ?? `${tenantId}-action-ledger`;
const dataDir = resolve(process.env.SOCIAL_GIT_DATA_DIR ?? "/var/lib/social-git");
const backupRoot = resolve(process.env.SOCIAL_GIT_BACKUP_DIR ?? "/var/lib/social-git/backups");
const restoreRoot = resolve(process.env.SOCIAL_GIT_RESTORE_DIR ?? "/var/lib/social-git/restore");
const journalPath = join(dataDir, "restore-promotion.json");
const historyPath = join(dataDir, "restore-history.json");
const FILES = Object.freeze(["sessions.sqlite", "sessions.sqlite.audit-anchor", "actions.sqlite", "actions.sqlite.audit-anchor", "identity.sqlite", "identity.sqlite.audit-anchor"]);

let backupKey;
let phase = "initialize";
try {
  assertPrivateDirectory(dataDir);
  backupKey = readKey(process.env.SOCIAL_GIT_BACKUP_KEY_FILE);
  phase = "recover-journal";
  recoverPromotion(backupKey);
  if (setName === "--recover-only") {
    process.stdout.write(`${JSON.stringify({ operation: "restore-recover", status: "ok" })}\n`);
  } else {
  if (!setName || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(setName)) throw new TypeError("A valid backup set name is required");
  const sourceDirectory = join(backupRoot, setName);
  const restoreDirectory = join(restoreRoot, setName);
  assertPrivateDirectory(sourceDirectory);
  assertPrivateDirectory(restoreDirectory);
  phase = "verify-manifest";
  const manifest = verifyAuthenticatedBackupSetManifest({ directory: sourceDirectory, setName, tenantId, ledgerId, backupKey });
  phase = "verify-receipt";
  const receipt = verifyRestoreSetReceipt({ restoreDirectory, sourceDirectory, manifest, backupKey });
  phase = "reject-replay";
  rejectReplay(manifest.setId, receipt.manifestSha256, backupKey);
  phase = "validate-staged";
  validateStaged({
    "sessions.sqlite": join(restoreDirectory, "sessions.sqlite"),
    "actions.sqlite": join(restoreDirectory, "actions.sqlite"),
    "identity.sqlite": join(restoreDirectory, "identity.sqlite"),
  });
  phase = "promote";
  promote({ manifest, receipt, restoreDirectory, backupKey });
  process.stdout.write(`${JSON.stringify({ operation: "restore-promote", status: "ok", set: setName, setId: manifest.setId })}\n`);
  }
} catch {
  process.stderr.write(`${JSON.stringify({ operation: "restore-promote", status: "failed", error: "restore promotion failed", phase })}\n`);
  process.exitCode = 1;
} finally { backupKey?.fill(0); }

function validateStaged(staged) {
  const auditKey = readKey(process.env.SOCIAL_GIT_AUDIT_KEY_FILE);
  const database = new DatabaseSync(staged["sessions.sqlite"], { open: true, readOnly: true, enableForeignKeyConstraints: true, timeout: 5_000 });
  try {
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("Session integrity check failed");
    if (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version !== SESSION_RUNTIME_SCHEMA_VERSION) throw new Error("Session schema mismatch");
    if (database.prepare("SELECT value FROM runtime_metadata WHERE key = 'tenant_id'").get()?.value !== tenantId) throw new Error("Session tenant mismatch");
    validateActionLedgerDatabase(staged["actions.sqlite"], ledgerId, undefined, auditKey).fill(0);
    validateIdentityDatabase(staged["identity.sqlite"], tenantId, auditKey).fill(0);
  } finally { database.close(); auditKey.fill(0); }
}

function promote({ manifest, receipt, restoreDirectory, backupKey }) {
  phase = "promote-inventory";
  const suffix = randomUUID();
  const entries = FILES.map((name) => {
    const destination = join(dataDir, name);
    phase = `promote-inventory-sidecars-${name}`;
    for (const sidecar of [`${destination}-wal`, `${destination}-shm`]) {
      if (existsSync(sidecar)) throw new Error("Database sidecars remain; Core must be stopped before restore");
    }
    phase = `promote-inventory-digest-${name}`;
    if (existsSync(destination)) chmodSync(destination, 0o600);
    return { name, hadOriginal: existsSync(destination), oldSha256: existsSync(destination) ? sha256File(destination) : null, newSha256: receipt.files[name].sha256 };
  });
  let journal = { version: 1, type: "social-git.restore-promotion", state: "preparing", setId: manifest.setId, setName: manifest.id, manifestSha256: receipt.manifestSha256, restoreDirectory, suffix, entries };
  phase = "promote-journal";
  writeAuthenticated(journalPath, journal, backupKey, "restore-promotion-journal");
  fault("after-journal");
  entries.forEach((entry, index) => {
    phase = `promote-copy-${index + 1}`;
    copyPrivate(join(restoreDirectory, entry.name), incomingPath(entry.name, suffix));
    fault(`after-copy-${index + 1}`);
  });
  journal = { ...journal, state: "prepared" };
  phase = "promote-prepared";
  writeAuthenticated(journalPath, journal, backupKey, "restore-promotion-journal");
  fault("after-prepare");
  entries.forEach((entry, index) => {
    phase = `promote-publish-${index + 1}`;
    const destination = join(dataDir, entry.name);
    if (entry.hadOriginal) renameSync(destination, previousPath(entry.name, suffix));
    fsyncDirectory(dataDir);
    fault(`after-original-${index + 1}`);
    renameSync(incomingPath(entry.name, suffix), destination);
    chmodSync(destination, 0o600);
    fsyncDirectory(dataDir);
    fault(`after-publish-${index + 1}`);
  });
  journal = { ...journal, state: "committed" };
  phase = "promote-commit";
  writeAuthenticated(journalPath, journal, backupKey, "restore-promotion-journal");
  fault("after-commit");
  phase = "promote-finalize";
  finalizeCommitted(journal, backupKey);
}

function recoverPromotion(backupKey) {
  if (!existsSync(journalPath)) return;
  const journal = readAuthenticated(journalPath, backupKey, "restore-promotion-journal");
  validateJournal(journal);
  if (journal.state === "committed") return finalizeCommitted(journal, backupKey);
  for (const entry of [...journal.entries].reverse()) {
    const destination = join(dataDir, entry.name);
    const previous = previousPath(entry.name, journal.suffix);
    const incoming = incomingPath(entry.name, journal.suffix);
    if (existsSync(previous)) {
      if (existsSync(destination)) unlinkSync(destination);
      renameSync(previous, destination);
    } else if (!entry.hadOriginal && existsSync(destination) && sha256File(destination) === entry.newSha256) {
      unlinkSync(destination);
    }
    if (existsSync(incoming)) unlinkSync(incoming);
  }
  fsyncDirectory(dataDir);
  unlinkSync(journalPath);
  fsyncDirectory(dataDir);
}

function finalizeCommitted(journal, backupKey) {
  for (const entry of journal.entries) {
    const destination = join(dataDir, entry.name);
    const incoming = incomingPath(entry.name, journal.suffix);
    if (!existsSync(destination) || sha256File(destination) !== entry.newSha256) {
      if (!existsSync(incoming) || sha256File(incoming) !== entry.newSha256) throw new Error("committed restore cannot be recovered");
      if (existsSync(destination)) unlinkSync(destination);
      renameSync(incoming, destination);
      chmodSync(destination, 0o600);
    }
    const previous = previousPath(entry.name, journal.suffix);
    if (existsSync(previous)) unlinkSync(previous);
    if (existsSync(incoming)) unlinkSync(incoming);
  }
  fsyncDirectory(dataDir);
  recordHistory(journal.setId, journal.manifestSha256, backupKey);
  fault("after-history");
  rmSync(journal.restoreDirectory, { recursive: true, force: true });
  if (existsSync(journalPath)) unlinkSync(journalPath);
  fsyncDirectory(dataDir);
}

function rejectReplay(setId, manifestSha256, backupKey) {
  const history = readHistory(backupKey);
  if (history.entries.some((entry) => entry.setId === setId || entry.manifestSha256 === manifestSha256)) throw new Error("backup set has already been restored");
}

function recordHistory(setId, manifestSha256, backupKey) {
  const history = readHistory(backupKey);
  if (!history.entries.some((entry) => entry.setId === setId || entry.manifestSha256 === manifestSha256)) {
    history.entries.push({ setId, manifestSha256, restoredAt: Date.now() });
    if (history.entries.length > 256) history.entries.splice(0, history.entries.length - 256);
    writeAuthenticated(historyPath, history, backupKey, "restore-history");
  }
}

function readHistory(backupKey) {
  if (!existsSync(historyPath)) return { version: 1, type: "social-git.restore-history", entries: [] };
  const history = readAuthenticated(historyPath, backupKey, "restore-history");
  if (history.version !== 1 || history.type !== "social-git.restore-history" || !Array.isArray(history.entries) || history.entries.length > 256) throw new Error("restore history is invalid");
  for (const entry of history.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.setId !== "string" || !/^[a-f0-9-]{36}$/iu.test(entry.setId) || typeof entry.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.manifestSha256) || !Number.isSafeInteger(entry.restoredAt)) throw new Error("restore history is invalid");
  }
  return history;
}

function validateJournal(journal) {
  if (!journal || typeof journal !== "object" || journal.version !== 1 || journal.type !== "social-git.restore-promotion" || !["preparing", "prepared", "committed"].includes(journal.state) || typeof journal.setId !== "string" || typeof journal.setName !== "string" || typeof journal.manifestSha256 !== "string" || typeof journal.restoreDirectory !== "string" || !journal.restoreDirectory.startsWith(`${restoreRoot}/`) || typeof journal.suffix !== "string" || !/^[a-f0-9-]{36}$/iu.test(journal.suffix) || !Array.isArray(journal.entries) || journal.entries.length !== FILES.length) throw new Error("restore journal is invalid");
  for (const [index, entry] of journal.entries.entries()) {
    if (!entry || entry.name !== FILES[index] || typeof entry.hadOriginal !== "boolean" || (entry.oldSha256 !== null && !/^[a-f0-9]{64}$/u.test(entry.oldSha256)) || !/^[a-f0-9]{64}$/u.test(entry.newSha256)) throw new Error("restore journal is invalid");
  }
}

function writeAuthenticated(path, payload, backupKey, purpose) {
  const key = deriveKey(backupKey, purpose);
  try {
    const authentication = { algorithm: "HMAC-SHA256", tag: createHmac("sha256", key).update(JSON.stringify(payload)).digest("base64url") };
    atomicWritePrivate(path, Buffer.from(JSON.stringify({ ...payload, authentication }), "utf8"));
  } finally { key.fill(0); }
}

function readAuthenticated(path, backupKey, purpose) {
  assertPrivateFile(path);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || !value.authentication || value.authentication.algorithm !== "HMAC-SHA256") throw new Error("authenticated state is invalid");
  const { authentication, ...payload } = value;
  const actual = Buffer.from(authentication.tag ?? "", "base64url");
  const key = deriveKey(backupKey, purpose);
  const expected = createHmac("sha256", key).update(JSON.stringify(payload)).digest();
  key.fill(0);
  try {
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw new Error("authenticated state failed verification");
  } finally { actual.fill(0); expected.fill(0); }
  return payload;
}

function deriveKey(backupKey, purpose) { return createHmac("sha256", backupKey).update(`social-git/${purpose}/v1\0`).digest(); }
function incomingPath(name, suffix) { return join(dataDir, `.${name}.incoming-${suffix}`); }
function previousPath(name, suffix) { return join(dataDir, `.${name}.previous-${suffix}`); }

function copyPrivate(source, destination) {
  assertPrivateFile(source);
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
  const descriptor = openSync(destination, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function assertPrivateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new TypeError("Restore directories must be private");
}

function assertPrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || (stat.mode & 0o077) !== 0) throw new TypeError("Restore files must be private regular files");
}

function readKey(path) {
  if (!path) throw new TypeError("Key file path is required");
  assertPrivateFile(path);
  const encoded = readFileSync(path, "utf8").trim();
  const key = Buffer.from(encoded, "base64url");
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || key.length !== 32 || key.toString("base64url") !== encoded) {
    key.fill(0);
    throw new TypeError("Key file is invalid");
  }
  return key;
}

function fault(point) { if (process.env.SOCIAL_GIT_RESTORE_FAULT === point) process.exit(86); }
