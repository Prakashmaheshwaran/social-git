#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const directory = resolve(process.env.SOCIAL_GIT_SECRETS_DIR ?? "/var/lib/social-git/secrets");
const xCommandDirectory = resolve(process.env.SOCIAL_GIT_X_COMMAND_SECRETS_DIR ?? "/var/lib/social-git/x-command-secrets");
const files = [
  [directory, "master-key"],
  [directory, "audit-key"],
  [directory, "backup-key"],
  [xCommandDirectory, "x-command-key"],
];

try {
  for (const candidate of [directory, xCommandDirectory]) {
    if (!isAbsolute(candidate)) throw new TypeError("The secrets directories must be absolute");
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("The secrets directories must be regular directories");
    chmodSync(candidate, candidate === xCommandDirectory ? 0o750 : 0o700);
  }

  let created = 0;
  const values = new Set();
  for (const [parent, name] of files) {
    const path = join(parent, name);
    const shared = parent === xCommandDirectory;
    if (!existsSync(path)) {
      createKey(path, shared);
      created += 1;
    }
    values.add(readKey(path, shared));
  }
  if (values.size !== files.length) throw new TypeError("Generated keys must be distinct");
  process.stdout.write(`${JSON.stringify({ status: "ok", created, existing: files.length - created })}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ status: "failed", error: "secret initialization failed" })}\n`);
  process.exitCode = 1;
}

function createKey(path, shared) {
  const staging = `${path}.stage-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(staging, "wx", shared ? 0o640 : 0o600);
    writeFileSync(descriptor, `${randomBytes(32).toString("base64url")}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(staging, shared ? 0o640 : 0o600);
    if (existsSync(path)) throw new TypeError("The key already exists");
    renameSync(staging, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(staging)) unlinkSync(staging);
  }
}

function readKey(path, shared) {
  const stat = lstatSync(path);
  const expectedMode = shared ? 0o640 : 0o600;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 || (stat.mode & 0o777) !== expectedMode) {
    throw new TypeError("Existing key files must be private regular files");
  }
  const encoded = readFileSync(path, "utf8").trim();
  const decoded = Buffer.from(encoded, "base64url");
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
    decoded.fill(0);
    throw new TypeError("Existing keys must contain canonical 32-byte base64url values");
  }
  decoded.fill(0);
  return encoded;
}
