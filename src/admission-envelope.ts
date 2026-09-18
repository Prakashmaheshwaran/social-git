import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Role,
  RoleAuthority,
  approveLiveTestGrant,
  liveTestGrantFingerprint,
  type LiveTestGrant,
  type LiveTestGrantInput,
  type TrustedActor,
} from "@social-git/security";
import { COMMITTED_ADMISSION_TRUST_ROOTS } from "./admission-trust.ts";

export interface VerifiedAdmissionEnvelope {
  readonly grant: LiveTestGrant;
  readonly qaOperator: TrustedActor;
  readonly approver: TrustedActor;
  readonly grantFingerprint: string;
  readonly qaKeyFingerprint: string;
  readonly approverKeyFingerprint: string;
  readonly sourceCommit: string;
  readonly compatibilityEvidenceDigest: string;
  readonly evidenceKeyFingerprint: string;
  readonly deploymentId: string;
  readonly tenantId: string;
  verifyExecutionChallenge(challenge: string, signature: string): boolean;
}

/**
 * Verify a two-party release-certification envelope. Public verification keys
 * are provisioned separately from the envelope; no private signing key enters
 * the service or container.
 */
export function loadAdmissionEnvelope(input: {
  envelopePath: string;
  qaPublicKeyPath: string;
  approverPublicKeyPath: string;
  releaseMetadataDirectory: string;
  trustRoots?: { qaKeyFingerprints: readonly string[]; approverKeyFingerprints: readonly string[] };
}): VerifiedAdmissionEnvelope {
  const envelope = exact(JSON.parse(readFileSync(input.envelopePath, "utf8")), ["version", "sourceCommit", "compatibilityEvidenceDigest", "evidenceKeyFingerprint", "deploymentId", "tenantId", "grant", "actors", "signatures"], "admission envelope");
  if (envelope.version !== 2) throw new TypeError("Only admission envelope version 2 is accepted");
  const actors = exact(envelope.actors, ["qaOperatorId", "approverId", "qaKeyFingerprint", "approverKeyFingerprint"], "admission actors");
  const signatures = exact(envelope.signatures, ["qa", "approver"], "admission signatures");
  const grantInput = exact(envelope.grant, ["authorizationId", "ledgerId", "environment", "artifactDigest", "sbomDigest", "testEvidenceDigest", "canaryAccountId", "expectedNativeIdentity", "sessionGeneration", "routeId", "readOperations", "writeOperations", "resourceConstraints", "cleanupOperation", "actionLimit", "notBefore", "expiresAt"], "admission grant");
  const sourceCommit = text(envelope.sourceCommit, "sourceCommit", 40);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new TypeError("sourceCommit must be an exact Git commit");
  const compatibilityEvidenceDigest = text(envelope.compatibilityEvidenceDigest, "compatibilityEvidenceDigest", 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(compatibilityEvidenceDigest)) throw new TypeError("compatibilityEvidenceDigest must be SHA-256");
  const evidenceKeyFingerprint = text(envelope.evidenceKeyFingerprint, "evidenceKeyFingerprint", 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(evidenceKeyFingerprint)) throw new TypeError("evidenceKeyFingerprint must be SHA-256");
  const deploymentId = text(envelope.deploymentId, "deploymentId", 128);
  const tenantId = text(envelope.tenantId, "tenantId", 128);
  const qaOperatorId = text(actors.qaOperatorId, "qaOperatorId", 128);
  const approverId = text(actors.approverId, "approverId", 128);
  if (qaOperatorId === approverId) throw new TypeError("Admission approval and execution identities must be distinct");
  const qaKey = publicEd25519Key(input.qaPublicKeyPath, "QA");
  const approverKey = publicEd25519Key(input.approverPublicKeyPath, "approver");
  const qaKeyFingerprint = fingerprint(qaKey);
  const approverKeyFingerprint = fingerprint(approverKey);
  if (actors.qaKeyFingerprint !== qaKeyFingerprint || actors.approverKeyFingerprint !== approverKeyFingerprint || qaKeyFingerprint === approverKeyFingerprint) {
    throw new TypeError("Admission actor key fingerprints do not match the separately provisioned keys");
  }
  const trustRoots = input.trustRoots ?? COMMITTED_ADMISSION_TRUST_ROOTS;
  if (!trustRoots.qaKeyFingerprints.includes(qaKeyFingerprint) || !trustRoots.approverKeyFingerprints.includes(approverKeyFingerprint)) {
    throw new TypeError("Admission approval keys are not pinned by the committed release-maintainer trust root");
  }
  const signed = Buffer.from(canonicalJson({ version: 2, sourceCommit, compatibilityEvidenceDigest, evidenceKeyFingerprint, deploymentId, tenantId, grant: envelope.grant, actors }), "utf8");
  const qaSignature = signature(signatures.qa, "QA");
  const approverSignature = signature(signatures.approver, "approver");
  try {
    if (!verify(null, signed, qaKey, qaSignature)) throw new TypeError("The independent QA admission signature is invalid");
    if (!verify(null, signed, approverKey, approverSignature)) throw new TypeError("The security approver admission signature is invalid");
  } finally { signed.fill(0); qaSignature.fill(0); approverSignature.fill(0); }

  const authority = new RoleAuthority([
    { actorId: qaOperatorId, role: Role.INDEPENDENT_LIVE_QA },
    { actorId: approverId, role: Role.SECURITY_REVIEWER },
  ]);
  const qaOperator = authority.principalFor(qaOperatorId);
  const approver = authority.principalFor(approverId);
  const grant = approveLiveTestGrant(grantInput as unknown as LiveTestGrantInput, { qaOperator, approver });
  verifyMeasuredRelease(input.releaseMetadataDirectory, sourceCommit, grant);
  const grantFingerprint = liveTestGrantFingerprint(grant);
  return Object.freeze({
    grant,
    qaOperator,
    approver,
    grantFingerprint,
    qaKeyFingerprint,
    approverKeyFingerprint,
    sourceCommit,
    compatibilityEvidenceDigest,
    evidenceKeyFingerprint,
    deploymentId,
    tenantId,
    verifyExecutionChallenge(challenge: string, encodedSignature: string) {
      if (typeof challenge !== "string" || challenge.length < 1 || challenge.length > 2048) return false;
      let decoded: Buffer;
      try { decoded = signature(encodedSignature, "execution"); } catch { return false; }
      const bytes = Buffer.from(challenge, "utf8");
      try { return verify(null, bytes, qaKey, decoded); }
      finally { bytes.fill(0); decoded.fill(0); }
    },
  });
}

