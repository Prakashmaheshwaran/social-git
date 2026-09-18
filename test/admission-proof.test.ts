import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Role, RoleAuthority, approveLiveTestGrant, type LiveTestGrant } from "@social-git/security";
import { AdmissionProofCoordinator } from "../src/admission-proof.ts";
import { admissionProofRequestDigest } from "../src/admission-envelope.ts";

const NOW = Date.UTC(2026, 8, 17, 15, 0, 0);
const OWNER = { callerId: "installation-owner", scopes: [], role: "owner" } as any;

test("X result mismatch becomes UNKNOWN for writes and protocol drift for reads", async () => {
  const fixture = proofFixture("x", ["x.post.get"], ["x.bookmark.set"], { targetId: "777" }, async (input: any) => input.intent === "write"
    ? { data: { enabled: true }, native: { nativeId: "778" } }
    : { data: { entity: { nativeId: "778" } }, native: { nativeId: "778" } });
  try {
    const write = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "canary_write", targetId: "777", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE x canary_write canary" }) as any;
    assert.equal(admissionProofRequestDigest(write.proofRequest), write.proofRequestDigest);
    assert.notEqual(admissionProofRequestDigest({ ...write.proofRequest, targetDigest: `sha256:${"0".repeat(64)}` }), write.proofRequestDigest);
    const writeResult = await fixture.coordinator.execute(OWNER, write.proof.id, fixture.execution(write));
    assert.equal((writeResult as any).proof.state, "UNKNOWN");
    assert.equal((writeResult as any).evidence.bundle.outcome.state, "UNKNOWN");
    const cleanup = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "canary_cleanup", targetId: "777", parentProofId: write.proof.id, expiresInSeconds: 120, confirmation: "PREPARE x canary_cleanup canary" }) as any;
    const cleanupResult = await fixture.coordinator.execute(OWNER, cleanup.proof.id, fixture.execution(cleanup)) as any;
    assert.equal(cleanupResult.proof.state, "UNKNOWN");
    assert.equal(cleanupResult.evidence.bundle.cleanup.parentOutcomeState, "UNKNOWN");
    assert.equal(cleanupResult.evidence.bundle.cleanup.workflowComplete, false);
    const read = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "read", targetId: "777", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE x read canary" }) as any;
    const readResult = await fixture.coordinator.execute(OWNER, read.proof.id, fixture.execution(read));
    assert.equal((readResult as any).proof.state, "failed");
    assert.equal((readResult as any).proof.errorCode, "PROTOCOL_DRIFT");
  } finally { fixture.close(); }
});

test("restart reconciliation terminalizes orphaned synchronous proofs and reattaches durable Reddit actions", () => {
  const fixture = proofFixture("x", ["x.post.get"], ["x.bookmark.set"], { targetId: "777" }, async () => ({ data: {}, native: { nativeId: "777" } }));
  try {
    const write = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "canary_write", targetId: "777", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE x canary_write canary" }) as any;
    const read = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "read", targetId: "777", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE x read canary" }) as any;
    const db = new DatabaseSync(fixture.databasePath);
    db.prepare("UPDATE admission_proofs SET state='executing', execute_count=1, executed_at=? WHERE id IN (?, ?)").run(new Date(NOW).toISOString(), write.proof.id, read.proof.id);
    db.close(); fixture.coordinator.close();
    const restarted = new AdmissionProofCoordinator(fixture.options);
    assert.equal((restarted.get(OWNER, write.proof.id) as any).proof.state, "UNKNOWN");
    assert.equal((restarted.get(OWNER, read.proof.id) as any).proof.state, "failed");
    restarted.close(); fixture.closed = true;
  } finally { fixture.close(); }
});

test("restart reconciliation attaches an exact durable Reddit action committed before the proof mapping", () => {
  const durable = { id: "33333333-3333-4333-8333-333333333333", state: "queued", request: { kind: "save", targetId: "t3_target" } };
  const fixture = proofFixture("reddit", [], ["reddit.item.save"], { targetId: "t3_target" }, undefined, { findActionByIdempotency() { return durable; }, getActionInternal() { return durable; } });
  try {
    const prepared = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "canary_write", targetId: "t3_target", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE reddit canary_write canary" }) as any;
    const db = new DatabaseSync(fixture.databasePath);
    db.prepare("UPDATE admission_proofs SET state='executing', execute_count=1, executed_at=? WHERE id=?").run(new Date(NOW).toISOString(), prepared.proof.id);
    db.close(); fixture.coordinator.close();
    const restarted = new AdmissionProofCoordinator(fixture.options);
    const recovered = restarted.get(OWNER, prepared.proof.id) as any;
    assert.equal(recovered.proof.state, "executing");
    assert.equal(recovered.proof.actionId, durable.id);
    restarted.close(); fixture.closed = true;
  } finally { fixture.close(); }
});

