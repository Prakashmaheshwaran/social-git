import { decodeWorkerMessage, encodeWorkerMessage, type WorkerCommand } from "@social-git/core";
import { liveTestGrantFingerprint, type LiveTestGrant } from "@social-git/security";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { admissionExecutionChallenge, admissionProofRequestDigest, type VerifiedAdmissionEnvelope } from "./admission-envelope.ts";
import { XRuntimeError, type XCommandDispatcher, type XCommandExecution } from "./runtime-x.ts";

/** Worker-side, certification-only admission. It never changes product capability truth. */
export class CertificationOnlyXDispatcher implements XCommandDispatcher {
  private readonly db: DatabaseSync;
  private readonly grantFingerprint: string;
  private readonly delegate: XCommandDispatcher;
  private readonly envelope: VerifiedAdmissionEnvelope;
  private readonly now: () => number;
  constructor(delegate: XCommandDispatcher, envelope: VerifiedAdmissionEnvelope, databasePath: string, now: () => number = Date.now) {
    this.delegate = delegate;
    this.envelope = envelope;
    this.now = now;
    if (envelope.grant.platform !== "x") throw new TypeError("X certification requires an X grant");
    this.grantFingerprint = liveTestGrantFingerprint(envelope.grant);
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS consumed_x_certification_proofs (grant_fingerprint TEXT NOT NULL, authorization_id TEXT NOT NULL, proof_digest TEXT NOT NULL, consumed_at TEXT NOT NULL, PRIMARY KEY(grant_fingerprint, proof_digest));");
  }
  async ready() { const timestamp = this.now(); return timestamp >= this.envelope.grant.notBefore && timestamp < this.envelope.grant.expiresAt; }

  async execute(serialized: Uint8Array): Promise<XCommandExecution> {
    const decoded = decodeWorkerMessage(serialized);
    if (decoded.type !== "social-git.worker.command") throw new XRuntimeError("POLICY_DENIED", "Certification worker accepts commands only.");
    let forwarded: Uint8Array | undefined;
    try {
      const { proofDigest, proofRequest, expiresAt, qaExecutionSignature, operationPayload } = certificationPayload(decoded.payload);
      if (admissionProofRequestDigest(proofRequest) !== proofDigest) throw new XRuntimeError("POLICY_DENIED", "Certification proof digest does not match its canonical request.");
      const challenge = admissionExecutionChallenge({ proofDigest, expiresAt, grantFingerprint: this.grantFingerprint });
      if (!this.envelope.verifyExecutionChallenge(challenge, qaExecutionSignature)) throw new XRuntimeError("POLICY_DENIED", "Independent QA proof signature is invalid.");
      if (this.now() < this.envelope.grant.notBefore) throw new XRuntimeError("POLICY_DENIED", "Certification authorization is not active yet.");
      if (this.now() >= Date.parse(expiresAt) || this.now() >= this.envelope.grant.expiresAt) throw new XRuntimeError("POLICY_DENIED", "Certification authorization expired.");
      assertGrantBinding(decoded, this.envelope, proofDigest, proofRequest, operationPayload, expiresAt);
      assertResourceBinding(decoded.payload, this.envelope.grant);
      this.consume(proofDigest); // durable before any possible provider submission
      forwarded = encodeWorkerMessage({ ...decoded, payload: operationPayload });
      return await this.delegate.execute(forwarded);
    }
    finally {
      forwarded?.fill(0);
      decoded.sessionBase64 = "REDACTED";
      decoded.networkRoute.materialBase64 = "REDACTED";
    }
  }
  close() { this.delegate.close?.(); this.db.close(); }
  private consume(proofDigest: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM consumed_x_certification_proofs WHERE grant_fingerprint=? AND authorization_id=?").get(this.grantFingerprint, this.envelope.grant.authorizationId) as { count: number }).count);
      if (count >= this.envelope.grant.actionLimit) throw new XRuntimeError("POLICY_DENIED", "Certification action limit is exhausted.");
      this.db.prepare("INSERT INTO consumed_x_certification_proofs(grant_fingerprint, authorization_id, proof_digest, consumed_at) VALUES (?, ?, ?, ?)").run(this.grantFingerprint, this.envelope.grant.authorizationId, proofDigest, new Date(this.now()).toISOString());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); if (String((error as Error).message).includes("UNIQUE")) throw new XRuntimeError("POLICY_DENIED", "Certification proof is single-use."); throw error; }
  }
}

export function certificationPayloadFor(input: { proofDigest: string; proofRequest: Record<string, unknown>; expiresAt: string; qaExecutionSignature: string; operationPayload: Record<string, unknown> }) {
  return Object.freeze({ certification: Object.freeze({ schema: "social-git.x-certification-command/v1", proofDigest: input.proofDigest, proofRequest: structuredClone(input.proofRequest), expiresAt: input.expiresAt, qaExecutionSignature: input.qaExecutionSignature }), operationPayload: structuredClone(input.operationPayload) });
}

