#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { SessionRuntime, SESSION_RUNTIME_SCHEMA_VERSION } from "@social-git/core";
import { validateActionLedgerDatabase } from "../src/ledger-backup.ts";
import { validateIdentityDatabase } from "../src/identity-backup.ts";

const setName = process.argv[2];
const tenantId = process.env.SOCIAL_GIT_TENANT_ID ?? "default";
const ledgerId = process.env.SOCIAL_GIT_LEDGER_ID ?? `${tenantId}-action-ledger`;
const dataDir = resolve(process.env.SOCIAL_GIT_DATA_DIR ?? "/var/lib/social-git");
const restoreRoot = resolve(process.env.SOCIAL_GIT_RESTORE_DIR ?? "/var/lib/social-git/restore");

try {
  if (!setName || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(setName)) throw new TypeError("A valid backup set name is required");
  const sourceDir = join(restoreRoot, setName);
  assertPrivateDirectory(dataDir);
  assertPrivateDirectory(sourceDir);
  const databases = {
    "sessions.sqlite": join(sourceDir, "sessions.sqlite"),
    "actions.sqlite": join(sourceDir, "actions.sqlite"),
    "identity.sqlite": join(sourceDir, "identity.sqlite"),
  };
  const staged = Object.fromEntries(Object.entries(databases).flatMap(([name, path]) => [
    [name, path],
    [`${name}.audit-anchor`, `${path}.audit-anchor`],
  ]));
  for (const path of Object.values(staged)) assertPrivateFile(path);
  validateStaged(databases);
  promote(staged);
  process.stdout.write(`${JSON.stringify({ operation: "restore-promote", status: "ok", set: setName })}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ operation: "restore-promote", status: "failed", error: "restore promotion failed" })}\n`);
  process.exitCode = 1;
}

function validateStaged(staged) {
  const masterKey = readKey(process.env.SOCIAL_GIT_MASTER_KEY_FILE);
  const auditKey = readKey(process.env.SOCIAL_GIT_AUDIT_KEY_FILE);
  try {
    const runtime = new SessionRuntime({ databasePath: staged["sessions.sqlite"], tenantId, masterKey, auditKey });
    try {
      if (runtime.diagnostics().schemaVersion !== SESSION_RUNTIME_SCHEMA_VERSION) throw new Error("Session schema mismatch");
    } finally {
      runtime.close();
    }
    validateActionLedgerDatabase(staged["actions.sqlite"], ledgerId).fill(0);
    validateIdentityDatabase(staged["identity.sqlite"], tenantId).fill(0);
  } finally {
    masterKey.fill(0);
    auditKey.fill(0);
  }
}

function promote(staged) {
  const suffix = randomUUID();
  const published = [];
  const originals = [];
  try {
    for (const [name, source] of Object.entries(staged)) {
      const destination = join(dataDir, name);
      for (const sidecar of [`${destination}-wal`, `${destination}-shm`]) {
        if (existsSync(sidecar)) throw new Error("Database sidecars remain; Core must be stopped before restore");
      }
      const incoming = `${destination}.incoming-${suffix}`;
      copyPrivate(source, incoming);
      if (existsSync(destination)) {
        const original = `${destination}.previous-${suffix}`;
        renameSync(destination, original);
        originals.push([destination, original]);
      }
      renameSync(incoming, destination);
      chmodSync(destination, 0o600);
      published.push(destination);
    }
    for (const [, original] of originals) unlinkSync(original);
    rmSync(join(restoreRoot, setName), { recursive: true, force: true });
  } catch (error) {
    for (const destination of published.reverse()) {
      if (existsSync(destination)) unlinkSync(destination);
    }
    for (const [destination, original] of originals.reverse()) {
      if (existsSync(original)) renameSync(original, destination);
    }
    for (const name of Object.keys(staged)) {
      const incoming = `${join(dataDir, name)}.incoming-${suffix}`;
      if (existsSync(incoming)) unlinkSync(incoming);
    }
    throw error;
  }
}

function copyPrivate(source, destination) {
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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || (stat.mode & 0o077) !== 0) throw new TypeError("Restored databases must be private regular files");
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
