BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS runtime_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'session.imported',
    'session.rotated',
    'account.revoked',
    'worker.completed',
    'worker.interrupted',
    'master_key.rotated',
    'database.checkpointed',
    'backup.created'
  )),
  account_id TEXT,
  generation INTEGER CHECK (generation IS NULL OR generation > 0),
  occurred_at INTEGER NOT NULL,
  details_json TEXT NOT NULL CHECK (
    json_valid(details_json) AND json_type(details_json) = 'object'
  ),
  previous_mac BLOB NOT NULL CHECK (length(previous_mac) = 32),
  event_mac BLOB NOT NULL CHECK (length(event_mac) = 32)
) STRICT;

CREATE INDEX IF NOT EXISTS audit_events_tenant_sequence
  ON audit_events(tenant_id, sequence);

CREATE INDEX IF NOT EXISTS accounts_tenant
  ON accounts(tenant_id, account_id);

CREATE INDEX IF NOT EXISTS worker_leases_tenant_history
  ON worker_leases(tenant_id, account_id, generation, fence);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit log is append only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit log is append only');
END;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (2, unixepoch('subsec') * 1000);

COMMIT;
