import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MAX_BACKUP_RETENTION_MS,
  SESSION_RUNTIME_SCHEMA_VERSION,
  SessionRuntime,
  createSafeLogger,
  createSafeTelemetry,
  decodeWorkerMessage,
  encodeWorkerMessage,
  restoreEncryptedBackup
} from "../src/index.js";

const SERVICE_KEY = Buffer.alloc(32, 0x31);
const ROTATED_SERVICE_KEY = Buffer.alloc(32, 0x32);
const AUDIT_KEY = Buffer.alloc(32, 0x33);
const BACKUP_KEY = Buffer.alloc(32, 0x34);
const TENANT_ID = "tenant-security-proof";
const TEST_ROOT = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  || process.env.PAPERCLIP_SCRATCH_DIR
  || tmpdir();

function expectCode(code) {
  return (error) => error?.code === code;
}

function harness(options = {}) {
  const directory = mkdtempSync(join(TEST_ROOT, "social-git-security-"));
  const databasePath = join(directory, "core.sqlite");
  let time = 1_900_000_000_000;
  let sequence = 0;
  let nonce = 0;
  const randomBytes = options.randomBytes ?? ((size) => Buffer.alloc(size, ++nonce));
  return {
    directory,
    databasePath,
    now: () => time,
    advance(milliseconds) {
      time += milliseconds;
    },
    open(masterKey = SERVICE_KEY, auditKey = AUDIT_KEY, path = databasePath) {
      return new SessionRuntime({
        databasePath: path,
        tenantId: TENANT_ID,
        masterKey,
        auditKey,
        now: () => time,
        randomUUID: () => `security-id-${++sequence}`,
        randomBytes
      });
    },
    nextId: () => `security-id-${++sequence}`,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function importSession(runtime, generation, session, route) {
  return runtime.importExternalSession({
    accountId: "account-security",
    platform: "reddit",
    expectedNativeIdentity: "native-security",
    generation,
    session: Buffer.from(session),
    networkRoute: { id: `route-${generation}`, material: Buffer.from(route) }
  });
}

function acquireIdentity(runtime, generation, requestId) {
  return decodeWorkerMessage(runtime.acquireWorkerCommand({
    accountId: "account-security",
    generation,
    requestId,
    intent: "identity_validation",
    operation: "identity.current"
  }));
}

function completeIdentity(runtime, command) {
  return runtime.completeWorkerResult({
    accountId: command.accountId,
    generation: command.generation,
    message: encodeWorkerMessage({
      version: 1,
      type: "social-git.worker.result",
      requestId: command.requestId,
      tenantId: command.tenantId,
      accountId: command.accountId,
      platform: command.platform,
      generation: command.generation,
      leaseId: command.leaseId,
      fence: command.fence,
      status: "SUCCEEDED",
      observedNativeIdentity: command.expectedNativeIdentity
    })
  });
}

function fileBytes(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(directory, entry.name)));
}

