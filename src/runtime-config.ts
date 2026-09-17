import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Principal } from "./service.ts";

export interface RuntimeConfig {
  mode: "production" | "fixture";
  host: string;
  port: number;
  tenantId: string;
  dataDir: string;
  actionDatabasePath: string;
  sessionDatabasePath: string;
  authorizationDatabasePath: string;
  identityDatabasePath: string;
  ledgerId: string;
  masterKey: Buffer;
  auditKey: Buffer;
  authEntries: ReadonlyMap<string, Principal>;
  sessionCookieSecure: boolean;
  sessionImportDir?: string;
  liveGrantFile?: string;
  workerIntervalMs: number;
  redditWorkerUrl: string;
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = required(environment, "SOCIAL_GIT_MODE");
  if (mode !== "production" && mode !== "fixture") throw new TypeError("SOCIAL_GIT_MODE must be production or fixture");
  if (mode === "fixture" && environment.NODE_ENV !== "test") {
    throw new TypeError("Fixture mode requires NODE_ENV=test");
  }
  const dataDir = privateDirectory(required(environment, "SOCIAL_GIT_DATA_DIR"), true);
  const masterKey = readKeyFile(required(environment, "SOCIAL_GIT_MASTER_KEY_FILE"), "master key");
  const auditKey = readKeyFile(required(environment, "SOCIAL_GIT_AUDIT_KEY_FILE"), "audit key");
  const authEntries = environment.SOCIAL_GIT_AUTH_FILE
    ? readAuthFile(environment.SOCIAL_GIT_AUTH_FILE)
    : new Map<string, Principal>();
  const sessionImportDir = mode === "production"
    ? privateDirectory(required(environment, "SOCIAL_GIT_SESSION_IMPORT_DIR"), false)
    : undefined;
  const port = integer(environment.SOCIAL_GIT_PORT ?? "8080", "SOCIAL_GIT_PORT", 0, 65_535);
  const workerIntervalMs = integer(environment.SOCIAL_GIT_WORKER_INTERVAL_MS ?? "250", "SOCIAL_GIT_WORKER_INTERVAL_MS", 25, 60_000);
  const redditWorkerUrl = internalWorkerUrl(environment.SOCIAL_GIT_REDDIT_WORKER_URL ?? "http://reddit-worker:8081/v1/dispatch");
  const tenantId = identifier(environment.SOCIAL_GIT_TENANT_ID ?? "default", "SOCIAL_GIT_TENANT_ID");
  const ledgerId = identifier(environment.SOCIAL_GIT_LEDGER_ID ?? `${tenantId}-action-ledger`, "SOCIAL_GIT_LEDGER_ID");
  const liveGrantFile = environment.SOCIAL_GIT_LIVE_GRANT_FILE
    ? privateFile(environment.SOCIAL_GIT_LIVE_GRANT_FILE, "live grant file")
    : undefined;
  return {
    mode,
    host: environment.SOCIAL_GIT_HOST ?? "127.0.0.1",
    port,
    tenantId,
    dataDir,
    actionDatabasePath: join(dataDir, "actions.sqlite"),
    sessionDatabasePath: join(dataDir, "sessions.sqlite"),
    authorizationDatabasePath: join(dataDir, "live-authorization.sqlite"),
    identityDatabasePath: join(dataDir, "identity.sqlite"),
    ledgerId,
    masterKey,
    auditKey,
    authEntries,
    sessionCookieSecure: boolean(environment.SOCIAL_GIT_SESSION_COOKIE_SECURE, mode === "production", "SOCIAL_GIT_SESSION_COOKIE_SECURE"),
    ...(sessionImportDir ? { sessionImportDir } : {}),
    ...(liveGrantFile ? { liveGrantFile } : {}),
    workerIntervalMs,
    redditWorkerUrl,
  };
}

function boolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function internalWorkerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new TypeError("SOCIAL_GIT_REDDIT_WORKER_URL must be an absolute HTTP URL"); }
  if (
    url.protocol !== "http:" || !url.hostname || url.username || url.password ||
    url.pathname !== "/v1/dispatch" || url.search || url.hash
  ) {
    throw new TypeError("SOCIAL_GIT_REDDIT_WORKER_URL must name the internal /v1/dispatch endpoint");
  }
  return url.toString();
}

function readAuthFile(path: string): ReadonlyMap<string, Principal> {
  const file = privateFile(path, "authentication file");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (parsed.version !== 1 || !Array.isArray(parsed.principals) || parsed.principals.length < 1 || parsed.principals.length > 1000) {
    throw new TypeError("The authentication file is invalid");
  }
  const entries = new Map<string, Principal>();
  for (const value of parsed.principals) {
    const item = object(value, "authentication principal");
    const digest = string(item.tokenSha256, "tokenSha256", 64);
    if (!/^[a-f0-9]{64}$/u.test(digest) || entries.has(digest)) throw new TypeError("The authentication token digest is invalid or duplicated");
    const callerId = identifier(item.callerId, "callerId");
    if (!Array.isArray(item.scopes) || item.scopes.length < 1 || item.scopes.length > 100) throw new TypeError("Authentication scopes are invalid");
    const scopes = item.scopes.map((scope) => string(scope, "scope", 128));
    if (new Set(scopes).size !== scopes.length) throw new TypeError("Authentication scopes contain duplicates");
    entries.set(digest, { callerId, scopes });
  }
  return entries;
}

function readKeyFile(path: string, label: string): Buffer {
  const file = privateFile(path, label);
  const encoded = readFileSync(file, "utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new TypeError(`The ${label} must contain canonical base64url`);
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    key.fill(0);
    throw new TypeError(`The ${label} must contain exactly 32 bytes`);
  }
  return key;
}

function privateDirectory(path: string, create: boolean): string {
  const absolute = resolve(path);
  if (!isAbsolute(path)) throw new TypeError("Runtime directories must use absolute paths");
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new TypeError("Runtime directories must be private and must not be symbolic links");
  }
  return absolute;
}

function privateFile(path: string, label: string): string {
  const absolute = resolve(path);
  if (!isAbsolute(path)) throw new TypeError(`${label} must use an absolute path`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512 * 1024 || (stat.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must be a private bounded regular file`);
  }
  return absolute;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function integer(value: string, name: string, minimum: number, maximum: number) {
  if (!/^\d+$/u.test(value)) throw new TypeError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError(`${name} is out of range`);
  return parsed;
}

function identifier(value: unknown, name: string): string {
  const text = string(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(text)) throw new TypeError(`${name} is invalid`);
  return text;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}
