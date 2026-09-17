import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { MAX_BACKUP_RETENTION_MS, type BackupMetadata, type SessionRuntime } from "@social-git/core";
import { createIdentityBackup } from "./identity-backup.ts";
import type { IdentityPrincipal } from "./identity.ts";
import { createActionLedgerBackup } from "./ledger-backup.ts";
import type { RuntimeMaintenanceGate } from "./maintenance.ts";

const BACKUP_SET_PATTERN = /^backup-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u;
const MAX_BACKUP_SETS = 64;
const MANIFEST_FILE = "manifest.json";
const DATABASE_FILES = Object.freeze(["sessions.backup", "actions.backup", "identity.backup"]);

export interface OwnerBackupSummary {
  id: string;
  status: "running" | "ready" | "failed";
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  sizeBytes: number | null;
  databaseCount: 3;
  errorCode?: "BACKUP_FAILED" | "BACKUP_INTERRUPTED";
}

interface BackupManifest extends OwnerBackupSummary {
  version: 1;
  tenantId: string;
  ledgerId: string;
  entries?: {
    sessions: BackupMetadata;
    actions: BackupMetadata;
    identity: BackupMetadata;
  };
}

export class OwnerBackupManager {
  private readonly directory: string;
  private readonly backupKey: Buffer;
  private readonly auditKey: Buffer;
  private readonly sessionRuntime: SessionRuntime;
  private readonly actionDatabasePath: string;
  private readonly identityDatabasePath: string;
  private readonly tenantId: string;
  private readonly ledgerId: string;
  private readonly gate: RuntimeMaintenanceGate;
  private readonly pause: () => Promise<void>;
  private readonly resume: () => void;
  private readonly now: () => number;
  private currentTask: Promise<void> | null = null;
  private closed = false;

