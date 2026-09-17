#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LedgerStore } from "../src/persistence.ts";
import { IdentityStore } from "../src/identity.ts";

const options = parseOptions(process.argv.slice(2));
let key;
let ledger;
let identity;
try {
  key = readKey(absolute("audit-key-file"));
  const expected = options.has("expected-head")
    ? JSON.parse(readFileSync(absolute("expected-head"), "utf8"))
    : undefined;
  ledger = new LedgerStore(absolute("action-database"), { ledgerId: text("ledger-id"), auditKey: key });
  identity = new IdentityStore(absolute("identity-database"), { tenantId: text("tenant-id"), auditKey: key });
  const heads = {
    version: 1,
    action: ledger.auditChainHeads(expected?.action),
    identity: identity.auditChainHead(expected?.identity),
  };
  process.stdout.write(`${JSON.stringify(heads)}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ version: 1, status: "failed", error: "audit integrity verification failed" })}\n`);
  process.exitCode = 1;
} finally {
  try { identity?.close(); } catch {}
  try { ledger?.close(); } catch {}
  key?.fill(0);
}

function parseOptions(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--") || result.has(option.slice(2))) throw new TypeError("invalid arguments");
    result.set(option.slice(2), value);
  }
  return result;
}

function text(name) {
  const value = options.get(name);
  if (!value || value.length > 4096) throw new TypeError(`--${name} is required`);
  return value;
}

function absolute(name) {
  const value = text(name);
  if (resolve(value) !== value) throw new TypeError(`--${name} must be absolute`);
  return value;
}

function readKey(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || (stat.mode & 0o077) !== 0) throw new TypeError("audit key file is unsafe");
  const encoded = readFileSync(path, "utf8").trim();
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) throw new TypeError("audit key is invalid");
  return key;
}