function assertCanariesAbsent(values, canaries) {
  const buffers = values.map((value) => Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
  for (const canary of canaries) {
    for (const buffer of buffers) {
      assert.equal(buffer.includes(Buffer.from(canary)), false, `leaked canary: ${canary}`);
    }
  }
}

test("canaries stay out of SQLite, WAL, SHM, temp, backup, audit, telemetry, and crash output", () => {
  const run = harness();
  const backupPath = join(run.directory, "core.backup.enc");
  const restoredPath = join(run.directory, "restored.sqlite");
  const wrongKeyDestination = join(run.directory, "wrong-key.sqlite");
  const wrongTenantDestination = join(run.directory, "wrong-tenant.sqlite");
  const expiredDestination = join(run.directory, "expired.sqlite");
  const wrongSchemaDestination = join(run.directory, "wrong-schema.sqlite");
  const noKeyDestination = join(run.directory, "no-key.sqlite");
  const overRetentionBackup = join(run.directory, "over-retention.backup.enc");
  const sessionCanary = "SG_SESSION_CANARY_3d54c8e98c784fb0";
  const routeCanary = "SG_ROUTE_CANARY_7b297c624a0946c1";
  const rotatedSessionCanary = "SG_ROTATED_SESSION_CANARY_c576afb18fa442ee";
  const rotatedRouteCanary = "SG_ROTATED_ROUTE_CANARY_d619e6e754e649a1";
  const canaries = [sessionCanary, routeCanary, rotatedSessionCanary, rotatedRouteCanary];
  const diagnosticOutput = [];
  const logger = createSafeLogger((level, message, fields) => {
    diagnosticOutput.push({ level, message, fields });
  });
  const telemetry = createSafeTelemetry((kind, name, fields) => {
    diagnosticOutput.push({ kind, name, fields });
  });
  let runtime = run.open();
  let restored;
  try {
    importSession(runtime, 1, sessionCanary, routeCanary);
    completeIdentity(runtime, acquireIdentity(runtime, 1, "identity-1"));
    importSession(runtime, 2, rotatedSessionCanary, rotatedRouteCanary);
    completeIdentity(runtime, acquireIdentity(runtime, 2, "identity-2"));

    assert.deepEqual(runtime.rotateMasterKey({ newMasterKey: ROTATED_SERVICE_KEY }), {
      accountCount: 1,
      rotatedAt: run.now()
    });
    const backup = runtime.createEncryptedBackup({
      backupPath,
      backupKey: BACKUP_KEY,
      expiresAt: run.now() + 60_000
    });
    assert.equal(backup.tenantId, TENANT_ID);
    assert.equal(backup.schemaVersion, SESSION_RUNTIME_SCHEMA_VERSION);
    runtime.checkpoint();

    assert.throws(() => restoreEncryptedBackup({
      backupPath,
      destinationPath: wrongKeyDestination,
      backupKey: Buffer.alloc(32, 0x35),
      tenantId: TENANT_ID,
      now: run.now,
      randomUUID: run.nextId
    }), expectCode("BACKUP_AUTH_FAILURE"));
    assert.throws(() => restoreEncryptedBackup({
      backupPath,
      destinationPath: wrongTenantDestination,
      backupKey: BACKUP_KEY,
      tenantId: "tenant-wrong",
      now: run.now,
      randomUUID: run.nextId
    }), expectCode("BACKUP_CONTEXT_MISMATCH"));
    assert.throws(() => restoreEncryptedBackup({
      backupPath,
      destinationPath: expiredDestination,
      backupKey: BACKUP_KEY,
      tenantId: TENANT_ID,
      now: () => backup.expiresAt,
      randomUUID: run.nextId
    }), expectCode("BACKUP_EXPIRED"));
    assert.throws(() => restoreEncryptedBackup({
      backupPath,
      destinationPath: wrongSchemaDestination,
      backupKey: BACKUP_KEY,
      tenantId: TENANT_ID,
      schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION + 1,
      now: run.now,
      randomUUID: run.nextId
    }), expectCode("BACKUP_CONTEXT_MISMATCH"));
    assert.throws(() => restoreEncryptedBackup({
      backupPath,
      destinationPath: noKeyDestination,
      tenantId: TENANT_ID,
      now: run.now,
      randomUUID: run.nextId
    }), expectCode("INVALID_ARGUMENT"));
    assert.equal(existsSync(wrongKeyDestination), false);
    assert.equal(existsSync(wrongTenantDestination), false);
    assert.equal(existsSync(expiredDestination), false);
    assert.equal(existsSync(wrongSchemaDestination), false);
    assert.equal(existsSync(noKeyDestination), false);
    assert.throws(() => runtime.createEncryptedBackup({
      backupPath: overRetentionBackup,
      backupKey: BACKUP_KEY,
      expiresAt: run.now() + MAX_BACKUP_RETENTION_MS + 1
    }), expectCode("INVALID_ARGUMENT"));
    assert.equal(existsSync(overRetentionBackup), false);

    restoreEncryptedBackup({
      backupPath,
      destinationPath: restoredPath,
      backupKey: BACKUP_KEY,
      tenantId: TENANT_ID,
      now: run.now,
      randomUUID: run.nextId
    });
    restored = run.open(ROTATED_SERVICE_KEY, AUDIT_KEY, restoredPath);
    const restoredCommand = acquireIdentity(restored, 2, "restored-identity");
    assert.equal(
      Buffer.from(restoredCommand.sessionBase64, "base64url").toString(),
      rotatedSessionCanary
    );
    assert.equal(
      Buffer.from(restoredCommand.networkRoute.materialBase64, "base64url").toString(),
      rotatedRouteCanary
    );
    completeIdentity(restored, restoredCommand);

    let oldKeyRuntime;
    try {
      oldKeyRuntime = run.open(SERVICE_KEY, AUDIT_KEY, restoredPath);
      assert.throws(
        () => acquireIdentity(oldKeyRuntime, 2, "old-key-read"),
        expectCode("CRYPTO_FAILURE")
      );
    } finally {
      oldKeyRuntime?.close();
    }
    assert.throws(
      () => run.open(ROTATED_SERVICE_KEY, Buffer.alloc(32, 0x36), restoredPath),
      expectCode("AUDIT_INTEGRITY_FAILURE")
    );

    runtime.revokeAccount({ accountId: "account-security", generation: 2 });
    restored.revokeAccount({ accountId: "account-security", generation: 2 });
    runtime.checkpoint();
    restored.checkpoint();

    logger.info(`Authorization: Bearer ${sessionCanary}`, {
      session: sessionCanary,
      routeMaterial: routeCanary
    });
    telemetry.trace("session.rotate", { session: rotatedSessionCanary });
    telemetry.metric("session.count", 1, { routeMaterial: rotatedRouteCanary });
    const crash = new Error(rotatedSessionCanary);
    telemetry.crash(crash, { session: sessionCanary, routeMaterial: routeCanary });
    diagnosticOutput.push(JSON.stringify(crash));

    const auditOutput = [runtime.listAuditEvents(), restored.listAuditEvents()];
    assert.ok(runtime.verifyAuditIntegrity().eventCount >= 8);
    assertCanariesAbsent(auditOutput, canaries);
    assertCanariesAbsent(diagnosticOutput, canaries);

    const command = {
      version: 1,
      type: "social-git.worker.command",
      requestId: "worker-boundary",
      tenantId: TENANT_ID,
      accountId: "account-security",
      platform: "reddit",
      generation: 2,
      leaseId: "lease-worker-boundary",
      fence: 1,
      expiresAt: run.now() + 1,
      intent: "read",
      operation: "account.get",
      expectedNativeIdentity: "native-security",
      sessionBase64: Buffer.from("worker-session").toString("base64url"),
      networkRoute: {
        id: "route-worker",
        materialBase64: Buffer.from("worker-route").toString("base64url")
      },
      payload: null,
      databasePath: run.databasePath
    };
    assert.throws(() => encodeWorkerMessage(command), expectCode("MALFORMED_MESSAGE"));
  } finally {
    restored?.close();
    runtime.close();
  }

  try {
    const storedFiles = fileBytes(run.directory);
    assert.ok(storedFiles.length >= 3);
    assertCanariesAbsent(storedFiles, canaries);
    assertCanariesAbsent(storedFiles, [
      SERVICE_KEY.toString("latin1"),
      ROTATED_SERVICE_KEY.toString("latin1"),
      AUDIT_KEY.toString("latin1"),
      BACKUP_KEY.toString("latin1")
    ]);
    for (const path of [run.databasePath, backupPath, restoredPath]) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      readdirSync(run.directory).filter((name) => name.includes(".stage-")),
      []
    );
  } finally {
    run.cleanup();
  }
});

