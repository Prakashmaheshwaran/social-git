import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backup } from "node:sqlite";
import { Role, RoleAuthority, approveLiveTestGrant } from "@social-git/security";
import { AdmissionProofCoordinator, ADMISSION_PROOF_PLATFORMS, ensureAdmissionProofSchema } from "../src/admission-proof.ts";

/**
 * The exact table definition that shipped before the platform list became a
 * named constant. Every migration test starts from this literal so it proves
 * behaviour against a real old deployment, not a restatement of new code.
 */
const LEGACY_PROOF_TABLE = `CREATE TABLE IF NOT EXISTS admission_proofs (
      id TEXT PRIMARY KEY,
      authorization_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('reddit','x')),
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

const LEGACY_PROOF_INDEX =
  "CREATE INDEX IF NOT EXISTS admission_proofs_authorization ON admission_proofs(authorization_id, executed_at)";

const NOW = Date.UTC(2026, 8, 17, 15, 0, 0);
const OWNER = { callerId: "installation-owner", scopes: [], role: "owner" } as any;
/** A simulated future release that adds one platform. */
const WIDENED_PLATFORMS = Object.freeze(["reddit", "x", "mastodon"] as const);

function legacyDdl() {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(LEGACY_PROOF_TABLE);
    return storedTableSql(database, "admission_proofs");
  } finally { database.close(); }
}

test("admission proof schema: a fresh database keeps exactly today's DDL", () => {
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(LEGACY_PROOF_TABLE);
  const legacySql = storedTableSql(legacy, "admission_proofs");
  legacy.close();

  const fresh = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(ensureAdmissionProofSchema(fresh), { migrated: false });
    assert.equal(storedTableSql(fresh, "admission_proofs"), legacySql);
    assert.equal(ADMISSION_PROOF_PLATFORMS.join(","), "reddit,x",
      "the shipped platform list must not change without a migration review");
  } finally { fresh.close(); }
});

test("admission proof schema: an upgraded database is rebuilt and keeps every row byte-for-byte", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec(LEGACY_PROOF_TABLE);
    legacy.exec(LEGACY_PROOF_INDEX);
    insertProof(legacy, { rowid: 1, id: "proof-1", platform: "reddit", full: true });
    insertProof(legacy, { rowid: 7, id: "proof-2", platform: "x", full: true });
    insertProof(legacy, { rowid: 42, id: "proof-3", platform: "reddit", full: false });
    const before = legacy.prepare("SELECT rowid, * FROM admission_proofs ORDER BY rowid").all();

    // The rebuild is triggered by the platform set changing: this is what an
    // operator upgrading across a third-platform release would experience.
    assert.deepEqual(ensureAdmissionProofSchema(legacy, { platforms: WIDENED_PLATFORMS }), { migrated: true });
    const after = legacy.prepare("SELECT rowid, * FROM admission_proofs ORDER BY rowid").all();
    assert.deepEqual(after, before);
    assert.deepEqual(after.map((row: any) => row.rowid), [1, 7, 42]);
    // The rebuilt constraint still rejects a platform outside the new set:
    // widening the constant is deliberate, not an open-ended string column.
    assert.throws(() => insertProof(legacy, { id: "proof-x", platform: "facebook" }), /CHECK constraint failed/u);
    assert.deepEqual(indexNames(legacy), ["admission_proofs_authorization"]);
    assert.equal(Number((legacy.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys), 1);
  } finally { legacy.close(); }
});

test("admission proof schema: the shipped platform set leaves an old deployment untouched", () => {
  // With the constant unchanged, the stored DDL is already current, so there is
  // nothing to rebuild. This proves the migration is a true no-op for every
  // deployment that has not added a platform yet.
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(LEGACY_PROOF_TABLE);
    insertProof(database, { id: "proof-1", platform: "x" });
    assert.deepEqual(ensureAdmissionProofSchema(database), { migrated: false });
    assert.equal(storedTableSql(database, "admission_proofs"), legacyDdl());
  } finally { database.close(); }
});

test("admission proof schema: a second run is a no-op and writes nothing", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(LEGACY_PROOF_TABLE);
    insertProof(database, { id: "proof-1", platform: "x" });
    assert.deepEqual(ensureAdmissionProofSchema(database, { platforms: WIDENED_PLATFORMS }), { migrated: true });
    const ddl = storedTableSql(database, "admission_proofs");
    const rows = database.prepare("SELECT rowid, * FROM admission_proofs").all();

    assert.deepEqual(ensureAdmissionProofSchema(database, { platforms: WIDENED_PLATFORMS }), { migrated: false });
    assert.equal(storedTableSql(database, "admission_proofs"), ddl);
    assert.deepEqual(database.prepare("SELECT rowid, * FROM admission_proofs").all(), rows);
  } finally { database.close(); }
});

test("admission proof schema: an unknown stored platform fails closed and changes nothing", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(LEGACY_PROOF_TABLE.replace("('reddit','x')", "('reddit','x','myspace')"));
    database.exec(LEGACY_PROOF_INDEX);
    insertProof(database, { id: "proof-1", platform: "reddit" });
    insertProof(database, { id: "proof-2", platform: "myspace" });
    const ddl = storedTableSql(database, "admission_proofs");
    const rows = database.prepare("SELECT rowid, * FROM admission_proofs ORDER BY rowid").all();

    assert.throws(() => ensureAdmissionProofSchema(database, { platforms: WIDENED_PLATFORMS }), /unsupported platforms myspace/u);
    assert.equal(storedTableSql(database, "admission_proofs"), ddl);
    assert.deepEqual(database.prepare("SELECT rowid, * FROM admission_proofs ORDER BY rowid").all(), rows);
    // No half-built table survives the refusal.
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%rebuild%'").all(), []);
    assert.deepEqual(indexNames(database), ["admission_proofs_authorization"]);
  } finally { database.close(); }
});

test("admission proof schema: a widened platform list accepts the new platform after migration", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(LEGACY_PROOF_TABLE);
    insertProof(database, { id: "proof-1", platform: "reddit" });
    // The old constraint must reject the new platform before the migration.
    assert.throws(() => insertProof(database, { id: "proof-2", platform: "mastodon" }), /CHECK constraint failed/u);

    assert.deepEqual(ensureAdmissionProofSchema(database, { platforms: WIDENED_PLATFORMS }), { migrated: true });
    insertProof(database, { id: "proof-3", platform: "mastodon" });
    assert.deepEqual(
      database.prepare("SELECT id, platform FROM admission_proofs ORDER BY rowid").all().map((row: any) => ({ id: row.id, platform: row.platform })),
      [{ id: "proof-1", platform: "reddit" }, { id: "proof-3", platform: "mastodon" }],
    );
    assert.deepEqual(ensureAdmissionProofSchema(database, { platforms: WIDENED_PLATFORMS }), { migrated: false });
    // Narrowing the list again would strand the mastodon row, so it must refuse.
    assert.throws(() => ensureAdmissionProofSchema(database), /unsupported platforms mastodon/u);
  } finally { database.close(); }
});

test("admission proof schema: the coordinator opens and writes through a legacy database", () => {
  const fixture = proofFixture();
  const legacyPath = join(fixture.root, "legacy.sqlite");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(LEGACY_PROOF_TABLE);
  legacy.exec(LEGACY_PROOF_INDEX);
  insertProof(legacy, { id: "11111111-1111-4111-8111-111111111111", platform: "x", full: true });
  legacy.close();

  const coordinator = new AdmissionProofCoordinator({ ...fixture.options, databasePath: legacyPath });
  try {
    const prepared = coordinator.get(OWNER, "11111111-1111-4111-8111-111111111111") as any;
    assert.equal(prepared.proof.platform, "x");
    const created = coordinator.prepare(OWNER, {
      accountId: "canary", proofKind: "identity", targetId: null, parentProofId: null,
      expiresInSeconds: 120, confirmation: "PREPARE x identity canary",
    }) as any;
    assert.equal(created.proof.platform, "x");
    assert.equal(created.proof.state, "authorized");
  } finally {
    coordinator.close();
    fixture.close();
  }
});

test("admission proof schema: a backup taken before the migration restores and still reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-git-admission-restore-"));
  const sourcePath = join(root, "live-authorization.sqlite");
  const backupPath = join(root, "live-authorization.backup.sqlite");
  const restoredPath = join(root, "live-authorization.restored.sqlite");
  try {
    // An old deployment's database: legacy DDL plus proof rows.
    const legacy = new DatabaseSync(sourcePath);
    legacy.exec("PRAGMA journal_mode=WAL;");
    legacy.exec(LEGACY_PROOF_TABLE);
    legacy.exec(LEGACY_PROOF_INDEX);
    insertProof(legacy, { id: "proof-1", platform: "reddit", full: true });
    insertProof(legacy, { id: "proof-2", platform: "x", full: true });
    const expected = legacy.prepare("SELECT rowid, * FROM admission_proofs ORDER BY rowid").all();
    await backup(legacy, backupPath);
    legacy.close();

    // Restore copies the pre-migration file to a new destination, exactly as
    // the owner backup path does for the databases it covers.
    const snapshot = new DatabaseSync(backupPath);
    await backup(snapshot, restoredPath);
    snapshot.close();

    // The restored database is still the old shape and holds both rows.
    const restored = new DatabaseSync(restoredPath);
    try {
      assert.deepEqual(restored.prepare("SELECT rowid, * FROM admission_proofs ORDER BY rowid").all(), expected);
    } finally { restored.close(); }

    // Opening it after a platform widening migrates it in place, still intact.
    const migrated = new DatabaseSync(restoredPath);
    try {
      assert.deepEqual(ensureAdmissionProofSchema(migrated, { platforms: WIDENED_PLATFORMS }), { migrated: true });
      assert.deepEqual(migrated.prepare("SELECT rowid, * FROM admission_proofs ORDER BY rowid").all(), expected);
      assert.equal((migrated.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function storedTableSql(database: DatabaseSync, name: string) {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql?: string } | undefined;
  return row?.sql ?? "";
}

function indexNames(database: DatabaseSync) {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admission_proofs' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function insertProof(database: DatabaseSync, input: { rowid?: number; id: string; platform: string; full?: boolean }) {
  const requester = input.id.startsWith("11111111") ? "installation-owner" : "requester-1";
  if (input.full) {
    database.prepare(`INSERT INTO admission_proofs(
      rowid, id, authorization_id, requester_id, account_id, platform, proof_kind, operation, target_id, target_digest,
      parent_proof_id, request_digest, state, action_id, result_digest, error_code, created_at, expires_at, executed_at,
      finalized_at, execute_count, evidence_json, evidence_digest, evidence_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.rowid ?? null, input.id, "authorization-1", requester, "canary", input.platform, "canary_write", "reddit.item.save",
        "target-1", "sha256:11", null, "sha256:22", "succeeded", "action-1", "sha256:33", null,
        "2026-09-17T15:00:00.000Z", "2026-09-17T15:15:00.000Z", "2026-09-17T15:01:00.000Z",
        "2026-09-17T15:02:00.000Z", 1, JSON.stringify({ sample: true }), "sha256:44", "signature-1");
    return;
  }
  if (input.rowid === undefined) {
    database.prepare(`INSERT INTO admission_proofs(
      id, authorization_id, requester_id, account_id, platform, proof_kind, operation, request_digest, state, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'identity', 'x.account.identity', 'sha256:55', 'authorized', '2026-09-17T15:00:00.000Z', '2026-09-17T15:15:00.000Z')`)
      .run(input.id, "authorization-1", requester, "canary", input.platform);
    return;
  }
  database.prepare(`INSERT INTO admission_proofs(
    rowid, id, authorization_id, requester_id, account_id, platform, proof_kind, operation, request_digest, state, created_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'identity', 'x.account.identity', 'sha256:55', 'authorized', '2026-09-17T15:00:00.000Z', '2026-09-17T15:15:00.000Z')`)
    .run(input.rowid, input.id, "authorization-1", requester, "canary", input.platform);
}

