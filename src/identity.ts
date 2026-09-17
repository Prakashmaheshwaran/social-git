import {
  createHash,
  randomBytes as secureRandomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { API_KEY_SCOPES } from "./contract.ts";
import { ServiceError } from "./errors.ts";
import type { Principal } from "./service.ts";

const OWNER_SCOPES = Object.freeze(["*"]);
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({ N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const COOKIE_NAME = "social_git_session";
const API_KEY_PREFIX = "sgk";
const API_KEY_SCOPE_SET = new Set<string>(API_KEY_SCOPES);
export const IDENTITY_SCHEMA_VERSION = 3;

export type WorkspaceRole = "owner" | "admin" | "member";
const ROLE_SCOPES: Readonly<Record<WorkspaceRole, readonly string[]>> = Object.freeze({
  owner: OWNER_SCOPES,
  admin: API_KEY_SCOPES,
  member: Object.freeze(["accounts:read", "connections:read", "social:read", "social:write", "actions:read", "audit:read", "usage:read"]),
});

export interface IdentityPrincipal extends Principal {
  tenantId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface ApiKeyPrincipal extends Principal {
  tenantId: string;
  workspaceId: string;
  apiKeyId: string;
  keyPrefix: string;
  authType: "api_key";
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
}

export interface ApiKeyCreation {
  apiKey: ApiKeyRecord;
  secret: string;
}

export interface ApiKeyRateLimitContext {
  tenantId: string;
  workspaceId: string;
  apiKeyId: string;
  keyPrefix: string;
  scopes: readonly string[];
}

export interface ApiKeyRateLimitDecision {
  allowed: boolean;
  limit?: number;
  remaining?: number;
  retryAfterSeconds?: number;
  resetAt?: string;
}

export type ApiKeyRateLimitHook = (context: ApiKeyRateLimitContext) => ApiKeyRateLimitDecision;

export interface LoginRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds?: number;
  resetAt: string;
}

interface BoundedRateLimiterOptions {
  now?: () => number;
  limit?: number;
  windowMs?: number;
  maximumEntries?: number;
}

interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

/** Secure per-process default. An absent deployment hook never means unlimited API-key access. */
export function createDefaultApiKeyRateLimit(options: BoundedRateLimiterOptions = {}): ApiKeyRateLimitHook {
  const now = options.now ?? Date.now;
  const limit = positiveInteger(options.limit, 300, "API key rate limit");
  const windowMs = positiveInteger(options.windowMs, 60_000, "API key rate-limit window");
  const maximumEntries = positiveInteger(options.maximumEntries, 10_000, "API key rate-limit capacity");
  const entries = new Map<string, FixedWindowEntry>();
  return (context) => {
    const timestamp = now();
    pruneExpired(entries, timestamp);
    const key = createHash("sha256")
      .update(context.tenantId, "utf8")
      .update("\0", "utf8")
      .update(context.apiKeyId, "utf8")
      .digest("base64url");
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maximumEntries) return failClosedDecision(limit, timestamp, windowMs);
      entry = { count: 0, resetAt: timestamp + windowMs };
      entries.set(key, entry);
    }
    if (entry.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: secondsUntil(entry.resetAt, timestamp),
        resetAt: new Date(entry.resetAt).toISOString(),
      };
    }
    entry.count += 1;
    return {
      allowed: true,
      limit,
      remaining: limit - entry.count,
      resetAt: new Date(entry.resetAt).toISOString(),
    };
  };
}

interface LoginFailureEntry {
  failures: number;
  expiresAt: number;
  blockedUntil: number;
}

export class LoginAttemptLimiter {
  private readonly now: () => number;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly maximumEntries: number;
  private readonly entries = new Map<string, LoginFailureEntry>();

  constructor(options: BoundedRateLimiterOptions & { blockMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.limit = positiveInteger(options.limit, 5, "login failure limit");
    this.windowMs = positiveInteger(options.windowMs, 15 * 60_000, "login failure window");
    this.blockMs = positiveInteger(options.blockMs, 60_000, "login block duration");
    this.maximumEntries = positiveInteger(options.maximumEntries, 10_000, "login limiter capacity");
  }

  check(key: string): LoginRateLimitDecision {
    const timestamp = this.now();
    this.prune(timestamp);
    const entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maximumEntries) {
        return failClosedDecision(this.limit, timestamp, this.blockMs) as LoginRateLimitDecision;
      }
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit,
        resetAt: new Date(timestamp + this.windowMs).toISOString(),
      };
    }
    if (entry.blockedUntil > timestamp) {
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        retryAfterSeconds: secondsUntil(entry.blockedUntil, timestamp),
        resetAt: new Date(entry.blockedUntil).toISOString(),
      };
    }
    return {
      allowed: true,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.failures),
      resetAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  failure(key: string): void {
    const timestamp = this.now();
    this.prune(timestamp);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maximumEntries) return;
      entry = { failures: 0, expiresAt: timestamp + this.windowMs, blockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.failures = Math.min(this.limit, entry.failures + 1);
    if (entry.failures >= this.limit) entry.blockedUntil = timestamp + this.blockMs;
  }

  success(key: string): void {
    this.entries.delete(key);
  }

  private prune(timestamp: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= timestamp && entry.blockedUntil <= timestamp) this.entries.delete(key);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function pruneExpired(entries: Map<string, FixedWindowEntry>, timestamp: number): void {
  for (const [key, entry] of entries) if (entry.resetAt <= timestamp) entries.delete(key);
}

function secondsUntil(deadline: number, timestamp: number): number {
  return Math.max(1, Math.ceil((deadline - timestamp) / 1000));
}

function failClosedDecision(limit: number, timestamp: number, retryMs: number): ApiKeyRateLimitDecision {
  return {
    allowed: false,
    limit,
    remaining: 0,
    retryAfterSeconds: secondsUntil(timestamp + retryMs, timestamp),
    resetAt: new Date(timestamp + retryMs).toISOString(),
  };
}

interface IdentityStoreOptions {
  tenantId: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  auditSink?: (event: { callerId: string | null; type: string; outcome: string; data: Record<string, unknown> }) => void;
}

interface SessionCreation {
  token: string;
  csrfToken: string;
  expiresAt: string;
  principal: IdentityPrincipal;
}

export interface WorkspaceRecord {
  id: string;
  tenantId: string;
  name: string;
  role: WorkspaceRole;
  status: "active" | "inactive";
  createdAt: string;
}

export interface MembershipRecord {
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface InvitationCreation {
  invitation: { id: string; workspaceId: string; email: string; role: WorkspaceRole; expiresAt: string; createdAt: string };
  token: string;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new IdentityInputError("A valid email address is required.");
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new IdentityInputError("A valid email address is required.");
  }
  return normalized;
}

function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) {
    throw new IdentityInputError("Password must contain between 12 and 256 characters.");
  }
  if (!/[A-Za-z]/u.test(value) || !/[^A-Za-z]/u.test(value)) {
    throw new IdentityInputError("Password must include letters and at least one non-letter character.");
  }
  return value;
}

function validateName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 120) {
    throw new IdentityInputError("Owner name must contain between 1 and 120 characters.");
  }
  return value.trim();
}

function validateWorkspaceName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 120) {
    throw new IdentityInputError("Workspace name must contain between 1 and 120 characters.");
  }
  return value.trim();
}

