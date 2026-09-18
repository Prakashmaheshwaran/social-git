import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify as cryptoVerify } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeWorkerMessage, decodeWorkerMessage, SessionRuntime } from "@social-git/core";
import { liveTestGrantFingerprint } from "@social-git/security";
import { admissionExecutionChallenge, admissionProofRequestDigest, loadAdmissionEnvelope, loadEvidenceSigner } from "../src/admission-envelope.ts";
import { CertificationOnlyXDispatcher, certificationPayloadFor } from "../src/x-certification.ts";
import { AdmissionProofCoordinator } from "../src/admission-proof.ts";
import { CoreXTransportProvider, ProductionXCommandDispatcher, RemoteXCommandDispatcher } from "../src/runtime-x.ts";
import { createXWorkerHttpServer } from "../src/x-worker-http.ts";
import { CoreRedditTransportProvider, ProductionRedditCommandDispatcher, RemoteRedditCommandDispatcher } from "../src/runtime-reddit.ts";
import { createRedditWorkerHttpServer } from "../src/reddit-worker-http.ts";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

test("v2 envelope requires committed independent keys and measured release bytes", () => {
  const fixture = envelopeFixture();
  try {
    const { trustRoots: _testOnlyRoots, ...productionInput } = fixture.loadInput;
    assert.throws(() => loadAdmissionEnvelope(productionInput), /committed release-maintainer trust root/u);
    const verified = loadAdmissionEnvelope(fixture.loadInput);
    assert.equal(verified.sourceCommit, fixture.sourceCommit);
    assert.equal(verified.evidenceKeyFingerprint, fixture.evidenceFingerprint);
    const substituted = generateKeyPairSync("ed25519");
    const substitutedPath = join(fixture.root, "substituted.pem");
    privateWrite(substitutedPath, substituted.publicKey.export({ type: "spki", format: "pem" }));
    assert.throws(() => loadAdmissionEnvelope({ ...fixture.loadInput, qaPublicKeyPath: substitutedPath }), /fingerprints|trust root/u);
    const raw = JSON.parse(readFileSync(fixture.envelopePath, "utf8")) as any;
    raw.grant.misspelledActionLimit = raw.grant.actionLimit;
    const unsigned = { ...raw }; delete unsigned.signatures;
    const signed = Buffer.from(canonicalJson(unsigned));
    raw.signatures = { qa: sign(null, signed, fixture.qa.privateKey).toString("base64url"), approver: sign(null, signed, fixture.approver.privateKey).toString("base64url") };
    signed.fill(0); privateWrite(fixture.envelopePath, JSON.stringify(raw));
    assert.throws(() => loadAdmissionEnvelope(fixture.loadInput), /grant fields are not exact/u);
  } finally { fixture.close(); }
});

test("evidence signer releases key references and refuses use after close", () => {
  const fixture = envelopeFixture();
  try {
    const signer = loadEvidenceSigner({ privateKeyPath: fixture.evidencePrivatePath, publicKeyPath: fixture.evidencePublicPath, forbiddenFingerprints: [], expectedFingerprint: fixture.evidenceFingerprint });
    const body = Buffer.from("evidence"); const signature = signer.sign(body);
    assert.equal(signer.verify(body, signature), true);
    signer.close(); signer.close();
    assert.throws(() => signer.sign(body), /closed/u); assert.equal(signer.verify(body, signature), false); body.fill(0);
  } finally { fixture.close(); }
});

