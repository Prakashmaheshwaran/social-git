import { randomUUID as secureRandomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { threadId } from "node:worker_threads";
import { AuditLedger } from "./audit.js";
import { MAX_BACKUP_RETENTION_MS, createEncryptedBackupFile } from "./backup.js";
import { SessionEnvelopeCrypto } from "./crypto.js";
import { SessionRuntimeError, requireValue, runtimeError } from "./errors.js";
import {
  MAX_NETWORK_ROUTE_BYTES,
  MAX_SESSION_BYTES,
  decodeWorkerMessage,
  encodeWorkerMessage
} from "./worker-contract.js";

const MIGRATIONS = [
  readFileSync(
  new URL("../migrations/001_session_runtime.sql", import.meta.url),
  "utf8"
  ),
  readFileSync(
    new URL("../migrations/002_security_storage.sql", import.meta.url),
    "utf8"
  )
];
const SCHEMA_VERSION = 2;
const MAX_LEASE_TTL_MS = 5 * 60 * 1000;
const VALID_INTENTS = new Set(["identity_validation", "refresh", "read", "write"]);

function validText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validateGeneration(generation) {
  requireValue(Number.isSafeInteger(generation) && generation > 0);
}

function validateImport(input) {
  requireValue(input !== null && typeof input === "object");
  requireValue(validText(input.accountId, 128));
  requireValue(validText(input.platform, 64));
  requireValue(validText(input.expectedNativeIdentity, 256));
  validateGeneration(input.generation);
  requireValue(input.session instanceof Uint8Array
    && input.session.byteLength > 0
    && input.session.byteLength <= MAX_SESSION_BYTES);
  requireValue(input.networkRoute !== null && typeof input.networkRoute === "object");
  requireValue(validText(input.networkRoute.id, 128));
  requireValue(input.networkRoute.material instanceof Uint8Array
    && input.networkRoute.material.byteLength > 0
    && input.networkRoute.material.byteLength <= MAX_NETWORK_ROUTE_BYTES);
}

function toAccountState(row) {
  if (row === undefined) return undefined;
  return Object.freeze({
    tenantId: row.tenant_id,
    accountId: row.account_id,
    platform: row.platform,
    expectedNativeIdentity: row.expected_native_identity,
    generation: row.generation,
    revokedThroughGeneration: row.revoked_through_generation,
    health: row.health_status,
    refresh: row.refresh_state,
    networkRouteId: row.route_id ?? null,
    activeLease: row.active_lease_id === null
      ? null
      : Object.freeze({
        leaseId: row.active_lease_id,
        fence: row.active_lease_fence,
        expiresAt: row.active_lease_expires_at
      }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at ?? null
  });
}

function preserveRuntimeError(error) {
  if (error instanceof SessionRuntimeError) throw error;
  throw runtimeError("STORAGE_FAILURE", error);
}

class CoreStore {
  #database;
  #databasePath;
  #tenantId;
  #ownerPid = process.pid;
  #ownerThreadId = threadId;
  #closed = false;

  constructor(databasePath, now, tenantId) {
    requireValue(validText(databasePath, 4096) && databasePath !== ":memory:");
    requireValue(validText(tenantId, 128));
    this.#tenantId = tenantId;
    this.#databasePath = databasePath;
    try {
      chmodSync(dirname(databasePath), 0o700);
      const descriptor = openSync(databasePath, "a", 0o600);
      closeSync(descriptor);
      chmodSync(databasePath, 0o600);
      this.#database = new DatabaseSync(databasePath, {
        open: true,
        readOnly: false,
        enableForeignKeyConstraints: true,
        timeout: 5000
      });
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#enforcePrivateFiles();
      this.#database.exec("PRAGMA synchronous = FULL");
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      this.#database.exec("PRAGMA temp_store = MEMORY");
      this.#database.exec("PRAGMA secure_delete = ON");
      this.#database.exec(MIGRATIONS[0]);
      this.#upgradeLegacyTenantColumns();
      this.#database.exec(MIGRATIONS[1]);
      this.transaction(() => {
        const metadata = this.#database.prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'tenant_id'"
        ).get();
        if (metadata === undefined) {
          const foreignTenant = this.#database.prepare(
            "SELECT 1 AS present FROM accounts WHERE tenant_id <> ? LIMIT 1"
          ).get(tenantId);
          if (foreignTenant !== undefined) throw runtimeError("TENANT_MISMATCH");
          this.#database.prepare(
            "INSERT INTO runtime_metadata(key, value) VALUES ('tenant_id', ?)"
          ).run(tenantId);
        } else if (metadata.value !== tenantId) {
          throw runtimeError("TENANT_MISMATCH");
        }
      });
      this.#database.enableDefensive(true);
      this.#enforcePrivateFiles();
    } catch (error) {
      try {
        this.#database?.close();
      } catch {
        // The original sanitized storage failure is more useful.
      }
      preserveRuntimeError(error);
    }
  }

  #enforcePrivateFiles() {
    for (const path of [
      this.#databasePath,
      `${this.#databasePath}-wal`,
      `${this.#databasePath}-shm`
    ]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  #upgradeLegacyTenantColumns() {
    const accountColumns = new Set(
      this.#database.prepare("PRAGMA table_info(accounts)").all().map((row) => row.name)
    );
    if (!accountColumns.has("tenant_id")) {
      this.#database.exec("ALTER TABLE accounts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'");
    }
    const leaseColumns = new Set(
      this.#database.prepare("PRAGMA table_info(worker_leases)").all().map((row) => row.name)
    );
    if (!leaseColumns.has("tenant_id")) {
      this.#database.exec(
        "ALTER TABLE worker_leases ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'"
      );
    }
  }

  assertOwner() {
    if (this.#closed || process.pid !== this.#ownerPid || threadId !== this.#ownerThreadId) {
      throw runtimeError("OWNERSHIP_VIOLATION");
    }
  }

  transaction(operation) {
    this.assertOwner();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      this.#enforcePrivateFiles();
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure and never expose database text.
      }
      this.#enforcePrivateFiles();
      throw error;
    }
  }

  getAccount(accountId) {
    this.assertOwner();
    return this.#database.prepare(
      "SELECT * FROM accounts WHERE tenant_id = ? AND account_id = ?"
    ).get(this.#tenantId, accountId);
  }

  getLease(leaseId) {
    this.assertOwner();
    return this.#database.prepare(
      "SELECT * FROM worker_leases WHERE tenant_id = ? AND lease_id = ?"
    ).get(this.#tenantId, leaseId);
  }

  getLeaseByRequest(requestId) {
    this.assertOwner();
    return this.#database.prepare(
      "SELECT * FROM worker_leases WHERE tenant_id = ? AND request_id = ?"
    ).get(this.#tenantId, requestId);
  }

  run(sql, ...values) {
    this.assertOwner();
    return this.#database.prepare(sql).run(...values);
  }

  all(sql, ...values) {
    this.assertOwner();
    return this.#database.prepare(sql).all(...values);
  }

  getAuditHead(tenantId) {
    this.assertOwner();
    if (tenantId !== this.#tenantId) throw runtimeError("TENANT_MISMATCH");
    return this.#database.prepare(`
      SELECT * FROM audit_events
       WHERE tenant_id = ?
       ORDER BY sequence DESC
       LIMIT 1
    `).get(tenantId);
  }

  getAuditEvents(tenantId) {
    this.assertOwner();
    if (tenantId !== this.#tenantId) throw runtimeError("TENANT_MISMATCH");
    return this.#database.prepare(`
      SELECT * FROM audit_events
       WHERE tenant_id = ?
       ORDER BY sequence ASC
    `).all(tenantId);
  }

  insertAuditEvent(event) {
    this.assertOwner();
    if (event.tenantId !== this.#tenantId) throw runtimeError("TENANT_MISMATCH");
    this.#database.prepare(`
      INSERT INTO audit_events (
        sequence, tenant_id, event_type, account_id, generation,
        occurred_at, details_json, previous_mac, event_mac
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sequence,
      event.tenantId,
      event.eventType,
      event.accountId,
      event.generation,
      event.occurredAt,
      event.detailsJson,
      event.previousMac,
      event.eventMac
    );
  }

  getEncryptedAccounts() {
    this.assertOwner();
    return this.#database.prepare(`
      SELECT account_id, tenant_id, platform, generation,
             session_envelope, route_envelope
        FROM accounts
       WHERE tenant_id = ?
         AND session_envelope IS NOT NULL
         AND route_envelope IS NOT NULL
       ORDER BY account_id
    `).all(this.#tenantId);
  }

  getActiveLeases({ expiresAt = undefined } = {}) {
    this.assertOwner();
    if (expiresAt === undefined) {
      return this.#database.prepare(`
        SELECT * FROM worker_leases
         WHERE tenant_id = ? AND state = 'active'
         ORDER BY lease_id
      `).all(this.#tenantId);
    }
    return this.#database.prepare(`
      SELECT * FROM worker_leases
       WHERE tenant_id = ? AND state = 'active' AND expires_at <= ?
       ORDER BY lease_id
    `).all(this.#tenantId, expiresAt);
  }

  snapshot() {
    return this.transaction(() => Buffer.from(this.#database.serialize()));
  }

  checkpoint() {
    this.assertOwner();
    const row = this.#database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    this.#enforcePrivateFiles();
    return Object.freeze({
      busy: Number(row.busy ?? 0),
      logFrames: Number(row.log ?? 0),
      checkpointedFrames: Number(row.checkpointed ?? 0)
    });
  }

  journalMode() {
    this.assertOwner();
    return this.#database.prepare("PRAGMA journal_mode").get().journal_mode;
  }

  schemaVersion() {
    this.assertOwner();
    return this.#database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
  }

  close() {
    if (this.#closed) return;
    this.assertOwner();
    this.#enforcePrivateFiles();
    this.#database.close();
    this.#closed = true;
  }
}

export class SessionRuntime {
  #store;
  #crypto;
  #audit;
  #tenantId;
  #now;
  #randomUUID;
  #randomBytes;
  #claimedBackupNonces = new Set();
  #closed = false;

  constructor({
    databasePath,
    tenantId = "default",
    masterKey,
    auditKey,
    now = Date.now,
    randomUUID = secureRandomUUID,
    randomBytes
  }) {
    requireValue(validText(tenantId, 128));
    requireValue(auditKey instanceof Uint8Array && auditKey.byteLength === 32);
    requireValue(typeof now === "function");
    requireValue(typeof randomUUID === "function");
    requireValue(randomBytes === undefined || typeof randomBytes === "function");
    this.#tenantId = tenantId;
    this.#now = now;
    this.#randomUUID = randomUUID;
    this.#randomBytes = randomBytes;
    this.#crypto = new SessionEnvelopeCrypto({ masterKey, randomBytes });
    try {
      const startedAt = this.#timestamp();
      this.#store = new CoreStore(databasePath, startedAt, tenantId);
      this.#audit = new AuditLedger({
        auditKey,
        anchorPath: `${databasePath}.audit-anchor`,
        store: this.#store,
        tenantId
      });
      this.#audit.verify({ initializeEmpty: true });
      this.#recoverInterruptedOnStartup(startedAt);
    } catch (error) {
      try {
        this.#audit?.close();
        this.#store?.close();
      } catch {
        // Preserve the original sanitized initialization failure.
      }
      this.#crypto.close();
      throw error;
    }
  }

  #binding(row, purpose, generation = row.generation) {
    return {
      tenantId: this.#tenantId,
      accountId: row.account_id,
      platform: row.platform,
      purpose,
      schemaVersion: SCHEMA_VERSION,
      generation
    };
  }

  #recoverInterruptedOnStartup(now) {
    const interrupted = this.#store.getActiveLeases();
    if (interrupted.length === 0) return;
    this.#transaction(() => {
      this.#store.run(`
        UPDATE accounts
           SET active_lease_id = NULL,
               active_lease_fence = NULL,
               active_lease_expires_at = NULL,
               refresh_state = CASE
                 WHEN EXISTS (
                   SELECT 1
                     FROM worker_leases
                    WHERE lease_id = accounts.active_lease_id
                      AND tenant_id = ?
                      AND state = 'active'
                      AND intent = 'write'
                 ) THEN 'failed'
                 WHEN refresh_state = 'in_progress' THEN 'required'
                 ELSE refresh_state
               END,
               health_status = CASE
                 WHEN EXISTS (
                   SELECT 1
                     FROM worker_leases
                    WHERE lease_id = accounts.active_lease_id
                      AND tenant_id = ?
                      AND state = 'active'
                      AND intent = 'write'
                 ) THEN 'unknown'
                 ELSE health_status
               END,
               updated_at = ?
         WHERE tenant_id = ? AND active_lease_id IS NOT NULL
      `, this.#tenantId, this.#tenantId, now, this.#tenantId);
      this.#store.run(`
        UPDATE worker_leases
           SET state = 'abandoned', completed_at = ?,
               result_status = CASE
                 WHEN intent = 'write' THEN 'UNKNOWN'
                 ELSE result_status
               END
         WHERE tenant_id = ? AND state = 'active'
      `, now, this.#tenantId);
      for (const lease of interrupted) {
        this.#audit.append({
          eventType: "worker.interrupted",
          accountId: lease.account_id,
          generation: lease.generation,
          occurredAt: now,
          details: {
            reason: "startup_recovery",
            resultStatus: lease.intent === "write" ? "UNKNOWN" : null
          }
        });
      }
    });
  }

  #assertOpen() {
    if (this.#closed) throw runtimeError("OWNERSHIP_VIOLATION");
    this.#store.assertOwner();
  }

  #transaction(operation) {
    const result = this.#store.transaction(operation);
    this.#audit.persistAnchor();
    return result;
  }

  #timestamp() {
    const value = this.#now();
    requireValue(Number.isSafeInteger(value) && value >= 0);
    return value;
  }

  #accountOrThrow(accountId) {
    const row = this.#store.getAccount(accountId);
    if (row === undefined) throw runtimeError("NOT_FOUND");
    return row;
  }

  #assertGeneration(row, generation) {
    validateGeneration(generation);
    if (generation <= row.revoked_through_generation || row.health_status === "revoked") {
      throw runtimeError("REVOKED");
    }
    if (generation !== row.generation) throw runtimeError("STALE_GENERATION");
  }

  importExternalSession(input) {
    this.#assertOpen();
    validateImport(input);
    const now = this.#timestamp();
    const sessionCopy = Buffer.from(input.session);
    const routeCopy = Buffer.from(input.networkRoute.material);
    const sessionBinding = {
      tenantId: this.#tenantId,
      accountId: input.accountId,
      platform: input.platform,
      purpose: "session",
      schemaVersion: SCHEMA_VERSION,
      generation: input.generation
    };
    const routeBinding = { ...sessionBinding, purpose: "network-route" };
    let sessionEnvelope;
    let routeEnvelope;

    try {
      sessionEnvelope = this.#crypto.seal(sessionCopy, sessionBinding);
      routeEnvelope = this.#crypto.seal(routeCopy, routeBinding);
      return this.#transaction(() => {
        const existing = this.#store.getAccount(input.accountId);
        if (existing === undefined) {
          if (input.generation !== 1) throw runtimeError("STALE_GENERATION");
          this.#store.run(`
            INSERT INTO accounts (
              account_id, tenant_id, platform, expected_native_identity, generation,
              revoked_through_generation, session_envelope, route_id, route_envelope,
              health_status, refresh_state, next_fence, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending_identity', 'idle', 1, ?, ?)
          `,
          input.accountId,
          this.#tenantId,
          input.platform,
          input.expectedNativeIdentity,
          input.generation,
          sessionEnvelope,
          input.networkRoute.id,
          routeEnvelope,
          now,
          now);
        } else {
          if (existing.platform !== input.platform) throw runtimeError("WRONG_ACCOUNT");
          if (existing.expected_native_identity !== input.expectedNativeIdentity) {
            throw runtimeError("WRONG_IDENTITY");
          }
          const nextGeneration = Math.max(
            existing.generation,
            existing.revoked_through_generation
          ) + 1;
          if (input.generation !== nextGeneration) throw runtimeError("STALE_GENERATION");
          this.#store.run(`
            UPDATE worker_leases
               SET state = 'superseded', completed_at = ?,
                   result_status = CASE
                     WHEN intent = 'write' THEN 'UNKNOWN'
                     ELSE result_status
                   END
             WHERE tenant_id = ? AND account_id = ? AND state = 'active'
          `, now, this.#tenantId, input.accountId);
          this.#store.run(`
            UPDATE accounts
               SET generation = ?, session_envelope = ?, route_id = ?, route_envelope = ?,
                   health_status = 'pending_identity', refresh_state = 'idle',
                   active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL, updated_at = ?, last_validated_at = NULL
             WHERE tenant_id = ? AND account_id = ?
          `,
          input.generation,
          sessionEnvelope,
          input.networkRoute.id,
          routeEnvelope,
          now,
          this.#tenantId,
          input.accountId);
        }
        this.#audit.append({
          eventType: existing === undefined ? "session.imported" : "session.rotated",
          accountId: input.accountId,
          generation: input.generation,
          occurredAt: now
        });
        return toAccountState(this.#store.getAccount(input.accountId));
      });
    } catch (error) {
      preserveRuntimeError(error);
    } finally {
      sessionCopy.fill(0);
      routeCopy.fill(0);
      sessionEnvelope?.fill(0);
      routeEnvelope?.fill(0);
    }
  }

  getAccountState(accountId) {
    this.#assertOpen();
    requireValue(validText(accountId, 128));
    try {
      return toAccountState(this.#accountOrThrow(accountId));
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  requestRefresh({ accountId, generation }) {
    this.#assertOpen();
    requireValue(validText(accountId, 128));
    const now = this.#timestamp();
    try {
      return this.#transaction(() => {
        const row = this.#accountOrThrow(accountId);
        this.#assertGeneration(row, generation);
        if (!["healthy", "needs_refresh"].includes(row.health_status)) {
          throw runtimeError("INVALID_STATE");
        }
        if (row.active_lease_id !== null) throw runtimeError("LEASE_BUSY");
        this.#store.run(`
          UPDATE accounts
             SET health_status = 'needs_refresh', refresh_state = 'required', updated_at = ?
           WHERE tenant_id = ? AND account_id = ?
        `, now, this.#tenantId, accountId);
        return toAccountState(this.#store.getAccount(accountId));
      });
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  revokeAccount({ accountId, generation }) {
    this.#assertOpen();
    requireValue(validText(accountId, 128));
    const now = this.#timestamp();
    try {
      return this.#transaction(() => {
        const row = this.#accountOrThrow(accountId);
        if (generation !== row.generation) throw runtimeError("STALE_GENERATION");
        if (generation <= row.revoked_through_generation) throw runtimeError("REVOKED");
        this.#store.run(`
          UPDATE worker_leases
             SET state = 'revoked', completed_at = ?
           WHERE tenant_id = ? AND account_id = ? AND state = 'active'
        `, now, this.#tenantId, accountId);
        this.#store.run(`
          UPDATE accounts
             SET revoked_through_generation = ?,
                 session_envelope = NULL, route_id = NULL, route_envelope = NULL,
                 health_status = 'revoked', refresh_state = 'idle',
                 active_lease_id = NULL, active_lease_fence = NULL,
                 active_lease_expires_at = NULL, updated_at = ?
           WHERE tenant_id = ? AND account_id = ?
        `, generation, now, this.#tenantId, accountId);
        this.#audit.append({
          eventType: "account.revoked",
          accountId,
          generation,
          occurredAt: now
        });
        return toAccountState(this.#store.getAccount(accountId));
      });
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  acquireWorkerCommand({
    accountId,
    generation,
    requestId,
    intent,
    operation,
    payload = null,
    leaseTtlMs = 30_000,
    previousLease = undefined
  }) {
    this.#assertOpen();
    requireValue(validText(accountId, 128));
    requireValue(validText(requestId, 128));
    requireValue(VALID_INTENTS.has(intent));
    requireValue(validText(operation, 128));
    requireValue(Number.isSafeInteger(leaseTtlMs)
      && leaseTtlMs > 0
      && leaseTtlMs <= MAX_LEASE_TTL_MS);
    if (previousLease !== undefined) {
      requireValue(previousLease !== null && typeof previousLease === "object");
      requireValue(validText(previousLease.leaseId, 128));
      requireValue(Number.isSafeInteger(previousLease.fence) && previousLease.fence > 0);
    }
    const now = this.#timestamp();
    const expiresAt = now + leaseTtlMs;
    requireValue(Number.isSafeInteger(expiresAt));

    let session;
    let route;
    let deferredError;
    try {
      const encoded = this.#transaction(() => {
        let row = this.#accountOrThrow(accountId);
        this.#assertGeneration(row, generation);
        if (row.session_envelope === null || row.route_envelope === null || row.route_id === null) {
          throw runtimeError("REVOKED");
        }

        if (row.active_lease_id !== null) {
          const activeLease = this.#store.getLease(row.active_lease_id);
          if (activeLease === undefined
            || activeLease.state !== "active"
            || activeLease.account_id !== accountId
            || activeLease.generation !== generation
            || activeLease.fence !== row.active_lease_fence) {
            throw runtimeError("STORAGE_FAILURE");
          }
          let interruptedState;
          if (row.active_lease_expires_at <= now) {
            interruptedState = "expired";
          } else if (previousLease !== undefined
            && previousLease.leaseId === row.active_lease_id
            && previousLease.fence === row.active_lease_fence) {
            interruptedState = "superseded";
          } else {
            throw runtimeError(previousLease === undefined ? "LEASE_BUSY" : "STALE_LEASE");
          }
          const interruptedWrite = activeLease.intent === "write";
          this.#store.run(`
            UPDATE worker_leases
               SET state = ?, completed_at = ?,
                   result_status = CASE WHEN ? = 1 THEN 'UNKNOWN' ELSE result_status END
             WHERE tenant_id = ? AND lease_id = ? AND state = 'active'
          `,
          interruptedState,
          now,
          interruptedWrite ? 1 : 0,
          this.#tenantId,
          row.active_lease_id);
          this.#store.run(`
            UPDATE accounts
               SET active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL,
                   health_status = CASE WHEN ? = 1 THEN 'unknown' ELSE health_status END,
                   refresh_state = CASE
                     WHEN ? = 1 THEN 'failed'
                     WHEN refresh_state = 'in_progress' THEN 'required'
                     ELSE refresh_state
                   END,
                   updated_at = ?
             WHERE tenant_id = ? AND account_id = ?
          `,
          interruptedWrite ? 1 : 0,
          interruptedWrite ? 1 : 0,
          now,
          this.#tenantId,
          accountId);
          this.#audit.append({
            eventType: "worker.interrupted",
            accountId,
            generation,
            occurredAt: now,
            details: {
              reason: interruptedState,
              resultStatus: interruptedWrite ? "UNKNOWN" : null
            }
          });
          row = this.#accountOrThrow(accountId);
          if (interruptedWrite) {
            deferredError = runtimeError("INVALID_STATE");
            return undefined;
          }
        } else if (previousLease !== undefined) {
          throw runtimeError("STALE_LEASE");
        }

        const allowedStates = intent === "identity_validation"
          ? ["pending_identity", "healthy"]
          : intent === "refresh"
            ? ["healthy", "needs_refresh"]
            : ["healthy"];
        if (!allowedStates.includes(row.health_status)) throw runtimeError("INVALID_STATE");

        if (this.#store.getLeaseByRequest(requestId) !== undefined) {
          throw runtimeError("INVALID_STATE");
        }

        const leaseId = this.#randomUUID();
        requireValue(validText(leaseId, 128));
        const fence = row.next_fence;
        session = this.#crypto.open(row.session_envelope, this.#binding(row, "session", generation));
        route = this.#crypto.open(
          row.route_envelope,
          this.#binding(row, "network-route", generation)
        );

        const command = {
          version: 1,
          type: "social-git.worker.command",
          requestId,
          tenantId: this.#tenantId,
          accountId,
          platform: row.platform,
          generation,
          leaseId,
          fence,
          expiresAt,
          intent,
          operation,
          expectedNativeIdentity: row.expected_native_identity,
          sessionBase64: session.toString("base64url"),
          networkRoute: {
            id: row.route_id,
            materialBase64: route.toString("base64url")
          },
          payload
        };
        const encoded = encodeWorkerMessage(command);

        this.#store.run(`
          INSERT INTO worker_leases (
            lease_id, request_id, account_id, tenant_id, platform, generation, fence,
            intent, operation, state, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `,
        leaseId,
        requestId,
        accountId,
        this.#tenantId,
        row.platform,
        generation,
        fence,
        intent,
        operation,
        expiresAt,
        now);
        this.#store.run(`
          UPDATE accounts
             SET active_lease_id = ?, active_lease_fence = ?,
                 active_lease_expires_at = ?, next_fence = ?,
                 refresh_state = CASE WHEN ? = 'refresh' THEN 'in_progress' ELSE refresh_state END,
                 updated_at = ?
           WHERE tenant_id = ? AND account_id = ?
        `, leaseId, fence, expiresAt, fence + 1, intent, now, this.#tenantId, accountId);
        return encoded;
      });
      if (deferredError !== undefined) throw deferredError;
      return encoded;
    } catch (error) {
      preserveRuntimeError(error);
    } finally {
      session?.fill(0);
      route?.fill(0);
    }
  }

  completeWorkerResult({ accountId, generation, message }) {
    this.#assertOpen();
    requireValue(validText(accountId, 128));
    validateGeneration(generation);
    const result = decodeWorkerMessage(message);
    if (result.type !== "social-git.worker.result") throw runtimeError("MALFORMED_MESSAGE");
    if (result.tenantId !== this.#tenantId
      || result.accountId !== accountId
      || result.platform.length === 0) {
      throw runtimeError("WRONG_ACCOUNT");
    }
    if (result.generation !== generation) throw runtimeError("STALE_GENERATION");
    const now = this.#timestamp();

    let deferredError;
    try {
      const state = this.#transaction(() => {
        const row = this.#accountOrThrow(accountId);
        this.#assertGeneration(row, generation);
        if (result.platform !== row.platform) throw runtimeError("WRONG_ACCOUNT");
        if (row.active_lease_id !== result.leaseId
          || row.active_lease_fence !== result.fence) {
          throw runtimeError("STALE_LEASE");
        }
        const lease = this.#store.getLease(result.leaseId);
        if (lease === undefined
          || lease.state !== "active"
          || lease.request_id !== result.requestId
          || lease.account_id !== accountId
          || lease.generation !== generation
          || lease.fence !== result.fence) {
          throw runtimeError("STALE_LEASE");
        }
        if (lease.expires_at <= now) {
          const interruptedWrite = lease.intent === "write";
          this.#store.run(`
            UPDATE worker_leases
               SET state = 'expired', completed_at = ?, result_status = ?
             WHERE tenant_id = ? AND lease_id = ?
          `, now, interruptedWrite ? "UNKNOWN" : result.status, this.#tenantId, result.leaseId);
          this.#store.run(`
            UPDATE accounts
               SET active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL,
                   health_status = CASE WHEN ? = 1 THEN 'unknown' ELSE health_status END,
                   refresh_state = CASE
                     WHEN ? = 1 THEN 'failed'
                     WHEN refresh_state = 'in_progress' THEN 'required'
                     ELSE refresh_state
                   END,
                   updated_at = ?
             WHERE tenant_id = ? AND account_id = ?
          `,
          interruptedWrite ? 1 : 0,
          interruptedWrite ? 1 : 0,
          now,
          this.#tenantId,
          accountId);
          this.#audit.append({
            eventType: "worker.interrupted",
            accountId,
            generation,
            occurredAt: now,
            details: {
              reason: "expired",
              resultStatus: interruptedWrite ? "UNKNOWN" : result.status
            }
          });
          deferredError = runtimeError("LEASE_EXPIRED");
          return toAccountState(this.#store.getAccount(accountId));
        }

        const identityMismatch = result.observedNativeIdentity !== undefined
          && result.observedNativeIdentity !== row.expected_native_identity;
        let health;
        let refresh;
        let leaseState = "completed";
        let revoke = false;

        if (identityMismatch) {
          health = "wrong_identity";
          refresh = "failed";
          leaseState = "rejected";
          revoke = true;
          deferredError = runtimeError("WRONG_IDENTITY");
        } else {
          switch (result.status) {
            case "SUCCEEDED":
              health = "healthy";
              refresh = "idle";
              break;
            case "AUTH_FAILURE":
              health = "needs_refresh";
              refresh = "required";
              break;
            case "CHALLENGE":
            case "CHECKPOINT":
            case "CAPTCHA":
              health = "challenged";
              refresh = "failed";
              break;
            case "RATE_LIMITED":
              health = "rate_limited";
              refresh = "required";
              break;
            case "REVOKED":
              health = "revoked";
              refresh = "idle";
              revoke = true;
              leaseState = "revoked";
              break;
            case "PROTOCOL_DRIFT":
            case "UNEXPECTED_REDIRECT":
            case "POLICY_DENIED":
              health = "protocol_drift";
              refresh = "failed";
              break;
            case "NOT_EXECUTED":
              // The authenticated worker proved that provider submission never
              // started. Clear only the lease; retain the account's prior
              // health so an operator-controlled retry can use a fresh fence.
              health = row.health_status;
              refresh = lease.intent === "refresh" ? "required" : row.refresh_state;
              break;
            case "UNKNOWN":
              health = "unknown";
              refresh = "failed";
              break;
            default:
              throw runtimeError("MALFORMED_MESSAGE");
          }
        }

        this.#store.run(`
          UPDATE worker_leases
             SET state = ?, completed_at = ?, result_status = ?
           WHERE tenant_id = ? AND lease_id = ?
        `, leaseState, now, result.status, this.#tenantId, result.leaseId);
        if (revoke) {
          this.#store.run(`
            UPDATE accounts
               SET revoked_through_generation = MAX(revoked_through_generation, ?),
                   session_envelope = NULL, route_id = NULL, route_envelope = NULL,
                   health_status = ?, refresh_state = ?,
                   active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL, updated_at = ?
             WHERE tenant_id = ? AND account_id = ?
          `, generation, health, refresh, now, this.#tenantId, accountId);
        } else {
          this.#store.run(`
            UPDATE accounts
               SET health_status = ?, refresh_state = ?,
                   active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL, updated_at = ?,
                   last_validated_at = CASE WHEN ? = 'SUCCEEDED' THEN ? ELSE last_validated_at END
             WHERE tenant_id = ? AND account_id = ?
          `, health, refresh, now, result.status, now, this.#tenantId, accountId);
        }
        this.#audit.append({
          eventType: "worker.completed",
          accountId,
          generation,
          occurredAt: now,
          details: { status: identityMismatch ? "WRONG_IDENTITY" : result.status }
        });
        if (revoke) {
          this.#audit.append({
            eventType: "account.revoked",
            accountId,
            generation,
            occurredAt: now
          });
        }
        return toAccountState(this.#store.getAccount(accountId));
      });
      if (deferredError !== undefined) throw deferredError;
      return state;
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  recoverExpiredLeases() {
    this.#assertOpen();
    const now = this.#timestamp();
    try {
      const interrupted = this.#store.getActiveLeases({ expiresAt: now });
      return this.#transaction(() => {
        this.#store.run(`
          UPDATE accounts
             SET active_lease_id = NULL, active_lease_fence = NULL,
                 active_lease_expires_at = NULL,
                 health_status = CASE
                   WHEN EXISTS (
                     SELECT 1
                      FROM worker_leases
                      WHERE lease_id = accounts.active_lease_id
                        AND tenant_id = ?
                        AND state = 'active'
                        AND intent = 'write'
                   ) THEN 'unknown'
                   ELSE health_status
                 END,
                 refresh_state = CASE
                   WHEN EXISTS (
                     SELECT 1
                      FROM worker_leases
                      WHERE lease_id = accounts.active_lease_id
                        AND tenant_id = ?
                        AND state = 'active'
                        AND intent = 'write'
                   ) THEN 'failed'
                   WHEN refresh_state = 'in_progress' THEN 'required'
                   ELSE refresh_state
                 END,
                 updated_at = ?
           WHERE tenant_id = ?
             AND active_lease_id IS NOT NULL
             AND active_lease_expires_at <= ?
        `, this.#tenantId, this.#tenantId, now, this.#tenantId, now);
        const expired = this.#store.run(`
          UPDATE worker_leases
             SET state = 'expired', completed_at = ?,
                 result_status = CASE
                   WHEN intent = 'write' THEN 'UNKNOWN'
                   ELSE result_status
                 END
           WHERE tenant_id = ? AND state = 'active' AND expires_at <= ?
        `, now, this.#tenantId, now).changes;
        for (const lease of interrupted) {
          this.#audit.append({
            eventType: "worker.interrupted",
            accountId: lease.account_id,
            generation: lease.generation,
            occurredAt: now,
            details: {
              reason: "expired",
              resultStatus: lease.intent === "write" ? "UNKNOWN" : null
            }
          });
        }
        return expired;
      });
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  rotateMasterKey({ newMasterKey }) {
    this.#assertOpen();
    requireValue(newMasterKey instanceof Uint8Array && newMasterKey.byteLength === 32);
    const replacement = new SessionEnvelopeCrypto({
      masterKey: newMasterKey,
      randomBytes: this.#randomBytes
    });
    const now = this.#timestamp();
    let committed = false;
    try {
      const rows = this.#store.getEncryptedAccounts();
      this.#transaction(() => {
        for (const row of rows) {
          let session;
          let route;
          let sessionEnvelope;
          let routeEnvelope;
          try {
            session = this.#crypto.open(row.session_envelope, this.#binding(row, "session"));
            route = this.#crypto.open(row.route_envelope, this.#binding(row, "network-route"));
            sessionEnvelope = replacement.seal(session, this.#binding(row, "session"));
            routeEnvelope = replacement.seal(route, this.#binding(row, "network-route"));
            this.#store.run(`
              UPDATE accounts
                 SET session_envelope = ?, route_envelope = ?, updated_at = ?
               WHERE tenant_id = ? AND account_id = ? AND generation = ?
            `,
            sessionEnvelope,
            routeEnvelope,
            now,
            this.#tenantId,
            row.account_id,
            row.generation);
          } finally {
            session?.fill(0);
            route?.fill(0);
            sessionEnvelope?.fill(0);
            routeEnvelope?.fill(0);
          }
        }
        this.#audit.append({
          eventType: "master_key.rotated",
          occurredAt: now,
          details: { accountCount: rows.length }
        });
      });
      const previous = this.#crypto;
      this.#crypto = replacement;
      previous.close();
      committed = true;
      return Object.freeze({ accountCount: rows.length, rotatedAt: now });
    } catch (error) {
      preserveRuntimeError(error);
    } finally {
      if (!committed) replacement.close();
    }
  }

  createEncryptedBackup({ backupPath, backupKey, expiresAt }) {
    this.#assertOpen();
    const createdAt = this.#timestamp();
    requireValue(Number.isSafeInteger(expiresAt)
      && expiresAt > createdAt
      && expiresAt - createdAt <= MAX_BACKUP_RETENTION_MS);
    const backupId = this.#randomUUID();
    requireValue(validText(backupId, 128));
    let auditAnchor;
    let snapshot;
    try {
      snapshot = this.#store.snapshot();
      auditAnchor = this.#audit.backupAnchor();
      const metadata = createEncryptedBackupFile({
        snapshot,
        auditAnchor,
        backupPath,
        backupKey,
        metadata: {
          backupId,
          tenantId: this.#tenantId,
          purpose: "database-backup",
          schemaVersion: SCHEMA_VERSION,
          createdAt,
          expiresAt
        },
        randomBytes: this.#randomBytes,
        randomUUID: this.#randomUUID,
        claimedNonces: this.#claimedBackupNonces
      });
      this.#transaction(() => {
        this.#audit.append({
          eventType: "backup.created",
          occurredAt: createdAt,
          details: { backupId, expiresAt }
        });
      });
      return metadata;
    } catch (error) {
      preserveRuntimeError(error);
    } finally {
      auditAnchor?.fill(0);
      snapshot?.fill(0);
    }
  }

  checkpoint() {
    this.#assertOpen();
    try {
      const result = this.#store.checkpoint();
      const now = this.#timestamp();
      this.#transaction(() => {
        this.#audit.append({
          eventType: "database.checkpointed",
          occurredAt: now,
          details: result
        });
      });
      this.#store.checkpoint();
      return result;
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  verifyAuditIntegrity() {
    this.#assertOpen();
    try {
      return this.#audit.verify();
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  listAuditEvents() {
    this.#assertOpen();
    try {
      return this.#audit.list();
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  diagnostics() {
    this.#assertOpen();
    try {
      return Object.freeze({
        journalMode: this.#store.journalMode(),
        schemaVersion: this.#store.schemaVersion(),
        tenantId: this.#tenantId,
        auditEventCount: this.#audit.verify().eventCount,
        ownerPid: process.pid,
        ownerThreadId: threadId
      });
    } catch (error) {
      preserveRuntimeError(error);
    }
  }

  close() {
    if (this.#closed) return;
    try {
      this.#store.close();
    } catch (error) {
      preserveRuntimeError(error);
    } finally {
      this.#audit.close();
      this.#crypto.close();
      this.#claimedBackupNonces.clear();
      this.#closed = true;
    }
  }
}

export const SESSION_RUNTIME_SCHEMA_VERSION = SCHEMA_VERSION;
export const MAX_WORKER_LEASE_TTL_MS = MAX_LEASE_TTL_MS;