function certificationPayload(value: unknown) {
  const body = record(value);
  exact(body, ["certification", "operationPayload"]);
  const certification = record(body.certification);
  exact(certification, ["schema", "proofDigest", "proofRequest", "expiresAt", "qaExecutionSignature"]);
  if (certification.schema !== "social-git.x-certification-command/v1") throw new XRuntimeError("POLICY_DENIED", "Certification schema is invalid.");
  const proofDigest = bounded(certification.proofDigest, /^sha256:[a-f0-9]{64}$/u);
  const expiresAt = bounded(certification.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new XRuntimeError("POLICY_DENIED", "Certification expiry is invalid.");
  const qaExecutionSignature = bounded(certification.qaExecutionSignature, /^[A-Za-z0-9_-]{86}$/u);
  return { proofDigest, proofRequest: record(certification.proofRequest), expiresAt, qaExecutionSignature, operationPayload: record(body.operationPayload) };
}

function assertGrantBinding(command: WorkerCommand, envelope: VerifiedAdmissionEnvelope, proofDigest: string, proofRequest: Record<string, unknown>, operationPayload: Record<string, unknown>, expiresAt: string) {
  const grant = envelope.grant;
  const allowed = command.intent === "write" ? grant.writeOperations : grant.readOperations;
  if (command.requestId !== proofDigest || command.tenantId !== envelope.tenantId || command.platform !== "x" || command.accountId !== grant.canaryAccountId
    || command.generation !== grant.sessionGeneration || command.networkRoute.id !== grant.routeId
    || command.expectedNativeIdentity !== grant.expectedNativeIdentity || !allowed.includes(`x.${command.operation}`)) {
    throw new XRuntimeError("POLICY_DENIED", "Certification command is outside the signed grant binding.");
  }
  exact(proofRequest, ["schema", "proofId", "tenantId", "ledgerId", "accountIdDigest", "platform", "proofKind", "operation", "targetDigest", "parentProofId", "sessionGeneration", "routeIdDigest", "expiresAt", "grantFingerprint", "evidenceKeyFingerprint", "deploymentId"]);
  if (proofRequest.schema !== "social-git.admission-proof-request/v1") throw new XRuntimeError("POLICY_DENIED", "Certification proof request schema is invalid.");
  const expectedKind = command.intent === "identity_validation" ? "identity" : command.intent === "read" ? "read" : operationPayload.enabled === false ? "canary_cleanup" : "canary_write";
  if (command.intent === "identity_validation") exact(operationPayload, []);
  else if (command.intent === "read") exact(operationPayload, ["postId"]);
  else {
    exact(operationPayload, ["postId", "enabled"]);
    if (typeof operationPayload.enabled !== "boolean") throw new XRuntimeError("POLICY_DENIED", "Certification write state is invalid.");
  }
  const target = typeof operationPayload.postId === "string" ? operationPayload.postId : null;
  for (const [name, expected] of grant.resourceConstraints) {
    if (name === "proofKind" && proofRequest.proofKind !== expected) throw new XRuntimeError("POLICY_DENIED", "Certification proof kind is outside the grant.");
    if (name === "accountId" && command.accountId !== expected) throw new XRuntimeError("POLICY_DENIED", "Certification account is outside the grant.");
  }
  if (proofRequest.tenantId !== command.tenantId || proofRequest.ledgerId !== grant.ledgerId || proofRequest.accountIdDigest !== digestText(command.accountId)
    || proofRequest.platform !== "x" || proofRequest.proofKind !== expectedKind || proofRequest.operation !== `x.${command.operation}`
    || proofRequest.targetDigest !== (target ? digestText(target) : null) || proofRequest.sessionGeneration !== command.generation
    || proofRequest.routeIdDigest !== digestText(command.networkRoute.id) || proofRequest.expiresAt !== expiresAt
    || proofRequest.grantFingerprint !== liveTestGrantFingerprint(grant) || proofRequest.evidenceKeyFingerprint !== envelope.evidenceKeyFingerprint
    || proofRequest.deploymentId !== envelope.deploymentId
    || (expectedKind === "canary_cleanup" ? typeof proofRequest.parentProofId !== "string" : proofRequest.parentProofId !== null)) throw new XRuntimeError("POLICY_DENIED", "Certification proof request does not bind the exact command.");
}
function assertResourceBinding(value: unknown, grant: LiveTestGrant) {
  const { operationPayload } = certificationPayload(value);
  const resource = record(operationPayload);
  for (const [name, expected] of grant.resourceConstraints) {
    if (name === "accountId" || name === "proofKind") continue;
    const actual = resource[name] ?? (name === "targetId" ? resource.postId : undefined);
    if (actual !== expected) throw new XRuntimeError("POLICY_DENIED", `Certification resource ${name} is outside the grant.`);
  }
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new XRuntimeError("POLICY_DENIED", "Certification payload is invalid."); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new XRuntimeError("POLICY_DENIED", "Certification payload fields are not exact."); }
function bounded(value: unknown, pattern: RegExp) { if (typeof value !== "string" || value.length > 256 || !pattern.test(value)) throw new XRuntimeError("POLICY_DENIED", "Certification value is invalid."); return value; }
function digestText(value: string) { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
