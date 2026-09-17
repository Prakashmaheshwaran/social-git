import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as secureRandomBytes,
  randomUUID as secureRandomUUID
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { SessionRuntimeError, requireValue, runtimeError } from "./errors.js";

const BACKUP_VERSION = 1;
const ALGORITHM = "A256GCM";
const PURPOSE = "database-backup";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_AUDIT_ANCHOR_BYTES = 4096;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CURRENT_SCHEMA_VERSION = 2;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validateKey(key) {
  requireValue(key instanceof Uint8Array && key.byteLength === 32);
}

function validateMetadata(metadata) {
  if (!isPlainObject(metadata)
    || Object.keys(metadata).length !== 6
    || !validText(metadata.backupId, 128)
    || !validText(metadata.tenantId, 128)
    || metadata.purpose !== PURPOSE
    || !Number.isSafeInteger(metadata.schemaVersion)
    || metadata.schemaVersion < 1
    || !Number.isSafeInteger(metadata.createdAt)
    || metadata.createdAt < 0
    || !Number.isSafeInteger(metadata.expiresAt)
    || metadata.expiresAt <= metadata.createdAt
    || metadata.expiresAt - metadata.createdAt > MAX_RETENTION_MS) {
    throw runtimeError("MALFORMED_BACKUP");
  }
  return Object.freeze({
    backupId: metadata.backupId,
    tenantId: metadata.tenantId,
    purpose: metadata.purpose,
    schemaVersion: metadata.schemaVersion,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt
  });
}

function metadataBytes(metadata) {
  return Buffer.from(JSON.stringify(validateMetadata(metadata)), "utf8");
}

function backupAad(metadata, auditAnchor) {
  const metadataBuffer = metadataBytes(metadata);
  try {
    return Buffer.concat([
      metadataBuffer,
      Buffer.from("\0social-git/audit-anchor/v1\0", "utf8"),
      auditAnchor
    ]);
  } finally {
    metadataBuffer.fill(0);
  }
}

function deriveBackupKey(backupKey, metadata) {
  const source = Buffer.from(backupKey);
  const aad = metadataBytes(metadata);
  const info = Buffer.concat([
    Buffer.from("social-git/backup-key/v1\0", "utf8"),
    aad
  ]);
  try {
    return Buffer.from(hkdfSync("sha256", source, Buffer.alloc(0), info, 32));
  } finally {
    source.fill(0);
    aad.fill(0);
    info.fill(0);
  }
}

function decodeBase64Url(value, expectedBytes = undefined) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw runtimeError("MALFORMED_BACKUP");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value
    || (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)) {
    bytes.fill(0);
    throw runtimeError("MALFORMED_BACKUP");
  }
  return bytes;
}

function parseBackup(serialized) {
  if (!(serialized instanceof Uint8Array)
    || serialized.byteLength === 0
    || serialized.byteLength > MAX_BACKUP_BYTES) {
    throw runtimeError(serialized?.byteLength > MAX_BACKUP_BYTES
      ? "BACKUP_TOO_LARGE"
      : "MALFORMED_BACKUP");
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(serialized).toString("utf8"));
  } catch (error) {
    throw runtimeError("MALFORMED_BACKUP", error);
  }
  if (!isPlainObject(envelope)
    || Object.keys(envelope).length !== 7
    || envelope.version !== BACKUP_VERSION
    || envelope.algorithm !== ALGORITHM) {
    throw runtimeError("MALFORMED_BACKUP");
  }
  const auditAnchor = decodeBase64Url(envelope.auditAnchor);
  if (auditAnchor.byteLength > MAX_AUDIT_ANCHOR_BYTES) {
    auditAnchor.fill(0);
    throw runtimeError("MALFORMED_BACKUP");
  }
  return {
    metadata: validateMetadata(envelope.metadata),
    auditAnchor,
    nonce: decodeBase64Url(envelope.nonce, NONCE_BYTES),
    ciphertext: decodeBase64Url(envelope.ciphertext),
    tag: decodeBase64Url(envelope.tag, TAG_BYTES)
  };
}

