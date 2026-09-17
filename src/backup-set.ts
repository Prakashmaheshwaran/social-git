import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { SESSION_RUNTIME_SCHEMA_VERSION, type BackupMetadata } from "@social-git/core";
import { ACTION_LEDGER_SCHEMA_VERSION } from "./ledger-backup.ts";
import { IDENTITY_SCHEMA_VERSION } from "./identity.ts";

export const BACKUP_SET_MANIFEST_FILE = "manifest.json";
export const RESTORE_SET_RECEIPT_FILE = "restore-receipt.json";
export const BACKUP_SET_VERSION = 2;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SET_SKEW_MS = 60_000;
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const HEX_256 = /^[a-f0-9]{64}$/u;

type ArtifactName = "sessions" | "actions" | "identity";
const ARTIFACTS = Object.freeze({
  sessions: { file: "sessions.backup", schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION },
  actions: { file: "actions.backup", schemaVersion: ACTION_LEDGER_SCHEMA_VERSION },
  identity: { file: "identity.backup", schemaVersion: IDENTITY_SCHEMA_VERSION },
} satisfies Record<ArtifactName, { file: string; schemaVersion: number }>);

export interface BackupSetArtifact {
  file: string;
  backupId: string;
  contextId: string;
  schemaVersion: number;
  createdAt: number;
  expiresAt: number;
  sizeBytes: number;
  sha256: string;
}

export interface AuthenticatedBackupSetManifest {
  version: 2;
  type: "social-git.backup-set";
  id: string;
  setId: string;
  status: "ready";
  tenantId: string;
  ledgerId: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string;
  sizeBytes: number;
  databaseCount: 3;
  artifacts: Record<ArtifactName, BackupSetArtifact>;
  authentication: { algorithm: "HMAC-SHA256"; tag: string };
}

interface RestoreSetReceipt {
  version: 1;
  type: "social-git.restore-set-receipt";
  setId: string;
  setName: string;
  tenantId: string;
  ledgerId: string;
  manifestSha256: string;
  restoredAt: number;
  files: Record<string, { sizeBytes: number; sha256: string }>;
  authentication: { algorithm: "HMAC-SHA256"; tag: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("backup set contains unexpected fields");
  }
}

function assertPrivateRegular(path: string, maximum = MAX_FILE_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum || (stat.mode & 0o077) !== 0) {
    throw new Error("backup set files must be private regular files");
  }
  return stat;
}

export function sha256File(path: string) {
  assertPrivateRegular(path);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function deriveAuthenticationKey(backupKey: Uint8Array, purpose: string) {
  if (backupKey.byteLength !== 32) throw new TypeError("backup key must contain exactly 32 bytes");
  return createHmac("sha256", Buffer.from(backupKey))
    .update(`social-git/${purpose}/v1\0`, "utf8")
    .digest();
}

function authenticate(payload: unknown, backupKey: Uint8Array, purpose: string) {
  const key = deriveAuthenticationKey(backupKey, purpose);
  try { return createHmac("sha256", key).update(JSON.stringify(payload), "utf8").digest("base64url"); }
  finally { key.fill(0); }
}

function verifyTag(payload: unknown, tag: unknown, backupKey: Uint8Array, purpose: string) {
  if (typeof tag !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(tag)) throw new Error("backup set authentication is invalid");
  const actual = Buffer.from(tag, "base64url");
  const expected = Buffer.from(authenticate(payload, backupKey, purpose), "base64url");
  try {
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new Error("backup set authentication failed");
    }
  } finally { actual.fill(0); expected.fill(0); }
}

function readEnvelopeMetadata(path: string): BackupMetadata {
  assertPrivateRegular(path);
  let envelope: unknown;
  try { envelope = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("backup artifact is malformed"); }
  if (!isRecord(envelope) || !isRecord(envelope.metadata)) throw new Error("backup artifact metadata is missing");
  const metadata = envelope.metadata;
  exactKeys(metadata, ["backupId", "tenantId", "purpose", "schemaVersion", "createdAt", "expiresAt"]);
  if (
    typeof metadata.backupId !== "string" || metadata.backupId.length < 1 || metadata.backupId.length > 128 ||
    typeof metadata.tenantId !== "string" || !CONTEXT_ID.test(metadata.tenantId) ||
    metadata.purpose !== "database-backup" ||
    !Number.isSafeInteger(metadata.schemaVersion) || !Number.isSafeInteger(metadata.createdAt) ||
    !Number.isSafeInteger(metadata.expiresAt) || Number(metadata.expiresAt) <= Number(metadata.createdAt)
  ) throw new Error("backup artifact metadata is invalid");
  return metadata as unknown as BackupMetadata;
}

