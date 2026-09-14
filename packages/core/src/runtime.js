import { randomUUID as secureRandomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { SessionEnvelopeCrypto } from "./crypto.js";
import { SessionRuntimeError, requireValue, runtimeError } from "./errors.js";
import {
  MAX_NETWORK_ROUTE_BYTES,
  MAX_SESSION_BYTES,
  decodeWorkerMessage,
  encodeWorkerMessage
} from "./worker-contract.js";

const MIGRATION = readFileSync(
  new URL("../migrations/001_session_runtime.sql", import.meta.url),
  "utf8"
);
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
  #ownerPid = process.pid;
  #ownerThreadId = threadId;
  #closed = false;

  constructor(databasePath, now) {
    requireValue(validText(databasePath, 4096) && databasePath !== ":memory:");
    try {
      this.#database = new DatabaseSync(databasePath, {
        open: true,
        readOnly: false,
        enableForeignKeyConstraints: true,
        timeout: 5000
      });
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = FULL");
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      this.#database.exec(MIGRATION);
      this.transaction(() => {
        this.#database.prepare(`
          UPDATE accounts
             SET active_lease_id = NULL,
                 active_lease_fence = NULL,
                 active_lease_expires_at = NULL,
                 refresh_state = CASE
                   WHEN EXISTS (
                     SELECT 1
                       FROM worker_leases
                      WHERE lease_id = accounts.active_lease_id
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
                        AND state = 'active'
                        AND intent = 'write'
                   ) THEN 'unknown'
                   ELSE health_status
                 END,
                 updated_at = ?
           WHERE active_lease_id IS NOT NULL
        `).run(now);
        this.#database.prepare(`
          UPDATE worker_leases
             SET state = 'abandoned', completed_at = ?,
                 result_status = CASE
                   WHEN intent = 'write' THEN 'UNKNOWN'
                   ELSE result_status
                 END
           WHERE state = 'active'
        `).run(now);
      });
    } catch (error) {
      try {
        this.#database?.close();
      } catch {
        // The original sanitized storage failure is more useful.
      }
      preserveRuntimeError(error);
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
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure and never expose database text.
      }
      throw error;
    }
  }

  getAccount(accountId) {
    this.assertOwner();
    return this.#database.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId);
  }

  getLease(leaseId) {
    this.assertOwner();
    return this.#database.prepare("SELECT * FROM worker_leases WHERE lease_id = ?").get(leaseId);
  }

  getLeaseByRequest(requestId) {
    this.assertOwner();
    return this.#database.prepare("SELECT * FROM worker_leases WHERE request_id = ?").get(requestId);
  }

  run(sql, ...values) {
    this.assertOwner();
    return this.#database.prepare(sql).run(...values);
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
    this.#database.close();
    this.#closed = true;
  }
}

export class SessionRuntime {
  #store;
  #crypto;
  #now;
  #randomUUID;
  #closed = false;

  constructor({ databasePath, masterKey, now = Date.now, randomUUID = secureRandomUUID, randomBytes }) {
    requireValue(typeof now === "function");
    requireValue(typeof randomUUID === "function");
    this.#now = now;
    this.#randomUUID = randomUUID;
    this.#crypto = new SessionEnvelopeCrypto({ masterKey, randomBytes });
    try {
      this.#store = new CoreStore(databasePath, this.#timestamp());
    } catch (error) {
      this.#crypto.close();
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw runtimeError("OWNERSHIP_VIOLATION");
    this.#store.assertOwner();
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
      accountId: input.accountId,
      platform: input.platform,
      purpose: "session",
      generation: input.generation
    };
    const routeBinding = { ...sessionBinding, purpose: "network-route" };
    let sessionEnvelope;
    let routeEnvelope;

    try {
      sessionEnvelope = this.#crypto.seal(sessionCopy, sessionBinding);
      routeEnvelope = this.#crypto.seal(routeCopy, routeBinding);
      return this.#store.transaction(() => {
        const existing = this.#store.getAccount(input.accountId);
        if (existing === undefined) {
          if (input.generation !== 1) throw runtimeError("STALE_GENERATION");
          this.#store.run(`
            INSERT INTO accounts (
              account_id, platform, expected_native_identity, generation,
              revoked_through_generation, session_envelope, route_id, route_envelope,
              health_status, refresh_state, next_fence, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'pending_identity', 'idle', 1, ?, ?)
          `,
          input.accountId,
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
             WHERE account_id = ? AND state = 'active'
          `, now, input.accountId);
          this.#store.run(`
            UPDATE accounts
               SET generation = ?, session_envelope = ?, route_id = ?, route_envelope = ?,
                   health_status = 'pending_identity', refresh_state = 'idle',
                   active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL, updated_at = ?, last_validated_at = NULL
             WHERE account_id = ?
          `,
          input.generation,
          sessionEnvelope,
          input.networkRoute.id,
          routeEnvelope,
          now,
          input.accountId);
        }
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
      return this.#store.transaction(() => {
        const row = this.#accountOrThrow(accountId);
        this.#assertGeneration(row, generation);
        if (!["healthy", "needs_refresh"].includes(row.health_status)) {
          throw runtimeError("INVALID_STATE");
        }
        if (row.active_lease_id !== null) throw runtimeError("LEASE_BUSY");
        this.#store.run(`
          UPDATE accounts
             SET health_status = 'needs_refresh', refresh_state = 'required', updated_at = ?
           WHERE account_id = ?
        `, now, accountId);
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
      return this.#store.transaction(() => {
        const row = this.#accountOrThrow(accountId);
        if (generation !== row.generation) throw runtimeError("STALE_GENERATION");
        if (generation <= row.revoked_through_generation) throw runtimeError("REVOKED");
        this.#store.run(`
          UPDATE worker_leases
             SET state = 'revoked', completed_at = ?
           WHERE account_id = ? AND state = 'active'
        `, now, accountId);
        this.#store.run(`
          UPDATE accounts
             SET revoked_through_generation = ?,
                 session_envelope = NULL, route_id = NULL, route_envelope = NULL,
                 health_status = 'revoked', refresh_state = 'idle',
                 active_lease_id = NULL, active_lease_fence = NULL,
                 active_lease_expires_at = NULL, updated_at = ?
           WHERE account_id = ?
        `, generation, now, accountId);
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
      const encoded = this.#store.transaction(() => {
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
             WHERE lease_id = ? AND state = 'active'
          `, interruptedState, now, interruptedWrite ? 1 : 0, row.active_lease_id);
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
             WHERE account_id = ?
          `, interruptedWrite ? 1 : 0, interruptedWrite ? 1 : 0, now, accountId);
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
        session = this.#crypto.open(row.session_envelope, {
          accountId,
          platform: row.platform,
          purpose: "session",
          generation
        });
        route = this.#crypto.open(row.route_envelope, {
          accountId,
          platform: row.platform,
          purpose: "network-route",
          generation
        });

        const command = {
          version: 1,
          type: "social-git.worker.command",
          requestId,
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
            lease_id, request_id, account_id, platform, generation, fence,
            intent, operation, state, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `,
        leaseId,
        requestId,
        accountId,
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
           WHERE account_id = ?
        `, leaseId, fence, expiresAt, fence + 1, intent, now, accountId);
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
    if (result.accountId !== accountId || result.platform.length === 0) {
      throw runtimeError("WRONG_ACCOUNT");
    }
    if (result.generation !== generation) throw runtimeError("STALE_GENERATION");
    const now = this.#timestamp();

    let deferredError;
    try {
      const state = this.#store.transaction(() => {
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
             WHERE lease_id = ?
          `, now, interruptedWrite ? "UNKNOWN" : result.status, result.leaseId);
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
             WHERE account_id = ?
          `, interruptedWrite ? 1 : 0, interruptedWrite ? 1 : 0, now, accountId);
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
              health = "protocol_drift";
              refresh = "failed";
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
           WHERE lease_id = ?
        `, leaseState, now, result.status, result.leaseId);
        if (revoke) {
          this.#store.run(`
            UPDATE accounts
               SET revoked_through_generation = MAX(revoked_through_generation, ?),
                   session_envelope = NULL, route_id = NULL, route_envelope = NULL,
                   health_status = ?, refresh_state = ?,
                   active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL, updated_at = ?
             WHERE account_id = ?
          `, generation, health, refresh, now, accountId);
        } else {
          this.#store.run(`
            UPDATE accounts
               SET health_status = ?, refresh_state = ?,
                   active_lease_id = NULL, active_lease_fence = NULL,
                   active_lease_expires_at = NULL, updated_at = ?,
                   last_validated_at = CASE WHEN ? = 'SUCCEEDED' THEN ? ELSE last_validated_at END
             WHERE account_id = ?
          `, health, refresh, now, result.status, now, accountId);
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
      return this.#store.transaction(() => {
        this.#store.run(`
          UPDATE accounts
             SET active_lease_id = NULL, active_lease_fence = NULL,
                 active_lease_expires_at = NULL,
                 health_status = CASE
                   WHEN EXISTS (
                     SELECT 1
                       FROM worker_leases
                      WHERE lease_id = accounts.active_lease_id
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
                        AND state = 'active'
                        AND intent = 'write'
                   ) THEN 'failed'
                   WHEN refresh_state = 'in_progress' THEN 'required'
                   ELSE refresh_state
                 END,
                 updated_at = ?
           WHERE active_lease_id IS NOT NULL AND active_lease_expires_at <= ?
        `, now, now);
        const expired = this.#store.run(`
          UPDATE worker_leases
             SET state = 'expired', completed_at = ?,
                 result_status = CASE
                   WHEN intent = 'write' THEN 'UNKNOWN'
                   ELSE result_status
                 END
           WHERE state = 'active' AND expires_at <= ?
        `, now, now).changes;
        return expired;
      });
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
      this.#crypto.close();
      this.#closed = true;
    }
  }
}

export const SESSION_RUNTIME_SCHEMA_VERSION = 1;
export const MAX_WORKER_LEASE_TTL_MS = MAX_LEASE_TTL_MS;
