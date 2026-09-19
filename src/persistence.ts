import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { redactDetails, ServiceError } from "./errors.ts";
import {
  AUDIT_CHAIN_VERSION,
  AUDIT_GENESIS_MAC,
  computeAuditMac,
  requireAuditKey,
  verifyAuditChain,
  type AuditChainHead,
} from "./audit-integrity.ts";

export const ACTION_STATES = ["queued", "running", "succeeded", "failed", "action_required", "UNKNOWN", "cancelled"] as const;
export type ActionState = (typeof ACTION_STATES)[number];
export const INTERNAL_ACTION_RESULT_SOURCE = "core-action-worker";

export interface AccountRecord {
  id: string;
  platform: string;
  expectedNativeUserId: string;
  actualNativeUserId: string | null;
  label: string | null;
  status: "disconnected" | "active" | "suspended" | "revoked";
  connectionHealth: ConnectionHealth;
  actionRequiredReason: ConnectionActionRequiredReason | null;
  healthGeneration: number;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionHealth = "disconnected" | "pending_identity" | "healthy" | "action_required" | "revoked";
export type ConnectionActionRequiredReason =
  | "SESSION_EXPIRED"
  | "CHALLENGE_REQUIRED"
  | "RATE_LIMITED"
  | "SESSION_REVOKED"
  | "WRONG_IDENTITY"
  | "PROTOCOL_DRIFT";

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

export interface IdentityAuditProjection {
  id: string;
  sequence: number;
  callerId: string | null;
  type: string;
  outcome: string;
  data: Record<string, unknown>;
  occurredAt: string;
}

export interface UsageAggregate {
  tenantId: string;
  keyId: string | null;
  callerId: string | null;
  accountId: string | null;
  operationId: string | null;
  outcome: "succeeded" | "failed";
  count: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
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
  {
    version: 6,
    sql: `
      CREATE TABLE webhook_subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        url TEXT NOT NULL,
        event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json) AND json_type(event_types_json) = 'array'),
        secret_ciphertext BLOB NOT NULL,
        secret_nonce BLOB NOT NULL CHECK (length(secret_nonce) = 12),
        secret_tag BLOB NOT NULL CHECK (length(secret_tag) = 16),
        secret_generation INTEGER NOT NULL CHECK (secret_generation > 0),
        status TEXT NOT NULL CHECK (status IN ('active','disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX webhook_subscriptions_tenant_status_idx
        ON webhook_subscriptions(tenant_id, status, created_at);
      CREATE TABLE webhook_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, source_key)
      ) STRICT;
      CREATE TABLE webhook_outbox (
        event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('pending','delivered','exhausted')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT NOT NULL,
        claim_token TEXT,
        claim_expires_at TEXT,
        delivered_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (event_id, subscription_id)
      ) STRICT;
      CREATE UNIQUE INDEX webhook_outbox_claim_token_idx
        ON webhook_outbox(claim_token) WHERE claim_token IS NOT NULL;
      CREATE INDEX webhook_outbox_due_idx
        ON webhook_outbox(state, next_attempt_at, claim_expires_at);
      CREATE TABLE webhook_delivery_attempts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        attempted_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('delivered','retry_scheduled','exhausted')),
        response_status INTEGER,
        error_code TEXT,
        next_attempt_at TEXT,
        FOREIGN KEY (event_id, subscription_id) REFERENCES webhook_outbox(event_id, subscription_id) ON DELETE CASCADE,
        UNIQUE (event_id, subscription_id, attempt_number)
      ) STRICT;
      CREATE INDEX webhook_delivery_attempts_subscription_idx
        ON webhook_delivery_attempts(subscription_id, attempted_at);
      CREATE TABLE webhook_idempotency (
        tenant_id TEXT NOT NULL,
        caller_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
        secret_generation INTEGER NOT NULL CHECK (secret_generation > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, caller_id, operation_id, idempotency_key)
      ) STRICT;
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE actions ADD COLUMN cancelled_at TEXT;
      CREATE TABLE action_cancellations (
        action_id TEXT PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        caller_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        cancelled_at TEXT NOT NULL,
        UNIQUE (tenant_id, caller_id, idempotency_key)
      ) STRICT;
      CREATE TABLE usage_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        caller_id TEXT NOT NULL,
        key_id TEXT,
        account_id TEXT,
        operation_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed')),
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX usage_events_tenant_time_idx ON usage_events(tenant_id, recorded_at);
      CREATE INDEX usage_events_caller_time_idx ON usage_events(tenant_id, caller_id, recorded_at);
      CREATE INDEX usage_events_dimensions_idx ON usage_events(tenant_id, key_id, account_id, operation_id, recorded_at);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE accounts ADD COLUMN connection_health TEXT NOT NULL DEFAULT 'disconnected'
        CHECK (connection_health IN ('disconnected','pending_identity','healthy','action_required','revoked'));
      ALTER TABLE accounts ADD COLUMN action_required_reason TEXT
        CHECK (action_required_reason IS NULL OR action_required_reason IN (
          'SESSION_EXPIRED','CHALLENGE_REQUIRED','RATE_LIMITED','SESSION_REVOKED','WRONG_IDENTITY','PROTOCOL_DRIFT'
        ));
      ALTER TABLE accounts ADD COLUMN health_generation INTEGER NOT NULL DEFAULT 0 CHECK (health_generation >= 0);
      ALTER TABLE accounts ADD COLUMN last_verified_at TEXT;
      UPDATE accounts
         SET connection_health = CASE
           WHEN status = 'active' THEN 'healthy'
           WHEN status = 'revoked' THEN 'revoked'
           ELSE 'disconnected'
         END,
         action_required_reason = CASE WHEN status = 'revoked' THEN 'SESSION_REVOKED' ELSE NULL END,
         health_generation = COALESCE((SELECT generation FROM connections WHERE connections.account_id = accounts.id), 0),
         last_verified_at = CASE WHEN status = 'active' THEN updated_at ELSE NULL END;
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE audit_events ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'core';
      ALTER TABLE audit_events ADD COLUMN source_sequence INTEGER;
      ALTER TABLE audit_events ADD COLUMN previous_mac TEXT;
      ALTER TABLE audit_events ADD COLUMN event_mac TEXT;
      CREATE UNIQUE INDEX audit_identity_source_idx
        ON audit_events(source_kind, source_sequence) WHERE source_kind='identity';
      ALTER TABLE webhook_events ADD COLUMN chain_sequence INTEGER;
      ALTER TABLE webhook_events ADD COLUMN previous_mac TEXT;
      ALTER TABLE webhook_events ADD COLUMN event_mac TEXT;
      CREATE UNIQUE INDEX webhook_events_chain_sequence_idx ON webhook_events(chain_sequence);
      CREATE TABLE audit_chain_heads (
        stream TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        event_id TEXT,
        mac TEXT NOT NULL CHECK (length(mac) = 64),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE identity_audit_projection (
        identity_event_id TEXT PRIMARY KEY,
        identity_sequence INTEGER NOT NULL UNIQUE CHECK (identity_sequence > 0),
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        audit_sequence INTEGER NOT NULL UNIQUE REFERENCES audit_events(sequence) ON DELETE RESTRICT,
        projected_at TEXT NOT NULL
      ) STRICT;
    `,
  },
] as const;

const MAX_AUDIT_BYTES = 4096;

// Conservative durable-queue admission bounds. These cap only the active
// backlog (queued + running, excluding cancelled) so terminal and UNKNOWN
// evidence is never deleted or blocked by retention. Counts are evaluated
// inside the same BEGIN IMMEDIATE transaction as the insert, so concurrent
// writers serialize and cannot overshoot the bound.
export const MAX_PENDING_ACTIONS_PER_ACCOUNT = 100;
export const MAX_PENDING_ACTIONS_PER_CALLER_ACCOUNT = 50;
export const ACTION_BACKLOG_RETRY_AFTER_SECONDS = 60;

export interface ActionQueueLimits {
  maxPerAccount?: number;
  maxPerCallerAccount?: number;
}

function normalizeActionQueueLimits(input?: ActionQueueLimits): { maxPerAccount: number; maxPerCallerAccount: number } {
  const maxPerAccount = input?.maxPerAccount ?? MAX_PENDING_ACTIONS_PER_ACCOUNT;
  const maxPerCallerAccount = input?.maxPerCallerAccount ?? MAX_PENDING_ACTIONS_PER_CALLER_ACCOUNT;
  for (const [label, value] of [["maxPerAccount", maxPerAccount], ["maxPerCallerAccount", maxPerCallerAccount]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 10_000) {
      throw new ServiceError("VALIDATION_FAILED", `Action queue ${label} is invalid.`);
    }
  }
  return { maxPerAccount, maxPerCallerAccount };
}

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
    connectionHealth: (row.connection_health ?? "disconnected") as ConnectionHealth,
    actionRequiredReason: row.action_required_reason === null || row.action_required_reason === undefined
      ? null
      : row.action_required_reason as ConnectionActionRequiredReason,
    healthGeneration: Number(row.health_generation ?? 0),
    lastVerifiedAt: row.last_verified_at === null || row.last_verified_at === undefined ? null : String(row.last_verified_at),
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
    request: JSON.parse(String(row.request_json)), kind: String(row.kind),
    state: row.cancelled_at === null || row.cancelled_at === undefined ? row.state as ActionState : "cancelled",
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
  private readonly auditKey: Buffer;
  private readonly maxPendingPerAccount: number;
  private readonly maxPendingPerCallerAccount: number;