function artifact(directory: string, name: ArtifactName, contextId: string): BackupSetArtifact {
  const definition = ARTIFACTS[name];
  const path = join(directory, definition.file);
  const stat = assertPrivateRegular(path);
  const metadata = readEnvelopeMetadata(path);
  if (metadata.tenantId !== contextId || metadata.schemaVersion !== definition.schemaVersion) {
    throw new Error("backup artifact context does not match the set");
  }
  return {
    file: definition.file,
    backupId: metadata.backupId,
    contextId: metadata.tenantId,
    schemaVersion: metadata.schemaVersion,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    sizeBytes: stat.size,
    sha256: sha256File(path),
  };
}

function manifestPayload(manifest: Omit<AuthenticatedBackupSetManifest, "authentication"> | AuthenticatedBackupSetManifest) {
  return {
    version: manifest.version,
    type: manifest.type,
    id: manifest.id,
    setId: manifest.setId,
    status: manifest.status,
    tenantId: manifest.tenantId,
    ledgerId: manifest.ledgerId,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    completedAt: manifest.completedAt,
    sizeBytes: manifest.sizeBytes,
    databaseCount: manifest.databaseCount,
    artifacts: manifest.artifacts,
  };
}

export function createAuthenticatedBackupSetManifest(input: {
  directory: string;
  setName: string;
  tenantId: string;
  ledgerId: string;
  backupKey: Uint8Array;
  setId?: string;
  completedAt?: number;
}): AuthenticatedBackupSetManifest {
  if (!SET_NAME.test(input.setName) || !CONTEXT_ID.test(input.tenantId) || !CONTEXT_ID.test(input.ledgerId)) {
    throw new TypeError("backup set context is invalid");
  }
  const artifacts = {
    sessions: artifact(input.directory, "sessions", input.tenantId),
    actions: artifact(input.directory, "actions", input.ledgerId),
    identity: artifact(input.directory, "identity", input.tenantId),
  };
  const created = Object.values(artifacts).map((entry) => entry.createdAt);
  const expires = Object.values(artifacts).map((entry) => entry.expiresAt);
  if (Math.max(...created) - Math.min(...created) > MAX_SET_SKEW_MS) throw new Error("backup artifacts were not captured as one set");
  const setId = input.setId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/iu.test(setId)) throw new TypeError("backup set id is invalid");
  const completedAt = input.completedAt ?? Date.now();
  const payload = {
    version: BACKUP_SET_VERSION as 2,
    type: "social-git.backup-set" as const,
    id: input.setName,
    setId,
    status: "ready" as const,
    tenantId: input.tenantId,
    ledgerId: input.ledgerId,
    createdAt: new Date(Math.max(...created)).toISOString(),
    expiresAt: new Date(Math.min(...expires)).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    sizeBytes: Object.values(artifacts).reduce((total, entry) => total + entry.sizeBytes, 0),
    databaseCount: 3 as const,
    artifacts,
  };
  return { ...payload, authentication: { algorithm: "HMAC-SHA256", tag: authenticate(payload, input.backupKey, "backup-set-manifest") } };
}

export function writeAuthenticatedBackupSetManifest(directory: string, manifest: AuthenticatedBackupSetManifest) {
  atomicWritePrivate(join(directory, BACKUP_SET_MANIFEST_FILE), Buffer.from(JSON.stringify(manifest), "utf8"));
}

