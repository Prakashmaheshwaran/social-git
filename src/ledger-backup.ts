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
import { LedgerStore, MIGRATIONS } from "./persistence.ts";

export const ACTION_LEDGER_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

interface LedgerBackupInput {
  databasePath: string;
  backupPath: string;
  backupKey: Uint8Array;
  ledgerId: string;
  expiresAt?: number;
  now?: () => number;
}

export async function createActionLedgerBackup(input: LedgerBackupInput): Promise<BackupMetadata> {
  const currentTime = input.now?.() ?? Date.now();
  const expiresAt = input.expiresAt ?? currentTime + MAX_BACKUP_RETENTION_MS;
  const directory = mkdtempSync(join(dirname(input.backupPath), ".action-ledger-snapshot-"));
  chmodSync(directory, 0o700);
  const snapshotPath = join(directory, "actions.sqlite");
  let snapshot: Buffer | undefined;
  let anchor: Buffer | undefined;
  try {
    const store = new LedgerStore(input.databasePath, { ledgerId: input.ledgerId });
    try {
      store.checkpoint();
      await backup(store.db, snapshotPath);
      chmodSync(snapshotPath, 0o600);
    } finally {
      store.close();
    }
    anchor = validateActionLedgerDatabase(snapshotPath, input.ledgerId, ACTION_LEDGER_SCHEMA_VERSION);
    snapshot = readFileSync(snapshotPath);
    return createEncryptedBackupFile({
      snapshot,
      auditAnchor: anchor,
      backupPath: input.backupPath,
      backupKey: input.backupKey,
      metadata: {
        backupId: randomUUID(),
        tenantId: input.ledgerId,
        purpose: "database-backup",
        schemaVersion: ACTION_LEDGER_SCHEMA_VERSION,
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

export function restoreActionLedgerBackup(input: {
  backupPath: string;
  destinationPath: string;
  backupKey: Uint8Array;
  ledgerId: string;
  now?: () => number;
}): BackupMetadata {
  return restoreEncryptedBackup({
    backupPath: input.backupPath,
    destinationPath: input.destinationPath,
    backupKey: input.backupKey,
    tenantId: input.ledgerId,
    schemaVersion: ACTION_LEDGER_SCHEMA_VERSION,
    ...(input.now ? { now: input.now } : {}),
    validateDatabase(path, ledgerId, schemaVersion, expectedAnchor) {
      const actualAnchor = validateActionLedgerDatabase(path, ledgerId, schemaVersion);
      try {
        if (actualAnchor.byteLength !== expectedAnchor.byteLength || !timingSafeEqual(actualAnchor, expectedAnchor)) {
          throw new Error("The action ledger audit anchor does not match the restored database.");
        }
      } finally {
        actualAnchor.fill(0);
      }
    },
  });
}

export function validateActionLedgerDatabase(path: string, ledgerId: string, schemaVersion: number = ACTION_LEDGER_SCHEMA_VERSION): Buffer {
  const database = new DatabaseSync(path, { open: true, readOnly: true, enableForeignKeyConstraints: true, timeout: 5_000 });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("The action ledger failed its integrity check.");
    }
    const storedVersion = Number((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: number }).version);
    const storedLedgerId = String((database.prepare("SELECT ledger_id FROM ledger_metadata WHERE singleton=1").get() as { ledger_id?: string }).ledger_id ?? "");
    if (storedVersion !== schemaVersion || storedLedgerId !== ledgerId) {
      throw new Error("The action ledger backup context does not match.");
    }
    const latestAudit = database.prepare("SELECT sequence, id, occurred_at FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const actionCount = Number((database.prepare("SELECT COUNT(*) AS count FROM actions").get() as { count: number }).count);
    const inboundCount = Number((database.prepare("SELECT COUNT(*) AS count FROM inbound_events").get() as { count: number }).count);
    return createHash("sha256").update(JSON.stringify({
      ledgerId,
      schemaVersion,
      actionCount,
      inboundCount,
      latestAudit: latestAudit ?? null,
    })).digest();
  } finally {
    database.close();
  }
}