test("certification worker strips proof metadata and durably rejects replay after restart", async () => {
  const fixture = envelopeFixture();
  try {
    const verified = loadAdmissionEnvelope(fixture.loadInput);
    const expiresAt = new Date(NOW + 60_000).toISOString();
    const proofRequest = {
      schema: "social-git.admission-proof-request/v1", proofId: "11111111-1111-4111-8111-111111111111", tenantId: "tenant-test", ledgerId: "tenant-test-action-ledger",
      accountIdDigest: digest(Buffer.from("x-canary")), platform: "x", proofKind: "canary_write", operation: "x.bookmark.set", targetDigest: digest(Buffer.from("777")), parentProofId: null,
      sessionGeneration: 4, routeIdDigest: digest(Buffer.from("direct-route")), expiresAt, grantFingerprint: liveTestGrantFingerprint(verified.grant),
      evidenceKeyFingerprint: verified.evidenceKeyFingerprint, deploymentId: verified.deploymentId,
    };
    const proofDigest = admissionProofRequestDigest(proofRequest);
    const challenge = admissionExecutionChallenge({ proofDigest, expiresAt, grantFingerprint: liveTestGrantFingerprint(verified.grant) });
    const qaExecutionSignature = sign(null, Buffer.from(challenge), fixture.qa.privateKey).toString("base64url");
    const serialized = encodeWorkerMessage({
      version: 1, type: "social-git.worker.command", requestId: proofDigest, tenantId: "tenant-test", accountId: "x-canary",
      platform: "x", generation: 4, leaseId: "lease-one", fence: 1, expiresAt: NOW + 30_000, intent: "write",
      operation: "bookmark.set", expectedNativeIdentity: "12345", sessionBase64: Buffer.from("session").toString("base64url"),
      networkRoute: { id: "direct-route", materialBase64: Buffer.from("route").toString("base64url") },
      payload: certificationPayloadFor({ proofDigest, proofRequest, expiresAt, qaExecutionSignature, operationPayload: { postId: "777", enabled: true } }),
    });
    const observed: unknown[] = [];
    const delegate = { async ready() { return true; }, async execute(bytes: Uint8Array) { const command = decodeWorkerMessage(bytes); if (command.type === "social-git.worker.command") observed.push(command.payload); return { message: Buffer.from("result") }; } };
    const database = join(fixture.root, "worker.sqlite");
    const first = new CertificationOnlyXDispatcher(delegate, verified, database, () => NOW);
    const before = new CertificationOnlyXDispatcher(delegate, verified, join(fixture.root, "before.sqlite"), () => verified.grant.notBefore - 1);
    await assert.rejects(before.execute(serialized), /not active/u);
    before.close();
    const expired = new CertificationOnlyXDispatcher(delegate, verified, join(fixture.root, "expired.sqlite"), () => verified.grant.expiresAt);
    await assert.rejects(expired.execute(serialized), /expired/u);
    expired.close();
    assert.equal(observed.length, 0);
    const forged = decodeWorkerMessage(serialized);
    assert.equal(forged.type, "social-git.worker.command");
    if (forged.type !== "social-git.worker.command") throw new Error("command expected");
    forged.payload = certificationPayloadFor({ proofDigest, proofRequest, expiresAt, qaExecutionSignature, operationPayload: { postId: "778", enabled: true } });
    await assert.rejects(first.execute(encodeWorkerMessage(forged)), /bind|resource/u);
    await first.execute(serialized);
    first.close();
    assert.deepEqual(observed, [{ postId: "777", enabled: true }]);
    const restarted = new CertificationOnlyXDispatcher(delegate, verified, database, () => NOW);
    await assert.rejects(restarted.execute(serialized), /single-use/u);
    restarted.close();
    const otherFixture = envelopeFixture();
    try {
      const cross = new CertificationOnlyXDispatcher(delegate, loadAdmissionEnvelope(otherFixture.loadInput), join(fixture.root, "cross.sqlite"), () => NOW);
      await assert.rejects(cross.execute(serialized), /signature|grant binding/u);
      cross.close();
    } finally { otherFixture.close(); }
    const constrainedFixture = envelopeFixture("x", { proofKind: "read" });
    try {
      const constrained = loadAdmissionEnvelope(constrainedFixture.loadInput);
      const constrainedRequest = { ...proofRequest, grantFingerprint: liveTestGrantFingerprint(constrained.grant) };
      const constrainedDigest = admissionProofRequestDigest(constrainedRequest);
      const constrainedChallenge = admissionExecutionChallenge({ proofDigest: constrainedDigest, expiresAt, grantFingerprint: liveTestGrantFingerprint(constrained.grant) });
      const constrainedSignature = sign(null, Buffer.from(constrainedChallenge), constrainedFixture.qa.privateKey).toString("base64url");
      const constrainedCommand = encodeWorkerMessage({ ...decodeCommand(serialized), requestId: constrainedDigest, payload: certificationPayloadFor({ proofDigest: constrainedDigest, proofRequest: constrainedRequest, expiresAt, qaExecutionSignature: constrainedSignature, operationPayload: { postId: "777", enabled: true } }) });
      const constrainedDispatcher = new CertificationOnlyXDispatcher(delegate, constrained, join(fixture.root, "proof-kind.sqlite"), () => NOW);
      await assert.rejects(constrainedDispatcher.execute(constrainedCommand), /proof kind/u);
      constrainedCommand.fill(0); constrainedDispatcher.close();
    } finally { constrainedFixture.close(); }
  } finally { fixture.close(); }
});

