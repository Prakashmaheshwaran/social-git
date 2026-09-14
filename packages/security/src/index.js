import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const Role = Object.freeze({
  PLATFORM_SECURITY_ADMIN: "platform_security_admin",
  SESSION_NETWORK_CUSTODIAN: "session_network_custodian",
  API_CALLER: "api_caller",
  CORE_RUNTIME: "core_runtime",
  PLATFORM_WORKER: "platform_worker",
  DEVELOPER: "developer",
  RESEARCHER: "researcher",
  SECURITY_REVIEWER: "security_reviewer",
  BACKUP_OPERATOR: "backup_operator",
  INDEPENDENT_LIVE_QA: "independent_live_qa"
});

export const Permission = Object.freeze({
  MANAGE_ROLE_POLICY: "manage_role_policy",
  VIEW_ACCOUNT_ROUTE_METADATA: "view_account_route_metadata",
  REVOKE_ACCOUNT: "revoke_account",
  IMPORT_SESSION: "import_session",
  PROVISION_ROUTE_SECRET: "provision_route_secret",
  ENTER_EXPECTED_IDENTITY: "enter_expected_identity",
  USE_CORE_DATABASE: "use_core_database",
  DECRYPT_FENCED_JOB_SECRET: "decrypt_fenced_job_secret",
  CONSUME_LIVE_AUTHORIZATION: "consume_live_authorization",
  RUN_FENCED_PLATFORM_JOB: "run_fenced_platform_job",
  USE_ASSIGNED_PLATFORM_EGRESS: "use_assigned_platform_egress",
  CALL_SCOPED_READ: "call_scoped_read",
  CALL_SCOPED_WRITE: "call_scoped_write",
  VIEW_SOURCE: "view_source",
  USE_SYNTHETIC_FIXTURES: "use_synthetic_fixtures",
  VIEW_REDACTED_TELEMETRY: "view_redacted_telemetry",
  REVIEW_SECURITY_EVIDENCE: "review_security_evidence",
  APPROVE_LIVE_TEST: "approve_live_test",
  TRANSPORT_CIPHERTEXT_BACKUP: "transport_ciphertext_backup",
  EXECUTE_APPROVED_LIVE_TEST: "execute_approved_live_test"
});

export const ROLE_PERMISSIONS = Object.freeze({
  [Role.PLATFORM_SECURITY_ADMIN]: Object.freeze([
    Permission.MANAGE_ROLE_POLICY,
    Permission.VIEW_ACCOUNT_ROUTE_METADATA,
    Permission.REVOKE_ACCOUNT
  ]),
  [Role.SESSION_NETWORK_CUSTODIAN]: Object.freeze([
    Permission.IMPORT_SESSION,
    Permission.PROVISION_ROUTE_SECRET,
    Permission.ENTER_EXPECTED_IDENTITY
  ]),
  [Role.API_CALLER]: Object.freeze([
    Permission.CALL_SCOPED_READ,
    Permission.CALL_SCOPED_WRITE
  ]),
  [Role.CORE_RUNTIME]: Object.freeze([
    Permission.USE_CORE_DATABASE,
    Permission.DECRYPT_FENCED_JOB_SECRET,
    Permission.CONSUME_LIVE_AUTHORIZATION
  ]),
  [Role.PLATFORM_WORKER]: Object.freeze([
    Permission.RUN_FENCED_PLATFORM_JOB,
    Permission.USE_ASSIGNED_PLATFORM_EGRESS
  ]),
  [Role.DEVELOPER]: Object.freeze([
    Permission.VIEW_SOURCE,
    Permission.USE_SYNTHETIC_FIXTURES,
    Permission.VIEW_REDACTED_TELEMETRY
  ]),
  [Role.RESEARCHER]: Object.freeze([
    Permission.VIEW_SOURCE,
    Permission.USE_SYNTHETIC_FIXTURES,
    Permission.VIEW_REDACTED_TELEMETRY
  ]),
  [Role.SECURITY_REVIEWER]: Object.freeze([
    Permission.REVIEW_SECURITY_EVIDENCE,
    Permission.APPROVE_LIVE_TEST
  ]),
  [Role.BACKUP_OPERATOR]: Object.freeze([
    Permission.TRANSPORT_CIPHERTEXT_BACKUP
  ]),
  [Role.INDEPENDENT_LIVE_QA]: Object.freeze([
    Permission.EXECUTE_APPROVED_LIVE_TEST
  ])
});