  constructor(options: {
    directory: string;
    backupKey: Uint8Array;
    auditKey: Uint8Array;
    sessionRuntime: SessionRuntime;
    actionDatabasePath: string;
    identityDatabasePath: string;
    tenantId: string;
    ledgerId: string;
    gate: RuntimeMaintenanceGate;
    pause: () => Promise<void>;
    resume: () => void;
    now?: () => number;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(options.tenantId)) throw new TypeError("backup tenant is invalid");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(options.ledgerId)) throw new TypeError("backup ledger is invalid");
    if (options.backupKey.byteLength !== 32) throw new TypeError("backup key must contain exactly 32 bytes");
    if (options.auditKey.byteLength !== 32) throw new TypeError("audit key must contain exactly 32 bytes");
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new TypeError("backup directory must be a private regular directory");
    }
    this.directory = options.directory;
    this.backupKey = Buffer.from(options.backupKey);
    this.auditKey = Buffer.from(options.auditKey);
    this.sessionRuntime = options.sessionRuntime;
    this.actionDatabasePath = options.actionDatabasePath;
    this.identityDatabasePath = options.identityDatabasePath;
    this.tenantId = options.tenantId;
    this.ledgerId = options.ledgerId;
    this.gate = options.gate;
    this.pause = options.pause;
    this.resume = options.resume;
    this.now = options.now ?? Date.now;
    this.markInterruptedJobs();
    this.removeExpiredSets();
  }

  list(): OwnerBackupSummary[] {
    this.assertOpen();
    this.removeExpiredSets();
    return this.readManifests()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_BACKUP_SETS)
      .map(publicSummary);
  }

  create(): OwnerBackupSummary {
    this.assertOpen();
    if (this.currentTask) throw new OwnerOperationsError(409, "BACKUP_IN_PROGRESS", "A backup is already running.");
    this.removeExpiredSets();
    if (this.readManifests().length >= MAX_BACKUP_SETS) {
      throw new OwnerOperationsError(507, "BACKUP_RETENTION_FULL", "Backup retention is full. Export or expire an existing backup before creating another.");
    }
    const timestamp = this.now();
    const id = generatedBackupId(timestamp);
    const setDirectory = join(this.directory, id);
    mkdirSync(setDirectory, { mode: 0o700 });
    chmodSync(setDirectory, 0o700);
    const manifest: BackupManifest = {
      version: 1,
      id,
      status: "running",
      createdAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + MAX_BACKUP_RETENTION_MS).toISOString(),
      completedAt: null,
      sizeBytes: null,
      databaseCount: 3,
      tenantId: this.tenantId,
      ledgerId: this.ledgerId,
    };
    writeManifest(setDirectory, manifest);
    const task = this.execute(setDirectory, manifest);
    this.currentTask = task;
    void task.then(
      () => { if (this.currentTask === task) this.currentTask = null; },
      () => { if (this.currentTask === task) this.currentTask = null; },
    );
    return publicSummary(manifest);
  }

  async waitForIdle(): Promise<void> { await this.currentTask; }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.currentTask;
    this.closed = true;
    this.backupKey.fill(0);
    this.auditKey.fill(0);
  }

  private async execute(setDirectory: string, manifest: BackupManifest): Promise<void> {
    const expiresAt = Date.parse(manifest.expiresAt);
    try {
      let sessions!: BackupMetadata;
      let actions!: BackupMetadata;
      let identity!: BackupMetadata;
      await this.gate.runExclusive({
        pause: this.pause,
        resume: this.resume,
        task: async () => {
          sessions = this.sessionRuntime.createEncryptedBackup({
            backupPath: join(setDirectory, "sessions.backup"),
            backupKey: this.backupKey,
            expiresAt,
          });
          actions = await createActionLedgerBackup({
            databasePath: this.actionDatabasePath,
            backupPath: join(setDirectory, "actions.backup"),
            backupKey: this.backupKey,
            ledgerId: this.ledgerId,
            auditKey: this.auditKey,
            expiresAt,
            now: () => Date.parse(manifest.createdAt),
          });
          identity = await createIdentityBackup({
            databasePath: this.identityDatabasePath,
            backupPath: join(setDirectory, "identity.backup"),
            backupKey: this.backupKey,
            tenantId: this.tenantId,
            auditKey: this.auditKey,
            expiresAt,
            now: () => Date.parse(manifest.createdAt),
          });
        },
      });
      assertBackupBindings({ sessions, actions, identity }, manifest);
      const sizeBytes = DATABASE_FILES.reduce((total, file) => total + privateFileSize(join(setDirectory, file)), 0);
      writeManifest(setDirectory, {
        ...manifest,
        status: "ready",
        completedAt: new Date(this.now()).toISOString(),
        sizeBytes,
        entries: { sessions, actions, identity },
      });
    } catch {
      for (const file of DATABASE_FILES) rmSync(join(setDirectory, file), { force: true });
      writeManifest(setDirectory, {
        ...manifest,
        status: "failed",
        completedAt: new Date(this.now()).toISOString(),
        errorCode: "BACKUP_FAILED",
      });
    }
  }

  private readManifests(): BackupManifest[] {
    const results: BackupManifest[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !BACKUP_SET_PATTERN.test(entry.name)) continue;
      const setDirectory = join(this.directory, entry.name);
      const setStat = lstatSync(setDirectory);
      if (setStat.isSymbolicLink() || !setStat.isDirectory()) continue;
      const manifest = readManifest(setDirectory);
      if (!manifest || manifest.id !== entry.name || manifest.tenantId !== this.tenantId || manifest.ledgerId !== this.ledgerId) continue;
      if (manifest.status === "ready") {
        try {
          const actual = DATABASE_FILES.reduce((total, file) => total + privateFileSize(join(setDirectory, file)), 0);
          if (actual !== manifest.sizeBytes) continue;
        } catch { continue; }
      }
      results.push(manifest);
    }
    return results;
  }

  private markInterruptedJobs() {
    for (const manifest of this.readManifests()) {
      if (manifest.status !== "running") continue;
      const setDirectory = join(this.directory, manifest.id);
      for (const file of DATABASE_FILES) rmSync(join(setDirectory, file), { force: true });
      writeManifest(setDirectory, {
        ...manifest,
        status: "failed",
        completedAt: new Date(this.now()).toISOString(),
        errorCode: "BACKUP_INTERRUPTED",
      });
    }
  }

  private removeExpiredSets() {
    const timestamp = this.now();
    for (const manifest of this.readManifests()) {
      if (manifest.status === "running" || Date.parse(manifest.expiresAt) > timestamp) continue;
      const setDirectory = join(this.directory, manifest.id);
      const stat = lstatSync(setDirectory);
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(setDirectory, { recursive: true, force: true });
    }
  }

  private assertOpen() {
    if (this.closed) throw new OwnerOperationsError(503, "BACKUP_UNAVAILABLE", "Backup management is unavailable.");
  }
}

export class OwnerOperationsHttpController {
  private readonly backups: OwnerBackupManager;
  private readonly authenticateSession: (request: IncomingMessage, csrfRequired: boolean) => IdentityPrincipal | null;
  private readonly currentVersion: string;

  constructor(
    backups: OwnerBackupManager,
    authenticateSession: (request: IncomingMessage, csrfRequired: boolean) => IdentityPrincipal | null,
    currentVersion = "0.1.0",
  ) {
    this.backups = backups;
    this.authenticateSession = authenticateSession;
    this.currentVersion = currentVersion;
  }