export function verifyAuthenticatedBackupSetManifest(input: {
  directory: string;
  setName: string;
  tenantId: string;
  ledgerId: string;
  backupKey: Uint8Array;
  now?: number;
}): AuthenticatedBackupSetManifest {
  if (!SET_NAME.test(input.setName)) throw new TypeError("backup set name is invalid");
  const path = join(input.directory, BACKUP_SET_MANIFEST_FILE);
  assertPrivateRegular(path, MAX_MANIFEST_BYTES);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.authentication) || !isRecord(parsed.artifacts)) throw new Error("backup set manifest is malformed");
  exactKeys(parsed, ["version", "type", "id", "setId", "status", "tenantId", "ledgerId", "createdAt", "expiresAt", "completedAt", "sizeBytes", "databaseCount", "artifacts", "authentication"]);
  exactKeys(parsed.authentication, ["algorithm", "tag"]);
  exactKeys(parsed.artifacts, ["sessions", "actions", "identity"]);
  if (
    parsed.version !== BACKUP_SET_VERSION || parsed.type !== "social-git.backup-set" || parsed.status !== "ready" ||
    parsed.id !== input.setName || typeof parsed.setId !== "string" || !/^[a-f0-9-]{36}$/iu.test(parsed.setId) ||
    parsed.tenantId !== input.tenantId || parsed.ledgerId !== input.ledgerId || parsed.databaseCount !== 3 ||
    typeof parsed.createdAt !== "string" || typeof parsed.expiresAt !== "string" || typeof parsed.completedAt !== "string" ||
    !Number.isSafeInteger(parsed.sizeBytes) || parsed.authentication.algorithm !== "HMAC-SHA256"
  ) throw new Error("backup set manifest context is invalid");
  const manifest = parsed as unknown as AuthenticatedBackupSetManifest;
  verifyTag(manifestPayload(manifest), manifest.authentication.tag, input.backupKey, "backup-set-manifest");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now >= Date.parse(manifest.expiresAt)) throw new Error("backup set has expired");
  let total = 0;
  for (const name of Object.keys(ARTIFACTS) as ArtifactName[]) {
    const entry = manifest.artifacts[name];
    if (!isRecord(entry)) throw new Error("backup set artifact is malformed");
    exactKeys(entry, ["file", "backupId", "contextId", "schemaVersion", "createdAt", "expiresAt", "sizeBytes", "sha256"]);
    const definition = ARTIFACTS[name];
    const expectedContext = name === "actions" ? input.ledgerId : input.tenantId;
    if (
      entry.file !== definition.file || basename(entry.file) !== entry.file || entry.contextId !== expectedContext ||
      entry.schemaVersion !== definition.schemaVersion || typeof entry.backupId !== "string" || entry.backupId.length < 1 ||
      !Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.expiresAt) ||
      !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || typeof entry.sha256 !== "string" || !HEX_256.test(entry.sha256)
    ) throw new Error("backup set artifact binding is invalid");
    const artifactPath = join(input.directory, entry.file);
    const stat = assertPrivateRegular(artifactPath);
    if (stat.size !== entry.sizeBytes || sha256File(artifactPath) !== entry.sha256) throw new Error("backup set artifact digest mismatch");
    const metadata = readEnvelopeMetadata(artifactPath);
    if (
      metadata.backupId !== entry.backupId || metadata.tenantId !== entry.contextId ||
      metadata.schemaVersion !== entry.schemaVersion || metadata.createdAt !== entry.createdAt || metadata.expiresAt !== entry.expiresAt
    ) throw new Error("backup set artifact metadata mismatch");
    total += entry.sizeBytes;
  }
  if (total !== manifest.sizeBytes) throw new Error("backup set size binding is invalid");
  const created = Object.values(manifest.artifacts).map((entry) => entry.createdAt);
  const expires = Object.values(manifest.artifacts).map((entry) => entry.expiresAt);
  if (
    Math.max(...created) - Math.min(...created) > MAX_SET_SKEW_MS ||
    Date.parse(manifest.createdAt) !== Math.max(...created) ||
    Date.parse(manifest.expiresAt) !== Math.min(...expires) ||
    !Number.isFinite(Date.parse(manifest.completedAt)) || Date.parse(manifest.completedAt) < Math.min(...created)
  ) throw new Error("backup set time binding is invalid");
  return manifest;
}

function receiptPayload(receipt: Omit<RestoreSetReceipt, "authentication"> | RestoreSetReceipt) {
  return {
    version: receipt.version,
    type: receipt.type,
    setId: receipt.setId,
    setName: receipt.setName,
    tenantId: receipt.tenantId,
    ledgerId: receipt.ledgerId,
    manifestSha256: receipt.manifestSha256,
    restoredAt: receipt.restoredAt,
    files: receipt.files,
  };
}

