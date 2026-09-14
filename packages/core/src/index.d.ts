export type Platform = string;
export type AccountId = string;

export type EnvelopePurpose = "session" | "network-route";
export interface EnvelopeBinding {
  tenantId: string;
  accountId: AccountId;
  platform: Platform;
  purpose: EnvelopePurpose;
  schemaVersion: number;
  generation: number;
}

export class SessionRuntimeError extends Error {
  readonly code: string;
  toJSON(): { name: string; code: string; message: string };
}

export class SessionEnvelopeCrypto {
  constructor(options: {
    masterKey: Uint8Array;
    randomBytes?: (size: number) => Uint8Array;
  });
  seal(plaintext: Uint8Array, binding: EnvelopeBinding): Uint8Array;
  open(serialized: string | Uint8Array, expectedBinding: EnvelopeBinding): Uint8Array;
  close(): void;
}

export interface ExternalSessionImport {
  accountId: AccountId;
  platform: Platform;
  expectedNativeIdentity: string;
  generation: number;
  session: Uint8Array;
  networkRoute: {
    id: string;
    material: Uint8Array;
  };
}

export type AccountHealth =
  | "pending_identity"
  | "healthy"
  | "needs_refresh"
  | "wrong_identity"
  | "challenged"
  | "rate_limited"
  | "revoked"
  | "protocol_drift"
  | "unknown";

export type RefreshState = "idle" | "required" | "in_progress" | "failed";
export interface LeaseFence {
  leaseId: string;
  fence: number;
  expiresAt: number;
}
export interface AccountState {
  tenantId: string;
  accountId: AccountId;
  platform: Platform;
  expectedNativeIdentity: string;
  generation: number;
  revokedThroughGeneration: number;
  health: AccountHealth;
  refresh: RefreshState;
  networkRouteId: string | null;
  activeLease: LeaseFence | null;
  createdAt: number;
  updatedAt: number;
  lastValidatedAt: number | null;
}

export type WorkerIntent = "identity_validation" | "refresh" | "read" | "write";
export type WorkerResultStatus =
  | "SUCCEEDED"
  | "AUTH_FAILURE"
  | "CHALLENGE"
  | "RATE_LIMITED"
  | "REVOKED"
  | "PROTOCOL_DRIFT"
  | "UNKNOWN";

export interface WorkerCommand {
  version: 1;
  type: "social-git.worker.command";
  requestId: string;
  tenantId: string;
  accountId: AccountId;
  platform: Platform;
  generation: number;
  leaseId: string;
  fence: number;
  expiresAt: number;
  intent: WorkerIntent;
  operation: string;
  expectedNativeIdentity: string;
  sessionBase64: string;
  networkRoute: { id: string; materialBase64: string };
  payload: unknown;
}

export interface WorkerResult {
  version: 1;
  type: "social-git.worker.result";
  requestId: string;
  tenantId: string;
  accountId: AccountId;
  platform: Platform;
  generation: number;
  leaseId: string;
  fence: number;
  status: WorkerResultStatus;
  observedNativeIdentity?: string;
}

export type WorkerMessage = WorkerCommand | WorkerResult;

export interface BackupMetadata {
  backupId: string;
  tenantId: string;
  purpose: "database-backup";
  schemaVersion: number;
  createdAt: number;
  expiresAt: number;
}

export interface AuditEvent {
  sequence: number;
  tenantId: string;
  eventType: string;
  accountId: AccountId | null;
  generation: number | null;
  occurredAt: number;
  details: Readonly<Record<string, string | number | null>>;
}

export interface SessionRuntimeService {
  importExternalSession(input: ExternalSessionImport): AccountState;
  getAccountState(accountId: AccountId): AccountState;
  requestRefresh(input: { accountId: AccountId; generation: number }): AccountState;
  revokeAccount(input: { accountId: AccountId; generation: number }): AccountState;
  acquireWorkerCommand(input: {
    accountId: AccountId;
    generation: number;
    requestId: string;
    intent: WorkerIntent;
    operation: string;
    payload?: unknown;
    leaseTtlMs?: number;
    previousLease?: Pick<LeaseFence, "leaseId" | "fence">;
  }): Uint8Array;
  completeWorkerResult(input: {
    accountId: AccountId;
    generation: number;
    message: string | Uint8Array;
  }): AccountState;
  recoverExpiredLeases(): number;
  rotateMasterKey(input: { newMasterKey: Uint8Array }): {
    accountCount: number;
    rotatedAt: number;
  };
  createEncryptedBackup(input: {
    backupPath: string;
    backupKey: Uint8Array;
    expiresAt: number;
  }): BackupMetadata;
  checkpoint(): { busy: number; logFrames: number; checkpointedFrames: number };
  verifyAuditIntegrity(): { eventCount: number };
  listAuditEvents(): readonly AuditEvent[];
  diagnostics(): {
    journalMode: string;
    schemaVersion: number;
    tenantId: string;
    auditEventCount: number;
    ownerPid: number;
    ownerThreadId: number;
  };
  close(): void;
}