test("coordinator executes identity, read, write, and cleanup through authenticated X HTTP certification worker", async () => {
  const fixture = envelopeFixture();
  const verified = loadAdmissionEnvelope(fixture.loadInput);
  const runtime = new SessionRuntime({ databasePath: join(fixture.root, "sessions.sqlite"), tenantId: "tenant-test", masterKey: Buffer.alloc(32, 31), auditKey: Buffer.alloc(32, 32) });
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "synthetic", ct0: "synthetic-csrf" } }));
  const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  for (let generation = 1; generation <= 4; generation += 1) {
    runtime.importExternalSession({ accountId: "x-canary", platform: "x", expectedNativeIdentity: "12345", generation, session: Buffer.from(session), networkRoute: { id: "direct-route", material: Buffer.from(route) } });
    if (generation < 4) runtime.revokeAccount({ accountId: "x-canary", generation });
  }
  const calls: string[] = [];
  const candidate = new ProductionXCommandDispatcher({ admission: { requested: true, enabled: true, productionEnabled: false, disabledReasons: [] }, bootstrap: async () => ({
    async verifyIdentity() { calls.push("identity"); return { entity: { nativeId: "12345", username: "fixture", displayName: "Fixture", canonicalUrl: "https://x.com/fixture" } }; },
    async execute(operation: string, payload: any) { calls.push(operation); return operation === "post.get" ? { entity: { nativeId: payload.postId, authorNativeId: "12345", text: "fixture", canonicalUrl: `https://x.com/i/status/${payload.postId}` } } : { nativeId: payload.postId, canonicalUrl: `https://x.com/i/status/${payload.postId}` }; },
    async executeMediaPhase() { throw new Error("media not admitted in proof"); },
  }) as any });
  const worker = new CertificationOnlyXDispatcher(candidate, verified, join(fixture.root, "worker-e2e.sqlite"), () => NOW);
  const key = Buffer.alloc(32, 0xa5);
  const identity = { grantFingerprint: liveTestGrantFingerprint(verified.grant), sourceCommit: verified.sourceCommit, deploymentId: verified.deploymentId, evidenceKeyFingerprint: verified.evidenceKeyFingerprint };
  const server = createXWorkerHttpServer({ admission: { requested: true, enabled: true, productionEnabled: false, disabledReasons: [], certification: identity }, dispatcher: worker, commandKey: key, now: () => NOW });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${address.port}/v1/dispatch`, key, { now: () => NOW, expectedCertificationIdentity: identity });
  const provider = new CoreXTransportProvider({ runtime, dispatcher: remote });
  const account = { id: "x-canary", platform: "x", expectedNativeUserId: "12345" } as any;
  const store = { getAccount() { return account; }, audit() {}, findActionByIdempotency() { return null; } };
  const service = { store } as any;
  const evidenceSigner = { fingerprint: verified.evidenceKeyFingerprint, sign(payload: Uint8Array) { return sign(null, payload, fixture.evidence.privateKey).toString("base64url"); }, verify(payload: Uint8Array, signature: string) { return cryptoVerify(null, payload, fixture.evidence.publicKey, Buffer.from(signature, "base64url")); } };
  const coordinator = new AdmissionProofCoordinator({ databasePath: join(fixture.root, "proofs.sqlite"), evidenceSigner, grant: verified.grant, qaOperator: verified.qaOperator, qaKeyFingerprint: verified.qaKeyFingerprint, approverKeyFingerprint: verified.approverKeyFingerprint, sourceCommit: verified.sourceCommit, compatibilityEvidenceDigest: verified.compatibilityEvidenceDigest, deploymentId: verified.deploymentId, tenantId: verified.tenantId, verifyExecutionChallenge: verified.verifyExecutionChallenge, sessionRuntime: runtime, service, wakeAction() {}, xCertificationProvider: provider, now: () => NOW });
  const owner = { callerId: "owner", role: "owner", scopes: [] } as any;
  const execute = async (kind: string, targetId: string | null, parentProofId: string | null = null) => {
    const prepared = coordinator.prepare(owner, { accountId: "x-canary", proofKind: kind, targetId, parentProofId, expiresInSeconds: 120, confirmation: `PREPARE x ${kind} x-canary` }) as any;
    const signature = sign(null, Buffer.from(prepared.qaExecutionChallenge), fixture.qa.privateKey).toString("base64url");
    return await coordinator.execute(owner, prepared.proof.id, { confirmation: prepared.requiredExecutionConfirmation, qaExecutionSignature: signature }) as any;
  };
  try {
    assert.equal(await remote.ready(), true);
    assert.equal((await execute("identity", null)).proof.state, "succeeded");
    assert.equal((await execute("read", "777")).proof.state, "succeeded");
    const written = await execute("canary_write", "777"); assert.equal(written.proof.state, "succeeded");
    const cleaned = await execute("canary_cleanup", "777", written.proof.id); assert.equal(cleaned.proof.state, "succeeded"); assert.equal(cleaned.evidence.verification.valid, true);
    assert.deepEqual(calls, ["identity", "post.get", "bookmark.set", "bookmark.set"]);
  } finally {
    coordinator.close(); remote.close(); server.close(); await once(server, "close"); runtime.close(); session.fill(0); route.fill(0); fixture.close();
  }
});

test("coordinator executes normalized Reddit identity, read, save, and cleanup through authenticated HTTP worker", async () => {
  const fixture = envelopeFixture("reddit");
  const verified = loadAdmissionEnvelope(fixture.loadInput);
  const runtime = new SessionRuntime({ databasePath: join(fixture.root, "reddit-sessions.sqlite"), tenantId: "tenant-test", masterKey: Buffer.alloc(32, 41), auditKey: Buffer.alloc(32, 42) });
  importBoundSession(runtime, "reddit-canary", "reddit", "reddit:t2_aliceid", 4, "direct-route", { cookies: { reddit_session: "synthetic" }, csrfToken: "synthetic-csrf" });
  const calls: string[] = [];
  const candidate = new ProductionRedditCommandDispatcher({ resolver: async () => ["151.101.1.140"], sessionConnectorFactory: () => async (request: any) => {
    const url = new URL(request.url); calls.push(`${request.method}:${url.pathname}`);
    let body: unknown;
    if (url.pathname === "/api/me.json") body = { data: { id: "aliceid", name: "alice", link_karma: 1, comment_karma: 2 } };
    else if (url.pathname === "/comments/777.json") body = [
      { data: { children: [{ kind: "t3", data: { id: "777", name: "t3_777", author: "alice", author_fullname: "t2_aliceid", title: "Fixture", selftext: "", permalink: "/r/test/comments/777/fixture/", subreddit: "test", created_utc: 1, score: 1, num_comments: 0 } }], after: null, before: null } },
      { data: { children: [], after: null, before: null } },
    ];
    else if (url.pathname === "/api/save" || url.pathname === "/api/unsave") body = {};
    else throw new Error(`unexpected Reddit proof route ${url.pathname}`);
    return { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "10", "x-ratelimit-reset": "60" }, body: Buffer.from(JSON.stringify(body)), remoteAddress: request.selectedAddress };
  } });
  const key = Buffer.alloc(32, 0xb6);
  const commandIds: string[] = [];
  const server = createRedditWorkerHttpServer({ dispatcher: { async execute(bytes) { const command = decodeWorkerMessage(bytes); if (command.type === "social-git.worker.command") commandIds.push(command.requestId); return candidate.execute(bytes); } }, commandKey: key }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${address.port}/v1/dispatch`, key);
  const provider = new CoreRedditTransportProvider({ runtime, dispatcher: remote, source: { consume() { throw new Error("unused"); } } });
  const account = { id: "reddit-canary", platform: "reddit", expectedNativeUserId: "reddit:t2_aliceid" } as any;
  const service = { store: { getAccount() { return account; }, audit() {}, findActionByIdempotency() { return null; } } } as any;
  const coordinator = admissionCoordinator(fixture, verified, runtime, service, { redditCertificationProvider: provider });
  const owner = { callerId: "owner", role: "owner", scopes: [] } as any;
  const execute = proofExecutor(coordinator, fixture, owner, "reddit", "reddit-canary");
  try {
    assert.equal(await remote.ready(), true);
    const identityResult = await execute("identity", null); assert.equal(identityResult.proof.state, "succeeded");
    const read = await execute("read", "t3_777"); assert.equal(read.proof.state, "succeeded", JSON.stringify(read));
    const written = await execute("canary_write", "t3_777"); assert.equal(written.proof.state, "succeeded");
    const cleaned = await execute("canary_cleanup", "t3_777", written.proof.id); assert.equal(cleaned.proof.state, "succeeded");
    assert.deepEqual(commandIds, [identityResult.proof.requestDigest, read.proof.requestDigest, written.proof.requestDigest, cleaned.proof.requestDigest]);
    assert.deepEqual(calls, ["GET:/api/me.json", "GET:/api/me.json", "GET:/comments/777.json", "GET:/api/me.json", "POST:/api/save", "GET:/api/me.json", "POST:/api/unsave"]);
  } finally { coordinator.close(); remote.close(); server.close(); await once(server, "close"); runtime.close(); fixture.close(); }
});