export const AuthorizationErrorCode = Object.freeze({
  ROLE_DENIED: "ROLE_DENIED",
  INVALID_GRANT: "INVALID_GRANT",
  NOT_YET_VALID: "NOT_YET_VALID",
  EXPIRED: "EXPIRED",
  WRONG_ARTIFACT: "WRONG_ARTIFACT",
  WRONG_ENVIRONMENT: "WRONG_ENVIRONMENT",
  WRONG_SBOM: "WRONG_SBOM",
  WRONG_TEST_EVIDENCE: "WRONG_TEST_EVIDENCE",
  WRONG_ACCOUNT: "WRONG_ACCOUNT",
  WRONG_IDENTITY: "WRONG_IDENTITY",
  WRONG_ROUTE: "WRONG_ROUTE",
  STALE_GENERATION: "STALE_GENERATION",
  WRONG_OPERATOR: "WRONG_OPERATOR",
  WRONG_OPERATION: "WRONG_OPERATION",
  WRONG_RESOURCE: "WRONG_RESOURCE",
  WRONG_LEDGER: "WRONG_LEDGER",
  REPLAYED: "REPLAYED",
  OVER_LIMIT: "OVER_LIMIT",
  STOPPED: "STOPPED",
  STORAGE_FAILURE: "STORAGE_FAILURE"
});

export class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

const roleValues = new Set(Object.values(Role));
const permissionValues = new Set(Object.values(Permission));
const approvedGrants = new WeakSet();
const trustedActors = new WeakSet();
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const operationPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/;
const broadOperationComponents = new Set(["all", "any", "mutate", "read", "write"]);

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requireDigest(value, name) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${name} must be a lowercase sha256 digest`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function requireTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative epoch millisecond timestamp`);
  }
  return value;
}

function validateOperation(value) {
  requireText(value, "operation");
  const components = value.split(".");
  if (
    !operationPattern.test(value)
    || value.includes("*")
    || components.some((component) => broadOperationComponents.has(component))
  ) {
    throw new TypeError(`operation is not exact: ${value}`);
  }
  return value;
}