function validateRole(value: unknown): WorkspaceRole {
  if (value !== "owner" && value !== "admin" && value !== "member") {
    throw new IdentityInputError("Role must be owner, admin, or member.");
  }
  return value;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function derivePassword(password: string, salt: Uint8Array): Buffer {
  return scryptSync(password, salt, 32, SCRYPT_OPTIONS);
}

function canonicalToken(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}

function validateApiKeyName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 120) {
    throw new IdentityInputError("API key name must contain between 1 and 120 characters.");
  }
  return value.trim();
}

function validateApiKeyScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > API_KEY_SCOPES.length) {
    throw new IdentityInputError("API key scopes must be a non-empty bounded array.");
  }
  if (value.some((scope) => typeof scope !== "string" || !API_KEY_SCOPE_SET.has(scope))) {
    throw new IdentityInputError("API key scopes contain an unsupported scope.");
  }
  const scopes = [...new Set(value as string[])].sort();
  if (scopes.length !== value.length) throw new IdentityInputError("API key scopes must not contain duplicates.");
  return scopes;
}

function validateStoredScopes(value: string): string[] {
  try {
    return validateApiKeyScopes(JSON.parse(value));
  } catch {
    throw new TypeError("Stored API key scopes are invalid");
  }
}

function isoTimestamp(value: unknown): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

function rowToApiKey(row: Record<string, unknown>): ApiKeyRecord {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    prefix: `${API_KEY_PREFIX}_${String(row.key_prefix)}_`,
    scopes: validateStoredScopes(String(row.scopes_json)),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    lastUsedAt: isoTimestamp(row.last_used_at),
    revokedAt: isoTimestamp(row.revoked_at),
    rotatedFromId: row.rotated_from_id === null ? null : String(row.rotated_from_id),
  });
}

function rowToMembership(row: Record<string, unknown>): MembershipRecord {
  return Object.freeze({
    userId: String(row.user_id), workspaceId: String(row.workspace_id), email: String(row.email),
    displayName: String(row.display_name), role: row.role as WorkspaceRole,
    status: row.status as "active" | "inactive",
    createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString(),
  });
}

function validateRateLimitDecision(value: ApiKeyRateLimitDecision): ApiKeyRateLimitDecision {
  if (!value || typeof value !== "object" || typeof value.allowed !== "boolean") throw new TypeError("Invalid API key rate-limit decision");
  const integer = (field: "limit" | "remaining" | "retryAfterSeconds", maximum: number) => {
    const item = value[field];
    if (item === undefined) return;
    if (!Number.isSafeInteger(item) || item < (field === "remaining" ? 0 : 1) || item > maximum) {
      throw new TypeError("Invalid API key rate-limit decision");
    }
  };
  integer("limit", 1_000_000_000);
  integer("remaining", 1_000_000_000);
  integer("retryAfterSeconds", 86_400);
  if (value.limit !== undefined && value.remaining !== undefined && value.remaining > value.limit) {
    throw new TypeError("Invalid API key rate-limit decision");
  }
  if (value.resetAt !== undefined && (
    typeof value.resetAt !== "string" || value.resetAt.length > 64 ||
    !Number.isFinite(Date.parse(value.resetAt))
  )) throw new TypeError("Invalid API key rate-limit decision");
  return value;
}

export class IdentityInputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.status = options.status ?? 422;
    this.code = options.code ?? "VALIDATION_FAILED";
  }
}

export class IdentityStore {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly auditSink?: IdentityStoreOptions["auditSink"];

  constructor(path: string, options: IdentityStoreOptions) {
    if (!validIdentifier(options.tenantId)) throw new TypeError("tenantId is invalid");
    this.tenantId = options.tenantId;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.auditSink = options.auditSink;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
    this.migrate();
    if (path !== ":memory:") {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    }
  }

  close() { this.db.close(); }