function envelopeFixture(platform: "x" | "reddit" = "x", resourceConstraints?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "social-git-admission-"));
  const qa = generateKeyPairSync("ed25519");
  const approver = generateKeyPairSync("ed25519");
  const evidence = generateKeyPairSync("ed25519");
  const qaFingerprint = fingerprint(qa.publicKey);
  const approverFingerprint = fingerprint(approver.publicKey);
  const evidenceFingerprint = fingerprint(evidence.publicKey);
  const qaPath = join(root, "qa.pem");
  const approverPath = join(root, "approver.pem");
  const evidencePrivatePath = join(root, "evidence-private.pem");
  const evidencePublicPath = join(root, "evidence-public.pem");
  privateWrite(qaPath, qa.publicKey.export({ type: "spki", format: "pem" }));
  privateWrite(approverPath, approver.publicKey.export({ type: "spki", format: "pem" }));
  privateWrite(evidencePrivatePath, evidence.privateKey.export({ type: "pkcs8", format: "pem" }));
  privateWrite(evidencePublicPath, evidence.publicKey.export({ type: "spki", format: "pem" }));
  const metadata = join(root, "metadata");
  mkdirSync(metadata, { mode: 0o700 });
  const sourceCommit = "1".repeat(40);
  const manifest = Buffer.from("manifest\n");
  const sbom = Buffer.from('{"spdxVersion":"SPDX-2.3"}\n');
  writeFileSync(join(metadata, "source-commit"), `${sourceCommit}\n`);
  writeFileSync(join(metadata, "source-manifest.sha256"), manifest);
  writeFileSync(join(metadata, "sbom.spdx.json"), sbom);
  const grant = {
    authorizationId: `${platform}-cert-1`, ledgerId: "tenant-test-action-ledger", environment: "production-canary",
    artifactDigest: digest(manifest), sbomDigest: digest(sbom), testEvidenceDigest: `sha256:${"3".repeat(64)}`,
    canaryAccountId: platform === "x" ? "x-canary" : "reddit-canary", expectedNativeIdentity: platform === "x" ? "12345" : "reddit:t2_aliceid", sessionGeneration: 4, routeId: "direct-route",
    readOperations: platform === "x" ? ["x.account.identity", "x.post.get"] : ["reddit.account.identity", "reddit.post.get"], writeOperations: platform === "x" ? ["x.bookmark.set"] : ["reddit.item.save", "reddit.item.unsave"],
    resourceConstraints: resourceConstraints ?? { accountId: platform === "x" ? "x-canary" : "reddit-canary" }, cleanupOperation: platform === "x" ? "x.bookmark.set" : "reddit.item.unsave", actionLimit: 4,
    notBefore: NOW - 60_000, expiresAt: NOW + 600_000,
  };
  const actors = { qaOperatorId: "qa-independent", approverId: "security-approver", qaKeyFingerprint: qaFingerprint, approverKeyFingerprint: approverFingerprint };
  const unsigned = { version: 2, sourceCommit, compatibilityEvidenceDigest: `sha256:${"4".repeat(64)}`, evidenceKeyFingerprint: evidenceFingerprint, deploymentId: "deployment-test", tenantId: "tenant-test", grant, actors };
  const bytes = Buffer.from(canonicalJson(unsigned));
  const envelope = { ...unsigned, signatures: { qa: sign(null, bytes, qa.privateKey).toString("base64url"), approver: sign(null, bytes, approver.privateKey).toString("base64url") } };
  const envelopePath = join(root, "envelope.json");
  privateWrite(envelopePath, JSON.stringify(envelope));
  return {
    root, qa, approver, evidence, sourceCommit, evidenceFingerprint, envelopePath, evidencePrivatePath, evidencePublicPath,
    loadInput: { envelopePath, qaPublicKeyPath: qaPath, approverPublicKeyPath: approverPath, releaseMetadataDirectory: metadata, trustRoots: { qaKeyFingerprints: [qaFingerprint], approverKeyFingerprints: [approverFingerprint] } },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}