function stagePath(targetPath, randomUUID) {
  const suffix = randomUUID();
  requireValue(validText(suffix, 128) && /^[A-Za-z0-9-]+$/.test(suffix));
  return `${targetPath}.stage-${suffix}`;
}

function writePrivateStage(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function publishStage(stagingPath, destinationPath) {
  if (existsSync(destinationPath)) throw runtimeError("PATH_CONFLICT");
  try {
    linkSync(stagingPath, destinationPath);
  } catch (error) {
    if (existsSync(destinationPath)) throw runtimeError("PATH_CONFLICT");
    throw error;
  }
  unlinkSync(stagingPath);
  chmodSync(destinationPath, 0o600);
}

export function createEncryptedBackupFile({
  snapshot,
  auditAnchor,
  backupPath,
  backupKey,
  metadata,
  randomBytes = secureRandomBytes,
  randomUUID = secureRandomUUID,
  claimedNonces
}) {
  requireValue(snapshot instanceof Uint8Array && snapshot.byteLength > 0);
  requireValue(auditAnchor instanceof Uint8Array
    && auditAnchor.byteLength > 0
    && auditAnchor.byteLength <= MAX_AUDIT_ANCHOR_BYTES);
  requireValue(validText(backupPath, 4096));
  requireValue(typeof randomBytes === "function");
  requireValue(typeof randomUUID === "function");
  requireValue(claimedNonces instanceof Set);
  validateKey(backupKey);
  chmodSync(dirname(backupPath), 0o700);
  const validMetadata = validateMetadata(metadata);
  const anchorCopy = Buffer.from(auditAnchor);
  const aad = backupAad(validMetadata, anchorCopy);
  const key = deriveBackupKey(backupKey, validMetadata);
  const nonce = Buffer.from(randomBytes(NONCE_BYTES));
  requireValue(nonce.byteLength === NONCE_BYTES);
  const nonceClaim = nonce.toString("base64url");
  if (claimedNonces.has(nonceClaim)) {
    aad.fill(0);
    key.fill(0);
    nonce.fill(0);
    throw runtimeError("NONCE_REUSE");
  }
  claimedNonces.add(nonceClaim);
  const cleartext = Buffer.from(snapshot);
  let ciphertext;
  let tag;
  let serialized;
  const stagingPath = stagePath(backupPath, randomUUID);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: cleartext.byteLength });
    ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    tag = cipher.getAuthTag();
    serialized = Buffer.from(JSON.stringify({
      version: BACKUP_VERSION,
      algorithm: ALGORITHM,
      metadata: validMetadata,
      auditAnchor: anchorCopy.toString("base64url"),
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url")
    }), "utf8");
    if (serialized.byteLength > MAX_BACKUP_BYTES) throw runtimeError("BACKUP_TOO_LARGE");
    writePrivateStage(stagingPath, serialized);
    publishStage(stagingPath, backupPath);
    return validMetadata;
  } catch (error) {
    if (existsSync(stagingPath)) unlinkSync(stagingPath);
    if (error instanceof SessionRuntimeError) throw error;
    throw runtimeError("STORAGE_FAILURE", error);
  } finally {
    aad.fill(0);
    anchorCopy.fill(0);
    key.fill(0);
    nonce.fill(0);
    cleartext.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
    serialized?.fill(0);
  }
}

function decryptBackup(serialized, backupKey) {
  validateKey(backupKey);
  const envelope = parseBackup(serialized);
  const aad = backupAad(envelope.metadata, envelope.auditAnchor);
  const key = deriveBackupKey(backupKey, envelope.metadata);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, {
      authTagLength: TAG_BYTES
    });
    decipher.setAAD(aad, { plaintextLength: envelope.ciphertext.byteLength });
    decipher.setAuthTag(envelope.tag);
    return {
      metadata: envelope.metadata,
      auditAnchor: Buffer.from(envelope.auditAnchor),
      snapshot: Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
    };
  } catch (error) {
    throw runtimeError("BACKUP_AUTH_FAILURE", error);
  } finally {
    aad.fill(0);
    key.fill(0);
    envelope.nonce.fill(0);
    envelope.auditAnchor.fill(0);
    envelope.ciphertext.fill(0);
    envelope.tag.fill(0);
  }
}