export function writeRestoreSetReceipt(input: {
  restoreDirectory: string;
  sourceDirectory: string;
  manifest: AuthenticatedBackupSetManifest;
  backupKey: Uint8Array;
  restoredAt?: number;
}) {
  const files: Record<string, { sizeBytes: number; sha256: string }> = {};
  for (const name of ["sessions.sqlite", "sessions.sqlite.audit-anchor", "actions.sqlite", "actions.sqlite.audit-anchor", "identity.sqlite", "identity.sqlite.audit-anchor"]) {
    const path = join(input.restoreDirectory, name);
    const stat = assertPrivateRegular(path);
    files[name] = { sizeBytes: stat.size, sha256: sha256File(path) };
  }
  const payload = {
    version: 1 as const,
    type: "social-git.restore-set-receipt" as const,
    setId: input.manifest.setId,
    setName: input.manifest.id,
    tenantId: input.manifest.tenantId,
    ledgerId: input.manifest.ledgerId,
    manifestSha256: sha256File(join(input.sourceDirectory, BACKUP_SET_MANIFEST_FILE)),
    restoredAt: input.restoredAt ?? Date.now(),
    files,
  };
  const receipt: RestoreSetReceipt = { ...payload, authentication: { algorithm: "HMAC-SHA256", tag: authenticate(payload, input.backupKey, "restore-set-receipt") } };
  atomicWritePrivate(join(input.restoreDirectory, RESTORE_SET_RECEIPT_FILE), Buffer.from(JSON.stringify(receipt), "utf8"));
  return receipt;
}

export function verifyRestoreSetReceipt(input: {
  restoreDirectory: string;
  sourceDirectory: string;
  manifest: AuthenticatedBackupSetManifest;
  backupKey: Uint8Array;
}) {
  const path = join(input.restoreDirectory, RESTORE_SET_RECEIPT_FILE);
  assertPrivateRegular(path, MAX_MANIFEST_BYTES);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.authentication) || !isRecord(parsed.files)) throw new Error("restore receipt is malformed");
  exactKeys(parsed, ["version", "type", "setId", "setName", "tenantId", "ledgerId", "manifestSha256", "restoredAt", "files", "authentication"]);
  exactKeys(parsed.authentication, ["algorithm", "tag"]);
  if (
    parsed.version !== 1 || parsed.type !== "social-git.restore-set-receipt" || parsed.setId !== input.manifest.setId ||
    parsed.setName !== input.manifest.id || parsed.tenantId !== input.manifest.tenantId || parsed.ledgerId !== input.manifest.ledgerId ||
    parsed.authentication.algorithm !== "HMAC-SHA256" || parsed.manifestSha256 !== sha256File(join(input.sourceDirectory, BACKUP_SET_MANIFEST_FILE)) ||
    !Number.isSafeInteger(parsed.restoredAt)
  ) throw new Error("restore receipt context is invalid");
  const receipt = parsed as unknown as RestoreSetReceipt;
  verifyTag(receiptPayload(receipt), receipt.authentication.tag, input.backupKey, "restore-set-receipt");
  const expectedNames = ["sessions.sqlite", "sessions.sqlite.audit-anchor", "actions.sqlite", "actions.sqlite.audit-anchor", "identity.sqlite", "identity.sqlite.audit-anchor"];
  exactKeys(receipt.files as unknown as Record<string, unknown>, expectedNames);
  for (const name of expectedNames) {
    const entry = receipt.files[name];
    if (!isRecord(entry) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || typeof entry.sha256 !== "string" || !HEX_256.test(entry.sha256)) {
      throw new Error("restore receipt file binding is invalid");
    }
    const file = join(input.restoreDirectory, name);
    const stat = assertPrivateRegular(file);
    if (stat.size !== entry.sizeBytes || sha256File(file) !== entry.sha256) throw new Error("restored database digest mismatch");
  }
  return receipt;
}

export function atomicWritePrivate(path: string, bytes: Uint8Array) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function fsyncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

export function privateFileDigest(path: string) {
  const stat = statSync(path);
  return { sizeBytes: stat.size, sha256: sha256File(path) };
}
