import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRuntime } from "@social-git/core";
import {
  Permission,
  assertPermission,
  liveTestGrantFingerprint,
  type LiveTestGrant,
  type TrustedActor,
} from "@social-git/security";
import { X_TRANSPORT_ADMISSION } from "@social-git/x-adapter";
import { ServiceError, toPublicError } from "./errors.ts";
import type { Principal, SocialGitService } from "./service.ts";
import { admissionExecutionChallenge, admissionProofRequestDigest } from "./admission-envelope.ts";
import { XRuntimeError, type CoreXTransportProvider } from "./runtime-x.ts";
import type { CoreRedditTransportProvider } from "./runtime-reddit.ts";

const PATH = "/v1/control-plane/admission";
const PROOF_PATH = /^\/v1\/control-plane\/admission\/proofs\/([A-Za-z0-9-]{36})(?:\/(execute|evidence))?$/u;
const TERMINAL_ACTIONS = new Set(["succeeded", "failed", "action_required", "UNKNOWN", "cancelled"]);
const MAX_TTL_SECONDS = 900;

/**
 * The single source of truth for the platforms an admission proof row may
 * carry. The table's CHECK constraint is generated from this list.
 *
 * Widening this list is not sufficient on its own. The table is created with
 * `CREATE TABLE IF NOT EXISTS`, which never alters an existing table, so an
 * upgraded installation would keep the old constraint and reject the new
 * platform at insert time. `ensureAdmissionProofSchema()` closes that gap by
 * comparing the stored definition with the current one and rebuilding the
 * table when they differ.
 */
export const ADMISSION_PROOF_PLATFORMS = Object.freeze(["reddit", "x"] as const);

const PROOF_PLATFORM_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

/**
 * The table definition. Column order is part of the on-disk contract and is
 * preserved verbatim; `columns` is also the copy list used by the rebuild so
 * the DDL and the migration can never drift apart.
 */
const ADMISSION_PROOF_TABLE = Object.freeze({
  name: "admission_proofs",
  index: "CREATE INDEX IF NOT EXISTS admission_proofs_authorization ON admission_proofs(authorization_id, executed_at)",
  columns: Object.freeze([
    "id",
    "authorization_id",
    "requester_id",
    "account_id",
    "platform",
    "proof_kind",
    "operation",
    "target_id",
    "target_digest",
    "parent_proof_id",
    "request_digest",
    "state",
    "action_id",
    "result_digest",
    "error_code",
    "created_at",
    "expires_at",
    "executed_at",
    "finalized_at",
    "execute_count",
    "evidence_json",
    "evidence_digest",
    "evidence_signature",
  ] as const),
});

function admissionProofTableSql(table: string, platforms: readonly string[], options: { ifNotExists?: boolean } = {}) {
  const literal = platforms.map((platform) => `'${platform}'`).join(",");
  return `CREATE TABLE ${options.ifNotExists ? "IF NOT EXISTS " : ""}${table} (
      id TEXT PRIMARY KEY,
      authorization_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN (${literal})),
      proof_kind TEXT NOT NULL CHECK(proof_kind IN ('identity','read','canary_write','canary_cleanup')),
      operation TEXT NOT NULL,
      target_id TEXT,
      target_digest TEXT,
      parent_proof_id TEXT,
      request_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      action_id TEXT,
      result_digest TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      executed_at TEXT,
      finalized_at TEXT,
      execute_count INTEGER NOT NULL DEFAULT 0 CHECK(execute_count BETWEEN 0 AND 1),
      evidence_json TEXT,
      evidence_digest TEXT,
      evidence_signature TEXT
    )`;
}

/**
 * Compare stored DDL with current DDL ignoring the differences SQLite itself
 * introduces on rewrite: a dropped `IF NOT EXISTS`, re-quoted identifiers, and
 * any whitespace/line-break reformatting. Everything else must match exactly,
 * so an unrelated schema change still triggers a rebuild rather than being
 * silently accepted.
 */