  ownsPath(pathname: string) {
    return pathname === "/v1/control-plane/backups" || pathname.startsWith("/v1/control-plane/upgrades");
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!this.ownsPath(url.pathname)) return false;
    try {
      if (url.pathname === "/v1/control-plane/backups") {
        const mutating = request.method === "POST";
        const authorization = this.requireOwner(request, mutating);
        if (authorization) return this.error(response, authorization.status, authorization.code, authorization.message);
        if (request.method === "GET") return this.json(response, 200, { items: this.backups.list() });
        if (request.method === "POST") {
          const body = await readEmptyJsonObject(request);
          if (Object.keys(body).length !== 0) {
            throw new OwnerOperationsError(422, "VALIDATION_FAILED", "Backup creation does not accept paths, names, or options.");
          }
          return this.json(response, 202, { backup: this.backups.create() });
        }
        return this.error(response, 405, "METHOD_NOT_ALLOWED", "Only backup listing and creation are available.");
      }
      const authorization = this.requireOwner(request, false);
      if (authorization) return this.error(response, authorization.status, authorization.code, authorization.message);
      if (url.pathname !== "/v1/control-plane/upgrades/status") {
        return this.error(response, 404, "NOT_FOUND", "Route not found.");
      }
      if (request.method !== "GET") {
        return this.error(response, 405, "UPGRADES_READ_ONLY", "Automatic upgrades are unavailable. Follow the self-hosting upgrade guide manually.");
      }
      return this.json(response, 200, {
        currentVersion: this.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        channel: "manual",
        automation: "unavailable",
        message: "Remote update checks and automatic upgrades are disabled.",
      });
    } catch (error) {
      if (error instanceof OwnerOperationsError) return this.error(response, error.status, error.code, error.message);
      return this.error(response, 500, "BACKUP_FAILED", "The backup operation could not be processed.");
    }
  }

  private requireOwner(
    request: IncomingMessage,
    csrfRequired: boolean,
  ): { status: 401 | 403; code: "UNAUTHENTICATED" | "FORBIDDEN"; message: string } | null {
    const principal = this.authenticateSession(request, csrfRequired);
    if (!principal) {
      return {
        status: 401,
        code: "UNAUTHENTICATED",
        message: csrfRequired
          ? "A valid owner session and CSRF token are required."
          : "A valid owner session is required.",
      };
    }
    if (principal.role !== "owner") {
      return { status: 403, code: "FORBIDDEN", message: "Owner authorization is required." };
    }
    return null;
  }

  private json(response: ServerResponse, status: number, value: unknown): true {
    const body = JSON.stringify(value);
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
    return true;
  }

  private error(response: ServerResponse, status: number, code: string, message: string): true {
    const requestId = response.getHeader("x-request-id");
    return this.json(response, status, { error: {
      code,
      message,
      requestId: typeof requestId === "string" ? requestId : "unknown",
      retryable: status === 503,
    } });
  }
}

class OwnerOperationsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function generatedBackupId(timestamp: number) {
  const date = new Date(timestamp).toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `backup-${date}-${randomBytes(6).toString("hex")}`;
}

function publicSummary(manifest: BackupManifest): OwnerBackupSummary {
  return Object.freeze({
    id: manifest.id,
    status: manifest.status,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    completedAt: manifest.completedAt,
    sizeBytes: manifest.sizeBytes,
    databaseCount: 3,
    ...(manifest.errorCode ? { errorCode: manifest.errorCode } : {}),
  });
}

function writeManifest(directory: string, manifest: BackupManifest) {
  const path = join(directory, MANIFEST_FILE);
  const temporary = join(directory, `.manifest-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function readManifest(directory: string): BackupManifest | null {
  const path = join(directory, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 32_768 || (stat.mode & 0o077) !== 0) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      value.version !== 1 || typeof value.id !== "string" || !BACKUP_SET_PATTERN.test(value.id) ||
      !["running", "ready", "failed"].includes(String(value.status)) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
      (value.completedAt !== null && (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)))) ||
      (value.sizeBytes !== null && (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0)) ||
      value.databaseCount !== 3 || typeof value.tenantId !== "string" || typeof value.ledgerId !== "string"
    ) return null;
    return value as unknown as BackupManifest;
  } catch { return null; }
}

function privateFileSize(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || (stat.mode & 0o077) !== 0) throw new Error("invalid backup file");
  return statSync(path).size;
}

function assertBackupBindings(entries: NonNullable<BackupManifest["entries"]>, manifest: BackupManifest) {
  const createdAt = Date.parse(manifest.createdAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (
    entries.sessions.tenantId !== manifest.tenantId || entries.identity.tenantId !== manifest.tenantId ||
    entries.actions.tenantId !== manifest.ledgerId ||
    entries.sessions.createdAt < createdAt || entries.sessions.createdAt - createdAt > 60_000 ||
    entries.actions.createdAt !== createdAt || entries.identity.createdAt !== createdAt ||
    entries.sessions.expiresAt !== expiresAt || entries.actions.expiresAt !== expiresAt || entries.identity.expiresAt !== expiresAt
  ) throw new Error("backup bindings do not match");
}

async function readEmptyJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new OwnerOperationsError(422, "VALIDATION_FAILED", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1024) throw new OwnerOperationsError(413, "VALIDATION_FAILED", "Backup request body exceeds the 1024 byte limit.");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new OwnerOperationsError(422, "VALIDATION_FAILED", "Request body must be an empty JSON object.");
  }
}