function normalizeOperations(values, name) {
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
  const unique = [...new Set(values.map(validateOperation))].sort();
  if (unique.length !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(unique);
}

function normalizeResourceConstraints(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("resourceConstraints must be an object");
  }
  const entries = Object.entries(value)
    .map(([name, bound]) => [requireText(name, "resource constraint name"), requireText(bound, `resourceConstraints.${name}`)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map((entry) => Object.freeze(entry));
  if (entries.length === 0) throw new TypeError("resourceConstraints cannot be empty");
  return Object.freeze(entries);
}

export class RoleAuthority {
  #bindings = new Map();

  constructor(bindings) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      throw new TypeError("role bindings are required");
    }
    for (const binding of bindings) {
      const actorId = requireText(binding?.actorId, "actorId");
      if (!roleValues.has(binding?.role)) throw new TypeError("role is invalid");
      if (this.#bindings.has(actorId)) throw new TypeError("actorId has more than one role binding");
      this.#bindings.set(actorId, binding.role);
    }
  }

  principalFor(actorId) {
    requireText(actorId, "actorId");
    const role = this.#bindings.get(actorId);
    if (role === undefined) {
      throw new AuthorizationError(AuthorizationErrorCode.ROLE_DENIED, "actor has no role binding");
    }
    const principal = Object.freeze({ actorId, role });
    trustedActors.add(principal);
    return principal;
  }
}

export function hasPermission(principal, permission) {
  if (!trustedActors.has(principal) || !roleValues.has(principal.role) || !permissionValues.has(permission)) return false;
  return ROLE_PERMISSIONS[principal.role].includes(permission);
}

export function assertPermission(principal, permission) {
  if (!hasPermission(principal, permission)) {
    const role = principal && roleValues.has(principal.role) ? principal.role : "unknown";
    throw new AuthorizationError(
      AuthorizationErrorCode.ROLE_DENIED,
      `role ${role} cannot ${permission}`
    );
  }
}

export function approveLiveTestGrant(input, { qaOperator, approver }) {
  assertPermission(qaOperator, Permission.EXECUTE_APPROVED_LIVE_TEST);
  assertPermission(approver, Permission.APPROVE_LIVE_TEST);
  if (qaOperator.actorId === approver.actorId) {
    throw new AuthorizationError(
      AuthorizationErrorCode.INVALID_GRANT,
      "the live-test executor cannot approve the grant"
    );
  }

  const readOperations = normalizeOperations(input.readOperations, "readOperations");
  const writeOperations = normalizeOperations(input.writeOperations, "writeOperations");
  if (readOperations.length === 0 && writeOperations.length === 0) {
    throw new TypeError("at least one exact operation is required");
  }
  if (readOperations.some((operation) => writeOperations.includes(operation))) {
    throw new TypeError("readOperations and writeOperations must be disjoint");
  }

  let cleanupOperation = null;
  if (writeOperations.length > 0) {
    cleanupOperation = validateOperation(input.cleanupOperation);
    if (!writeOperations.includes(cleanupOperation)) {
      throw new TypeError("cleanupOperation must be in writeOperations");
    }
  } else if (input.cleanupOperation !== null && input.cleanupOperation !== undefined) {
    throw new TypeError("a read-only grant cannot specify cleanupOperation");
  }

  const notBefore = requireTimestamp(input.notBefore, "notBefore");
  const expiresAt = requireTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt <= notBefore) throw new TypeError("expiresAt must be after notBefore");

  const grant = Object.freeze({
    authorizationId: requireText(input.authorizationId, "authorizationId"),
    ledgerId: requireText(input.ledgerId, "ledgerId"),
    environment: requireText(input.environment, "environment"),
    artifactDigest: requireDigest(input.artifactDigest, "artifactDigest"),
    sbomDigest: requireDigest(input.sbomDigest, "sbomDigest"),
    testEvidenceDigest: requireDigest(input.testEvidenceDigest, "testEvidenceDigest"),
    canaryAccountId: requireText(input.canaryAccountId, "canaryAccountId"),
    expectedNativeIdentity: requireText(input.expectedNativeIdentity, "expectedNativeIdentity"),
    sessionGeneration: requirePositiveInteger(input.sessionGeneration, "sessionGeneration"),
    routeId: requireText(input.routeId, "routeId"),
    readOperations,
    writeOperations,
    resourceConstraints: normalizeResourceConstraints(input.resourceConstraints),
    cleanupOperation,
    actionLimit: requirePositiveInteger(input.actionLimit, "actionLimit"),
    qaOperatorId: qaOperator.actorId,
    qaOperatorRole: qaOperator.role,
    approverId: approver.actorId,
    approverRole: approver.role,
    notBefore,
    expiresAt
  });
  approvedGrants.add(grant);
  return grant;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function liveTestGrantFingerprint(grant) {
  validateGrantRecord(grant);
  return `sha256:${createHash("sha256").update(canonicalJson(grant)).digest("hex")}`;
}

function validateGrantRecord(grant) {
  if (grant === null || typeof grant !== "object") {
    throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "grant is invalid");
  }
  requireText(grant.authorizationId, "authorizationId");
  requireText(grant.ledgerId, "ledgerId");
  requireText(grant.environment, "environment");
  requireDigest(grant.artifactDigest, "artifactDigest");
  requireDigest(grant.sbomDigest, "sbomDigest");
  requireDigest(grant.testEvidenceDigest, "testEvidenceDigest");
  requireText(grant.canaryAccountId, "canaryAccountId");
  requireText(grant.expectedNativeIdentity, "expectedNativeIdentity");
  requirePositiveInteger(grant.sessionGeneration, "sessionGeneration");
  requireText(grant.routeId, "routeId");
  requirePositiveInteger(grant.actionLimit, "actionLimit");
  requireTimestamp(grant.notBefore, "notBefore");
  requireTimestamp(grant.expiresAt, "expiresAt");
  if (grant.expiresAt <= grant.notBefore) throw new TypeError("expiresAt must be after notBefore");
  if (grant.qaOperatorRole !== Role.INDEPENDENT_LIVE_QA) {
    throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "grant has an invalid QA role");
  }
  if (grant.approverRole !== Role.SECURITY_REVIEWER) {
    throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "grant has an invalid approver role");
  }
  requireText(grant.qaOperatorId, "qaOperatorId");
  requireText(grant.approverId, "approverId");
  if (grant.qaOperatorId === grant.approverId) {
    throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "the live-test executor cannot approve the grant");
  }
  if (!Array.isArray(grant.readOperations) || !Array.isArray(grant.writeOperations)) {
    throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "grant operation lists are invalid");
  }
  for (const operation of [...grant.readOperations, ...grant.writeOperations]) validateOperation(operation);
  if (!Array.isArray(grant.resourceConstraints) || grant.resourceConstraints.length === 0) {
    throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "grant resource constraints are invalid");
  }
  for (const entry of grant.resourceConstraints) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "grant resource constraints are invalid");
    }
    requireText(entry[0], "resource constraint name");
    requireText(entry[1], `resourceConstraints.${entry[0]}`);
  }
}