function normalizeDdl(sql: string) {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/giu, " ")
    .replace(/"/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Create the admission-proof table, or rebuild it when its stored platform
 * constraint no longer matches `ADMISSION_PROOF_PLATFORMS`.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot widen a CHECK constraint on an existing
 * database, so a deployment upgraded across a platform addition would keep
 * rejecting the new platform at insert time. This applies SQLite's documented
 * table-rebuild procedure:
 *
 *   foreign_keys OFF -> BEGIN -> create new table -> copy rows -> drop old ->
 *   rename -> recreate indexes/triggers -> `PRAGMA foreign_key_check` ->
 *   COMMIT -> foreign_keys ON
 *
 * It is idempotent (a matching table is left untouched), preserves every row,
 * and fails closed with nothing changed if a row carries a platform outside the
 * current set or the table is otherwise not the shape this code writes.
 */
export function ensureAdmissionProofSchema(db: DatabaseSync, options: { platforms?: readonly string[] } = {}) {
  const platforms = options.platforms ?? ADMISSION_PROOF_PLATFORMS;
  for (const platform of platforms) {
    if (typeof platform !== "string" || !PROOF_PLATFORM_PATTERN.test(platform)) {
      throw new TypeError("Admission proof platforms must be short lowercase identifiers");
    }
  }
  if (new Set(platforms).size !== platforms.length || platforms.length === 0) {
    throw new TypeError("Admission proof platforms must be a non-empty, unique list");
  }
  db.exec(admissionProofTableSql(ADMISSION_PROOF_TABLE.name, platforms, { ifNotExists: true }));
  db.exec(ADMISSION_PROOF_TABLE.index);

  const stored = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(ADMISSION_PROOF_TABLE.name) as { sql?: string | null } | undefined;
  const expected = admissionProofTableSql(ADMISSION_PROOF_TABLE.name, platforms);
  if (typeof stored?.sql === "string" && normalizeDdl(stored.sql) === normalizeDdl(expected)) return { migrated: false };

  // The stored table predates the current definition. Refuse to touch anything
  // we cannot copy faithfully, before writing a single row.
  const table = ADMISSION_PROOF_TABLE.name;
  const storedColumns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  const missing = ADMISSION_PROOF_TABLE.columns.filter((column) => !storedColumns.includes(column));
  if (missing.length > 0) {
    throw new ServiceError("INTERNAL", `The admission proof table cannot be migrated: columns ${missing.join(", ")} are missing.`);
  }
  const allowed = new Set(platforms);
  const rejected = db.prepare(`SELECT DISTINCT platform FROM ${table}`).all() as Array<{ platform: unknown }>;
  const unknown = rejected.map((row) => String(row.platform)).filter((platform) => !allowed.has(platform));
  if (unknown.length > 0) {
    throw new ServiceError("INTERNAL", `The admission proof table cannot be migrated: existing rows use unsupported platforms ${unknown.sort().join(", ")}.`);
  }

  const dependent = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name")
    .all(table) as Array<{ type: string; name: string; sql: string }>;
  const foreignKeys = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined)?.foreign_keys ?? 0) === 1;
  // The table is a rowid table with an implicit `rowid`. Carry it across so row
  // identity and relative order are preserved exactly, not just column values.
  let hasRowid = true;
  try { db.prepare(`SELECT rowid FROM ${table} LIMIT 0`).all(); }
  catch { hasRowid = false; }
  const columnList = storedColumns.join(", ");
  const copyColumns = hasRowid ? `rowid, ${columnList}` : columnList;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(admissionProofTableSql(`${table}_rebuild`, platforms));
      db.exec(`INSERT INTO ${table}_rebuild (${copyColumns}) SELECT ${copyColumns} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_rebuild RENAME TO ${table}`);
      for (const entry of dependent) db.exec(entry.sql);
      db.exec(ADMISSION_PROOF_TABLE.index);
      if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
        throw new ServiceError("INTERNAL", "The admission proof table failed its foreign-key check during migration.");
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  } finally {
    if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
  return { migrated: true };
}

export type AdmissionProofKind = "identity" | "read" | "canary_write" | "canary_cleanup";
type ProofState = "authorized" | "executing" | "succeeded" | "failed" | "action_required" | "UNKNOWN" | "blocked" | "expired";

interface StoredProof {
  id: string;
  authorizationId: string;
  requesterId: string;
  accountId: string;
  platform: "reddit" | "x";
  proofKind: AdmissionProofKind;
  operation: string;
  targetId: string | null;
  targetDigest: string | null;
  parentProofId: string | null;
  requestDigest: string;
  state: ProofState;
  actionId: string | null;
  resultDigest: string | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  finalizedAt: string | null;
  executeCount: number;
  evidence: Record<string, unknown> | null;
  evidenceDigest: string | null;
  evidenceSignature: string | null;
}

interface AdmissionProofOptions {
  databasePath: string;
  evidenceSigner: { fingerprint: string; sign(payload: Uint8Array): string; verify(payload: Uint8Array, signature: string): boolean; close?(): void };
  grant: LiveTestGrant;
  qaOperator: TrustedActor;
  qaKeyFingerprint: string;
  approverKeyFingerprint: string;
  sourceCommit: string;
  compatibilityEvidenceDigest: string;
  deploymentId: string;
  tenantId: string;
  verifyExecutionChallenge(challenge: string, signature: string): boolean;
  sessionRuntime: SessionRuntime;
  service: SocialGitService;
  wakeAction(): void;
  xCertificationProvider?: CoreXTransportProvider;
  redditCertificationProvider?: CoreRedditTransportProvider;
  now?: () => number;
}

export class AdmissionProofCoordinator {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly grantFingerprint: string;
  private readonly options: AdmissionProofOptions;

  constructor(options: AdmissionProofOptions) {
    this.options = options;
    assertPermission(options.qaOperator, Permission.EXECUTE_APPROVED_LIVE_TEST!);
    if (options.qaOperator.actorId !== options.grant.qaOperatorId) throw new TypeError("The admission executor does not match the approved grant");
    this.now = options.now ?? Date.now;
    this.grantFingerprint = liveTestGrantFingerprint(options.grant);
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    ensureAdmissionProofSchema(this.db);
    this.reconcileInterruptedProofs();
  }

  summary() {
    const grant = this.options.grant;
    const timestamp = this.now();
    return {
      schema: "social-git.admission-workflow/v1",
      enabled: timestamp >= grant.notBefore && timestamp < grant.expiresAt,
      active: timestamp >= grant.notBefore && timestamp < grant.expiresAt,
      configured: true,
      approval: {
        authorizationId: grant.authorizationId,
        grantFingerprint: this.grantFingerprint,
        approverId: grant.approverId,
        approverKeyFingerprint: this.options.approverKeyFingerprint,
        qaOperatorId: grant.qaOperatorId,
        qaKeyFingerprint: this.options.qaKeyFingerprint,
        identitiesDistinct: grant.approverId !== grant.qaOperatorId,
        notBefore: new Date(grant.notBefore).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
        actionLimit: grant.actionLimit,
      },
      release: { sourceCommit: this.options.sourceCommit, compatibilityEvidenceDigest: this.options.compatibilityEvidenceDigest, evidenceKeyFingerprint: this.options.evidenceSigner.fingerprint, deploymentId: this.options.deploymentId, ledgerId: grant.ledgerId },
      binding: {
        platform: grant.platform,
        accountIdDigest: digestText(grant.canaryAccountId),
        expectedIdentityDigest: digestText(grant.expectedNativeIdentity),
        sessionGeneration: grant.sessionGeneration,
        routeIdDigest: digestText(grant.routeId),
        readOperations: grant.readOperations,
        writeOperations: grant.writeOperations,
        cleanupOperation: grant.cleanupOperation,
      },
      xAdmission: xAdmissionSummary(),
      mcpExposed: false,
    };
  }