test("tampered backups and audit records fail closed and audit rows are append only", () => {
  const run = harness();
  const backupPath = join(run.directory, "core.backup.enc");
  const tamperedPath = join(run.directory, "tampered.backup.enc");
  const destinationPath = join(run.directory, "tampered.sqlite");
  let runtime = run.open();
  try {
    importSession(runtime, 1, "audit-session-canary", "audit-route-canary");
    runtime.createEncryptedBackup({
      backupPath,
      backupKey: BACKUP_KEY,
      expiresAt: run.now() + 60_000
    });
  } finally {
    runtime.close();
  }

  try {
    assert.throws(() => new SessionRuntime({
      databasePath: run.databasePath,
      tenantId: "tenant-wrong",
      masterKey: SERVICE_KEY,
      auditKey: AUDIT_KEY,
      now: run.now
    }), expectCode("TENANT_MISMATCH"));

    const envelope = JSON.parse(readFileSync(backupPath, "utf8"));
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    ciphertext[0] ^= 0x01;
    envelope.ciphertext = ciphertext.toString("base64url");
    ciphertext.fill(0);
    writeFileSync(tamperedPath, JSON.stringify(envelope), { mode: 0o600 });
    assert.throws(() => restoreEncryptedBackup({
      backupPath: tamperedPath,
      destinationPath,
      backupKey: BACKUP_KEY,
      tenantId: TENANT_ID,
      now: run.now,
      randomUUID: run.nextId
    }), expectCode("BACKUP_AUTH_FAILURE"));
    assert.equal(existsSync(destinationPath), false);

    const database = new DatabaseSync(run.databasePath);
    assert.throws(() => database.exec("UPDATE audit_events SET event_type = 'session.rotated'"));
    assert.throws(() => database.exec("DELETE FROM audit_events"));
    database.exec("DROP TRIGGER audit_events_no_update");
    database.exec("UPDATE audit_events SET event_type = 'session.rotated' WHERE sequence = 1");
    database.close();

    assert.throws(() => run.open(), expectCode("AUDIT_INTEGRITY_FAILURE"));
  } finally {
    run.cleanup();
  }
});

test("session and backup nonce reuse fail before a second ciphertext is written", () => {
  const run = harness({ randomBytes: (size) => Buffer.alloc(size, 0x7f) });
  const firstBackup = join(run.directory, "first.backup.enc");
  const secondBackup = join(run.directory, "second.backup.enc");
  const runtime = run.open();
  try {
    importSession(runtime, 1, "nonce-session", "nonce-route");
    runtime.createEncryptedBackup({
      backupPath: firstBackup,
      backupKey: BACKUP_KEY,
      expiresAt: run.now() + 60_000
    });
    assert.throws(() => runtime.createEncryptedBackup({
      backupPath: secondBackup,
      backupKey: BACKUP_KEY,
      expiresAt: run.now() + 60_000
    }), expectCode("NONCE_REUSE"));
    assert.equal(existsSync(secondBackup), false);
  } finally {
    runtime.close();
    run.cleanup();
  }
});