function verifyMeasuredRelease(directory: string, sourceCommit: string, grant: LiveTestGrant) {
  const measuredCommit = readFileSync(join(directory, "source-commit"), "utf8").trim();
  if (measuredCommit !== sourceCommit) throw new TypeError("Admission sourceCommit does not match the measured runtime");
  const sourceManifest = readFileSync(join(directory, "source-manifest.sha256"));
  const sbom = readFileSync(join(directory, "sbom.spdx.json"));
  try {
    const artifactDigest = `sha256:${createHash("sha256").update(sourceManifest).digest("hex")}`;
    const sbomDigest = `sha256:${createHash("sha256").update(sbom).digest("hex")}`;
    if (grant.artifactDigest !== artifactDigest || grant.sbomDigest !== sbomDigest) throw new TypeError("Admission artifact or SBOM digest does not match the measured runtime");
  } finally { sourceManifest.fill(0); sbom.fill(0); }
}

export function admissionExecutionChallenge(input: { proofDigest: string; expiresAt: string; grantFingerprint: string }) {
  return `social-git.admission-execute/v2\n${input.proofDigest}\n${input.expiresAt}\n${input.grantFingerprint}`;
}

export function admissionProofRequestDigest(request: Record<string, unknown>) {
  return `sha256:${createHash("sha256").update(canonicalJson(request), "utf8").digest("hex")}`;
}

export function loadEvidenceSigner(input: { privateKeyPath: string; publicKeyPath: string; forbiddenFingerprints: readonly string[]; expectedFingerprint: string }) {
  const privateBytes = readFileSync(input.privateKeyPath);
  const publicBytes = readFileSync(input.publicKeyPath);
  try {
    if (privateBytes.length > 16 * 1024 || publicBytes.length > 16 * 1024) throw new TypeError("Admission evidence keys are invalid");
    let privateKey: KeyObject | undefined = createPrivateKey(privateBytes);
    let publicKey: KeyObject | undefined = createPublicKey(publicBytes);
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("Admission evidence keys must be Ed25519");
    const privatePublic = createPublicKey(privateKey);
    const fingerprintValue = fingerprint(publicKey);
    if (fingerprint(privatePublic) !== fingerprintValue) throw new TypeError("Admission evidence private and public keys do not match");
    if (input.forbiddenFingerprints.includes(fingerprintValue)) throw new TypeError("The admission evidence key must be distinct from approval keys");
    if (fingerprintValue !== input.expectedFingerprint) throw new TypeError("Admission evidence key is not bound by the signed envelope");
    let closed = false;
    return Object.freeze({
      fingerprint: fingerprintValue,
      sign(payload: Uint8Array) { if (closed || !privateKey) throw new Error("Admission evidence signer is closed"); return sign(null, payload, privateKey).toString("base64url"); },
      verify(payload: Uint8Array, encoded: string) {
        if (closed || !publicKey) return false;
        let decoded: Buffer;
        try { decoded = signature(encoded, "evidence"); } catch { return false; }
        try { return verify(null, payload, publicKey, decoded); } finally { decoded.fill(0); }
      },
      close() { if (closed) return; closed = true; privateKey = undefined; publicKey = undefined; },
    });
  } finally { privateBytes.fill(0); publicBytes.fill(0); }
}

function publicEd25519Key(path: string, label: string) {
  const encoded = readFileSync(path);
  try {
    if (encoded.length < 32 || encoded.length > 16 * 1024) throw new TypeError(`The ${label} public key file is invalid`);
    const key = createPublicKey(encoded);
    if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`The ${label} public key must be Ed25519`);
    return key;
  } finally { encoded.fill(0); }
}

function fingerprint(key: KeyObject) {
  const der = key.export({ type: "spki", format: "der" });
  try { return `sha256:${createHash("sha256").update(der).digest("hex")}`; }
  finally { der.fill(0); }
}

function signature(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(value)) throw new TypeError(`The ${label} signature is invalid`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== value) { decoded.fill(0); throw new TypeError(`The ${label} signature is non-canonical`); }
  return decoded;
}

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) throw new TypeError(`${label} fields are not exact`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum: number) { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/u.test(value)) throw new TypeError(`${label} is invalid`); return value; }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`; return JSON.stringify(value); }