  prepare(owner: Principal, input: unknown) {
    requireOwner(owner);
    const body = exactObject(input, ["accountId", "proofKind", "targetId", "parentProofId", "expiresInSeconds", "confirmation"]);
    const accountId = bounded(body.accountId, "accountId", 128, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
    const proofKind = bounded(body.proofKind, "proofKind", 32, /^(?:identity|read|canary_write|canary_cleanup)$/u) as AdmissionProofKind;
    const targetId = body.targetId === null ? null : bounded(body.targetId, "targetId", 128, /^[A-Za-z0-9_:-]+$/u);
    const parentProofId = body.parentProofId === null ? null : bounded(body.parentProofId, "parentProofId", 36, /^[A-Fa-f0-9-]{36}$/u);
    const ttl = integer(body.expiresInSeconds, "expiresInSeconds", 60, MAX_TTL_SECONDS);
    const account = this.options.service.store.getAccount(accountId);
    const confirmation = `PREPARE ${account.platform} ${proofKind} ${accountId}`;
    if (body.confirmation !== confirmation) throw new ServiceError("FORBIDDEN", `Explicit confirmation must equal: ${confirmation}`);
    if (accountId !== this.options.grant.canaryAccountId || account.platform !== this.options.grant.platform) {
      throw new ServiceError("FORBIDDEN", "The proof request is outside the independently approved canary binding.");
    }
    const operation = operationFor(account.platform as "reddit" | "x", proofKind);
    this.validateGrant(operation, proofKind, accountId, targetId);
    if (proofKind === "canary_cleanup") {
      if (!parentProofId) throw new ServiceError("VALIDATION_FAILED", "parentProofId is required for cleanup.");
      const parent = this.getStored(parentProofId);
      if (parent.requesterId !== owner.callerId || parent.proofKind !== "canary_write" || !["succeeded", "UNKNOWN"].includes(parent.state) || parent.accountId !== accountId || parent.targetDigest !== (targetId ? digestText(targetId) : null)) {
        throw new ServiceError("FORBIDDEN", "Cleanup must bind the exact terminal canary write and resource.");
      }
    } else if (parentProofId !== null) throw new ServiceError("VALIDATION_FAILED", "Only cleanup accepts parentProofId.");
    this.validateSessionBinding(accountId);
    const timestamp = this.now();
    if (timestamp < this.options.grant.notBefore || timestamp >= this.options.grant.expiresAt) throw new ServiceError("FORBIDDEN", "The independent live-proof approval is not currently valid.");
    const expiresAt = Math.min(timestamp + ttl * 1000, this.options.grant.expiresAt);
    const id = randomUUID();
    const requestDigest = admissionProofRequestDigest(this.proofRequest({ id, accountId, platform: account.platform as "reddit" | "x", proofKind, operation, targetDigest: targetId ? digestText(targetId) : null, parentProofId, expiresAt: iso(expiresAt) }));
    this.db.prepare(`INSERT INTO admission_proofs(
      id, authorization_id, requester_id, account_id, platform, proof_kind, operation,
      target_id, target_digest, parent_proof_id, request_digest, state, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?)`)
      .run(id, this.options.grant.authorizationId, owner.callerId, accountId, account.platform, proofKind, operation,
        targetId, targetId ? digestText(targetId) : null, parentProofId, requestDigest, iso(timestamp), iso(expiresAt));
    this.audit(owner.callerId, accountId, "admission.proof.prepared", "succeeded", { proofId: id, proofKind, operation, expiresAt: iso(expiresAt) });
    const proof = this.getStored(id);
    const proofRequest = this.proofRequest(proof);
    return {
      proof: this.publicProof(proof),
      proofRequest,
      proofRequestDigest: admissionProofRequestDigest(proofRequest),
      requiredExecutionConfirmation: `EXECUTE ${id} ${operation}`,
      qaExecutionChallenge: admissionExecutionChallenge({ proofDigest: proof.requestDigest, expiresAt: proof.expiresAt, grantFingerprint: this.grantFingerprint }),
    };
  }

  async execute(owner: Principal, proofId: string, input: unknown) {
    requireOwner(owner);
    const body = exactObject(input, ["confirmation", "qaExecutionSignature"]);
    const proof = this.refresh(proofId);
    if (proof.requesterId !== owner.callerId) throw new ServiceError("FORBIDDEN", "Only the owner who prepared this proof can present it for execution.");
    if (body.confirmation !== `EXECUTE ${proof.id} ${proof.operation}`) throw new ServiceError("FORBIDDEN", "The execution confirmation does not match this exact proof.");
    const qaExecutionSignature = bounded(body.qaExecutionSignature, "qaExecutionSignature", 128, /^[A-Za-z0-9_-]{86}$/u);
    const challenge = admissionExecutionChallenge({ proofDigest: proof.requestDigest, expiresAt: proof.expiresAt, grantFingerprint: this.grantFingerprint });
    if (!this.options.verifyExecutionChallenge(challenge, qaExecutionSignature)) throw new ServiceError("UNAUTHENTICATED", "The independent QA execution signature is invalid.");
    if (proof.state !== "authorized" || proof.executeCount !== 0) throw new ServiceError("ACTION_STATE_CONFLICT", "The proof authorization is single-use.");
    const timestamp = this.now();
    if (timestamp < this.options.grant.notBefore || timestamp >= Date.parse(proof.expiresAt) || timestamp >= this.options.grant.expiresAt) {
      const beforeWindow = timestamp < this.options.grant.notBefore;
      this.db.prepare("UPDATE admission_proofs SET state=?, error_code=?, finalized_at=? WHERE id=? AND state='authorized'").run(beforeWindow ? "blocked" : "expired", beforeWindow ? "AUTHORIZATION_NOT_ACTIVE" : "AUTHORIZATION_EXPIRED", iso(timestamp), proof.id);
      return { proof: this.publicProof(this.refresh(proof.id)) };
    }
    this.validateSessionBinding(proof.accountId);
    this.consumeAuthorization(proof, timestamp);
    this.audit(owner.callerId, proof.accountId, "admission.proof.executed", "pending", {
      proofId: proof.id, operation: proof.operation, qaOperatorId: this.options.qaOperator.actorId,
    });

    if (proof.platform === "x" && !xCommittedAdmissionComplete() && !this.options.xCertificationProvider) {
      this.finalize(proof.id, "blocked", "X_TRANSPORT_NOT_ADMITTED", null);
      return { proof: this.publicProof(this.getStored(proof.id)), evidence: this.evidenceFor(owner, proof.id) };
    }

    try {
      if (proof.proofKind === "identity" || proof.proofKind === "read") {
        const result = await this.executeRead(owner, proof, qaExecutionSignature);
        this.finalize(proof.id, "succeeded", null, canonicalDigest(result));
        return { proof: this.publicProof(this.getStored(proof.id)), evidence: this.evidenceFor(owner, proof.id) };
      }
      if (proof.platform === "reddit" && this.options.redditCertificationProvider) {
        const result = await this.executeRedditProof(proof, "write");
        if (!sameRedditNativeId(result.native?.nativeId, proof.targetId)) {
          throw new XRuntimeError("UNKNOWN", "The Reddit canary write result did not bind the signed target.", { submissionMayHaveStarted: true });
        }
        this.finalize(proof.id, "succeeded", null, canonicalDigest(result.data));
        return { proof: this.publicProof(this.getStored(proof.id)), evidence: this.evidenceFor(owner, proof.id) };
      }
      if (proof.platform === "x" && this.options.xCertificationProvider) {
        const result = await this.options.xCertificationProvider.execute({
          account: this.options.service.store.getAccount(proof.accountId), intent: "write", operation: "bookmark.set",
          payload: { postId: proof.targetId!, enabled: proof.proofKind !== "canary_cleanup" }, requestId: proof.requestDigest,
          certification: { proofDigest: proof.requestDigest, proofRequest: this.proofRequest(proof), expiresAt: proof.expiresAt, qaExecutionSignature },
        });
        if (result.native?.nativeId !== proof.targetId) throw new XRuntimeError("UNKNOWN", "The X canary write result did not bind the signed target.", { submissionMayHaveStarted: true });
        this.finalize(proof.id, "succeeded", null, canonicalDigest(result.data));
        return { proof: this.publicProof(this.getStored(proof.id)), evidence: this.evidenceFor(owner, proof.id) };
      }
      const request = writeRequest(proof);
      const idempotencyKey = `admission-proof:${proof.id}`;
      let queued;
      try {
        queued = await this.options.service.enqueueAction(owner, proof.accountId, idempotencyKey, request, proof.platform === "x" ? "x.actions.create" : "actions.create");
      } catch (error) {
        const durable = this.options.service.store.findActionByIdempotency({ callerId: owner.callerId, accountId: proof.accountId, idempotencyKey, request });
        if (!durable) throw error;
        this.db.prepare("UPDATE admission_proofs SET action_id=? WHERE id=?").run(durable.id, proof.id);
        this.options.wakeAction();
        return { proof: this.publicProof(this.getStored(proof.id)) };
      }
      if (queued.replayed) throw new ServiceError("ACTION_STATE_CONFLICT", "The canary proof idempotency key was already consumed.");
      this.db.prepare("UPDATE admission_proofs SET action_id=? WHERE id=?").run(queued.action.id, proof.id);
      this.options.wakeAction();
      return { proof: this.publicProof(this.getStored(proof.id)) };
    } catch (error) {
      const code = safeErrorCode(error);
      const ambiguous = proof.proofKind.startsWith("canary_") && ((error as { submissionMayHaveStarted?: unknown })?.submissionMayHaveStarted === true || code === "UNKNOWN");
      this.finalize(proof.id, ambiguous ? "UNKNOWN" : code === "CHALLENGE_REQUIRED" || code === "CHECKPOINT_REQUIRED" || code === "CAPTCHA_REQUIRED" ? "action_required" : "failed", code, null);
      return { proof: this.publicProof(this.getStored(proof.id)), evidence: this.evidenceFor(owner, proof.id) };
    }
  }

  get(owner: Principal, proofId: string) {
    requireOwner(owner);
    const proof = this.refresh(proofId);
    if (proof.requesterId !== owner.callerId) throw new ServiceError("FORBIDDEN", "The proof belongs to another requester.");
    return { proof: this.publicProof(proof), ...(proof.evidence ? { evidence: this.evidenceFor(owner, proof.id) } : {}) };
  }

  evidenceFor(owner: Principal, proofId: string) {
    requireOwner(owner);
    const proof = this.getStored(proofId);
    if (proof.requesterId !== owner.callerId) throw new ServiceError("FORBIDDEN", "The proof belongs to another requester.");
    if (!proof.evidence || !proof.evidenceDigest || !proof.evidenceSignature) throw new ServiceError("ACTION_STATE_CONFLICT", "Admission evidence is not terminal yet.");
    const encoded = Buffer.from(canonicalJson(proof.evidence));
    const expectedDigest = `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
    const valid = expectedDigest === proof.evidenceDigest && this.options.evidenceSigner.verify(encoded, proof.evidenceSignature);
    encoded.fill(0);
    return {
      bundle: proof.evidence,
      digest: proof.evidenceDigest,
      signature: { algorithm: "Ed25519", publicKeyFingerprint: this.options.evidenceSigner.fingerprint, value: proof.evidenceSignature },
      verification: { valid },
    };
  }

  close() { try { this.db.close(); } finally { this.options.evidenceSigner.close?.(); } }

  private async executeRead(owner: Principal, proof: StoredProof, qaExecutionSignature: string) {
    if (proof.platform === "x" && this.options.xCertificationProvider) {
      const result = await this.options.xCertificationProvider.execute({
        account: this.options.service.store.getAccount(proof.accountId),
        intent: proof.proofKind === "identity" ? "identity_validation" : "read",
        operation: proof.proofKind === "identity" ? "account.identity" : "post.get",
        payload: proof.proofKind === "identity" ? {} : { postId: proof.targetId! }, requestId: proof.requestDigest,
        certification: { proofDigest: proof.requestDigest, proofRequest: this.proofRequest(proof), expiresAt: proof.expiresAt, qaExecutionSignature },
      });
      if (proof.proofKind === "identity") {
        const nativeId = findNativeId(result.data);
        if (nativeId !== this.options.grant.expectedNativeIdentity) throw new ServiceError("WRONG_IDENTITY", "The admission proof observed the wrong native identity.");
      }
      if (proof.proofKind === "read" && findNativeId(result.data) !== proof.targetId) throw new ServiceError("PROTOCOL_DRIFT", "The X read result did not bind the signed target.");
      return result.data;
    }
    if (proof.platform === "reddit" && this.options.redditCertificationProvider) {
      const result = await this.executeRedditProof(proof, proof.proofKind === "identity" ? "identity_validation" : "read");
      const observedNativeId = result.native?.nativeId ?? findNativeId(result.data);
      if (proof.proofKind === "identity" && normalizeRedditIdentity(observedNativeId) !== normalizeRedditIdentity(this.options.grant.expectedNativeIdentity)) {
        throw new ServiceError("WRONG_IDENTITY", "The admission proof observed the wrong native identity.");
      }
      if (proof.proofKind === "read" && !sameRedditNativeId(observedNativeId, proof.targetId)) {
        throw new ServiceError("PROTOCOL_DRIFT", "The Reddit read result did not bind the signed target.");
      }
      return result.data;
    }
    const result = proof.platform === "reddit"
      ? await this.options.service.read(owner, proof.accountId, proof.proofKind === "identity" ? "reads.profile" : "reads.post", proof.proofKind === "identity" ? { kind: "profile" } : { kind: "post", postId: proof.targetId! })
      : await this.options.service.read(owner, proof.accountId, proof.proofKind === "identity" ? "x.account.health" : "x.posts.get", proof.proofKind === "identity" ? { kind: "x_account_health" } : { kind: "x_post", postId: proof.targetId! });
    if (proof.proofKind === "identity") {
      const nativeId = findNativeId(result);
      const expected = proof.platform === "reddit" ? normalizeRedditIdentity(this.options.grant.expectedNativeIdentity) : this.options.grant.expectedNativeIdentity;
      const observed = proof.platform === "reddit" ? normalizeRedditIdentity(nativeId) : nativeId;
      if (observed !== expected) throw new ServiceError("WRONG_IDENTITY", "The admission proof observed the wrong native identity.");
    }
    return result;
  }

  private executeRedditProof(proof: StoredProof, intent: "identity_validation" | "read" | "write") {
    const operation = proof.proofKind === "identity" ? "profile.get"
      : proof.proofKind === "read" ? "post.get"
        : proof.proofKind === "canary_cleanup" ? "reddit.item.unsave" : "reddit.item.save";
    const payload = proof.proofKind === "identity" ? {}
      : proof.proofKind === "read" ? { nativeId: proof.targetId! }
        : { targetId: proof.targetId! };
    return this.options.redditCertificationProvider!.execute({
      account: this.options.service.store.getAccount(proof.accountId), vaultHandle: "admission-proof", intent, operation, payload,
      expectedBinding: { generation: this.options.grant.sessionGeneration, routeId: this.options.grant.routeId, nativeIdentity: this.options.grant.expectedNativeIdentity, requestId: proof.requestDigest },
    });
  }

  private refresh(proofId: string) {
    const proof = this.getStored(proofId);
    if (proof.state !== "executing" || !proof.actionId) return proof;
    const action = this.options.service.store.getActionInternal(proof.actionId);
    if (!TERMINAL_ACTIONS.has(action.state)) return proof;
    const state = action.state === "succeeded" ? "succeeded" : action.state === "UNKNOWN" ? "UNKNOWN" : action.state === "action_required" ? "action_required" : "failed";
    const digest = action.result ? canonicalDigest(action.result) : null;
    const code = action.error && typeof action.error === "object" && "code" in action.error ? String((action.error as { code: unknown }).code) : (action.state === "cancelled" ? "CANCELLED" : null);
    this.finalize(proof.id, state, code, digest);
    return this.getStored(proof.id);
  }

  private reconcileInterruptedProofs() {
    const rows = this.db.prepare("SELECT * FROM admission_proofs WHERE state='executing'").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const proof = rowToProof(row);
      if (proof.actionId) continue;
      if (proof.platform === "reddit" && (proof.proofKind === "canary_write" || proof.proofKind === "canary_cleanup")) {
        const request = writeRequest(proof);
        const durable = this.options.service.store.findActionByIdempotency({
          callerId: proof.requesterId, accountId: proof.accountId, idempotencyKey: `admission-proof:${proof.id}`, request,
        });
        if (durable) {
          this.db.prepare("UPDATE admission_proofs SET action_id=? WHERE id=? AND state='executing' AND action_id IS NULL").run(durable.id, proof.id);
          continue;
        }
      }
      const write = proof.proofKind === "canary_write" || proof.proofKind === "canary_cleanup";
      this.finalize(proof.id, write ? "UNKNOWN" : "failed", write ? "INTERRUPTED_WRITE_UNKNOWN" : "INTERRUPTED_BEFORE_RESULT", null);
    }
  }

  private finalize(proofId: string, state: ProofState, errorCode: string | null, resultDigest: string | null) {
    const proof = this.getStored(proofId);
    if (proof.evidence) return;
    const bundle = {
      schema: "social-git.admission-evidence/v1",
      proofId: proof.id,
      authorizationId: proof.authorizationId,
      grantFingerprint: this.grantFingerprint,
      proofRequestDigest: proof.requestDigest,
      proofRequest: this.proofRequest(proof),
      approval: {
        approverId: this.options.grant.approverId,
        approverRole: this.options.grant.approverRole,
        approverKeyFingerprint: this.options.approverKeyFingerprint,
        qaOperatorId: this.options.grant.qaOperatorId,
        qaOperatorRole: this.options.grant.qaOperatorRole,
        qaKeyFingerprint: this.options.qaKeyFingerprint,
        identitiesDistinct: this.options.grant.approverId !== this.options.grant.qaOperatorId,
      },
      binding: {
        platform: proof.platform,
        accountIdDigest: digestText(proof.accountId),
        expectedIdentityDigest: digestText(this.options.grant.expectedNativeIdentity),
        sessionGeneration: this.options.grant.sessionGeneration,
        routeIdDigest: digestText(this.options.grant.routeId),
        targetDigest: proof.targetDigest,
      },
      proof: { kind: proof.proofKind, operation: proof.operation, singleAttempt: true, automaticRetry: false },
      cleanup: proof.proofKind === "canary_write"
        ? { required: true, parentProofId: null, workflowComplete: false }
        : proof.proofKind === "canary_cleanup"
          ? { required: true, ...this.parentEvidenceLink(proof), workflowComplete: state === "succeeded" && this.parentEvidenceLink(proof).parentEvidenceVerified }
          : { required: false, parentProofId: null, workflowComplete: state === "succeeded" },
      outcome: { state, errorCode, resultDigest, actionId: proof.actionId },
      deployment: {
        environment: this.options.grant.environment,
        artifactDigest: this.options.grant.artifactDigest,
        sbomDigest: this.options.grant.sbomDigest,
        priorTestEvidenceDigest: this.options.grant.testEvidenceDigest,
        sourceCommit: this.options.sourceCommit,
        compatibilityEvidenceDigest: this.options.compatibilityEvidenceDigest,
        evidenceKeyFingerprint: this.options.evidenceSigner.fingerprint,
        deploymentId: this.options.deploymentId,
        tenantId: this.options.tenantId,
        ledgerId: this.options.grant.ledgerId,
      },
      xAdmission: proof.platform === "x" ? xAdmissionSummary() : null,
      occurredAt: iso(this.now()),
    };
    const encoded = Buffer.from(canonicalJson(bundle));
    const evidenceDigest = `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
    const evidenceSignature = this.options.evidenceSigner.sign(encoded);
    encoded.fill(0);
    this.db.prepare(`UPDATE admission_proofs SET state=?, error_code=?, result_digest=?, finalized_at=?, evidence_json=?, evidence_digest=?, evidence_signature=?
      WHERE id=? AND evidence_json IS NULL`)
      .run(state, errorCode, resultDigest, iso(this.now()), JSON.stringify(bundle), evidenceDigest, evidenceSignature, proof.id);
    this.audit(proof.requesterId, proof.accountId, "admission.proof.finalized", state === "succeeded" ? "succeeded" : state, {
      proofId: proof.id, operation: proof.operation, evidenceDigest, errorCode,
    });
  }

  private validateGrant(operation: string, proofKind: AdmissionProofKind, accountId: string, targetId: string | null) {
    const writes = proofKind === "canary_write" || proofKind === "canary_cleanup";
    if (!(writes ? this.options.grant.writeOperations : this.options.grant.readOperations).includes(operation)) {
      throw new ServiceError("FORBIDDEN", "The exact proof operation is not in the independent approval.");
    }
    if (proofKind === "canary_cleanup" && this.options.grant.cleanupOperation !== operation) {
      throw new ServiceError("FORBIDDEN", "The cleanup proof does not match the approved cleanup operation.");
    }
    if (proofKind !== "identity" && !targetId) throw new ServiceError("VALIDATION_FAILED", "targetId is required for this proof.");
    if (proofKind === "identity" && targetId !== null) throw new ServiceError("VALIDATION_FAILED", "Identity proofs do not accept a targetId.");
    const resources: Record<string, string> = { accountId, proofKind, ...(targetId ? { targetId, postId: targetId } : {}) };
    for (const [name, value] of this.options.grant.resourceConstraints) {
      if (resources[name] !== value) throw new ServiceError("FORBIDDEN", `The proof does not satisfy the approved ${name} resource binding.`);
    }
  }

  private validateSessionBinding(accountId: string) {
    const state = this.options.sessionRuntime.getAccountState(accountId);
    if (state.expectedNativeIdentity !== this.options.grant.expectedNativeIdentity
      || state.generation !== this.options.grant.sessionGeneration
      || state.networkRouteId !== this.options.grant.routeId) {
      throw new ServiceError("FORBIDDEN", "The encrypted session generation or direct route no longer matches the approval.");
    }
  }

  private proofRequest(proof: Pick<StoredProof, "id" | "accountId" | "platform" | "proofKind" | "operation" | "targetDigest" | "parentProofId" | "expiresAt">) {
    return {
      schema: "social-git.admission-proof-request/v1", proofId: proof.id, tenantId: this.options.tenantId, ledgerId: this.options.grant.ledgerId,
      accountIdDigest: digestText(proof.accountId), platform: proof.platform, proofKind: proof.proofKind, operation: proof.operation,
      targetDigest: proof.targetDigest, parentProofId: proof.parentProofId, sessionGeneration: this.options.grant.sessionGeneration,
      routeIdDigest: digestText(this.options.grant.routeId), expiresAt: proof.expiresAt, grantFingerprint: this.grantFingerprint,
      evidenceKeyFingerprint: this.options.evidenceSigner.fingerprint, deploymentId: this.options.deploymentId,
    };
  }

  private consumeAuthorization(proof: StoredProof, timestamp: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = Number((this.db.prepare("SELECT COUNT(*) AS count FROM admission_proofs WHERE authorization_id=? AND execute_count=1").get(proof.authorizationId) as { count: number }).count);
      if (consumed >= this.options.grant.actionLimit) throw new ServiceError("FORBIDDEN", "The independently approved proof action limit is exhausted.");
      const result = this.db.prepare("UPDATE admission_proofs SET state='executing', execute_count=1, executed_at=? WHERE id=? AND state='authorized' AND execute_count=0").run(iso(timestamp), proof.id);
      if (result.changes !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "The proof authorization was already consumed.");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private parentEvidenceLink(proof: StoredProof) {
    if (!proof.parentProofId) return { parentProofId: null, parentRequestDigest: null, parentEvidenceDigest: null, parentResultDigest: null, parentEvidenceVerified: false };
    const parent = this.getStored(proof.parentProofId);
    if (!parent.evidence || !parent.evidenceDigest || !parent.evidenceSignature) return { parentProofId: parent.id, parentRequestDigest: parent.requestDigest, parentEvidenceDigest: null, parentResultDigest: parent.resultDigest, parentEvidenceVerified: false };
    const bytes = Buffer.from(canonicalJson(parent.evidence));
    try {
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      return { parentProofId: parent.id, parentRequestDigest: parent.requestDigest, parentEvidenceDigest: parent.evidenceDigest, parentResultDigest: parent.resultDigest, parentOutcomeState: parent.state, parentEvidenceVerified: digest === parent.evidenceDigest && this.options.evidenceSigner.verify(bytes, parent.evidenceSignature) && parent.state === "succeeded" };
    } finally { bytes.fill(0); }
  }

  private getStored(proofId: string): StoredProof {
    if (!/^[A-Fa-f0-9-]{36}$/u.test(proofId)) throw new ServiceError("VALIDATION_FAILED", "proofId is invalid.");
    const row = this.db.prepare("SELECT * FROM admission_proofs WHERE id=?").get(proofId) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Admission proof not found.");
    return rowToProof(row);
  }

  private publicProof(proof: StoredProof) {
    return {
      id: proof.id, authorizationId: proof.authorizationId, platform: proof.platform, proofKind: proof.proofKind,
      operation: proof.operation, targetDigest: proof.targetDigest, state: proof.state, actionId: proof.actionId,
      requestDigest: proof.requestDigest, parentProofId: proof.parentProofId,
      resultDigest: proof.resultDigest, errorCode: proof.errorCode, createdAt: proof.createdAt, expiresAt: proof.expiresAt,
      executedAt: proof.executedAt, finalizedAt: proof.finalizedAt, executeCount: proof.executeCount,
    };
  }

  private audit(callerId: string, accountId: string, type: string, outcome: string, data: Record<string, unknown>) {
    this.options.service.store.audit({ callerId, accountId, type, outcome, data });
  }
}

export class OwnerAdmissionProofController {
  private readonly coordinator: AdmissionProofCoordinator;
  private readonly authenticateOwner: (request: IncomingMessage, csrfRequired: boolean) => Principal | null;
  constructor(coordinator: AdmissionProofCoordinator, authenticateOwner: (request: IncomingMessage, csrfRequired: boolean) => Principal | null) { this.coordinator = coordinator; this.authenticateOwner = authenticateOwner; }
  ownsPath(pathname: string) { return pathname === PATH || pathname === `${PATH}/proofs` || PROOF_PATH.test(pathname); }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!this.ownsPath(url.pathname)) return false;
    try {
      if (request.headers.authorization !== undefined) throw new ServiceError("FORBIDDEN", "Admission proofs are available only to the signed-in owner control plane.");
      if (request.headers["sec-fetch-site"] !== "same-origin") throw new ServiceError("FORBIDDEN", "Admission proofs require a same-origin browser request.");
      const mutation = request.method === "POST";
      if (mutation) {
        const origin = request.headers.origin;
        const host = request.headers.host;
        if (typeof origin !== "string" || typeof host !== "string" || new URL(origin).host !== host) throw new ServiceError("FORBIDDEN", "Admission mutations require the exact same origin.");
      }
      if (mutation && String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new ServiceError("VALIDATION_FAILED", "Admission mutations require application/json.", { status: 415 });
      const owner = this.authenticateOwner(request, mutation);
      if (!owner) throw new ServiceError("UNAUTHENTICATED", "A valid owner session and fresh CSRF token are required.");
      requireOwner(owner);
      if (request.method === "GET" && url.pathname === PATH) return sendJson(response, 200, this.coordinator.summary());
      if (request.method === "POST" && url.pathname === `${PATH}/proofs`) return sendJson(response, 201, this.coordinator.prepare(owner, await readJson(request)));
      const match = PROOF_PATH.exec(url.pathname);
      if (!match) throw new ServiceError("NOT_FOUND", "Route not found.");
      const proofId = match[1]!;
      if (request.method === "GET" && !match[2]) return sendJson(response, 200, this.coordinator.get(owner, proofId));
      if (request.method === "GET" && match[2] === "evidence") return sendJson(response, 200, this.coordinator.evidenceFor(owner, proofId));
      if (request.method === "POST" && match[2] === "execute") {
        return sendJson(response, 200, await this.coordinator.execute(owner, proofId, await readJson(request)));
      }
      throw new ServiceError("NOT_FOUND", "Route not found.");
    } catch (error) {
      const requestId = response.getHeader("x-request-id");
      const safe = toPublicError(error, typeof requestId === "string" ? requestId : "unknown");
      return sendJson(response, safe.status, safe.body);
    }
  }
}

function operationFor(platform: "reddit" | "x", proofKind: AdmissionProofKind) {
  if (platform === "reddit") return proofKind === "identity" ? "reddit.account.identity" : proofKind === "read" ? "reddit.post.get" : proofKind === "canary_write" ? "reddit.item.save" : "reddit.item.unsave";
  return proofKind === "identity" ? "x.account.identity" : proofKind === "read" ? "x.post.get" : "x.bookmark.set";
}

function writeRequest(proof: StoredProof) {
  if (!proof.targetId) throw new ServiceError("PROTOCOL_DRIFT", "The canary proof target is missing.");
  if (proof.platform === "reddit") return proof.proofKind === "canary_cleanup" ? { kind: "unsave", targetId: proof.targetId } : { kind: "save", targetId: proof.targetId };
  return { kind: "x_bookmark_set", postId: proof.targetId, enabled: proof.proofKind !== "canary_cleanup" };
}

function rowToProof(row: Record<string, unknown>): StoredProof {
  return {
    id: String(row.id), authorizationId: String(row.authorization_id), requesterId: String(row.requester_id), accountId: String(row.account_id),
    platform: row.platform as "reddit" | "x", proofKind: row.proof_kind as AdmissionProofKind, operation: String(row.operation),
    targetId: row.target_id === null ? null : String(row.target_id), targetDigest: row.target_digest === null ? null : String(row.target_digest),
    parentProofId: row.parent_proof_id === null ? null : String(row.parent_proof_id), requestDigest: String(row.request_digest),
    state: row.state as ProofState, actionId: row.action_id === null ? null : String(row.action_id), resultDigest: row.result_digest === null ? null : String(row.result_digest),
    errorCode: row.error_code === null ? null : String(row.error_code), createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    executedAt: row.executed_at === null ? null : String(row.executed_at), finalizedAt: row.finalized_at === null ? null : String(row.finalized_at),
    executeCount: Number(row.execute_count), evidence: row.evidence_json === null ? null : JSON.parse(String(row.evidence_json)),
    evidenceDigest: row.evidence_digest === null ? null : String(row.evidence_digest), evidenceSignature: row.evidence_signature === null ? null : String(row.evidence_signature),
  };
}

function xCommittedAdmissionComplete() { return Boolean(X_TRANSPORT_ADMISSION.productionEnabled) && Object.values(X_TRANSPORT_ADMISSION.gates).every(Boolean) && X_TRANSPORT_ADMISSION.disabledReasons.length === 0; }
function xAdmissionSummary() { return { schema: X_TRANSPORT_ADMISSION.schema, sourceRevision: X_TRANSPORT_ADMISSION.sourceRevision, productionEnabled: X_TRANSPORT_ADMISSION.productionEnabled, gates: X_TRANSPORT_ADMISSION.gates, disabledReasons: X_TRANSPORT_ADMISSION.disabledReasons }; }
function digestText(value: string) { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function canonicalDigest(value: unknown) { return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`; return JSON.stringify(value); }
function iso(value: number) { return new Date(value).toISOString(); }
function safeErrorCode(error: unknown) { const value = (error as { code?: unknown })?.code; return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : "PROTOCOL_DRIFT"; }
function findNativeId(value: unknown): string | null { if (!value || typeof value !== "object") return null; const record = value as Record<string, unknown>; if (typeof record.nativeId === "string") return record.nativeId; for (const child of Object.values(record)) { const found = findNativeId(child); if (found) return found; } return null; }
function normalizeRedditIdentity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const native = value.startsWith("reddit:") ? value.slice("reddit:".length) : value;
  return /^t2_[a-z0-9]+$/u.test(native) ? native : null;
}
function sameRedditNativeId(observed: string | null | undefined, expected: string | null) {
  if (!observed || !expected) return false;
  const normalize = (value: string) => value.startsWith("reddit:") ? value.slice("reddit:".length) : value;
  return normalize(observed) === normalize(expected);
}
function requireOwner(principal: Principal) { if (principal.role !== "owner") throw new ServiceError("FORBIDDEN", "Only the signed-in owner can use the admission workflow."); }
function bounded(value: unknown, field: string, maximum: number, pattern: RegExp) { if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) throw new ServiceError("VALIDATION_FAILED", `${field} is invalid.`, { details: { field } }); return value; }
function integer(value: unknown, field: string, minimum: number, maximum: number) { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new ServiceError("VALIDATION_FAILED", `${field} is invalid.`, { details: { field } }); return Number(value); }
function exactObject(value: unknown, keys: readonly string[]) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ServiceError("VALIDATION_FAILED", "Request body must be a plain object."); const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ServiceError("VALIDATION_FAILED", "Request body fields are not exact."); return value as Record<string, unknown>; }
async function readJson(request: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; try { for await (const chunk of request) { const copy = Buffer.from(chunk); size += copy.length; if (size > 16_384) { copy.fill(0); throw new ServiceError("VALIDATION_FAILED", "Admission request exceeds 16384 bytes.", { status: 413 }); } chunks.push(copy); } const joined = Buffer.concat(chunks, size); try { const parsed: unknown = JSON.parse(joined.toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new ServiceError("VALIDATION_FAILED", "Request body must be a plain object."); return parsed; } finally { joined.fill(0); } } finally { for (const chunk of chunks) chunk.fill(0); } }
function sendJson(response: ServerResponse, status: number, value: unknown): true { const body = JSON.stringify(value); response.statusCode = status; response.setHeader("cache-control", "no-store"); response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("content-length", Buffer.byteLength(body)); response.end(body); return true; }
