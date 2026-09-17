import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  MAX_BACKUP_RETENTION_MS,
  createEncryptedBackupFile,
  restoreEncryptedBackup,
  type BackupMetadata,
} from "@social-git/core";
import { IDENTITY_SCHEMA_VERSION, IdentityStore } from "./identity.ts";

interface IdentityBackupInput {
  databasePath: string;
  backupPath: string;
  backupKey: Uint8Array;
  tenantId: string;
  expiresAt?: number;
  now?: () => number;
}

export async function createIdentityBackup(input: IdentityBackupInput): Promise<BackupMetadata> {
  const currentTime = input.now?.() ?? Date.now();
  const expiresAt = input.expiresAt ?? currentTime + MAX_BACKUP_RETENTION_MS;
  const directory = mkdtempSync(join(dirname(input.backupPath), ".identity-snapshot-"));
  chmodSync(directory, 0o700);
  const snapshotPath = join(directory, "identity.sqlite");
  let snapshot: Buffer | undefined;
  let anchor: Buffer | undefined;
  try {
    const store = new IdentityStore(input.databasePath, { tenantId: input.tenantId });
    try {
      store.db.exec("PRAGMA wal_checkpoint(FULL)");
      await backup(store.db, snapshotPath);
      chmodSync(snapshotPath, 0o600);
    } finally {
      store.close();
    }
    anchor = validateIdentityDatabase(snapshotPath, input.tenantId);
    snapshot = readFileSync(snapshotPath);
    return createEncryptedBackupFile({
      snapshot,
      auditAnchor: anchor,
      backupPath: input.backupPath,
      backupKey: input.backupKey,
      metadata: {
        backupId: randomUUID(),
        tenantId: input.tenantId,
        purpose: "database-backup",
        schemaVersion: IDENTITY_SCHEMA_VERSION,
        createdAt: currentTime,
        expiresAt,
      },
      claimedNonces: new Set<string>(),
    });
  } finally {
    snapshot?.fill(0);
    anchor?.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}

export function restoreIdentityBackup(input: {
  backupPath: string;
  destinationPath: string;
  backupKey: Uint8Array;
  tenantId: string;
  now?: () => number;
}): BackupMetadata {
  return restoreEncryptedBackup({
    backupPath: input.backupPath,
    destinationPath: input.destinationPath,
    backupKey: input.backupKey,
    tenantId: input.tenantId,
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    ...(input.now ? { now: input.now } : {}),
    validateDatabase(path, tenantId, schemaVersion, expectedAnchor) {
      if (schemaVersion !== IDENTITY_SCHEMA_VERSION) throw new Error("The identity schema version does not match");
      const actualAnchor = validateIdentityDatabase(path, tenantId);
      try {
        if (actualAnchor.byteLength !== expectedAnchor.byteLength || !timingSafeEqual(actualAnchor, expectedAnchor)) {
          throw new Error("The identity backup anchor does not match the restored database");
        }
      } finally {
        actualAnchor.fill(0);
      }
    },
  });
}

export function validateIdentityDatabase(path: string, tenantId: string): Buffer {
  const database = new DatabaseSync(path, { open: true, readOnly: true, enableForeignKeyConstraints: true, timeout: 5_000 });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("The identity database failed its integrity check");
    }
    const version = Number((database.prepare("SELECT MAX(version) AS version FROM identity_schema_migrations").get() as { version?: number }).version);
    if (version !== IDENTITY_SCHEMA_VERSION) throw new Error("The identity schema version does not match");
    const tenants = database.prepare("SELECT id FROM identity_tenants ORDER BY id").all() as Array<{ id: string }>;
    if (tenants.length > 1 || (tenants.length === 1 && tenants[0]?.id !== tenantId)) {
      throw new Error("The identity tenant does not match");
    }
    const latestAudit = database.prepare("SELECT sequence, event_type, outcome, occurred_at FROM identity_audit_events ORDER BY sequence DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    const users = Number((database.prepare("SELECT COUNT(*) AS count FROM identity_users").get() as { count: number }).count);
    const keys = Number((database.prepare("SELECT COUNT(*) AS count FROM identity_api_keys").get() as { count: number }).count);
    const workspaces = Number((database.prepare("SELECT COUNT(*) AS count FROM identity_workspaces").get() as { count: number }).count);
    const memberships = Number((database.prepare("SELECT COUNT(*) AS count FROM identity_memberships").get() as { count: number }).count);
    const invitations = Number((database.prepare("SELECT COUNT(*) AS count FROM identity_invitations").get() as { count: number }).count);
    return createHash("sha256").update(JSON.stringify({
      tenantId, version, users, keys, workspaces, memberships, invitations, latestAudit: latestAudit ?? null,
    })).digest();
  } finally {
    database.close();
  }
}