  diagnostics() {
    const version = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM identity_schema_migrations").get() as { version: number };
    const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    const integrity = this.db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return Object.freeze({
      schemaVersion: Number(version.version),
      journalMode: journal?.journal_mode ?? "unknown",
      integrity: integrity?.quick_check ?? "failed",
    });
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS identity_tenants (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS identity_users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES identity_tenants(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role = 'owner'),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_salt BLOB NOT NULL CHECK (length(password_salt) = 16),
        password_hash BLOB NOT NULL CHECK (length(password_hash) = 32),
        password_algorithm TEXT NOT NULL CHECK (password_algorithm = 'scrypt-n32768-r8-p1'),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS identity_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES identity_tenants(id) ON DELETE RESTRICT,
        user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
        csrf_hash BLOB NOT NULL CHECK (length(csrf_hash) = 32),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS identity_sessions_active
        ON identity_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS identity_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT,
        actor_user_id TEXT,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rejected')),
        occurred_at INTEGER NOT NULL,
        details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object')
      ) STRICT;
      INSERT OR IGNORE INTO identity_schema_migrations(version, applied_at)
      VALUES (1, unixepoch('subsec') * 1000);
    `);
    const versionTwo = this.db.prepare("SELECT 1 AS present FROM identity_schema_migrations WHERE version = 2").get();
    if (versionTwo === undefined) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
      const auditSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'identity_audit_events'")
        .get() as { sql: string };
      if (auditSchema.sql.includes("event_type TEXT NOT NULL CHECK")) {
        this.db.exec(`
          ALTER TABLE identity_audit_events RENAME TO identity_audit_events_v1;
          CREATE TABLE identity_audit_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT,
            actor_user_id TEXT,
            event_type TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rejected')),
            occurred_at INTEGER NOT NULL,
            details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object')
          ) STRICT;
          INSERT INTO identity_audit_events(sequence, tenant_id, actor_user_id, event_type, outcome, occurred_at, details_json)
          SELECT sequence, tenant_id, actor_user_id, event_type, outcome, occurred_at, details_json
          FROM identity_audit_events_v1;
          DROP TABLE identity_audit_events_v1;
        `);
      }
      this.db.exec(`
        CREATE TABLE identity_api_keys (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES identity_tenants(id) ON DELETE RESTRICT,
          created_by_user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
          key_prefix TEXT NOT NULL CHECK (length(key_prefix) BETWEEN 8 AND 32),
          secret_hash BLOB NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
          scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER,
          rotated_from_id TEXT REFERENCES identity_api_keys(id) ON DELETE RESTRICT,
          UNIQUE (tenant_id, key_prefix)
        ) STRICT;
        CREATE INDEX identity_api_keys_active
          ON identity_api_keys(tenant_id, key_prefix) WHERE revoked_at IS NULL;
        INSERT INTO identity_schema_migrations(version, applied_at)
        VALUES (2, unixepoch('subsec') * 1000);
      `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const versionThree = this.db.prepare("SELECT 1 AS present FROM identity_schema_migrations WHERE version = 3").get();
    if (versionThree !== undefined) {
      const apiKeyColumns = this.db.prepare("PRAGMA table_info(identity_api_keys)").all() as Array<{ name: string }>;
      if (!apiKeyColumns.some((column) => column.name === "workspace_id")) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec("ALTER TABLE identity_api_keys ADD COLUMN workspace_id TEXT;");
          this.db.prepare("UPDATE identity_api_keys SET workspace_id=tenant_id WHERE workspace_id IS NULL").run();
          this.db.exec("CREATE INDEX IF NOT EXISTS identity_api_keys_workspace_active ON identity_api_keys(workspace_id, created_at) WHERE revoked_at IS NULL;");
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE identity_workspaces (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES identity_tenants(id) ON DELETE RESTRICT,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
          created_by_user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
          created_at INTEGER NOT NULL,
          archived_at INTEGER,
          UNIQUE (tenant_id, name)
        ) STRICT;
        CREATE TABLE identity_memberships (
          workspace_id TEXT NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
          status TEXT NOT NULL CHECK (status IN ('active','inactive')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        ) STRICT;
        CREATE INDEX identity_memberships_user_active
          ON identity_memberships(user_id, status, workspace_id);
        CREATE TABLE identity_invitations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
          token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
          created_by_user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          revoked_at INTEGER
        ) STRICT;
        CREATE UNIQUE INDEX identity_invitations_pending_email
          ON identity_invitations(workspace_id, email) WHERE consumed_at IS NULL AND revoked_at IS NULL;
        ALTER TABLE identity_sessions ADD COLUMN workspace_id TEXT;
        ALTER TABLE identity_api_keys ADD COLUMN workspace_id TEXT;
      `);
      const tenants = this.db.prepare("SELECT id, created_at FROM identity_tenants").all() as Array<{ id: string; created_at: number }>;
      for (const tenant of tenants) {
        const owner = this.db.prepare("SELECT id FROM identity_users WHERE tenant_id=? ORDER BY created_at, id LIMIT 1")
          .get(tenant.id) as { id: string } | undefined;
        if (!owner) continue;
        this.db.prepare("INSERT INTO identity_workspaces(id, tenant_id, name, created_by_user_id, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)")
          .run(tenant.id, tenant.id, "Default workspace", owner.id, tenant.created_at);
        const users = this.db.prepare("SELECT id, created_at FROM identity_users WHERE tenant_id=?").all(tenant.id) as Array<{ id: string; created_at: number }>;
        for (const user of users) {
          this.db.prepare("INSERT INTO identity_memberships(workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)")
            .run(tenant.id, user.id, user.created_at, user.created_at);
        }
      }
      this.db.exec(`
        UPDATE identity_sessions SET workspace_id=tenant_id WHERE workspace_id IS NULL;
        UPDATE identity_api_keys SET workspace_id=tenant_id WHERE workspace_id IS NULL;
        CREATE INDEX identity_sessions_workspace_active
          ON identity_sessions(workspace_id, user_id, expires_at) WHERE revoked_at IS NULL;
        CREATE INDEX identity_api_keys_workspace_active
          ON identity_api_keys(workspace_id, created_at) WHERE revoked_at IS NULL;
        INSERT INTO identity_schema_migrations(version, applied_at)
        VALUES (3, unixepoch('subsec') * 1000);
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setupStatus() {
    const owner = this.db.prepare("SELECT 1 AS present FROM identity_users LIMIT 1").get();
    return Object.freeze({ required: owner === undefined });
  }

  createFirstOwner(input: { email: unknown; password: unknown; displayName: unknown }): SessionCreation {
    // This route is intentionally public during first boot. Once setup has
    // closed, reject before validation, randomness, or synchronous scrypt so a
    // remote caller cannot turn the permanently closed setup route into a CPU
    // exhaustion primitive. The transactional check below remains necessary to
    // fence two legitimate first-boot requests racing each other.
    const existingOwner = this.db.prepare("SELECT 1 AS present FROM identity_users LIMIT 1").get();
    if (existingOwner !== undefined) throw new IdentityInputError("Initial setup has already been completed.");
    const email = normalizeEmail(input.email);
    const password = validatePassword(input.password);
    const displayName = validateName(input.displayName);
    const timestamp = this.now();
    const userId = randomUUID();
    const salt = Buffer.from(this.randomBytes(16));
    if (salt.byteLength !== 16) throw new TypeError("Identity random source returned an invalid salt");
    const passwordHash = derivePassword(password, salt);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.db.prepare("SELECT 1 AS present FROM identity_users LIMIT 1").get();
        if (existing !== undefined) throw new IdentityInputError("Initial setup has already been completed.");
        this.db.prepare("INSERT INTO identity_tenants(id, created_at) VALUES (?, ?)").run(this.tenantId, timestamp);
        this.db.prepare(`INSERT INTO identity_users(
          id, tenant_id, role, email, display_name, password_salt, password_hash,
          password_algorithm, created_at, updated_at
        ) VALUES (?, ?, 'owner', ?, ?, ?, ?, 'scrypt-n32768-r8-p1', ?, ?)`)
          .run(userId, this.tenantId, email, displayName, salt, passwordHash, timestamp, timestamp);
        this.db.prepare(`INSERT INTO identity_workspaces(
          id, tenant_id, name, created_by_user_id, created_at, archived_at
        ) VALUES (?, ?, 'Default workspace', ?, ?, NULL)`)
          .run(this.tenantId, this.tenantId, userId, timestamp);
        this.db.prepare(`INSERT INTO identity_memberships(
          workspace_id, user_id, role, status, created_at, updated_at
        ) VALUES (?, ?, 'owner', 'active', ?, ?)`)
          .run(this.tenantId, userId, timestamp, timestamp);
        this.audit("owner.created", "succeeded", this.tenantId, userId);
        const session = this.insertSession(userId, this.tenantId, this.tenantId, timestamp);
        this.db.exec("COMMIT");
        return session;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      salt.fill(0);
      passwordHash.fill(0);
    }
  }

  login(input: { email: unknown; password: unknown }): SessionCreation | null {
    let email: string;
    let password: string;
    try {
      email = normalizeEmail(input.email);
      password = typeof input.password === "string" && input.password.length <= 256 ? input.password : "";
    } catch {
      email = "invalid@example.invalid";
      password = "";
    }
    const row = this.db.prepare(`SELECT id, tenant_id, password_salt, password_hash
      FROM identity_users WHERE email = ? AND tenant_id = ?`).get(email, this.tenantId) as
      | { id: string; tenant_id: string; password_salt: Uint8Array; password_hash: Uint8Array }
      | undefined;
    const salt = row ? Buffer.from(row.password_salt) : Buffer.alloc(16);
    const expected = row ? Buffer.from(row.password_hash) : Buffer.alloc(32);
    const actual = derivePassword(password, salt);
    const accepted = row !== undefined && timingSafeEqual(actual, expected);
    salt.fill(0);
    expected.fill(0);
    actual.fill(0);
    if (!accepted || !row) {
      this.audit("auth.login_failed", "failed", this.tenantId, null);
      return null;
    }
    const membership = this.db.prepare(`SELECT m.workspace_id FROM identity_memberships m
      JOIN identity_workspaces w ON w.id=m.workspace_id AND w.tenant_id=? AND w.archived_at IS NULL
      WHERE m.user_id=? AND m.status='active'
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at, m.workspace_id LIMIT 1`)
      .get(row.tenant_id, row.id) as { workspace_id: string } | undefined;
    if (!membership) {
      this.audit("auth.login_failed", "failed", row.tenant_id, row.id, { reason: "no_active_membership" });
      return null;
    }
    const session = this.insertSession(row.id, row.tenant_id, membership.workspace_id, this.now());
    this.audit("auth.login_succeeded", "succeeded", row.tenant_id, row.id);
    return session;
  }

  authenticate(token: string, csrfToken?: string, touch = true): IdentityPrincipal | null {
    if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) return null;
    const tokenHash = digest(token);
    const row = this.db.prepare(`SELECT s.id, s.tenant_id, s.workspace_id, s.user_id, s.csrf_hash, s.expires_at,
      m.role FROM identity_sessions s
      JOIN identity_users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN identity_memberships m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id AND m.status='active'
      JOIN identity_workspaces w ON w.id=s.workspace_id AND w.tenant_id=s.tenant_id AND w.archived_at IS NULL
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`).get(tokenHash) as
      | { id: string; tenant_id: string; workspace_id: string; user_id: string; csrf_hash: Uint8Array; expires_at: number; role: WorkspaceRole }
      | undefined;
    tokenHash.fill(0);
    if (!row || row.tenant_id !== this.tenantId || row.expires_at <= this.now()) return null;
    if (csrfToken !== undefined) {
      if (!/^[A-Za-z0-9_-]{40,128}$/u.test(csrfToken)) return null;
      const csrfHash = digest(csrfToken);
      const stored = Buffer.from(row.csrf_hash);
      const valid = timingSafeEqual(csrfHash, stored);
      csrfHash.fill(0);
      stored.fill(0);
      if (!valid) return null;
    }
    if (touch) this.db.prepare("UPDATE identity_sessions SET last_seen_at = ? WHERE id = ?").run(this.now(), row.id);
    return Object.freeze({
      callerId: `user:${row.user_id}`,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      role: row.role,
      scopes: [...ROLE_SCOPES[row.role]],
    });
  }

  logout(token: string): boolean {
    if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) return false;
    const tokenHash = digest(token);
    const result = this.db.prepare("UPDATE identity_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(this.now(), tokenHash);
    tokenHash.fill(0);
    if (Number(result.changes) > 0) this.audit("auth.logout", "succeeded", this.tenantId, null);
    return Number(result.changes) > 0;
  }

  createApiKey(
    actor: IdentityPrincipal,
    input: { name: unknown; scopes: unknown },
  ): ApiKeyCreation {
    this.requireOwner(actor);
    const name = validateApiKeyName(input.name);
    const scopes = validateApiKeyScopes(input.scopes);
    return this.inTransaction(() => {
      const created = this.insertApiKey(actor.userId, actor.workspaceId, name, scopes, null);
      this.audit("api_key.created", "succeeded", this.tenantId, actor.userId, {
        apiKeyId: created.apiKey.id,
        prefix: created.apiKey.prefix,
        name,
        scopes,
      });
      return created;
    });
  }

  listApiKeys(actor: IdentityPrincipal): ApiKeyRecord[] {
    this.requireOwner(actor);
    return (this.db.prepare(`SELECT id, tenant_id, workspace_id, name, key_prefix, scopes_json, created_at,
      last_used_at, revoked_at, rotated_from_id
      FROM identity_api_keys WHERE tenant_id = ? AND workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC`)
      .all(this.tenantId, actor.workspaceId) as Array<Record<string, unknown>>).map(rowToApiKey);
  }

  revokeApiKey(actor: IdentityPrincipal, apiKeyId: string): ApiKeyRecord {
    this.requireOwner(actor);
    if (!validIdentifier(apiKeyId)) throw new IdentityInputError("API key was not found.", { status: 404, code: "NOT_FOUND" });
    return this.inTransaction(() => {
      const timestamp = this.now();
      const result = this.db.prepare(`UPDATE identity_api_keys SET revoked_at = ?
        WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND revoked_at IS NULL`).run(timestamp, apiKeyId, this.tenantId, actor.workspaceId);
      if (Number(result.changes) !== 1) {
        throw new IdentityInputError("API key was not found or is already revoked.", { status: 404, code: "NOT_FOUND" });
      }
      const record = this.getApiKey(apiKeyId, actor.workspaceId);
      this.audit("api_key.revoked", "succeeded", this.tenantId, actor.userId, {
        apiKeyId,
        prefix: record.prefix,
      });
      return record;
    });
  }

  rotateApiKey(
    actor: IdentityPrincipal,
    apiKeyId: string,
    input: { name?: unknown; scopes?: unknown } = {},
  ): ApiKeyCreation & { revokedApiKeyId: string } {
    this.requireOwner(actor);
    if (!validIdentifier(apiKeyId)) throw new IdentityInputError("API key was not found.", { status: 404, code: "NOT_FOUND" });
    return this.inTransaction(() => {
      const existing = this.getApiKey(apiKeyId, actor.workspaceId);
      if (existing.revokedAt !== null) {
        throw new IdentityInputError("API key was not found or is already revoked.", { status: 404, code: "NOT_FOUND" });
      }
      const name = input.name === undefined ? existing.name : validateApiKeyName(input.name);
      const scopes = input.scopes === undefined ? existing.scopes : validateApiKeyScopes(input.scopes);
      const timestamp = this.now();
      this.db.prepare("UPDATE identity_api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND revoked_at IS NULL")
        .run(timestamp, apiKeyId, this.tenantId, actor.workspaceId);
      const created = this.insertApiKey(actor.userId, actor.workspaceId, name, scopes, apiKeyId);
      this.audit("api_key.rotated", "succeeded", this.tenantId, actor.userId, {
        revokedApiKeyId: apiKeyId,
        apiKeyId: created.apiKey.id,
        prefix: created.apiKey.prefix,
        name,
        scopes,
      });
      return { ...created, revokedApiKeyId: apiKeyId };
    });
  }

  authenticateApiKey(token: string, rateLimit?: ApiKeyRateLimitHook): ApiKeyPrincipal | null {
    const tokenMatch = /^sgk_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/u.exec(token);
    if (!tokenMatch) return null;
    const tokenHash = digest(token);
    const row = this.db.prepare(`SELECT id, tenant_id, workspace_id, key_prefix, scopes_json
      FROM identity_api_keys
      WHERE tenant_id = ? AND secret_hash = ? AND revoked_at IS NULL`)
      .get(this.tenantId, tokenHash) as
      | { id: string; tenant_id: string; workspace_id: string; key_prefix: string; scopes_json: string }
      | undefined;
    tokenHash.fill(0);
    if (!row || row.key_prefix !== tokenMatch[1]) return null;
    const scopes = validateStoredScopes(row.scopes_json);
    if (rateLimit) {
      let decision: ApiKeyRateLimitDecision;
      try {
        decision = validateRateLimitDecision(rateLimit(Object.freeze({
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          apiKeyId: row.id,
          keyPrefix: `${API_KEY_PREFIX}_${row.key_prefix}_`,
          scopes: Object.freeze([...scopes]),
        })));
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError("RATE_LIMITED", "API key authentication is temporarily unavailable.", {
          status: 429,
          retryable: true,
          rateLimit: { retryAfterSeconds: 1 },
        });
      }
      if (!decision.allowed) {
        throw new ServiceError("RATE_LIMITED", "API key rate limit exceeded.", {
          status: 429,
          retryable: true,
          rateLimit: {
            ...(decision.limit === undefined ? {} : { limit: decision.limit }),
            ...(decision.remaining === undefined ? {} : { remaining: decision.remaining }),
            ...(decision.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: decision.retryAfterSeconds }),
            ...(decision.resetAt === undefined ? {} : { resetAt: decision.resetAt }),
          },
        });
      }
    }
    this.db.prepare("UPDATE identity_api_keys SET last_used_at = ? WHERE id = ? AND tenant_id = ?")
      .run(this.now(), row.id, this.tenantId);
    return Object.freeze({
      callerId: `api-key:${row.id}`,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      apiKeyId: row.id,
      keyPrefix: `${API_KEY_PREFIX}_${row.key_prefix}_`,
      authType: "api_key" as const,
      scopes,
    });
  }

  listWorkspaces(actor: IdentityPrincipal): WorkspaceRecord[] {
    if (actor.tenantId !== this.tenantId) throw new IdentityInputError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" });
    return (this.db.prepare(`SELECT w.id, w.tenant_id, w.name, w.created_at, m.role, m.status
      FROM identity_workspaces w JOIN identity_memberships m ON m.workspace_id=w.id
      WHERE w.tenant_id=? AND w.archived_at IS NULL AND m.user_id=? AND m.status='active'
      ORDER BY w.created_at, w.id`).all(this.tenantId, actor.userId) as Array<Record<string, unknown>>).map((row) => Object.freeze({
        id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name),
        role: row.role as WorkspaceRole, status: row.status as "active", createdAt: new Date(Number(row.created_at)).toISOString(),
      }));
  }

  createWorkspace(actor: IdentityPrincipal, input: { name: unknown }): WorkspaceRecord {
    this.requireOwner(actor);
    const name = validateWorkspaceName(input.name);
    const timestamp = this.now();
    const workspaceId = randomUUID();
    return this.inTransaction(() => {
      try {
        this.db.prepare(`INSERT INTO identity_workspaces(id, tenant_id, name, created_by_user_id, created_at, archived_at)
          VALUES (?, ?, ?, ?, ?, NULL)`).run(workspaceId, this.tenantId, name, actor.userId, timestamp);
      } catch {
        throw new IdentityInputError("A workspace with this name already exists.", { status: 409, code: "CONFLICT" });
      }
      this.db.prepare(`INSERT INTO identity_memberships(workspace_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)`).run(workspaceId, actor.userId, timestamp, timestamp);
      this.audit("workspace.created", "succeeded", this.tenantId, actor.userId, { workspaceId });
      return this.listWorkspaces(actor).find((item) => item.id === workspaceId)!;
    });
  }

  selectWorkspace(actor: IdentityPrincipal, workspaceId: unknown, currentToken: string): SessionCreation {
    if (typeof workspaceId !== "string" || !validIdentifier(workspaceId)) {
      throw new IdentityInputError("Workspace was not found.", { status: 404, code: "NOT_FOUND" });
    }
    const membership = this.db.prepare(`SELECT m.role FROM identity_memberships m
      JOIN identity_workspaces w ON w.id=m.workspace_id AND w.tenant_id=? AND w.archived_at IS NULL
      WHERE m.workspace_id=? AND m.user_id=? AND m.status='active'`).get(this.tenantId, workspaceId, actor.userId);
    if (!membership) throw new IdentityInputError("Workspace was not found.", { status: 404, code: "NOT_FOUND" });
    return this.inTransaction(() => {
      this.logoutWithoutAudit(currentToken);
      const created = this.insertSession(actor.userId, this.tenantId, workspaceId, this.now());
      this.audit("auth.workspace_selected", "succeeded", this.tenantId, actor.userId, { workspaceId });
      return created;
    });
  }

  listMembers(actor: IdentityPrincipal): MembershipRecord[] {
    this.requireOwner(actor);
    return (this.db.prepare(`SELECT u.id AS user_id, u.email, u.display_name, m.workspace_id, m.role, m.status, m.created_at, m.updated_at
      FROM identity_memberships m JOIN identity_users u ON u.id=m.user_id AND u.tenant_id=?
      WHERE m.workspace_id=? ORDER BY m.created_at, u.id`).all(this.tenantId, actor.workspaceId) as Array<Record<string, unknown>>)
      .map(rowToMembership);
  }

  provisionUser(actor: IdentityPrincipal, input: { email: unknown; displayName: unknown; password: unknown; role: unknown }): MembershipRecord {
    this.requireOwner(actor);
    const email = normalizeEmail(input.email);
    const displayName = validateName(input.displayName);
    const password = validatePassword(input.password);
    const role = validateRole(input.role);
    const timestamp = this.now();
    const userId = randomUUID();
    const salt = Buffer.from(this.randomBytes(16));
    const passwordHash = derivePassword(password, salt);
    try {
      return this.inTransaction(() => {
        try {
          this.db.prepare(`INSERT INTO identity_users(id, tenant_id, role, email, display_name, password_salt, password_hash,
            password_algorithm, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?, ?, 'scrypt-n32768-r8-p1', ?, ?)`)
            .run(userId, this.tenantId, email, displayName, salt, passwordHash, timestamp, timestamp);
        } catch {
          throw new IdentityInputError("A local user with this email already exists.", { status: 409, code: "CONFLICT" });
        }
        this.db.prepare(`INSERT INTO identity_memberships(workspace_id, user_id, role, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?)`).run(actor.workspaceId, userId, role, timestamp, timestamp);
        this.audit("membership.provisioned", "succeeded", this.tenantId, actor.userId, { workspaceId: actor.workspaceId, userId, role });
        return this.getMembership(actor.workspaceId, userId);
      });
    } finally { salt.fill(0); passwordHash.fill(0); }
  }

  createInvitation(actor: IdentityPrincipal, input: { email: unknown; role: unknown; expiresInHours?: unknown }): InvitationCreation {
    this.requireOwner(actor);
    const email = normalizeEmail(input.email);
    const role = validateRole(input.role);
    const hours = input.expiresInHours === undefined ? 24 : Number(input.expiresInHours);
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) throw new IdentityInputError("Invitation lifetime must be from 1 through 168 hours.");
    const tokenBytes = Buffer.from(this.randomBytes(32));
    const token = canonicalToken(tokenBytes);
    const tokenHash = digest(token);
    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = createdAt + hours * 60 * 60 * 1000;
    try {
      return this.inTransaction(() => {
        try {
          this.db.prepare(`INSERT INTO identity_invitations(id, workspace_id, email, role, token_hash, created_by_user_id,
            created_at, expires_at, consumed_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
            .run(id, actor.workspaceId, email, role, tokenHash, actor.userId, createdAt, expiresAt);
        } catch {
          throw new IdentityInputError("A pending invitation already exists for this email.", { status: 409, code: "CONFLICT" });
        }
        this.audit("invitation.created", "succeeded", this.tenantId, actor.userId, { workspaceId: actor.workspaceId, invitationId: id, role });
        return { invitation: { id, workspaceId: actor.workspaceId, email, role, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() }, token };
      });
    } finally { tokenBytes.fill(0); tokenHash.fill(0); }
  }

  acceptInvitation(input: { token: unknown; displayName: unknown; password: unknown }): SessionCreation {
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.token)) throw new IdentityInputError("Invitation is invalid or expired.", { status: 404, code: "NOT_FOUND" });
    const displayName = validateName(input.displayName);
    const password = validatePassword(input.password);
    const tokenHash = digest(input.token);
    const row = this.db.prepare(`SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, w.tenant_id
      FROM identity_invitations i JOIN identity_workspaces w ON w.id=i.workspace_id AND w.archived_at IS NULL
      WHERE i.token_hash=? AND i.consumed_at IS NULL AND i.revoked_at IS NULL`).get(tokenHash) as
      | { id: string; workspace_id: string; email: string; role: WorkspaceRole; expires_at: number; tenant_id: string } | undefined;
    tokenHash.fill(0);
    if (!row || row.tenant_id !== this.tenantId || row.expires_at <= this.now()) throw new IdentityInputError("Invitation is invalid or expired.", { status: 404, code: "NOT_FOUND" });
    const salt = Buffer.from(this.randomBytes(16));
    const passwordHash = derivePassword(password, salt);
    const userId = randomUUID();
    const timestamp = this.now();
    try {
      return this.inTransaction(() => {
        try {
          this.db.prepare(`INSERT INTO identity_users(id, tenant_id, role, email, display_name, password_salt, password_hash,
            password_algorithm, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?, ?, 'scrypt-n32768-r8-p1', ?, ?)`)
            .run(userId, this.tenantId, row.email, displayName, salt, passwordHash, timestamp, timestamp);
        } catch {
          throw new IdentityInputError("Invitation is invalid or expired.", { status: 404, code: "NOT_FOUND" });
        }
        const consumed = this.db.prepare("UPDATE identity_invitations SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?")
          .run(timestamp, row.id, timestamp);
        if (Number(consumed.changes) !== 1) throw new IdentityInputError("Invitation is invalid or expired.", { status: 404, code: "NOT_FOUND" });
        this.db.prepare(`INSERT INTO identity_memberships(workspace_id, user_id, role, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?)`).run(row.workspace_id, userId, row.role, timestamp, timestamp);
        this.audit("invitation.accepted", "succeeded", this.tenantId, userId, { workspaceId: row.workspace_id, invitationId: row.id });
        return this.insertSession(userId, this.tenantId, row.workspace_id, timestamp);
      });
    } finally { salt.fill(0); passwordHash.fill(0); }
  }

  updateMembership(actor: IdentityPrincipal, userId: string, input: { role?: unknown; status?: unknown }): MembershipRecord {
    this.requireOwner(actor);
    if (!validIdentifier(userId)) throw new IdentityInputError("Membership was not found.", { status: 404, code: "NOT_FOUND" });
    const current = this.getMembership(actor.workspaceId, userId);
    const role = input.role === undefined ? current.role : validateRole(input.role);
    const status = input.status === undefined ? current.status : input.status;
    if (status !== "active" && status !== "inactive") throw new IdentityInputError("Membership status must be active or inactive.");
    if (current.role === "owner" && current.status === "active" && (role !== "owner" || status !== "active")) {
      const owners = this.db.prepare("SELECT COUNT(*) AS count FROM identity_memberships WHERE workspace_id=? AND role='owner' AND status='active'")
        .get(actor.workspaceId) as { count: number };
      if (Number(owners.count) <= 1) throw new IdentityInputError("The last active owner cannot be removed or demoted.", { status: 409, code: "LAST_OWNER" });
    }
    return this.inTransaction(() => {
      const timestamp = this.now();
      this.db.prepare("UPDATE identity_memberships SET role=?, status=?, updated_at=? WHERE workspace_id=? AND user_id=?")
        .run(role, status, timestamp, actor.workspaceId, userId);
      if (status === "inactive") {
        this.db.prepare("UPDATE identity_sessions SET revoked_at=? WHERE workspace_id=? AND user_id=? AND revoked_at IS NULL")
          .run(timestamp, actor.workspaceId, userId);
        this.db.prepare("UPDATE identity_api_keys SET revoked_at=? WHERE workspace_id=? AND created_by_user_id=? AND revoked_at IS NULL")
          .run(timestamp, actor.workspaceId, userId);
      }
      this.audit("membership.updated", "succeeded", this.tenantId, actor.userId, { workspaceId: actor.workspaceId, userId, role, status });
      return this.getMembership(actor.workspaceId, userId);
    });
  }

  private getMembership(workspaceId: string, userId: string): MembershipRecord {
    const row = this.db.prepare(`SELECT u.id AS user_id, u.email, u.display_name, m.workspace_id, m.role, m.status, m.created_at, m.updated_at
      FROM identity_memberships m JOIN identity_users u ON u.id=m.user_id AND u.tenant_id=?
      WHERE m.workspace_id=? AND m.user_id=?`).get(this.tenantId, workspaceId, userId) as Record<string, unknown> | undefined;
    if (!row) throw new IdentityInputError("Membership was not found.", { status: 404, code: "NOT_FOUND" });
    return rowToMembership(row);
  }

  private logoutWithoutAudit(token: string): void {
    if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) return;
    const tokenHash = digest(token);
    this.db.prepare("UPDATE identity_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(this.now(), tokenHash);
    tokenHash.fill(0);
  }

  listAuditEvents() {
    return this.db.prepare(`SELECT sequence, tenant_id AS tenantId, actor_user_id AS actorUserId,
      event_type AS eventType, outcome, occurred_at AS occurredAt, details_json AS detailsJson
      FROM identity_audit_events ORDER BY sequence`).all();
  }

  private requireOwner(actor: IdentityPrincipal) {
    if (actor.tenantId !== this.tenantId || actor.role !== "owner") {
      throw new IdentityInputError("Owner authorization is required.", { status: 403, code: "FORBIDDEN" });
    }
    const owner = this.db.prepare(`SELECT 1 AS present FROM identity_memberships m
      JOIN identity_workspaces w ON w.id=m.workspace_id AND w.tenant_id=? AND w.archived_at IS NULL
      WHERE m.user_id=? AND m.workspace_id=? AND m.role='owner' AND m.status='active'`)
      .get(this.tenantId, actor.userId, actor.workspaceId);
    if (owner === undefined) throw new IdentityInputError("Owner authorization is required.", { status: 403, code: "FORBIDDEN" });
  }

  private getApiKey(apiKeyId: string, workspaceId: string): ApiKeyRecord {
    const row = this.db.prepare(`SELECT id, tenant_id, workspace_id, name, key_prefix, scopes_json, created_at,
      last_used_at, revoked_at, rotated_from_id
      FROM identity_api_keys WHERE id = ? AND tenant_id = ? AND workspace_id = ?`).get(apiKeyId, this.tenantId, workspaceId) as Record<string, unknown> | undefined;
    if (!row) throw new IdentityInputError("API key was not found.", { status: 404, code: "NOT_FOUND" });
    return rowToApiKey(row);
  }

  private insertApiKey(
    actorUserId: string,
    workspaceId: string,
    name: string,
    scopes: string[],
    rotatedFromId: string | null,
  ): ApiKeyCreation {
    const prefixBytes = Buffer.from(this.randomBytes(9));
    const secretBytes = Buffer.from(this.randomBytes(32));
    if (prefixBytes.byteLength !== 9 || secretBytes.byteLength !== 32) {
      prefixBytes.fill(0);
      secretBytes.fill(0);
      throw new TypeError("Identity random source returned invalid API key material");
    }
    const prefix = canonicalToken(prefixBytes);
    const secretPart = canonicalToken(secretBytes);
    const secret = `${API_KEY_PREFIX}_${prefix}_${secretPart}`;
    const secretHash = digest(secret);
    const id = randomUUID();
    const timestamp = this.now();
    try {
      const workspace = this.db.prepare("SELECT workspace_id FROM identity_memberships WHERE user_id=? AND workspace_id=? AND status='active'")
        .get(actorUserId, workspaceId) as { workspace_id: string } | undefined;
      if (!workspace) throw new IdentityInputError("An active workspace membership is required.", { status: 403, code: "FORBIDDEN" });
      this.db.prepare(`INSERT INTO identity_api_keys(
        id, tenant_id, workspace_id, created_by_user_id, name, key_prefix, secret_hash, scopes_json,
        created_at, last_used_at, revoked_at, rotated_from_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
        .run(id, this.tenantId, workspace.workspace_id, actorUserId, name, prefix, secretHash, JSON.stringify(scopes), timestamp, rotatedFromId);
      return { apiKey: this.getApiKey(id, workspace.workspace_id), secret };
    } finally {
      prefixBytes.fill(0);
      secretBytes.fill(0);
      secretHash.fill(0);
    }
  }

  private inTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertSession(userId: string, tenantId: string, workspaceId: string, timestamp: number): SessionCreation {
    const tokenBytes = Buffer.from(this.randomBytes(32));
    const csrfBytes = Buffer.from(this.randomBytes(32));
    if (tokenBytes.byteLength !== 32 || csrfBytes.byteLength !== 32) throw new TypeError("Identity random source returned an invalid token");
    const token = canonicalToken(tokenBytes);
    const csrfToken = canonicalToken(csrfBytes);
    const tokenHash = digest(token);
    const csrfHash = digest(csrfToken);
    const expiresAt = timestamp + SESSION_LIFETIME_MS;
    try {
      this.db.prepare(`INSERT INTO identity_sessions(
        id, tenant_id, workspace_id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(randomUUID(), tenantId, workspaceId, userId, tokenHash, csrfHash, timestamp, timestamp, expiresAt);
      const membership = this.db.prepare("SELECT role FROM identity_memberships WHERE workspace_id=? AND user_id=? AND status='active'")
        .get(workspaceId, userId) as { role: WorkspaceRole } | undefined;
      if (!membership) throw new IdentityInputError("An active workspace membership is required.", { status: 403, code: "FORBIDDEN" });
      return {
        token,
        csrfToken,
        expiresAt: new Date(expiresAt).toISOString(),
        principal: Object.freeze({
          callerId: `user:${userId}`,
          tenantId,
          workspaceId,
          userId,
          role: membership.role,
          scopes: [...ROLE_SCOPES[membership.role]],
        }),
      };
    } finally {
      tokenBytes.fill(0);
      csrfBytes.fill(0);
      tokenHash.fill(0);
      csrfHash.fill(0);
    }
  }

  private audit(
    eventType: string,
    outcome: string,
    tenantId: string | null,
    actorUserId: string | null,
    details: Record<string, unknown> = {},
  ) {
    const detailsJson = JSON.stringify(details);
    if (Buffer.byteLength(detailsJson) > 4096) throw new TypeError("Identity audit details exceed the bounded limit");
    this.db.prepare(`INSERT INTO identity_audit_events(
      tenant_id, actor_user_id, event_type, outcome, occurred_at, details_json
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(tenantId, actorUserId, eventType, outcome, this.now(), detailsJson);
    this.auditSink?.({
      callerId: actorUserId === null ? null : `user:${actorUserId}`,
      type: `identity.${eventType}`,
      outcome,
      data: { ...details },
    });
  }
}

export class IdentityHttpController {
  private readonly store: IdentityStore;
  private readonly secureCookie: boolean;
  private readonly apiKeyRateLimit: ApiKeyRateLimitHook;
  private readonly loginRateLimit: LoginAttemptLimiter;
  private readonly loginAddressRateLimit: LoginAttemptLimiter;

  constructor(
    store: IdentityStore,
    secureCookie = true,
    apiKeyRateLimit: ApiKeyRateLimitHook = createDefaultApiKeyRateLimit(),
    loginRateLimit = new LoginAttemptLimiter(),
    loginAddressRateLimit = new LoginAttemptLimiter({ limit: 30 }),
  ) {
    this.store = store;
    this.secureCookie = secureCookie;
    this.apiKeyRateLimit = apiKeyRateLimit;
    this.loginRateLimit = loginRateLimit;
    this.loginAddressRateLimit = loginAddressRateLimit;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (
      !url.pathname.startsWith("/v1/setup") &&
      !url.pathname.startsWith("/v1/auth") &&
      !url.pathname.startsWith("/v1/control-plane/api-keys") &&
      !url.pathname.startsWith("/v1/control-plane/workspaces") &&
      !url.pathname.startsWith("/v1/control-plane/members") &&
      !url.pathname.startsWith("/v1/control-plane/invitations") &&
      url.pathname !== "/v1/invitations/accept"
    ) return false;
    try {
      if (request.method === "GET" && url.pathname === "/v1/setup/status") {
        return this.json(response, 200, this.store.setupStatus());
      }
      if (request.method === "POST" && url.pathname === "/v1/setup/owner") {
        const body = await readBody(request);
        const created = this.store.createFirstOwner({ email: body.email, password: body.password, displayName: body.displayName });
        this.setCookie(response, created.token, created.expiresAt);
        return this.json(response, 201, sessionResponse(created));
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readBody(request);
        const loginKeys = loginAttemptKeys(request, body.email);
        const accountDecision = this.loginRateLimit.check(loginKeys.account);
        if (!accountDecision.allowed) return this.rateLimitError(response, accountDecision);
        const addressDecision = this.loginAddressRateLimit.check(loginKeys.address);
        if (!addressDecision.allowed) return this.rateLimitError(response, addressDecision);
        const session = this.store.login({ email: body.email, password: body.password });
        if (!session) {
          // These synchronous updates have no await boundary: both failure
          // buckets are committed before another request can reach scrypt.
          this.loginRateLimit.failure(loginKeys.account);
          this.loginAddressRateLimit.failure(loginKeys.address);
          return this.error(response, 401, "UNAUTHENTICATED", "Email or password is incorrect.");
        }
        // Successful authentication clears the narrow account bucket only.
        // It must not erase coarse evidence of identifier-rotation abuse.
        this.loginRateLimit.success(loginKeys.account);
        this.setCookie(response, session.token, session.expiresAt);
        return this.json(response, 200, sessionResponse(session));
      }
      if (request.method === "POST" && url.pathname === "/v1/invitations/accept") {
        const body = await readBody(request);
        const created = this.store.acceptInvitation({ token: body.token, displayName: body.displayName, password: body.password });
        this.setCookie(response, created.token, created.expiresAt);
        return this.json(response, 201, sessionResponse(created));
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        const token = cookieToken(request);
        const csrf = singleHeader(request.headers["x-csrf-token"]);
        if (!token || !csrf || !this.store.authenticate(token, csrf)) {
          return this.error(response, 401, "UNAUTHENTICATED", "A valid session and CSRF token are required.");
        }
        this.store.logout(token);
        response.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookie ? "; Secure" : ""}`);
        return this.json(response, 200, { loggedOut: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/auth/session") {
        const principal = this.authenticateRequest(request, false);
        if (!principal) return this.error(response, 401, "UNAUTHENTICATED", "Authentication is required.");
        return this.json(response, 200, { authenticated: true, tenantId: principal.tenantId, workspaceId: principal.workspaceId, role: principal.role });
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/workspace") {
        const principal = this.authenticateRequest(request, true);
        const token = cookieToken(request);
        if (!principal || !token) return this.error(response, 401, "UNAUTHENTICATED", "A valid session and CSRF token are required.");
        const body = await readBody(request);
        const selected = this.store.selectWorkspace(principal, body.workspaceId, token);
        this.setCookie(response, selected.token, selected.expiresAt);
        return this.json(response, 200, sessionResponse(selected));
      }
      if (url.pathname === "/v1/control-plane/workspaces") {
        const actor = this.authenticateRequest(request);
        if (!actor) return this.error(response, 401, "UNAUTHENTICATED", "A valid browser session is required.");
        if (request.method === "GET") return this.json(response, 200, { items: this.store.listWorkspaces(actor), nextCursor: null });
        if (request.method === "POST") {
          const body = await readBody(request);
          return this.json(response, 201, { workspace: this.store.createWorkspace(actor, { name: body.name }) });
        }
        return this.error(response, 404, "NOT_FOUND", "Route not found.");
      }
      if (url.pathname === "/v1/control-plane/members") {
        const owner = this.authenticateRequest(request);
        if (!owner) return this.error(response, 401, "UNAUTHENTICATED", "A valid owner session is required.");
        if (request.method === "GET") return this.json(response, 200, { items: this.store.listMembers(owner), nextCursor: null });
        if (request.method === "POST") {
          const body = await readBody(request);
          return this.json(response, 201, { member: this.store.provisionUser(owner, { email: body.email, displayName: body.displayName, password: body.password, role: body.role }) });
        }
        return this.error(response, 404, "NOT_FOUND", "Route not found.");
      }
      if (request.method === "POST" && url.pathname === "/v1/control-plane/invitations") {
        const owner = this.authenticateRequest(request, true);
        if (!owner) return this.error(response, 401, "UNAUTHENTICATED", "A valid owner session and CSRF token are required.");
        const body = await readBody(request);
        return this.json(response, 201, this.store.createInvitation(owner, { email: body.email, role: body.role, expiresInHours: body.expiresInHours }));
      }
      const memberAction = /^\/v1\/control-plane\/members\/([^/]+)$/u.exec(url.pathname);
      if (memberAction && request.method === "POST") {
        const owner = this.authenticateRequest(request, true);
        if (!owner) return this.error(response, 401, "UNAUTHENTICATED", "A valid owner session and CSRF token are required.");
        const body = await readBody(request);
        return this.json(response, 200, { member: this.store.updateMembership(owner, safeDecodePath(memberAction[1]!), { role: body.role, status: body.status }) });
      }
      if (url.pathname === "/v1/control-plane/api-keys") {
        const owner = this.authenticateRequest(request);
        if (!owner) return this.error(response, 401, "UNAUTHENTICATED", "A valid owner session is required.");
        if (request.method === "GET") {
          return this.json(response, 200, { items: this.store.listApiKeys(owner), nextCursor: null });
        }
        if (request.method === "POST") {
          const body = await readBody(request);
          const created = this.store.createApiKey(owner, { name: body.name, scopes: body.scopes });
          return this.json(response, 201, created);
        }
        return this.error(response, 404, "NOT_FOUND", "Route not found.");
      }
      const apiKeyAction = /^\/v1\/control-plane\/api-keys\/([^/]+)\/(revoke|rotate)$/u.exec(url.pathname);
      if (apiKeyAction) {
        const owner = this.authenticateRequest(request, true);
        if (!owner) return this.error(response, 401, "UNAUTHENTICATED", "A valid owner session and CSRF token are required.");
        if (request.method !== "POST") return this.error(response, 404, "NOT_FOUND", "Route not found.");
        const apiKeyId = safeDecodePath(apiKeyAction[1]!);
        if (apiKeyAction[2] === "revoke") {
          const apiKey = this.store.revokeApiKey(owner, apiKeyId);
          return this.json(response, 200, { apiKey, revoked: true });
        }
        const body = await readBody(request);
        const rotated = this.store.rotateApiKey(owner, apiKeyId, { name: body.name, scopes: body.scopes });
        return this.json(response, 201, rotated);
      }
      return this.error(response, 404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      if (error instanceof IdentityInputError) return this.error(response, error.status, error.code, error.message);
      return this.error(response, 500, "INTERNAL_ERROR", "The request could not be processed.");
    }
  }

  authenticateRequest(
    request: IncomingMessage,
    csrfRequired = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? ""),
    touch = true,
  ): IdentityPrincipal | null {
    const token = cookieToken(request);
    if (!token) return null;
    const csrf = csrfRequired ? singleHeader(request.headers["x-csrf-token"]) : undefined;
    if (csrfRequired && !csrf) return null;
    return this.store.authenticate(token, csrf, touch);
  }

  authenticateApiKeyRequest(request: IncomingMessage): ApiKeyPrincipal | null {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return null;
    return this.store.authenticateApiKey(authorization.slice(7), this.apiKeyRateLimit);
  }

  private setCookie(response: ServerResponse, token: string, expiresAt: string) {
    response.setHeader("set-cookie", `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${this.secureCookie ? "; Secure" : ""}`);
  }

  private json(response: ServerResponse, status: number, value: unknown): true {
    const body = JSON.stringify(value);
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
    return true;
  }

  private error(response: ServerResponse, status: number, code: string, message: string): true {
    const requestId = response.getHeader("x-request-id");
    return this.json(response, status, { error: {
      code,
      message,
      requestId: typeof requestId === "string" ? requestId : "unknown",
      retryable: false,
    } });
  }

  private rateLimitError(response: ServerResponse, decision: LoginRateLimitDecision): true {
    if (decision.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(decision.retryAfterSeconds));
    response.setHeader("x-ratelimit-limit", String(decision.limit));
    response.setHeader("x-ratelimit-remaining", String(decision.remaining));
    response.setHeader("x-ratelimit-reset", decision.resetAt);
    const requestId = response.getHeader("x-request-id");
    return this.json(response, 429, { error: {
      code: "RATE_LIMITED",
      message: "Too many login attempts. Try again later.",
      requestId: typeof requestId === "string" ? requestId : "unknown",
      retryable: true,
      rateLimit: {
        limit: decision.limit,
        remaining: decision.remaining,
        ...(decision.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: decision.retryAfterSeconds }),
        resetAt: decision.resetAt,
      },
    } });
  }
}

function loginAttemptKeys(request: IncomingMessage, email: unknown): { account: string; address: string } {
  // Forwarded headers are deliberately ignored absent explicit trusted-proxy
  // configuration. This may group a reverse proxy's clients into one coarse
  // bucket, while the independent account bucket remains precise.
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  const normalizedEmail = typeof email === "string"
    ? email.trim().toLowerCase().slice(0, 254)
    : `<${typeof email}>`;
  const address = createHash("sha256").update(remoteAddress, "utf8").digest("base64url");
  const account = createHash("sha256")
    .update(remoteAddress, "utf8")
    .update("\0", "utf8")
    .update(createHash("sha256").update(normalizedEmail, "utf8").digest())
    .digest("base64url");
  return { account, address };
}

function sessionResponse(session: SessionCreation) {
  return {
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    tenantId: session.principal.tenantId,
    workspaceId: session.principal.workspaceId,
    role: session.principal.role,
  };
}

function cookieToken(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeDecodePath(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new IdentityInputError("API key was not found.", { status: 404, code: "NOT_FOUND" }); }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new IdentityInputError("Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 16_384) throw new IdentityInputError("Request body is too large.");
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new IdentityInputError("Request body must be a JSON object.");
  }
}