function proofFixture() {
  const root = mkdtempSync(join(tmpdir(), "social-git-proof-schema-"));
  const qaKeys = generateKeyPairSync("ed25519");
  const evidenceKeys = generateKeyPairSync("ed25519");
  const authority = new RoleAuthority([{ actorId: "qa", role: Role.INDEPENDENT_LIVE_QA }, { actorId: "approver", role: Role.SECURITY_REVIEWER }]);
  const qa = authority.principalFor("qa");
  const grant = approveLiveTestGrant({
    authorizationId: "authorization-x", ledgerId: "tenant-action-ledger", environment: "production-canary",
    artifactDigest: `sha256:${"a".repeat(64)}`, sbomDigest: `sha256:${"b".repeat(64)}`, testEvidenceDigest: `sha256:${"c".repeat(64)}`,
    canaryAccountId: "canary", expectedNativeIdentity: "12345", sessionGeneration: 4, routeId: "direct-route",
    readOperations: ["x.account.identity"], writeOperations: [], resourceConstraints: { accountId: "canary" }, cleanupOperation: null,
    actionLimit: 4, notBefore: NOW - 1_000, expiresAt: NOW + 600_000,
  }, { qaOperator: qa, approver: authority.principalFor("approver") });
  const options = {
    databasePath: join(root, "authorization.sqlite"),
    evidenceSigner: {
      fingerprint: `sha256:${"d".repeat(64)}`,
      sign(payload: Uint8Array) { return cryptoSign(null, payload, evidenceKeys.privateKey).toString("base64url"); },
      verify(payload: Uint8Array, signature: string) { return cryptoVerify(null, payload, evidenceKeys.publicKey, Buffer.from(signature, "base64url")); },
    },
    grant, qaOperator: qa,
    qaKeyFingerprint: `sha256:${"e".repeat(64)}`, approverKeyFingerprint: `sha256:${"f".repeat(64)}`,
    sourceCommit: "1".repeat(40), compatibilityEvidenceDigest: `sha256:${"2".repeat(64)}`, deploymentId: "deployment-one", tenantId: "tenant",
    verifyExecutionChallenge() { return true; },
    sessionRuntime: { getAccountState() { return { expectedNativeIdentity: "12345", generation: 4, networkRouteId: "direct-route" }; } } as any,
    service: {
      store: { getAccount() { return { id: "canary", platform: "x", expectedNativeUserId: "12345" }; }, audit() {}, getActionInternal() { return undefined; } },
      async read() { return { entity: { nativeId: "12345" } }; },
      async enqueueAction() { throw new Error("not configured"); },
    } as any,
    wakeAction() {}, now: () => NOW,
  } as any;
  return { root, options, close() { rmSync(root, { recursive: true, force: true }); } };
}