function importBoundSession(runtime: SessionRuntime, accountId: string, platform: string, expectedNativeIdentity: string, finalGeneration: number, routeId: string, sessionValue: unknown) {
  const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    for (let generation = 1; generation <= finalGeneration; generation += 1) {
      const session = Buffer.from(JSON.stringify(sessionValue));
      runtime.importExternalSession({ accountId, platform, expectedNativeIdentity, generation, session, networkRoute: { id: routeId, material: Buffer.from(route) } });
      session.fill(0);
      if (generation < finalGeneration) runtime.revokeAccount({ accountId, generation });
    }
  } finally { route.fill(0); }
}
function admissionCoordinator(fixture: ReturnType<typeof envelopeFixture>, verified: ReturnType<typeof loadAdmissionEnvelope>, runtime: SessionRuntime, service: any, providers: Record<string, unknown>) {
  const evidenceSigner = { fingerprint: verified.evidenceKeyFingerprint, sign(payload: Uint8Array) { return sign(null, payload, fixture.evidence.privateKey).toString("base64url"); }, verify(payload: Uint8Array, signature: string) { return cryptoVerify(null, payload, fixture.evidence.publicKey, Buffer.from(signature, "base64url")); } };
  return new AdmissionProofCoordinator({ databasePath: join(fixture.root, "proofs.sqlite"), evidenceSigner, grant: verified.grant, qaOperator: verified.qaOperator, qaKeyFingerprint: verified.qaKeyFingerprint, approverKeyFingerprint: verified.approverKeyFingerprint, sourceCommit: verified.sourceCommit, compatibilityEvidenceDigest: verified.compatibilityEvidenceDigest, deploymentId: verified.deploymentId, tenantId: verified.tenantId, verifyExecutionChallenge: verified.verifyExecutionChallenge, sessionRuntime: runtime, service, wakeAction() {}, now: () => NOW, ...providers });
}
function proofExecutor(coordinator: AdmissionProofCoordinator, fixture: ReturnType<typeof envelopeFixture>, owner: any, platform: string, accountId: string) {
  return async (kind: string, targetId: string | null, parentProofId: string | null = null) => {
    const prepared = coordinator.prepare(owner, { accountId, proofKind: kind, targetId, parentProofId, expiresInSeconds: 120, confirmation: `PREPARE ${platform} ${kind} ${accountId}` }) as any;
    const signature = sign(null, Buffer.from(prepared.qaExecutionChallenge), fixture.qa.privateKey).toString("base64url");
    return await coordinator.execute(owner, prepared.proof.id, { confirmation: prepared.requiredExecutionConfirmation, qaExecutionSignature: signature }) as any;
  };
}
function privateWrite(path: string, value: string | Buffer) { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); }
function digest(value: Uint8Array) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function fingerprint(key: import("node:crypto").KeyObject) { return digest(key.export({ type: "spki", format: "der" })); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`; return JSON.stringify(value); }
function decodeCommand(serialized: Uint8Array) { const command = decodeWorkerMessage(serialized); if (command.type !== "social-git.worker.command") throw new Error("command expected"); return command; }
