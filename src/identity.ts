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
import type { Principal } from "./service.ts";

const OWNER_SCOPES = Object.freeze(["*"]);
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({ N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const COOKIE_NAME = "social_git_session";

export interface IdentityPrincipal extends Principal {
  tenantId: string;
  userId: string;
  role: "owner";
}

interface IdentityStoreOptions {
  tenantId: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

interface SessionCreation {
  token: string;
  csrfToken: string;
  expiresAt: string;
  principal: IdentityPrincipal;
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

export class IdentityInputError extends Error {
  readonly status = 422;
  readonly code = "VALIDATION_FAILED";
}

export class IdentityStore {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(path: string, options: IdentityStoreOptions) {
    if (!validIdentifier(options.tenantId)) throw new TypeError("tenantId is invalid");
    this.tenantId = options.tenantId;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
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
        event_type TEXT NOT NULL CHECK (event_type IN (
          'owner.created', 'auth.login_succeeded', 'auth.login_failed',
          'auth.logout', 'auth.session_rejected'
        )),
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rejected')),
        occurred_at INTEGER NOT NULL,
        details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object')
      ) STRICT;
      INSERT OR IGNORE INTO identity_schema_migrations(version, applied_at)
      VALUES (1, unixepoch('subsec') * 1000);
    `);
  }

  setupStatus() {
    const owner = this.db.prepare("SELECT 1 AS present FROM identity_users LIMIT 1").get();
    return Object.freeze({ required: owner === undefined });
  }

  createFirstOwner(input: { email: unknown; password: unknown; displayName: unknown }): SessionCreation {
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
        this.audit("owner.created", "succeeded", this.tenantId, userId);
        const session = this.insertSession(userId, this.tenantId, timestamp);
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
    const session = this.insertSession(row.id, row.tenant_id, this.now());
    this.audit("auth.login_succeeded", "succeeded", row.tenant_id, row.id);
    return session;
  }

  authenticate(token: string, csrfToken?: string): IdentityPrincipal | null {
    if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) return null;
    const tokenHash = digest(token);
    const row = this.db.prepare(`SELECT s.id, s.tenant_id, s.user_id, s.csrf_hash, s.expires_at,
      u.role FROM identity_sessions s
      JOIN identity_users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`).get(tokenHash) as
      | { id: string; tenant_id: string; user_id: string; csrf_hash: Uint8Array; expires_at: number; role: string }
      | undefined;
    tokenHash.fill(0);
    if (!row || row.tenant_id !== this.tenantId || row.expires_at <= this.now() || row.role !== "owner") return null;
    if (csrfToken !== undefined) {
      if (!/^[A-Za-z0-9_-]{40,128}$/u.test(csrfToken)) return null;
      const csrfHash = digest(csrfToken);
      const stored = Buffer.from(row.csrf_hash);
      const valid = timingSafeEqual(csrfHash, stored);
      csrfHash.fill(0);
      stored.fill(0);
      if (!valid) return null;
    }
    this.db.prepare("UPDATE identity_sessions SET last_seen_at = ? WHERE id = ?").run(this.now(), row.id);
    return Object.freeze({
      callerId: `owner:${row.user_id}`,
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: "owner" as const,
      scopes: [...OWNER_SCOPES],
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

  listAuditEvents() {
    return this.db.prepare(`SELECT sequence, tenant_id AS tenantId, actor_user_id AS actorUserId,
      event_type AS eventType, outcome, occurred_at AS occurredAt, details_json AS detailsJson
      FROM identity_audit_events ORDER BY sequence`).all();
  }

  private insertSession(userId: string, tenantId: string, timestamp: number): SessionCreation {
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
        id, tenant_id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(randomUUID(), tenantId, userId, tokenHash, csrfHash, timestamp, timestamp, expiresAt);
      return {
        token,
        csrfToken,
        expiresAt: new Date(expiresAt).toISOString(),
        principal: Object.freeze({
          callerId: `owner:${userId}`,
          tenantId,
          userId,
          role: "owner" as const,
          scopes: [...OWNER_SCOPES],
        }),
      };
    } finally {
      tokenBytes.fill(0);
      csrfBytes.fill(0);
      tokenHash.fill(0);
      csrfHash.fill(0);
    }
  }

  private audit(eventType: string, outcome: string, tenantId: string | null, actorUserId: string | null) {
    this.db.prepare(`INSERT INTO identity_audit_events(
      tenant_id, actor_user_id, event_type, outcome, occurred_at, details_json
    ) VALUES (?, ?, ?, ?, ?, '{}')`).run(tenantId, actorUserId, eventType, outcome, this.now());
  }
}

export class IdentityHttpController {
  private readonly store: IdentityStore;
  private readonly secureCookie: boolean;

  constructor(store: IdentityStore, secureCookie = true) {
    this.store = store;
    this.secureCookie = secureCookie;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/v1/setup") && !url.pathname.startsWith("/v1/auth")) return false;
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
        const session = this.store.login({ email: body.email, password: body.password });
        if (!session) return this.error(response, 401, "UNAUTHENTICATED", "Email or password is incorrect.");
        this.setCookie(response, session.token, session.expiresAt);
        return this.json(response, 200, sessionResponse(session));
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
        return this.json(response, 200, { authenticated: true, tenantId: principal.tenantId, role: principal.role });
      }
      return this.error(response, 404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      if (error instanceof IdentityInputError) return this.error(response, error.status, error.code, error.message);
      return this.error(response, 500, "INTERNAL_ERROR", "The request could not be processed.");
    }
  }

  authenticateRequest(request: IncomingMessage, csrfRequired = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")): IdentityPrincipal | null {
    const token = cookieToken(request);
    if (!token) return null;
    const csrf = csrfRequired ? singleHeader(request.headers["x-csrf-token"]) : undefined;
    if (csrfRequired && !csrf) return null;
    return this.store.authenticate(token, csrf);
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
}

function sessionResponse(session: SessionCreation) {
  return {
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    tenantId: session.principal.tenantId,
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
