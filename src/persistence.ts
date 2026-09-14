import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { redactDetails, ServiceError } from "./errors.ts";

export const ACTION_STATES = ["queued", "running", "succeeded", "failed", "action_required", "UNKNOWN"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export interface AccountRecord {
  id: string;
  platform: string;
  expectedNativeUserId: string;
  actualNativeUserId: string | null;
  label: string | null;
  status: "disconnected" | "active" | "suspended" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionRecord {
  accountId: string;
  generation: number;
  status: "active" | "revoked";
  connectedAt: string;
  revokedAt: string | null;
}

interface InternalConnectionRecord extends ConnectionRecord {
  vaultHandle: string;
}

export interface ActionRecord {
  id: string;
  callerId: string;
  accountId: string;
  idempotencyKey: string;
  kind: string;
  state: ActionState;
  submissionMayHaveStarted: boolean;
  result: unknown | null;
  error: unknown | null;
  createdAt: string;
  updatedAt: string;
}

interface InternalActionRecord extends ActionRecord {
  requestHash: string;
  request: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  callerId: string | null;
  accountId: string | null;
  type: string;
  outcome: string;
  data: unknown;
  occurredAt: string;
}

export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        expected_native_user_id TEXT NOT NULL,
        actual_native_user_id TEXT,
        label TEXT,
        status TEXT NOT NULL CHECK (status IN ('disconnected','active','suspended','revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE connections (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        vault_handle TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        status TEXT NOT NULL CHECK (status IN ('active','revoked')),
        connected_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','action_required','UNKNOWN')),
        submit_started_at TEXT,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (caller_id, idempotency_key)
      );
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        caller_id TEXT,
        account_id TEXT,
        type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        data_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE inbound_events (
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (source, event_id)
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX actions_state_created_idx ON actions(state, created_at);
      CREATE INDEX actions_account_idx ON actions(account_id, created_at);
      CREATE INDEX audit_account_sequence_idx ON audit_events(account_id, sequence);
    `,
  },
] as const;

const MAX_AUDIT_BYTES = 4096;

function now() { return new Date().toISOString(); }

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function boundAuditData(value: unknown): string {
  const json = canonicalJson(redactDetails(value ?? {}));
  const bytes = Buffer.byteLength(json);
  if (bytes <= MAX_AUDIT_BYTES) return json;
  return JSON.stringify({ truncated: true, originalBytes: bytes, sha256: createHash("sha256").update(json).digest("hex") });
}

function parseJson(value: unknown): unknown | null {
  return typeof value === "string" ? JSON.parse(value) : null;
}

function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, sequence })).toString("base64url");
}

function decodeCursor(value?: string): number {
  if (!value) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded.v !== 1 || !Number.isInteger(decoded.sequence) || decoded.sequence < 0) throw new Error();
    return decoded.sequence;
  } catch {
    throw new ServiceError("VALIDATION_FAILED", "cursor is invalid.", { details: { field: "cursor" } });
  }
}

function rowToAccount(row: Record<string, unknown>): AccountRecord {
  return {
    id: String(row.id), platform: String(row.platform), expectedNativeUserId: String(row.expected_native_user_id),
    actualNativeUserId: row.actual_native_user_id === null ? null : String(row.actual_native_user_id),
    label: row.label === null ? null : String(row.label), status: row.status as AccountRecord["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function rowToConnection(row: Record<string, unknown>): InternalConnectionRecord {
  return {
    accountId: String(row.account_id), vaultHandle: String(row.vault_handle), generation: Number(row.generation),
    status: row.status as ConnectionRecord["status"], connectedAt: String(row.connected_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  };
}

function rowToAction(row: Record<string, unknown>): InternalActionRecord {
  return {
    id: String(row.id), callerId: String(row.caller_id), accountId: String(row.account_id),
    idempotencyKey: String(row.idempotency_key), requestHash: String(row.request_hash),
    request: JSON.parse(String(row.request_json)), kind: String(row.kind), state: row.state as ActionState,
    submissionMayHaveStarted: row.submit_started_at !== null,
    result: parseJson(row.result_json), error: parseJson(row.error_json),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export class LedgerStore {
  readonly db: DatabaseSync;

  constructor(path: string, options: { maxMigrationVersion?: number } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate(options.maxMigrationVersion);
  }

  close() { this.db.close(); }

  private migrate(maxVersion = Number.POSITIVE_INFINITY) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => Number(row.version)),
    );
    for (const migration of MIGRATIONS) {
      if (migration.version > maxVersion || applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, now());
      });
    }
  }

  migrationVersion(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    return Number(row.version);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendAudit(input: { callerId?: string | null; accountId?: string | null; type: string; outcome: string; data?: unknown }) {
    const occurredAt = now();
    this.db.prepare(`INSERT INTO audit_events(id, caller_id, account_id, type, outcome, data_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), input.callerId ?? null, input.accountId ?? null, input.type, input.outcome, boundAuditData(input.data), occurredAt);
  }

  audit(input: { callerId?: string | null; accountId?: string | null; type: string; outcome: string; data?: unknown }) {
    this.transaction(() => this.appendAudit(input));
  }

  createAccount(input: { platform: string; expectedNativeUserId: string; label?: string; callerId: string }): AccountRecord {
    const id = randomUUID();
    const timestamp = now();
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO accounts(id, platform, expected_native_user_id, actual_native_user_id, label, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'disconnected', ?, ?)`)
        .run(id, input.platform, input.expectedNativeUserId, input.label ?? null, timestamp, timestamp);
      this.appendAudit({ callerId: input.callerId, accountId: id, type: "account.created", outcome: "succeeded", data: { platform: input.platform } });
      return this.getAccount(id);
    });
  }

  getAccount(id: string): AccountRecord {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Account not found.");
    return rowToAccount(row);
  }

  listAccounts(options: { cursor?: string; limit?: number } = {}) {
    const after = decodeCursor(options.cursor);
    const limitValue = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const rows = this.db.prepare("SELECT rowid AS sequence, * FROM accounts WHERE rowid > ? ORDER BY rowid LIMIT ?").all(after, limitValue + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limitValue;
    const page = rows.slice(0, limitValue);
    return {
      items: page.map(rowToAccount),
      nextCursor: hasMore ? encodeCursor(Number(page.at(-1)?.sequence)) : null,
    };
  }

  upsertConnection(input: { accountId: string; vaultHandle: string; generation: number; actualNativeUserId: string; callerId: string }): ConnectionRecord {
    const timestamp = now();
    return this.transaction(() => {
      const current = this.db.prepare("SELECT generation FROM connections WHERE account_id = ?").get(input.accountId) as { generation: number } | undefined;
      if (current && input.generation <= Number(current.generation)) {
        throw new ServiceError("VALIDATION_FAILED", "Connection generation must increase.", { details: { field: "generation" } });
      }
      this.db.prepare(`INSERT INTO connections(account_id, vault_handle, generation, status, connected_at, revoked_at)
        VALUES (?, ?, ?, 'active', ?, NULL)
        ON CONFLICT(account_id) DO UPDATE SET vault_handle=excluded.vault_handle, generation=excluded.generation, status='active', connected_at=excluded.connected_at, revoked_at=NULL`)
        .run(input.accountId, input.vaultHandle, input.generation, timestamp);
      this.db.prepare("UPDATE accounts SET actual_native_user_id=?, status='active', updated_at=? WHERE id=?")
        .run(input.actualNativeUserId, timestamp, input.accountId);
      this.appendAudit({ callerId: input.callerId, accountId: input.accountId, type: "connection.imported", outcome: "succeeded", data: { generation: input.generation } });
      return this.getConnection(input.accountId);
    });
  }

  getConnectionInternal(accountId: string): InternalConnectionRecord {
    const row = this.db.prepare("SELECT * FROM connections WHERE account_id=?").get(accountId) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Connection not found.");
    return rowToConnection(row);
  }

  getConnection(accountId: string): ConnectionRecord {
    const { vaultHandle: _vaultHandle, ...safe } = this.getConnectionInternal(accountId);
    return safe;
  }

  markAccountStatus(accountId: string, status: AccountRecord["status"]) {
    this.db.prepare("UPDATE accounts SET status=?, updated_at=? WHERE id=?").run(status, now(), accountId);
  }

  revokeAccount(input: { accountId: string; callerId: string; reason?: string }): ConnectionRecord {
    return this.transaction(() => {
      const timestamp = now();
      const result = this.db.prepare("UPDATE connections SET status='revoked', revoked_at=? WHERE account_id=? AND status='active'").run(timestamp, input.accountId);
      if (Number(result.changes) === 0) throw new ServiceError("SESSION_REVOKED", "Connection is already revoked or unavailable.");
      this.db.prepare("UPDATE accounts SET status='revoked', updated_at=? WHERE id=?").run(timestamp, input.accountId);
      this.appendAudit({ callerId: input.callerId, accountId: input.accountId, type: "connection.revoked", outcome: "succeeded", data: { reason: input.reason ?? "requested" } });
      return this.getConnection(input.accountId);
    });
  }

  createAction(input: { callerId: string; accountId: string; idempotencyKey: string; request: Record<string, unknown> }) {
    const requestHash = hashPayload(input.request);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM actions WHERE caller_id=? AND idempotency_key=?").get(input.callerId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        const action = rowToAction(existing);
        if (action.requestHash !== requestHash) {
          throw new ServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different request.");
        }
        return { action, replayed: true };
      }
      const id = randomUUID();
      const timestamp = now();
      this.db.prepare(`INSERT INTO actions(id, caller_id, account_id, idempotency_key, request_hash, request_json, kind, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(id, input.callerId, input.accountId, input.idempotencyKey, requestHash, canonicalJson(input.request), String(input.request.kind), timestamp, timestamp);
      this.appendAudit({ callerId: input.callerId, accountId: input.accountId, type: "action.queued", outcome: "queued", data: { actionId: id, kind: input.request.kind } });
      return { action: this.getActionInternal(id), replayed: false };
    });
  }

  getActionInternal(id: string): InternalActionRecord {
    const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Action not found.");
    return rowToAction(row);
  }

  getActionForCaller(id: string, callerId: string): ActionRecord {
    const row = this.db.prepare("SELECT * FROM actions WHERE id=? AND caller_id=?").get(id, callerId) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Action not found.");
    const { request: _request, requestHash: _hash, ...safe } = rowToAction(row);
    return safe;
  }

  claimNextAction(): InternalActionRecord | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM actions WHERE state='queued' ORDER BY created_at, id LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const action = rowToAction(row);
      this.db.prepare("UPDATE actions SET state='running', updated_at=? WHERE id=? AND state='queued'").run(now(), action.id);
      this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: "action.running", outcome: "running", data: { actionId: action.id } });
      return this.getActionInternal(action.id);
    });
  }

  markSubmissionStarted(id: string) {
    const result = this.db.prepare("UPDATE actions SET submit_started_at=?, updated_at=? WHERE id=? AND state='running' AND submit_started_at IS NULL").run(now(), now(), id);
    if (Number(result.changes) !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "Action is not ready for submission.");
  }

  transitionAction(id: string, from: ActionState[], to: ActionState, input: { result?: unknown; error?: unknown } = {}): ActionRecord {
    return this.transaction(() => {
      const action = this.getActionInternal(id);
      if (!from.includes(action.state)) throw new ServiceError("ACTION_STATE_CONFLICT", `Action cannot move from ${action.state} to ${to}.`);
      const timestamp = now();
      this.db.prepare("UPDATE actions SET state=?, result_json=?, error_json=?, updated_at=? WHERE id=?")
        .run(to, input.result === undefined ? null : canonicalJson(input.result), input.error === undefined ? null : canonicalJson(input.error), timestamp, id);
      this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: `action.${to}`, outcome: to, data: { actionId: id, kind: action.kind } });
      const { request: _request, requestHash: _hash, ...safe } = this.getActionInternal(id);
      return safe;
    });
  }

  recoverInterruptedActions(): { requeued: number; unknown: number } {
    return this.transaction(() => {
      const safe = this.db.prepare("SELECT id FROM actions WHERE state='running' AND submit_started_at IS NULL").all() as Array<{ id: string }>;
      const uncertain = this.db.prepare("SELECT * FROM actions WHERE state='running' AND submit_started_at IS NOT NULL").all() as Array<Record<string, unknown>>;
      this.db.prepare("UPDATE actions SET state='queued', updated_at=? WHERE state='running' AND submit_started_at IS NULL").run(now());
      this.db.prepare("UPDATE actions SET state='UNKNOWN', error_json=?, updated_at=? WHERE state='running' AND submit_started_at IS NOT NULL")
        .run(canonicalJson({ code: "UNKNOWN_RESULT", message: "The process stopped after submission might have started." }), now());
      for (const row of uncertain) {
        const action = rowToAction(row);
        this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: "action.UNKNOWN", outcome: "UNKNOWN", data: { actionId: action.id, reason: "restart_after_submit" } });
      }
      return { requeued: safe.length, unknown: uncertain.length };
    });
  }

  listAuditEvents(options: { accountId?: string; cursor?: string; limit?: number } = {}) {
    const after = decodeCursor(options.cursor);
    const limitValue = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const rows = (options.accountId
      ? this.db.prepare("SELECT * FROM audit_events WHERE sequence>? AND account_id=? ORDER BY sequence LIMIT ?").all(after, options.accountId, limitValue + 1)
      : this.db.prepare("SELECT * FROM audit_events WHERE sequence>? ORDER BY sequence LIMIT ?").all(after, limitValue + 1)) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limitValue;
    const page = rows.slice(0, limitValue);
    const items: AuditEvent[] = page.map((row) => ({
      id: String(row.id), sequence: Number(row.sequence), callerId: row.caller_id === null ? null : String(row.caller_id),
      accountId: row.account_id === null ? null : String(row.account_id), type: String(row.type), outcome: String(row.outcome),
      data: JSON.parse(String(row.data_json)), occurredAt: String(row.occurred_at),
    }));
    return { items, nextCursor: hasMore ? encodeCursor(items.at(-1)!.sequence) : null };
  }

  applyActionResultEvent(input: {
    source: string;
    eventId: string;
    accountId: string;
    payload: { actionId: string; state: "succeeded" | "failed" | "action_required" | "UNKNOWN"; result?: unknown; error?: unknown };
  }) {
    const payloadHash = hashPayload(input);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT payload_hash FROM inbound_events WHERE source=? AND event_id=?").get(input.source, input.eventId) as { payload_hash: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new ServiceError("IDEMPOTENCY_CONFLICT", "The event ID was replayed with different content.");
        return { replayed: true, action: this.getActionInternal(input.payload.actionId) };
      }
      const action = this.getActionInternal(input.payload.actionId);
      if (action.accountId !== input.accountId) throw new ServiceError("VALIDATION_FAILED", "Event account does not match the action.");
      if (!(["running", "UNKNOWN"] as ActionState[]).includes(action.state)) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "Action cannot accept this result event.");
      }
      this.db.prepare("INSERT INTO inbound_events(source, event_id, payload_hash, processed_at) VALUES (?, ?, ?, ?)")
        .run(input.source, input.eventId, payloadHash, now());
      this.db.prepare("UPDATE actions SET state=?, result_json=?, error_json=?, updated_at=? WHERE id=?")
        .run(input.payload.state, input.payload.result === undefined ? null : canonicalJson(input.payload.result), input.payload.error === undefined ? null : canonicalJson(input.payload.error), now(), action.id);
      this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: "adapter.event.applied", outcome: input.payload.state, data: { eventId: input.eventId, source: input.source, actionId: action.id } });
      return { replayed: false, action: this.getActionInternal(action.id) };
    });
  }
}