export class SessionRuntime implements SessionRuntimeService {
  constructor(options: {
    databasePath: string;
    tenantId?: string;
    masterKey: Uint8Array;
    auditKey: Uint8Array;
    now?: () => number;
    randomUUID?: () => string;
    randomBytes?: (size: number) => Uint8Array;
  });
  importExternalSession(input: ExternalSessionImport): AccountState;
  getAccountState(accountId: AccountId): AccountState;
  requestRefresh(input: { accountId: AccountId; generation: number }): AccountState;
  revokeAccount(input: { accountId: AccountId; generation: number }): AccountState;
  acquireWorkerCommand(input: {
    accountId: AccountId;
    generation: number;
    requestId: string;
    intent: WorkerIntent;
    operation: string;
    payload?: unknown;
    leaseTtlMs?: number;
    previousLease?: Pick<LeaseFence, "leaseId" | "fence">;
  }): Uint8Array;
  completeWorkerResult(input: {
    accountId: AccountId;
    generation: number;
    message: string | Uint8Array;
  }): AccountState;
  recoverExpiredLeases(): number;
  rotateMasterKey(input: { newMasterKey: Uint8Array }): {
    accountCount: number;
    rotatedAt: number;
  };
  createEncryptedBackup(input: {
    backupPath: string;
    backupKey: Uint8Array;
    expiresAt: number;
  }): BackupMetadata;
  checkpoint(): { busy: number; logFrames: number; checkpointedFrames: number };
  verifyAuditIntegrity(): { eventCount: number };
  listAuditEvents(): readonly AuditEvent[];
  diagnostics(): {
    journalMode: string;
    schemaVersion: number;
    tenantId: string;
    auditEventCount: number;
    ownerPid: number;
    ownerThreadId: number;
  };
  close(): void;
}

export function validateEnvelopeBinding(binding: EnvelopeBinding): Readonly<EnvelopeBinding>;
export function validateWorkerCommand(message: unknown): WorkerCommand;
export function validateWorkerResult(message: unknown): WorkerResult;
export function validateWorkerMessage(message: unknown): WorkerMessage;
export function encodeWorkerMessage(message: WorkerMessage, maximumBytes?: number): Uint8Array;
export function decodeWorkerMessage(
  message: string | Uint8Array,
  maximumBytes?: number
): WorkerMessage;
export function summarizeWorkerMessage(message: WorkerMessage): Record<string, unknown>;
export function redact(value: unknown): unknown;
export function redactError(error: unknown): { name: string; code: string; message: string };
export function createSafeLogger(
  sink: (level: string, message: string, fields?: unknown) => void
): Readonly<Record<"debug" | "info" | "warn" | "error", (message: unknown, fields?: unknown) => void>>;
export function createSafeTelemetry(
  sink: (kind: "trace" | "metric" | "crash", name: string, fields: unknown) => void
): Readonly<{
  trace(name: unknown, attributes?: unknown): void;
  metric(name: unknown, value: number, labels?: unknown): void;
  crash(error: unknown, fields?: unknown): void;
}>;
export function restoreEncryptedBackup(options: {
  backupPath: string;
  destinationPath: string;
  backupKey: Uint8Array;
  tenantId: string;
  schemaVersion?: number;
  now?: () => number;
  randomUUID?: () => string;
}): BackupMetadata;

export const ENCRYPTED_ENVELOPE_VERSION: 1;
export const ENCRYPTED_BACKUP_VERSION: 1;
export const SESSION_RUNTIME_SCHEMA_VERSION: 2;
export const MAX_BACKUP_RETENTION_MS: number;
export const AUDIT_EVENT_TYPES: readonly string[];
export const WORKER_MESSAGE_VERSION: 1;
export const MAX_WORKER_LEASE_TTL_MS: number;
export const MAX_WORKER_MESSAGE_BYTES: number;
export const MAX_SESSION_BYTES: number;
export const MAX_NETWORK_ROUTE_BYTES: number;
export const WORKER_RESULT_STATUSES: readonly WorkerResultStatus[];