test("cleanup evidence verifies and links the exact successful parent evidence", async () => {
  const fixture = proofFixture("x", [], ["x.bookmark.set"], { targetId: "777" }, async () => ({ data: { ok: true }, native: { nativeId: "777" } }));
  try {
    const write = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "canary_write", targetId: "777", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE x canary_write canary" }) as any;
    const written = await fixture.coordinator.execute(OWNER, write.proof.id, fixture.execution(write)) as any;
    assert.equal(written.evidence.bundle.cleanup.workflowComplete, false);
    assert.deepEqual(written.evidence.bundle.proofRequest, write.proofRequest);
    const cleanup = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "canary_cleanup", targetId: "777", parentProofId: write.proof.id, expiresInSeconds: 120, confirmation: "PREPARE x canary_cleanup canary" }) as any;
    const cleaned = await fixture.coordinator.execute(OWNER, cleanup.proof.id, fixture.execution(cleanup)) as any;
    assert.equal(cleaned.proof.state, "succeeded");
    assert.equal(cleaned.evidence.verification.valid, true);
    assert.equal(cleaned.evidence.bundle.cleanup.workflowComplete, true);
    assert.equal(cleaned.evidence.bundle.cleanup.parentRequestDigest, write.proof.requestDigest);
    assert.equal(cleaned.evidence.bundle.cleanup.parentEvidenceDigest, written.evidence.digest);
    assert.equal(JSON.stringify(cleaned.evidence.bundle).includes('"777"'), false);
  } finally { fixture.close(); }
});

test("throw after durable Reddit enqueue is recovered by exact idempotency record", async () => {
  const durable = { id: "22222222-2222-4222-8222-222222222222", state: "queued", request: { kind: "save", targetId: "t3_target" } };
  const fixture = proofFixture("reddit", [], ["reddit.item.save"], { targetId: "t3_target" }, undefined, {
    async enqueueAction() { throw new Error("lost response after commit"); },
    findActionByIdempotency() { return durable; },
  });
  try {
    const prepared = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "canary_write", targetId: "t3_target", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE reddit canary_write canary" }) as any;
    const result = await fixture.coordinator.execute(OWNER, prepared.proof.id, fixture.execution(prepared)) as any;
    assert.equal(result.proof.state, "executing");
    assert.equal(result.proof.actionId, durable.id);
    assert.equal(result.proof.executeCount, 1);
  } finally { fixture.close(); }
});

test("coordinator summary reports configured separately from exact active grant window", () => {
  let clock = NOW - 2_000;
  const fixture = proofFixture("x", ["x.post.get"], ["x.bookmark.set"], { targetId: "777" }, async () => ({ data: {}, native: { nativeId: "777" } }), {}, () => clock);
  try {
    assert.equal((fixture.coordinator.summary() as any).configured, true); assert.equal((fixture.coordinator.summary() as any).active, false);
    clock = NOW - 1_000; assert.equal((fixture.coordinator.summary() as any).active, true);
    clock = NOW + 600_000; assert.equal((fixture.coordinator.summary() as any).active, false);
  } finally { fixture.close(); }
});

test("execution rechecks notBefore after a backward clock step and performs zero dispatch", async () => {
  let clock = NOW;
  let calls = 0;
  const fixture = proofFixture("x", ["x.post.get"], ["x.bookmark.set"], { targetId: "777" }, async () => { calls += 1; return { data: {}, native: { nativeId: "777" } }; }, {}, () => clock);
  try {
    const prepared = fixture.coordinator.prepare(OWNER, { accountId: "canary", proofKind: "read", targetId: "777", parentProofId: null, expiresInSeconds: 120, confirmation: "PREPARE x read canary" }) as any;
    clock = NOW - 2_000;
    const result = await fixture.coordinator.execute(OWNER, prepared.proof.id, fixture.execution(prepared)) as any;
    assert.equal(result.proof.state, "blocked"); assert.equal(result.proof.errorCode, "AUTHORIZATION_NOT_ACTIVE"); assert.equal(calls, 0);
  } finally { fixture.close(); }
});