export const StopReason = Object.freeze({
  CHALLENGE: "CHALLENGE",
  CHECKPOINT: "CHECKPOINT",
  CAPTCHA: "CAPTCHA",
  RATE_LIMIT: "RATE_LIMIT",
  WRONG_IDENTITY: "WRONG_IDENTITY",
  REVOKED_SESSION: "REVOKED_SESSION",
  PROTOCOL_DRIFT: "PROTOCOL_DRIFT",
  UNEXPECTED_REDIRECT: "UNEXPECTED_REDIRECT",
  POLICY_DENIED: "POLICY_DENIED",
  UNKNOWN: "UNKNOWN"
});

export const LiveOutcome = Object.freeze({ SUCCEEDED: "SUCCEEDED" });
const stopReasons = new Set(Object.values(StopReason));

const schema = `
  CREATE TABLE IF NOT EXISTS live_authorizations (
    authorization_id TEXT PRIMARY KEY,
    grant_fingerprint TEXT NOT NULL,
    ledger_id TEXT NOT NULL,
    action_limit INTEGER NOT NULL CHECK (action_limit > 0),
    stopped_reason TEXT,
    activated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS live_authorization_actions (
    authorization_id TEXT NOT NULL REFERENCES live_authorizations(authorization_id),
    action_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    is_write INTEGER NOT NULL CHECK (is_write IN (0, 1)),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (authorization_id, action_id)
  ) STRICT;
`;

function preserveAuthorizationError(error) {
  if (error instanceof AuthorizationError) throw error;
  throw new AuthorizationError(AuthorizationErrorCode.STORAGE_FAILURE, "authorization storage failed");
}

export class LiveAuthorizationLedger {
  #database;
  #closed = false;

  constructor(databasePath) {
    requireText(databasePath, "databasePath");
    if (databasePath === ":memory:") throw new TypeError("databasePath must be durable");
    try {
      this.#database = new DatabaseSync(databasePath);
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = FULL");
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec(schema);
    } catch (error) {
      try { this.#database?.close(); } catch { /* preserve the normalized error */ }
      preserveAuthorizationError(error);
    }
  }

  #assertOpen() {
    if (this.#closed) {
      throw new AuthorizationError(AuthorizationErrorCode.STORAGE_FAILURE, "authorization storage is closed");
    }
  }