  constructor(path: string, options: { maxMigrationVersion?: number; ledgerId?: string; auditKey?: Uint8Array; actionQueueLimits?: ActionQueueLimits } = {}) {
    const queueLimits = normalizeActionQueueLimits(options.actionQueueLimits);
    this.maxPendingPerAccount = queueLimits.maxPerAccount;
    this.maxPendingPerCallerAccount = queueLimits.maxPerCallerAccount;
    this.auditKey = requireAuditKey(options.auditKey);
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
    if (this.migrationVersion() >= 9) this.initializeAuditIntegrity();
  }

  close() { this.auditKey.fill(0); this.db.close(); }

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
      actionQueueLimits: Object.freeze({
        maxPendingPerAccount: this.maxPendingPerAccount,
        maxPendingPerCallerAccount: this.maxPendingPerCallerAccount,
      }),
    });
  }

  actionQueueLimits() {
    return Object.freeze({
      maxPendingPerAccount: this.maxPendingPerAccount,
      maxPendingPerCallerAccount: this.maxPendingPerCallerAccount,
    });
  }

  pendingActionDepth(input: { accountId: string; callerId: string }): Readonly<{ perAccount: number; perCallerAccount: number }> {
    const perAccount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM actions WHERE account_id=? AND state IN ('queued','running') AND cancelled_at IS NULL",
    ).get(input.accountId) as { count: number };
    const perCallerAccount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM actions WHERE caller_id=? AND account_id=? AND state IN ('queued','running') AND cancelled_at IS NULL",
    ).get(input.callerId, input.accountId) as { count: number };
    return Object.freeze({ perAccount: Number(perAccount.count), perCallerAccount: Number(perCallerAccount.count) });
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

  private appendAudit(input: { callerId?: string | null; accountId?: string | null; type: string; outcome: string; data?: unknown; id?: string; sourceKind?: "core" | "identity"; sourceSequence?: number; occurredAt?: string }) {
    const occurredAt = input.occurredAt ?? now();
    const id = input.id ?? randomUUID();
    const dataJson = boundAuditData(input.data);
    const sourceKind = input.sourceKind ?? "core";
    const sourceSequence = input.sourceSequence ?? null;
    if (this.migrationVersion() < 9) {
      this.db.prepare(`INSERT INTO audit_events(id, caller_id, account_id, type, outcome, data_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.callerId ?? null, input.accountId ?? null, input.type, input.outcome, dataJson, occurredAt);
      return;
    }
    const head = this.chainHeadRow("ledger-audit-v1");
    const sequence = head.sequence + 1;
    const eventMac = computeAuditMac({
      key: this.auditKey,
      stream: "ledger-audit-v1",
      context: this.ledgerId,
      sequence,
      eventId: id,
      previousMac: head.mac,
      payload: { callerId: input.callerId ?? null, accountId: input.accountId ?? null, type: input.type, outcome: input.outcome, dataJson, occurredAt, sourceKind, sourceSequence },
    });
    this.db.prepare(`INSERT INTO audit_events(sequence, id, caller_id, account_id, type, outcome, data_json, occurred_at, source_kind, source_sequence, previous_mac, event_mac)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sequence, id, input.callerId ?? null, input.accountId ?? null, input.type, input.outcome, dataJson, occurredAt, sourceKind, sourceSequence, head.mac, eventMac);
    this.writeChainHead("ledger-audit-v1", sequence, id, eventMac);
  }

  audit(input: { callerId?: string | null; accountId?: string | null; type: string; outcome: string; data?: unknown }) {
    this.transaction(() => this.appendAudit(input));
  }

  projectIdentityAudit(input: IdentityAuditProjection): { replayed: boolean; auditSequence: number } {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.data === null || Array.isArray(input.data)) {
      throw new ServiceError("VALIDATION_FAILED", "Identity audit projection is invalid.");
    }
    const payloadHash = hashPayload(input);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT identity_sequence, payload_hash, audit_sequence FROM identity_audit_projection WHERE identity_event_id=?")
        .get(input.id) as { identity_sequence: number; payload_hash: string; audit_sequence: number } | undefined;
      if (existing) {
        if (Number(existing.identity_sequence) !== input.sequence || existing.payload_hash !== payloadHash) {
          throw new ServiceError("IDEMPOTENCY_CONFLICT", "Identity audit event was replayed with different content.");
        }
        return { replayed: true, auditSequence: Number(existing.audit_sequence) };
      }
      const prior = this.db.prepare("SELECT COALESCE(MAX(identity_sequence), 0) AS sequence FROM identity_audit_projection").get() as { sequence: number };
      if (input.sequence !== Number(prior.sequence) + 1) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "Identity audit projection is out of order.");
      }
      this.appendAudit({
        id: input.id,
        sourceKind: "identity",
        sourceSequence: input.sequence,
        callerId: input.callerId,
        type: input.type,
        outcome: input.outcome,
        data: input.data,
        occurredAt: input.occurredAt,
      });
      const audit = this.db.prepare("SELECT sequence FROM audit_events WHERE id=?").get(input.id) as { sequence: number };
      this.db.prepare(`INSERT INTO identity_audit_projection(identity_event_id, identity_sequence, payload_hash, audit_sequence, projected_at)
        VALUES (?, ?, ?, ?, ?)`).run(input.id, input.sequence, payloadHash, audit.sequence, now());
      return { replayed: false, auditSequence: Number(audit.sequence) };
    });
  }

  appendWebhookEvent(input: { id: string; tenantId: string; sourceKey: string; type: string; occurredAt: string; payloadJson: string; createdAt: string }) {
    const head = this.chainHeadRow("webhook-events-v1");
    const sequence = head.sequence + 1;
    const eventMac = computeAuditMac({
      key: this.auditKey,
      stream: "webhook-events-v1",
      context: this.ledgerId,
      sequence,
      eventId: input.id,
      previousMac: head.mac,
      payload: input,
    });
    this.db.prepare(`INSERT INTO webhook_events(
      id, tenant_id, source_key, type, occurred_at, payload_json, created_at, chain_sequence, previous_mac, event_mac
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.tenantId, input.sourceKey, input.type, input.occurredAt, input.payloadJson, input.createdAt, sequence, head.mac, eventMac);
    this.writeChainHead("webhook-events-v1", sequence, input.id, eventMac);
  }

  auditChainHeads(expected?: Partial<Record<"audit" | "webhooks", AuditChainHead>>): Readonly<{ audit: AuditChainHead; webhooks: AuditChainHead }> {
    return Object.freeze({
      audit: this.verifyAuditChain("ledger-audit-v1", expected?.audit),
      webhooks: this.verifyAuditChain("webhook-events-v1", expected?.webhooks),
    });
  }

  private chainHeadRow(stream: "ledger-audit-v1" | "webhook-events-v1"): { sequence: number; eventId: string | null; mac: string } {
    const row = this.db.prepare("SELECT sequence, event_id, mac FROM audit_chain_heads WHERE stream=?").get(stream) as Record<string, unknown> | undefined;
    return row
      ? { sequence: Number(row.sequence), eventId: row.event_id === null ? null : String(row.event_id), mac: String(row.mac) }
      : { sequence: 0, eventId: null, mac: AUDIT_GENESIS_MAC };
  }

  private writeChainHead(stream: "ledger-audit-v1" | "webhook-events-v1", sequence: number, eventId: string | null, mac: string) {
    this.db.prepare(`INSERT INTO audit_chain_heads(stream, sequence, event_id, mac, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(stream) DO UPDATE SET sequence=excluded.sequence, event_id=excluded.event_id, mac=excluded.mac, updated_at=excluded.updated_at`)
      .run(stream, sequence, eventId, mac, now());
  }

  private initializeAuditIntegrity() {
    this.transaction(() => {
      let previousMac = AUDIT_GENESIS_MAC;
      let sequence = 0;
      let eventId: string | null = null;
      const auditRows = this.db.prepare("SELECT * FROM audit_events ORDER BY sequence").all() as Array<Record<string, unknown>>;
      for (const row of auditRows) {
        const rowSequence = Number(row.sequence);
        if (rowSequence !== sequence + 1) throw new Error("Audit chain ledger-audit-v1 has a sequence gap");
        const payload = auditPayload(row);
        const expectedMac = computeAuditMac({
          key: this.auditKey, stream: "ledger-audit-v1", context: this.ledgerId,
          sequence: rowSequence, eventId: String(row.id), previousMac, payload,
        });
        if (row.previous_mac === null && row.event_mac === null) {
          this.db.prepare("UPDATE audit_events SET previous_mac=?, event_mac=? WHERE sequence=?")
            .run(previousMac, expectedMac, rowSequence);
        } else if (String(row.previous_mac) !== previousMac || String(row.event_mac) !== expectedMac) {
          throw new Error("Audit chain ledger-audit-v1 authentication failed during migration");
        }
        sequence = rowSequence;
        eventId = String(row.id);
        previousMac = expectedMac;
      }
      this.writeChainHead("ledger-audit-v1", sequence, eventId, previousMac);

      previousMac = AUDIT_GENESIS_MAC;
      sequence = 0;
      eventId = null;
      const webhookRows = this.db.prepare("SELECT rowid AS legacy_rowid, * FROM webhook_events ORDER BY COALESCE(chain_sequence, rowid), rowid").all() as Array<Record<string, unknown>>;
      for (const row of webhookRows) {
        const rowSequence = sequence + 1;
        const payload = webhookPayload(row);
        const expectedMac = computeAuditMac({
          key: this.auditKey, stream: "webhook-events-v1", context: this.ledgerId,
          sequence: rowSequence, eventId: String(row.id), previousMac, payload,
        });
        if (row.chain_sequence === null && row.previous_mac === null && row.event_mac === null) {
          this.db.prepare("UPDATE webhook_events SET chain_sequence=?, previous_mac=?, event_mac=? WHERE id=?")
            .run(rowSequence, previousMac, expectedMac, String(row.id));
        } else if (Number(row.chain_sequence) !== rowSequence || String(row.previous_mac) !== previousMac || String(row.event_mac) !== expectedMac) {
          throw new Error("Audit chain webhook-events-v1 authentication failed during migration");
        }
        sequence = rowSequence;
        eventId = String(row.id);
        previousMac = expectedMac;
      }
      this.writeChainHead("webhook-events-v1", sequence, eventId, previousMac);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS webhook_events_no_update BEFORE UPDATE ON webhook_events BEGIN SELECT RAISE(ABORT, 'webhook events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS webhook_events_no_delete BEFORE DELETE ON webhook_events BEGIN SELECT RAISE(ABORT, 'webhook events are append-only'); END;
      `);
    });
    this.auditChainHeads();
  }

  private verifyAuditChain(stream: "ledger-audit-v1" | "webhook-events-v1", expected?: AuditChainHead): AuditChainHead {
    const rows = stream === "ledger-audit-v1"
      ? this.db.prepare("SELECT * FROM audit_events ORDER BY sequence").all() as Array<Record<string, unknown>>
      : this.db.prepare("SELECT * FROM webhook_events ORDER BY chain_sequence").all() as Array<Record<string, unknown>>;
    const stored = this.chainHeadRow(stream);
    return verifyAuditChain({
      key: this.auditKey,
      stream,
      context: this.ledgerId,
      entries: rows.map((row) => ({
        sequence: Number(stream === "ledger-audit-v1" ? row.sequence : row.chain_sequence),
        eventId: String(row.id),
        previousMac: String(row.previous_mac),
        eventMac: String(row.event_mac),
        payload: stream === "ledger-audit-v1" ? auditPayload(row) : webhookPayload(row),
      })),
      storedHead: {
        version: AUDIT_CHAIN_VERSION,
        stream,
        context: this.ledgerId,
        sequence: stored.sequence,
        eventId: stored.eventId,
        mac: stored.mac,
      },
      ...(expected ? { expectedHead: expected } : {}),
    });
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
      const account = this.getAccount(input.accountId);
      if (account.actionRequiredReason !== null && input.generation <= account.healthGeneration) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "Only a verified newer session generation can clear the account action requirement.");
      }
      this.db.prepare(`UPDATE accounts
        SET actual_native_user_id=?, status='active', connection_health='healthy',
            action_required_reason=NULL, health_generation=?, last_verified_at=?, updated_at=?
        WHERE id=?`)
        .run(input.actualNativeUserId, input.generation, timestamp, timestamp, input.accountId);
      if (account.connectionHealth !== "healthy" || account.actionRequiredReason !== null || account.healthGeneration !== input.generation) {
        this.appendAudit({
          callerId: input.callerId,
          accountId: input.accountId,
          type: "connection.health.changed",
          outcome: "succeeded",
          data: { generation: input.generation, from: account.connectionHealth, to: "healthy", reason: null },
        });
      }
      this.appendAudit({ callerId: input.callerId, accountId: input.accountId, type: input.auditType ?? "connection.imported", outcome: "succeeded", data: { generation: input.generation } });
      return this.getConnection(input.accountId);
    });
  }

  markConnectionActionRequired(input: {
    accountId: string;
    generation: number;
    reason: ConnectionActionRequiredReason;
    callerId: string;
  }): AccountRecord {
    return this.transaction(() => {
      const account = this.getAccount(input.accountId);
      if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
        throw new ServiceError("VALIDATION_FAILED", "Connection health generation is invalid.");
      }
      if (input.generation < account.healthGeneration) return account;
      const health: ConnectionHealth = input.reason === "SESSION_REVOKED" ? "revoked" : "action_required";
      const status: AccountRecord["status"] = health === "revoked" ? "revoked" : "suspended";
      const changed = account.connectionHealth !== health
        || account.actionRequiredReason !== input.reason
        || account.healthGeneration !== input.generation;
      if (!changed) return account;
      const timestamp = now();
      this.db.prepare(`UPDATE accounts
        SET status=?, connection_health=?, action_required_reason=?, health_generation=?, updated_at=?
        WHERE id=?`)
        .run(status, health, input.reason, input.generation, timestamp, input.accountId);
      this.appendAudit({
        callerId: input.callerId,
        accountId: input.accountId,
        type: "connection.health.changed",
        outcome: "action_required",
        data: { generation: input.generation, from: account.connectionHealth, to: health, reason: input.reason },
      });
      return this.getAccount(input.accountId);
    });
  }

  markConnectionPending(input: { accountId: string; generation: number; callerId: string }): AccountRecord {
    return this.transaction(() => {
      const account = this.getAccount(input.accountId);
      if (!Number.isSafeInteger(input.generation) || input.generation <= account.healthGeneration) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "A pending connection must use a newer generation.");
      }
      const timestamp = now();
      this.db.prepare(`UPDATE accounts
        SET status='suspended', connection_health='pending_identity', updated_at=?
        WHERE id=?`)
        .run(timestamp, input.accountId);
      this.appendAudit({
        callerId: input.callerId,
        accountId: input.accountId,
        type: "connection.health.changed",
        outcome: "pending",
        data: { generation: input.generation, from: account.connectionHealth, to: "pending_identity", reason: account.actionRequiredReason },
      });
      return this.getAccount(input.accountId);
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
      const account = this.getAccount(input.accountId);
      const connection = this.getConnectionInternal(input.accountId);
      this.db.prepare(`UPDATE accounts
        SET status='revoked', connection_health='revoked', action_required_reason='SESSION_REVOKED',
            health_generation=?, updated_at=? WHERE id=?`)
        .run(connection.generation, timestamp, input.accountId);
      if (account.connectionHealth !== "revoked" || account.actionRequiredReason !== "SESSION_REVOKED") {
        this.appendAudit({
          callerId: input.callerId,
          accountId: input.accountId,
          type: "connection.health.changed",
          outcome: "action_required",
          data: { generation: connection.generation, from: account.connectionHealth, to: "revoked", reason: "SESSION_REVOKED" },
        });
      }
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
    if (!isMediaActionKind(action.kind)) throw new ServiceError("ACTION_STATE_CONFLICT", "The action does not use Core media.");
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
      // Race-safe admission: BEGIN IMMEDIATE serializes writers, so the
      // counts below and the insert that follows are atomic. Only the active
      // backlog (queued + running, excluding cancelled) is bounded; terminal
      // and UNKNOWN rows remain as evidence and never count against admission.
      const perAccount = (this.db.prepare(
        "SELECT COUNT(*) AS count FROM actions WHERE account_id=? AND state IN ('queued','running') AND cancelled_at IS NULL",
      ).get(input.accountId) as { count: number }).count;
      if (Number(perAccount) >= this.maxPendingPerAccount) {
        throw new ServiceError("RATE_LIMITED", "The account action backlog is full; retry after the queue drains.", {
          retryable: true,
          rateLimit: { limit: this.maxPendingPerAccount, remaining: 0, retryAfterSeconds: ACTION_BACKLOG_RETRY_AFTER_SECONDS },
        });
      }
      const perCallerAccount = (this.db.prepare(
        "SELECT COUNT(*) AS count FROM actions WHERE caller_id=? AND account_id=? AND state IN ('queued','running') AND cancelled_at IS NULL",
      ).get(input.callerId, input.accountId) as { count: number }).count;
      if (Number(perCallerAccount) >= this.maxPendingPerCallerAccount) {
        throw new ServiceError("RATE_LIMITED", "The caller action backlog for this account is full; retry after the queue drains.", {
          retryable: true,
          rateLimit: { limit: this.maxPendingPerCallerAccount, remaining: 0, retryAfterSeconds: ACTION_BACKLOG_RETRY_AFTER_SECONDS },
        });
      }
      const id = randomUUID();
      const timestamp = now();
      let mediaRef: string | null = null;
      if (isMediaActionKind(String(input.request.kind))) {
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

  listActions(options: {
    callerId?: string;
    accountId?: string;
    state?: ActionState;
    kind?: string;
    cursor?: string;
    limit?: number;
  } = {}) {
    const after = decodeCursor(options.cursor);
    const limitValue = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const clauses = ["rowid > ?"];
    const parameters: Array<string | number> = [after];
    if (options.callerId) { clauses.push("caller_id = ?"); parameters.push(options.callerId); }
    if (options.accountId) { clauses.push("account_id = ?"); parameters.push(options.accountId); }
    if (options.state === "cancelled") clauses.push("cancelled_at IS NOT NULL");
    else if (options.state) { clauses.push("state = ?", "cancelled_at IS NULL"); parameters.push(options.state); }
    if (options.kind) { clauses.push("kind = ?"); parameters.push(options.kind); }
    const rows = this.db.prepare(`SELECT rowid AS sequence, * FROM actions WHERE ${clauses.join(" AND ")} ORDER BY rowid LIMIT ?`)
      .all(...parameters, limitValue + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limitValue;
    const page = rows.slice(0, limitValue);
    return {
      items: page.map((row) => {
        const { request: _request, requestHash: _hash, claimToken: _claim, attemptCount: _attempt, ...safe } = rowToAction(row);
        return safe;
      }),
      nextCursor: hasMore ? encodeCursor(Number(page.at(-1)?.sequence)) : null,
    };
  }

  cancelQueuedAction(input: { tenantId: string; callerId: string; actionId: string; idempotencyKey: string }) {
    return this.transaction(() => {
      const prior = this.db.prepare(`SELECT action_id FROM action_cancellations
        WHERE tenant_id=? AND caller_id=? AND idempotency_key=?`).get(
        input.tenantId, input.callerId, input.idempotencyKey,
      ) as { action_id: string } | undefined;
      if (prior) {
        if (prior.action_id !== input.actionId) throw new ServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for another cancellation.");
        return { action: this.getActionForCaller(input.actionId, input.callerId), replayed: true };
      }
      const action = this.getActionForCaller(input.actionId, input.callerId);
      if (action.state !== "queued" || action.submissionMayHaveStarted) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "Only an unclaimed queued action can be cancelled.");
      }
      const timestamp = now();
      const changed = this.db.prepare(`UPDATE actions SET cancelled_at=?, updated_at=?
        WHERE id=? AND caller_id=? AND state='queued' AND claim_token IS NULL
          AND submit_started_at IS NULL AND cancelled_at IS NULL`).run(
        timestamp, timestamp, input.actionId, input.callerId,
      );
      if (Number(changed.changes) !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "The action was claimed before cancellation completed.");
      this.db.prepare(`INSERT INTO action_cancellations(action_id, tenant_id, caller_id, idempotency_key, cancelled_at)
        VALUES (?, ?, ?, ?, ?)`).run(input.actionId, input.tenantId, input.callerId, input.idempotencyKey, timestamp);
      this.appendAudit({ callerId: input.callerId, accountId: action.accountId, type: "action.cancelled", outcome: "cancelled", data: { actionId: action.id, kind: action.kind } });
      return { action: this.getActionForCaller(input.actionId, input.callerId), replayed: false };
    });
  }

  claimNextAction(): InternalActionRecord | null {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM actions queued
        WHERE queued.state='queued' AND queued.cancelled_at IS NULL
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

  listAuditEvents(options: { accountId?: string; callerId?: string; cursor?: string; limit?: number } = {}) {
    const after = decodeCursor(options.cursor);
    const limitValue = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const clauses = ["sequence>?"];
    const parameters: Array<string | number> = [after];
    if (options.accountId !== undefined) { clauses.push("account_id=?"); parameters.push(options.accountId); }
    if (options.callerId !== undefined) { clauses.push("caller_id=?"); parameters.push(options.callerId); }
    const rows = this.db.prepare(`SELECT * FROM audit_events WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`).all(...parameters, limitValue + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limitValue;
    const page = rows.slice(0, limitValue);
    const items: AuditEvent[] = page.map((row) => ({
      id: String(row.id), sequence: Number(row.sequence), callerId: row.caller_id === null ? null : String(row.caller_id),
      accountId: row.account_id === null ? null : String(row.account_id), type: String(row.type), outcome: String(row.outcome),
      data: JSON.parse(String(row.data_json)), occurredAt: String(row.occurred_at),
    }));
    return { items, nextCursor: hasMore ? encodeCursor(items.at(-1)!.sequence) : null };
  }

  recordUsage(input: {
    tenantId: string;
    callerId: string;
    accountId?: string;
    operationId: string;
    outcome: "succeeded" | "failed";
    retentionDays?: number;
  }) {
    const timestamp = now();
    const retentionDays = Math.min(Math.max(input.retentionDays ?? 90, 1), 365);
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const keyId = input.callerId.startsWith("api-key:") ? input.callerId.slice("api-key:".length) : null;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO usage_events(tenant_id, caller_id, key_id, account_id, operation_id, outcome, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        input.tenantId, input.callerId, keyId, input.accountId ?? null, input.operationId, input.outcome, timestamp,
      );
      this.db.prepare("DELETE FROM usage_events WHERE tenant_id=? AND recorded_at<?").run(input.tenantId, cutoff);
    });
  }

  usageAggregates(options: {
    tenantId: string;
    callerId?: string;
    accountId?: string;
    operationId?: string;
    since?: string;
    until?: string;
    groupBy?: readonly ("tenant" | "key" | "account" | "operation")[];
    limit?: number;
  }): { items: UsageAggregate[]; retentionDays: number } {
    const groups = [...new Set(options.groupBy ?? ["operation"])] as Array<"tenant" | "key" | "account" | "operation">;
    const selected: string[] = ["outcome"];
    const groupColumns: string[] = ["outcome"];
    const map = { tenant: "tenant_id", key: "key_id", account: "account_id", operation: "operation_id" } as const;
    for (const group of groups) { selected.push(map[group]); groupColumns.push(map[group]); }
    const clauses = ["tenant_id=?"];
    const parameters: Array<string | number> = [options.tenantId];
    if (options.callerId) { clauses.push("caller_id=?"); parameters.push(options.callerId); }
    if (options.accountId) { clauses.push("account_id=?"); parameters.push(options.accountId); }
    if (options.operationId) { clauses.push("operation_id=?"); parameters.push(options.operationId); }
    if (options.since) { clauses.push("recorded_at>=?"); parameters.push(options.since); }
    if (options.until) { clauses.push("recorded_at<=?"); parameters.push(options.until); }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    const rows = this.db.prepare(`SELECT ${selected.join(", ")}, COUNT(*) AS count,
      MIN(recorded_at) AS first_recorded_at, MAX(recorded_at) AS last_recorded_at
      FROM usage_events WHERE ${clauses.join(" AND ")}
      GROUP BY ${groupColumns.join(", ")} ORDER BY count DESC, last_recorded_at DESC LIMIT ?`)
      .all(...parameters, limit) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({
        tenantId: groups.includes("tenant") ? String(row.tenant_id) : options.tenantId,
        keyId: groups.includes("key") && row.key_id !== null ? String(row.key_id) : null,
        callerId: options.callerId ?? null,
        accountId: groups.includes("account") && row.account_id !== null ? String(row.account_id) : null,
        operationId: groups.includes("operation") ? String(row.operation_id) : null,
        outcome: row.outcome as "succeeded" | "failed",
        count: Number(row.count),
        firstRecordedAt: String(row.first_recorded_at),
        lastRecordedAt: String(row.last_recorded_at),
      })),
      retentionDays: 90,
    };
  }

  applyActionResultEvent(input: {
    callerId: string;
    source: string;
    eventId: string;
    accountId: string;
    payload: { actionId: string; attempt: number; claimToken: string; state: "succeeded" | "failed" | "action_required" | "UNKNOWN"; result?: unknown; error?: unknown };
  }) {
    const payloadHash = hashPayload(input);
    return this.transaction(() => {
      const action = this.getActionInternal(input.payload.actionId);
      if (action.callerId !== input.callerId) throw new ServiceError("NOT_FOUND", "Action not found.");
      if (action.accountId !== input.accountId) throw new ServiceError("ACTION_STATE_CONFLICT", "The adapter event does not match the current action claim.");
      if (input.source !== INTERNAL_ACTION_RESULT_SOURCE || action.attemptCount !== input.payload.attempt) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "The adapter event does not match the current action claim.");
      }
      const existing = this.db.prepare("SELECT payload_hash FROM inbound_events WHERE source=? AND event_id=?").get(input.source, input.eventId) as { payload_hash: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new ServiceError("IDEMPOTENCY_CONFLICT", "The event ID was replayed with different content.");
        return { replayed: true, action };
      }
      if (action.state !== "running" || action.claimToken !== input.payload.claimToken) {
        throw new ServiceError("ACTION_STATE_CONFLICT", "The adapter event does not match the current action claim.");
      }
      this.db.prepare("INSERT INTO inbound_events(source, event_id, payload_hash, processed_at) VALUES (?, ?, ?, ?)")
        .run(input.source, input.eventId, payloadHash, now());
      const updated = this.db.prepare(`UPDATE actions SET state=?, result_json=?, error_json=?, claim_token=NULL, updated_at=?
        WHERE id=? AND caller_id=? AND account_id=? AND state='running' AND attempt_count=? AND claim_token=?`)
        .run(
          input.payload.state,
          input.payload.result === undefined ? null : canonicalJson(input.payload.result),
          input.payload.error === undefined ? null : canonicalJson(input.payload.error),
          now(),
          action.id,
          input.callerId,
          input.accountId,
          input.payload.attempt,
          input.payload.claimToken,
        );
      if (Number(updated.changes) !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "The adapter event does not match the current action claim.");
      this.appendAudit({ callerId: action.callerId, accountId: action.accountId, type: "adapter.event.applied", outcome: input.payload.state, data: { eventId: input.eventId, source: input.source, actionId: action.id } });
      return { replayed: false, action: this.getActionInternal(action.id) };
    });
  }
}

function isMediaActionKind(kind: string) { return kind === "media_post" || kind === "x_media_post"; }

function auditPayload(row: Record<string, unknown>) {
  return {
    callerId: row.caller_id === null ? null : String(row.caller_id),
    accountId: row.account_id === null ? null : String(row.account_id),
    type: String(row.type),
    outcome: String(row.outcome),
    dataJson: String(row.data_json),
    occurredAt: String(row.occurred_at),
    sourceKind: String(row.source_kind ?? "core"),
    sourceSequence: row.source_sequence === null || row.source_sequence === undefined ? null : Number(row.source_sequence),
  };
}

function webhookPayload(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    sourceKey: String(row.source_key),
    type: String(row.type),
    occurredAt: String(row.occurred_at),
    payloadJson: String(row.payload_json),
    createdAt: String(row.created_at),
  };
}