function validateRestoredDatabase(path, tenantId, schemaVersion) {
  let database;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      enableForeignKeyConstraints: true,
      timeout: 5000
    });
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw runtimeError("STORAGE_FAILURE");
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw runtimeError("STORAGE_FAILURE");
    }
    const storedSchema = database.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations"
    ).get()?.version;
    const storedTenant = database.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'tenant_id'"
    ).get()?.value;
    if (storedSchema !== schemaVersion || storedTenant !== tenantId) {
      throw runtimeError("BACKUP_CONTEXT_MISMATCH");
    }
  } catch (error) {
    if (error instanceof SessionRuntimeError) throw error;
    throw runtimeError("STORAGE_FAILURE", error);
  } finally {
    database?.close();
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${path}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
  }
}

export function restoreEncryptedBackup({
  backupPath,
  destinationPath,
  backupKey,
  tenantId,
  schemaVersion = CURRENT_SCHEMA_VERSION,
  now = Date.now,
  randomUUID = secureRandomUUID,
  validateDatabase = validateRestoredDatabase
}) {
  requireValue(validText(backupPath, 4096));
  requireValue(validText(destinationPath, 4096));
  requireValue(backupPath !== destinationPath);
  requireValue(validText(tenantId, 128));
  requireValue(Number.isSafeInteger(schemaVersion) && schemaVersion > 0);
  requireValue(typeof now === "function");
  requireValue(typeof randomUUID === "function");
  requireValue(typeof validateDatabase === "function");
  if (existsSync(destinationPath)) throw runtimeError("PATH_CONFLICT");
  let serialized;
  let snapshot;
  let auditAnchor;
  let stagingPath;
  let anchorStagingPath;
  const destinationAnchorPath = `${destinationPath}.audit-anchor`;
  try {
    chmodSync(dirname(destinationPath), 0o700);
    if (existsSync(destinationAnchorPath)) throw runtimeError("PATH_CONFLICT");
    const size = statSync(backupPath).size;
    if (size > MAX_BACKUP_BYTES) throw runtimeError("BACKUP_TOO_LARGE");
    serialized = readFileSync(backupPath);
    const decrypted = decryptBackup(serialized, backupKey);
    snapshot = decrypted.snapshot;
    auditAnchor = decrypted.auditAnchor;
    const timestamp = now();
    requireValue(Number.isSafeInteger(timestamp) && timestamp >= 0);
    if (decrypted.metadata.tenantId !== tenantId
      || decrypted.metadata.schemaVersion !== schemaVersion) {
      throw runtimeError("BACKUP_CONTEXT_MISMATCH");
    }
    if (timestamp >= decrypted.metadata.expiresAt) throw runtimeError("BACKUP_EXPIRED");
    stagingPath = stagePath(destinationPath, randomUUID);
    anchorStagingPath = `${stagingPath}.audit-anchor`;
    writePrivateStage(stagingPath, snapshot);
    writePrivateStage(anchorStagingPath, auditAnchor);
    validateDatabase(stagingPath, tenantId, schemaVersion, auditAnchor);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${stagingPath}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    publishStage(stagingPath, destinationPath);
    stagingPath = undefined;
    try {
      publishStage(anchorStagingPath, destinationAnchorPath);
      anchorStagingPath = undefined;
    } catch (error) {
      unlinkSync(destinationPath);
      throw error;
    }
    return decrypted.metadata;
  } catch (error) {
    if (stagingPath !== undefined && existsSync(stagingPath)) unlinkSync(stagingPath);
    if (anchorStagingPath !== undefined && existsSync(anchorStagingPath)) {
      unlinkSync(anchorStagingPath);
    }
    if (error instanceof SessionRuntimeError) throw error;
    throw runtimeError("STORAGE_FAILURE", error);
  } finally {
    serialized?.fill(0);
    snapshot?.fill(0);
    auditAnchor?.fill(0);
  }
}

export const ENCRYPTED_BACKUP_VERSION = BACKUP_VERSION;
export const MAX_BACKUP_RETENTION_MS = MAX_RETENTION_MS;