  #transaction(operation) {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      preserveAuthorizationError(error);
    }
  }

  registerGrant(grant, now = Date.now()) {
    if (!approvedGrants.has(grant)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.INVALID_GRANT,
        "grant was not approved by this policy boundary"
      );
    }
    const fingerprint = liveTestGrantFingerprint(grant);
    const timestamp = requireTimestamp(now, "now");
    return this.#transaction(() => {
      const state = this.#database.prepare(
        "SELECT grant_fingerprint FROM live_authorizations WHERE authorization_id = ?"
      ).get(grant.authorizationId);
      if (state === undefined) {
        this.#database.prepare(`
          INSERT INTO live_authorizations (
            authorization_id, grant_fingerprint, ledger_id, action_limit, stopped_reason, activated_at
          ) VALUES (?, ?, ?, ?, NULL, ?)
        `).run(grant.authorizationId, fingerprint, grant.ledgerId, grant.actionLimit, timestamp);
      } else if (state.grant_fingerprint !== fingerprint) {
        throw new AuthorizationError(
          AuthorizationErrorCode.REPLAYED,
          "authorization identifier is already bound to a different grant"
        );
      }
      return fingerprint;
    });
  }

  authorizeAndRecord(grant, request, now = Date.now()) {
    const fingerprint = liveTestGrantFingerprint(grant);
    const timestamp = requireTimestamp(now, "now");
    const operation = this.#validateRequest(grant, request, timestamp);

    return this.#transaction(() => {
      let state = this.#database.prepare(
        "SELECT * FROM live_authorizations WHERE authorization_id = ?"
      ).get(grant.authorizationId);
      if (state === undefined) {
        throw new AuthorizationError(
          AuthorizationErrorCode.INVALID_GRANT,
          "authorization is not registered"
        );
      }
      if (state.grant_fingerprint !== fingerprint) {
        throw new AuthorizationError(
          AuthorizationErrorCode.REPLAYED,
          "authorization identifier is already bound to a different grant"
        );
      }

      if (state.ledger_id !== request.ledgerId) {
        throw new AuthorizationError(AuthorizationErrorCode.WRONG_LEDGER, "authorization is bound to a different ledger");
      }
      if (state.stopped_reason !== null) {
        throw new AuthorizationError(AuthorizationErrorCode.STOPPED, `authorization stopped with ${state.stopped_reason}`);
      }
      const existing = this.#database.prepare(`
        SELECT 1 FROM live_authorization_actions WHERE authorization_id = ? AND action_id = ?
      `).get(grant.authorizationId, request.actionId);
      if (existing !== undefined) {
        throw new AuthorizationError(AuthorizationErrorCode.REPLAYED, "action identifier was already consumed");
      }
      const count = this.#database.prepare(`
        SELECT COUNT(*) AS count FROM live_authorization_actions WHERE authorization_id = ?
      `).get(grant.authorizationId).count;
      if (Number(count) >= Number(state.action_limit)) {
        throw new AuthorizationError(AuthorizationErrorCode.OVER_LIMIT, "authorization action limit is exhausted");
      }

      const isWrite = grant.writeOperations.includes(operation);
      this.#database.prepare(`
        INSERT INTO live_authorization_actions (
          authorization_id, action_id, operation, is_write, recorded_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(grant.authorizationId, request.actionId, operation, isWrite ? 1 : 0, timestamp);

      return Object.freeze({
        authorizationId: grant.authorizationId,
        actionId: request.actionId,
        ledgerId: grant.ledgerId,
        artifactDigest: grant.artifactDigest,
        operation,
        isWrite
      });
    });
  }

  #validateRequest(grant, request, now) {
    if (request === null || typeof request !== "object") throw new TypeError("request is required");
    assertPermission(request.executor, Permission.EXECUTE_APPROVED_LIVE_TEST);
    if (request.executor.actorId !== grant.qaOperatorId) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_OPERATOR, "executor is not the named independent QA operator");
    }
    if (now < grant.notBefore) {
      throw new AuthorizationError(AuthorizationErrorCode.NOT_YET_VALID, "authorization is not active");
    }
    if (now >= grant.expiresAt) {
      throw new AuthorizationError(AuthorizationErrorCode.EXPIRED, "authorization has expired");
    }
    if (request.environment !== grant.environment) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_ENVIRONMENT, "environment does not match");
    }
    if (request.artifactDigest !== grant.artifactDigest) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_ARTIFACT, "artifact digest does not match");
    }
    if (request.sbomDigest !== grant.sbomDigest) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_SBOM, "SBOM digest does not match");
    }
    if (request.testEvidenceDigest !== grant.testEvidenceDigest) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_TEST_EVIDENCE, "test evidence digest does not match");
    }
    if (request.canaryAccountId !== grant.canaryAccountId) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_ACCOUNT, "canary account does not match");
    }
    if (request.observedNativeIdentity !== grant.expectedNativeIdentity) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_IDENTITY, "native identity does not match");
    }
    if (request.sessionGeneration !== grant.sessionGeneration) {
      throw new AuthorizationError(AuthorizationErrorCode.STALE_GENERATION, "session generation does not match");
    }
    if (request.routeId !== grant.routeId) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_ROUTE, "network route does not match");
    }
    const operation = validateOperation(request.operation);
    if (![...grant.readOperations, ...grant.writeOperations].includes(operation)) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_OPERATION, "operation is not authorized");
    }
    const requestConstraints = normalizeResourceConstraints(request.resourceConstraints);
    if (canonicalJson(requestConstraints) !== canonicalJson(grant.resourceConstraints)) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_RESOURCE, "resource constraints do not match");
    }
    if (request.ledgerId !== grant.ledgerId) {
      throw new AuthorizationError(AuthorizationErrorCode.WRONG_LEDGER, "ledger does not match");
    }
    requireText(request.actionId, "actionId");
    return operation;
  }

  stop(authorizationId, reason) {
    requireText(authorizationId, "authorizationId");
    if (!stopReasons.has(reason)) throw new TypeError("stop reason is invalid");
    this.#transaction(() => {
      const result = this.#database.prepare(`
        UPDATE live_authorizations SET stopped_reason = ? WHERE authorization_id = ?
      `).run(reason, authorizationId);
      if (result.changes !== 1) {
        throw new AuthorizationError(AuthorizationErrorCode.INVALID_GRANT, "authorization is not active");
      }
    });
  }

  close() {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}

export class LiveTestController {
  #ledger;

  constructor(ledger) {
    if (!(ledger instanceof LiveAuthorizationLedger)) throw new TypeError("ledger is required");
    this.#ledger = ledger;
  }

  async execute(grant, request, { now = Date.now(), coreActor, secretBoundary, dispatch }) {
    assertPermission(coreActor, Permission.CONSUME_LIVE_AUTHORIZATION);
    assertPermission(coreActor, Permission.DECRYPT_FENCED_JOB_SECRET);
    if (!secretBoundary || typeof secretBoundary.withLease !== "function") throw new TypeError("secretBoundary is required");
    if (typeof dispatch !== "function") throw new TypeError("dispatch is required");

    const decision = this.#ledger.authorizeAndRecord(grant, request, now);
    let result;
    try {
      result = await secretBoundary.withLease(
        decision,
        (opaqueLease) => dispatch(decision, opaqueLease)
      );
      if (
        result === null
        || typeof result !== "object"
        || (result.outcome !== LiveOutcome.SUCCEEDED && !stopReasons.has(result.outcome))
      ) {
        throw new TypeError("worker returned an invalid result");
      }
    } catch {
      this.#ledger.stop(grant.authorizationId, StopReason.UNKNOWN);
      return evidenceFor(decision, { outcome: StopReason.UNKNOWN });
    }

    if (stopReasons.has(result.outcome)) this.#ledger.stop(grant.authorizationId, result.outcome);
    return evidenceFor(decision, result);
  }
}

function evidenceFor(decision, result) {
  return Object.freeze({
    authorizationId: decision.authorizationId,
    actionId: decision.actionId,
    artifactDigest: decision.artifactDigest,
    operation: decision.operation,
    outcome: result.outcome,
    nativeId: typeof result.nativeId === "string" ? result.nativeId : null,
    canonicalUrl: typeof result.canonicalUrl === "string" ? result.canonicalUrl : null
  });
}
