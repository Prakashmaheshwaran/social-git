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

export interface InternalActionRecord extends ActionRecord {
  requestHash: string;
  request: Record<string, unknown>;
  claimToken: string | null;
  attemptCount: number;
}

export interface MediaAssetRecord {
  mediaRef: string;
  callerId: string;
  accountId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface ResolvedMediaAsset extends MediaAssetRecord {
  data: Uint8Array;
}

export type MediaFlowPhase = "reserved" | "leased" | "uploaded" | "submitting" | "submitted" | "processed";

export interface MediaFlowRecord {
  actionId: string;
  mediaRef: string;
  phase: MediaFlowPhase;
  workerTicket: string | null;
  updatedAt: string;
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
  {
    version: 3,
    sql: `
      CREATE TABLE ledger_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        ledger_id TEXT NOT NULL UNIQUE
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE media_assets (
        media_ref TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
        sha256 TEXT NOT NULL,
        content BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE media_action_flows (
        action_id TEXT PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
        media_ref TEXT NOT NULL REFERENCES media_assets(media_ref),
        phase TEXT NOT NULL CHECK (phase IN ('reserved','leased','uploaded','submitting','submitted','processed')),
        worker_ticket TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX media_assets_account_created_idx ON media_assets(account_id, created_at);
      CREATE INDEX media_flows_phase_idx ON media_action_flows(phase, updated_at);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE actions ADD COLUMN claim_token TEXT;
      ALTER TABLE actions ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
      CREATE UNIQUE INDEX actions_claim_token_idx ON actions(claim_token) WHERE claim_token IS NOT NULL;
      CREATE INDEX actions_account_state_idx ON actions(account_id, state);
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
    claimToken: row.claim_token === null || row.claim_token === undefined ? null : String(row.claim_token),
    attemptCount: row.attempt_count === undefined ? 0 : Number(row.attempt_count),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function rowToMediaAsset(row: Record<string, unknown>): MediaAssetRecord {
  return {
    mediaRef: String(row.media_ref), callerId: String(row.caller_id), accountId: String(row.account_id),
    filename: String(row.filename), mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256), createdAt: String(row.created_at),
  };
}

function rowToMediaFlow(row: Record<string, unknown>): MediaFlowRecord {
  return {
    actionId: String(row.action_id), mediaRef: String(row.media_ref), phase: row.phase as MediaFlowPhase,
    workerTicket: row.worker_ticket === null ? null : String(row.worker_ticket), updatedAt: String(row.updated_at),
  };
}

function requireCurrentClaim(action: InternalActionRecord, claimToken: string | undefined): asserts claimToken is string {
  if (typeof claimToken !== "string" || claimToken.length === 0 || action.claimToken !== claimToken) {
    throw new ServiceError("ACTION_STATE_CONFLICT", "The action worker claim is missing or stale.");
  }
}

export class LedgerStore {
  readonly db: DatabaseSync;
  readonly ledgerId: string;

  constructor(path: string, options: { maxMigrationVersion?: number; ledgerId?: string } = {}) {
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate(options.maxMigrationVersion);
    const integrity = this.db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok" || this.db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      this.db.close();
      throw new ServiceError("INTERNAL", "The durable action ledger failed its integrity check.");
    }
    const requestedLedgerId = options.ledgerId ?? "default-action-ledger";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestedLedgerId)) {
      this.db.close();
      throw new ServiceError("VALIDATION_FAILED", "ledgerId is invalid.");
    }
    if (this.migrationVersion() >= 3) {
      const existing = this.db.prepare("SELECT ledger_id FROM ledger_metadata WHERE singleton = 1").get() as { ledger_id: string } | undefined;
      if (existing === undefined) {
        this.db.prepare("INSERT INTO ledger_metadata(singleton, ledger_id) VALUES (1, ?)").run(requestedLedgerId);
        this.ledgerId = requestedLedgerId;
      } else if (existing.ledger_id !== requestedLedgerId) {
        this.db.close();
        throw new ServiceError("VALIDATION_FAILED", "The ledger identity does not match the persisted database.");
      } else {
        this.ledgerId = existing.ledger_id;
      }
    } else {
      this.ledgerId = requestedLedgerId;
    }
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

  diagnostics() {
    const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    const integrity = this.db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    const actions = this.db.prepare(`SELECT
      SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN state='UNKNOWN' THEN 1 ELSE 0 END) AS unknown
      FROM actions`).get() as { queued?: number; running?: number; unknown?: number } | undefined;
    return Object.freeze({
      ledgerId: this.ledgerId,
      migrationVersion: this.migrationVersion(),
      journalMode: journal?.journal_mode ?? "unknown",
      integrity: integrity?.quick_check ?? "failed",
      queuedActions: Number(actions?.queued ?? 0),
      runningActions: Number(actions?.running ?? 0),
      unknownActions: Number(actions?.unknown ?? 0),
    });
  }

  checkpoint() {
    const row = this.db.prepare("PRAGMA wal_checkpoint(FULL)").get() as Record<string, unknown> | undefined;
    return Object.freeze({
      busy: Number(row?.busy ?? 0),
      logFrames: Number(row?.log ?? 0),
      checkpointedFrames: Number(row?.checkpointed ?? 0),
    });
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

  upsertConnection(input: { accountId: string; vaultHandle: string; generation: number; actualNativeUserId: string; callerId: string; auditType?: "connection.imported" | "connection.refreshed" }): ConnectionRecord {
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
      this.appendAudit({ callerId: input.callerId, accountId: input.accountId, type: input.auditType ?? "connection.imported", outcome: "succeeded", data: { generation: input.generation } });
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

  createMediaAsset(input: {
    callerId: string;
    accountId: string;
    filename: string;
    mimeType: string;
    data: Uint8Array;
  }): MediaAssetRecord {
    const bytes = Buffer.from(input.data);
    if (bytes.length < 1 || bytes.length > 8 * 1024 * 1024) {
      bytes.fill(0);
      throw new ServiceError("VALIDATION_FAILED", "Media content must be from 1 through 8388608 bytes.");
    }
    const mediaRef = `core-media:${randomUUID()}`;
    const timestamp = now();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      return this.transaction(() => {
        this.getAccount(input.accountId);
        this.db.prepare(`INSERT INTO media_assets(
          media_ref, caller_id, account_id, filename, mime_type, size_bytes, sha256, content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          mediaRef, input.callerId, input.accountId, input.filename, input.mimeType,
          bytes.length, sha256, bytes, timestamp,
        );
        this.appendAudit({
          callerId: input.callerId,
          accountId: input.accountId,
          type: "media.created",
          outcome: "succeeded",
          data: { mediaRef, mimeType: input.mimeType, sizeBytes: bytes.length, sha256 },
        });
        return rowToMediaAsset(this.db.prepare("SELECT * FROM media_assets WHERE media_ref=?").get(mediaRef) as Record<string, unknown>);
      });
    } finally {
      bytes.fill(0);
    }
  }

  resolveMediaForAction(action: InternalActionRecord): { asset: ResolvedMediaAsset; flow: MediaFlowRecord } {
    if (action.kind !== "media_post") throw new ServiceError("ACTION_STATE_CONFLICT", "The action does not use Core media.");
    const row = this.db.prepare(`SELECT m.*, f.action_id, f.phase, f.worker_ticket, f.updated_at AS flow_updated_at
      FROM media_action_flows f JOIN media_assets m ON m.media_ref=f.media_ref
      WHERE f.action_id=? AND m.caller_id=? AND m.account_id=?`).get(
      action.id, action.callerId, action.accountId,
    ) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("PROTOCOL_DRIFT", "The Core media binding is missing.");
    const stored = row.content;
    if (!(stored instanceof Uint8Array)) throw new ServiceError("PROTOCOL_DRIFT", "The Core media content is unavailable.");
    const data = Buffer.from(stored);
    if (data.length !== Number(row.size_bytes) || createHash("sha256").update(data).digest("hex") !== row.sha256) {
      data.fill(0);
      throw new ServiceError("PROTOCOL_DRIFT", "The Core media content failed its integrity check.");
    }
    return {
      asset: { ...rowToMediaAsset(row), data },
      flow: rowToMediaFlow({
        action_id: row.action_id,
        media_ref: row.media_ref,
        phase: row.phase,
        worker_ticket: row.worker_ticket,
        updated_at: row.flow_updated_at,
      }),
    };
  }

  transitionMediaFlow(
    actionId: string,
    from: MediaFlowPhase,
    to: MediaFlowPhase,
    workerTicket: string | null,
    claimToken: string | undefined,
  ): MediaFlowRecord {
    const transitions: Readonly<Record<MediaFlowPhase, readonly MediaFlowPhase[]>> = {
      reserved: ["leased"], leased: ["uploaded", "reserved"], uploaded: ["submitting", "reserved"],
      submitting: ["submitted"], submitted: ["processed"], processed: [],
    };
    if (!transitions[from].includes(to)) throw new ServiceError("ACTION_STATE_CONFLICT", "The media flow transition is not allowed.");
    if (to !== "reserved" && (typeof workerTicket !== "string" || workerTicket.length < 1 || workerTicket.length > 128)) {
      throw new ServiceError("PROTOCOL_DRIFT", "The media worker ticket is invalid.");
    }
    return this.transaction(() => {
      const action = this.getActionInternal(actionId);
      requireCurrentClaim(action, claimToken);
      const timestamp = now();
      const result = this.db.prepare(`UPDATE media_action_flows SET phase=?, worker_ticket=?, updated_at=?
        WHERE action_id=? AND phase=? AND EXISTS (
          SELECT 1 FROM actions WHERE id=? AND state='running' AND claim_token=?
        )`).run(
        to, to === "reserved" ? null : workerTicket, timestamp, actionId, from, actionId, claimToken,
      );
      if (Number(result.changes) !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "The media flow state changed.");
      this.appendAudit({
        callerId: action.callerId,
        accountId: action.accountId,
        type: `media.${to}`,
        outcome: "running",
        data: { actionId, phase: to },
      });
      return rowToMediaFlow(this.db.prepare("SELECT * FROM media_action_flows WHERE action_id=?").get(actionId) as Record<string, unknown>);
    });
  }

  beginMediaSubmission(actionId: string, workerTicket: string, claimToken: string | undefined): MediaFlowRecord {
    if (typeof workerTicket !== "string" || workerTicket.length < 1 || workerTicket.length > 128) {
      throw new ServiceError("PROTOCOL_DRIFT", "The media worker ticket is invalid.");
    }
    return this.transaction(() => {
      const record = this.getActionInternal(actionId);
      requireCurrentClaim(record, claimToken);
      const timestamp = now();
      const action = this.db.prepare(`UPDATE actions SET submit_started_at=?, updated_at=?
        WHERE id=? AND state='running' AND submit_started_at IS NULL AND claim_token=?`)
        .run(timestamp, timestamp, actionId, claimToken);
      const flow = Number(action.changes) === 1
        ? this.db.prepare("UPDATE media_action_flows SET phase='submitting', worker_ticket=?, updated_at=? WHERE action_id=? AND phase='uploaded'")
          .run(workerTicket, timestamp, actionId)
        : { changes: 0 };
      if (Number(action.changes) !== 1 || Number(flow.changes) !== 1) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "The media action is not ready for submission.");
      }
      this.appendAudit({
        callerId: record.callerId,
        accountId: record.accountId,
        type: "media.submission_started",
        outcome: "running",
        data: { actionId, phase: "submitting" },
      });
      return rowToMediaFlow(this.db.prepare("SELECT * FROM media_action_flows WHERE action_id=?").get(actionId) as Record<string, unknown>);
    });
  }

  createAction(input: { callerId: string; accountId: string; idempotencyKey: string; request: Record<string, unknown> }) {
    const requestHash = hashPayload(input.request);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM actions WHERE caller_id=? AND idempotency_key=?").get(input.callerId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        const action = rowToAction(existing);
        if (action.accountId !== input.accountId || action.requestHash !== requestHash) {
          throw new ServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different request.");
        }
        return { action, replayed: true };
      }
      const id = randomUUID();
      const timestamp = now();
      let mediaRef: string | null = null;
      if (input.request.kind === "media_post") {
        mediaRef = typeof input.request.mediaRef === "string" ? input.request.mediaRef : null;
        const media = mediaRef === null ? undefined : this.db.prepare(
          "SELECT media_ref FROM media_assets WHERE media_ref=? AND caller_id=? AND account_id=?",
        ).get(mediaRef, input.callerId, input.accountId);
        if (!media) throw new ServiceError("VALIDATION_FAILED", "mediaRef must identify Core-managed media for this caller and account.", {
          details: { field: "action.mediaRef" },
        });
      }
      this.db.prepare(`INSERT INTO actions(id, caller_id, account_id, idempotency_key, request_hash, request_json, kind, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(id, input.callerId, input.accountId, input.idempotencyKey, requestHash, canonicalJson(input.request), String(input.request.kind), timestamp, timestamp);
      if (mediaRef !== null) {
        this.db.prepare(`INSERT INTO media_action_flows(action_id, media_ref, phase, worker_ticket, updated_at)
          VALUES (?, ?, 'reserved', NULL, ?)`).run(id, mediaRef, timestamp);
      }
      this.appendAudit({ callerId: input.callerId, accountId: input.accountId, type: "action.queued", outcome: "queued", data: { actionId: id, kind: input.request.kind } });
      return { action: this.getActionInternal(id), replayed: false };
    });
  }

  findActionByIdempotency(input: { callerId: string; accountId: string; idempotencyKey: string; request: Record<string, unknown> }): InternalActionRecord | null {
    const row = this.db.prepare("SELECT * FROM actions WHERE caller_id=? AND idempotency_key=?")
      .get(input.callerId, input.idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    const action = rowToAction(row);
    if (action.accountId !== input.accountId || action.requestHash !== hashPayload(input.request)) {
      throw new ServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different request.");
    }
    return action;
  }

  getActionInternal(id: string): InternalActionRecord {
    const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Action not found.");
    return rowToAction(row);
  }

  getActionForCaller(id: string, callerId: string): ActionRecord {
    const row = this.db.prepare("SELECT * FROM actions WHERE id=? AND caller_id=?").get(id, callerId) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Action not found.");
    const { request: _request, requestHash: _hash, claimToken: _claim, attemptCount: _attempt, ...safe } = rowToAction(row);
    return safe;
  }

  claimNextAction(): InternalActionRecord | null {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM actions queued
        WHERE queued.state='queued'
          AND NOT EXISTS (
            SELECT 1 FROM actions running
            WHERE running.account_id=queued.account_id AND running.state='running'
          )
        ORDER BY queued.created_at, queued.id LIMIT 1`).get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const action = rowToAction(row);
      const claimToken = randomUUID();
      const result = this.db.prepare(`UPDATE actions
        SET state='running', claim_token=?, attempt_count=attempt_count+1, updated_at=?
        WHERE id=? AND state='queued'`).run(claimToken, now(), action.id);
      if (Number(result.changes) !== 1) return null;
      this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: "action.running", outcome: "running", data: { actionId: action.id, attempt: action.attemptCount + 1 } });
      return this.getActionInternal(action.id);
    });
  }

  markSubmissionStarted(id: string, claimToken: string | undefined) {
    requireCurrentClaim(this.getActionInternal(id), claimToken);
    const timestamp = now();
    const result = this.db.prepare(`UPDATE actions SET submit_started_at=?, updated_at=?
      WHERE id=? AND state='running' AND submit_started_at IS NULL AND claim_token=?`)
      .run(timestamp, timestamp, id, claimToken);
    if (Number(result.changes) !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "Action is not ready for submission.");
  }

  transitionAction(id: string, from: ActionState[], to: ActionState, input: { result?: unknown; error?: unknown; claimToken?: string } = {}): ActionRecord {
    return this.transaction(() => {
      const action = this.getActionInternal(id);
      if (!from.includes(action.state)) throw new ServiceError("ACTION_STATE_CONFLICT", `Action cannot move from ${action.state} to ${to}.`);
      if (action.state === "running") requireCurrentClaim(action, input.claimToken);
      const timestamp = now();
      const result = this.db.prepare(`UPDATE actions SET state=?, result_json=?, error_json=?, claim_token=NULL, updated_at=?
        WHERE id=? AND state=? AND (? IS NULL OR claim_token=?)`)
        .run(to, input.result === undefined ? null : canonicalJson(input.result), input.error === undefined ? null : canonicalJson(input.error), timestamp, id, action.state, input.claimToken ?? null, input.claimToken ?? null);
      if (Number(result.changes) !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "The action state changed concurrently.");
      this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: `action.${to}`, outcome: to, data: { actionId: id, kind: action.kind } });
      const { request: _request, requestHash: _hash, claimToken: _claim, attemptCount: _attempt, ...safe } = this.getActionInternal(id);
      return safe;
    });
  }

  recoverLiveAuthorizationUnknown(actionIds: readonly string[]): number {
    if (!Array.isArray(actionIds) || actionIds.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new ServiceError("VALIDATION_FAILED", "Recovered action identifiers are invalid.");
    }
    return this.transaction(() => {
      let recovered = 0;
      for (const id of new Set(actionIds)) {
        const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (!action || !["queued", "running"].includes(String(action.state))) continue;
        const timestamp = now();
        this.db.prepare("UPDATE actions SET state='UNKNOWN', claim_token=NULL, error_json=?, updated_at=? WHERE id=?")
          .run(canonicalJson({ code: "UNKNOWN_RESULT", message: "The live authorization stopped after a recorded action did not complete." }), timestamp, id);
        const record = rowToAction(action);
        this.appendAudit({ callerId: record.callerId, accountId: record.accountId, type: "action.UNKNOWN", outcome: "UNKNOWN", data: { actionId: id, reason: "live_authorization_restart" } });
        recovered += 1;
      }
      return recovered;
    });
  }

  recoverInterruptedActions(): { requeued: number; unknown: number } {
    return this.transaction(() => {
      const safe = this.db.prepare("SELECT id FROM actions WHERE state='running' AND submit_started_at IS NULL").all() as Array<{ id: string }>;
      const uncertain = this.db.prepare("SELECT * FROM actions WHERE state='running' AND submit_started_at IS NOT NULL").all() as Array<Record<string, unknown>>;
      this.db.prepare("UPDATE actions SET state='queued', claim_token=NULL, updated_at=? WHERE state='running' AND submit_started_at IS NULL").run(now());
      this.db.prepare(`UPDATE media_action_flows SET phase='reserved', worker_ticket=NULL, updated_at=?
        WHERE action_id IN (SELECT id FROM actions WHERE state='queued' AND submit_started_at IS NULL)`).run(now());
      this.db.prepare("UPDATE actions SET state='UNKNOWN', claim_token=NULL, error_json=?, updated_at=? WHERE state='running' AND submit_started_at IS NOT NULL")
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
    payload: { actionId: string; attempt: number; state: "succeeded" | "failed" | "action_required" | "UNKNOWN"; result?: unknown; error?: unknown };
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
      if (action.attemptCount !== input.payload.attempt) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "The adapter event belongs to a stale action attempt.");
      }
      if (!(["running", "UNKNOWN"] as ActionState[]).includes(action.state)) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "Action cannot accept this result event.");
      }
      this.db.prepare("INSERT INTO inbound_events(source, event_id, payload_hash, processed_at) VALUES (?, ?, ?, ?)")
        .run(input.source, input.eventId, payloadHash, now());
      this.db.prepare("UPDATE actions SET state=?, result_json=?, error_json=?, claim_token=NULL, updated_at=? WHERE id=?")
        .run(input.payload.state, input.payload.result === undefined ? null : canonicalJson(input.payload.result), input.payload.error === undefined ? null : canonicalJson(input.payload.error), now(), action.id);
      this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: "adapter.event.applied", outcome: input.payload.state, data: { eventId: input.eventId, source: input.source, actionId: action.id } });
      return { replayed: false, action: this.getActionInternal(action.id) };
    });
  }
}
