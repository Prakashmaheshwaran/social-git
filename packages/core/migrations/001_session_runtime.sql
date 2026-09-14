BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  expected_native_identity TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  revoked_through_generation INTEGER NOT NULL DEFAULT 0
    CHECK (revoked_through_generation >= 0),
  session_envelope BLOB,
  route_id TEXT,
  route_envelope BLOB,
  health_status TEXT NOT NULL CHECK (health_status IN (
    'pending_identity',
    'healthy',
    'needs_refresh',
    'wrong_identity',
    'challenged',
    'rate_limited',
    'revoked',
    'protocol_drift',
    'unknown'
  )),
  refresh_state TEXT NOT NULL CHECK (refresh_state IN (
    'idle',
    'required',
    'in_progress',
    'failed'
  )),
  active_lease_id TEXT,
  active_lease_fence INTEGER,
  active_lease_expires_at INTEGER,
  next_fence INTEGER NOT NULL DEFAULT 1 CHECK (next_fence > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_validated_at INTEGER,
  CHECK (
    (session_envelope IS NULL AND route_id IS NULL AND route_envelope IS NULL)
    OR
    (session_envelope IS NOT NULL AND route_id IS NOT NULL AND route_envelope IS NOT NULL)
  ),
  CHECK (
    (active_lease_id IS NULL AND active_lease_fence IS NULL AND active_lease_expires_at IS NULL)
    OR
    (active_lease_id IS NOT NULL AND active_lease_fence IS NOT NULL AND active_lease_expires_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS worker_leases (
  lease_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  fence INTEGER NOT NULL CHECK (fence > 0),
  intent TEXT NOT NULL CHECK (intent IN (
    'identity_validation',
    'refresh',
    'read',
    'write'
  )),
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'active',
    'completed',
    'rejected',
    'superseded',
    'expired',
    'abandoned',
    'revoked'
  )),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  result_status TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS worker_leases_one_active_per_account
  ON worker_leases(account_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS worker_leases_account_history
  ON worker_leases(account_id, generation, fence);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, unixepoch('subsec') * 1000);

COMMIT;