function proofFixture(platform: "reddit" | "x", readOperations: string[], writeOperations: string[], constraints: Record<string, string>, xExecute?: (input: unknown) => Promise<any>, serviceOverrides: Record<string, unknown> = {}, now: () => number = () => NOW) {
  const root = mkdtempSync(join(tmpdir(), "social-git-proof-"));
  const qaKeys = generateKeyPairSync("ed25519");
  const evidenceKeys = generateKeyPairSync("ed25519");
  const authority = new RoleAuthority([{ actorId: "qa", role: Role.INDEPENDENT_LIVE_QA }, { actorId: "approver", role: Role.SECURITY_REVIEWER }]);
  const qa = authority.principalFor("qa");
  const grant = approveLiveTestGrant({
    authorizationId: `authorization-${platform}`, ledgerId: "tenant-action-ledger", environment: "production-canary",
    artifactDigest: `sha256:${"a".repeat(64)}`, sbomDigest: `sha256:${"b".repeat(64)}`, testEvidenceDigest: `sha256:${"c".repeat(64)}`,
    canaryAccountId: "canary", expectedNativeIdentity: platform === "x" ? "12345" : "reddit:t2_owner", sessionGeneration: 4, routeId: "direct-route",
    readOperations, writeOperations, resourceConstraints: constraints, cleanupOperation: writeOperations[0] ?? null,
    actionLimit: 4, notBefore: NOW - 1_000, expiresAt: NOW + 600_000,
  }, { qaOperator: qa, approver: authority.principalFor("approver") });
  const actions = new Map<string, any>();
  const store = {
    getAccount() { return { id: "canary", platform, expectedNativeUserId: platform === "x" ? "12345" : "reddit:t2_owner" }; },
    audit() {}, getActionInternal(id: string) { return typeof serviceOverrides.getActionInternal === "function" ? (serviceOverrides.getActionInternal as any)(id) : actions.get(id); },
    findActionByIdempotency: serviceOverrides.findActionByIdempotency ?? (() => null),
  };
  const service = { store, async read() { return { entity: { nativeId: platform === "x" ? "12345" : "reddit:t2_owner" } }; }, async enqueueAction() { throw new Error("not configured"); }, ...serviceOverrides } as any;
  const evidenceSigner = {
    fingerprint: `sha256:${"d".repeat(64)}`,
    sign(payload: Uint8Array) { return cryptoSign(null, payload, evidenceKeys.privateKey).toString("base64url"); },
    verify(payload: Uint8Array, signature: string) { return cryptoVerify(null, payload, evidenceKeys.publicKey, Buffer.from(signature, "base64url")); },
  };
  const options = {
    databasePath: join(root, "authorization.sqlite"), evidenceSigner, grant, qaOperator: qa,
    qaKeyFingerprint: `sha256:${"e".repeat(64)}`, approverKeyFingerprint: `sha256:${"f".repeat(64)}`,
    sourceCommit: "1".repeat(40), compatibilityEvidenceDigest: `sha256:${"2".repeat(64)}`, deploymentId: "deployment-one", tenantId: "tenant",
    verifyExecutionChallenge(challenge: string, signature: string) { return cryptoVerify(null, Buffer.from(challenge), qaKeys.publicKey, Buffer.from(signature, "base64url")); },
    sessionRuntime: { getAccountState() { return { expectedNativeIdentity: platform === "x" ? "12345" : "reddit:t2_owner", generation: 4, networkRouteId: "direct-route" }; } } as any,
    service, wakeAction() {}, now,
    ...(xExecute ? { xCertificationProvider: { execute: xExecute } as any } : {}),
  } as any;
  const coordinator = new AdmissionProofCoordinator(options);
  const databasePath = join(root, "authorization.sqlite");
  return {
    coordinator, options, databasePath, closed: false,
    execution(prepared: any) { return { confirmation: prepared.requiredExecutionConfirmation, qaExecutionSignature: cryptoSign(null, Buffer.from(prepared.qaExecutionChallenge), qaKeys.privateKey).toString("base64url") }; },
    close() { if (!(this as any).closed) { try { coordinator.close(); } catch {} } rmSync(root, { recursive: true, force: true }); },
  };
}
