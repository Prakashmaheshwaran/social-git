# Core storage security evidence

This document records the deterministic evidence for SG-SEC-002,
SG-SEC-003, SG-SEC-011, TM-01, TM-05, and TM-11. The fixtures contain only
synthetic canaries. They do not use a live social session.

## Secret storage boundary

`SessionEnvelopeCrypto` encrypts session and network-route fields separately
with AES-256-GCM. The authenticated context contains the schema version,
platform, tenant, account, purpose, and generation. HKDF derives a distinct
field key from the operator-supplied master key and the complete context. The
master key is never written to SQLite or returned through the worker contract.

Every seal operation obtains a 96-bit nonce. The process-local nonce claim set
rejects a duplicate before encryption. Context mismatch, stale generation,
malformed ciphertext, authentication failure, and nonce reuse return only a
normalized error. Key rotation decrypts and reseals all active fields inside
one `BEGIN IMMEDIATE` transaction, then erases the old in-memory key copy.

SQLite uses WAL, `synchronous=FULL`, `secure_delete=ON`, and in-memory temporary
storage. The core makes the database directory mode `0700` before opening the
database. It pre-creates the database as `0600` and reasserts `0600` on the
database, WAL, and SHM files after each transaction and checkpoint. Secret
plaintext is never used in a table key, index, FTS table, temporary table,
migration, SQL text, or audit payload.

## Backup and restore boundary

`SessionRuntime.createEncryptedBackup()` serializes one transactionally
consistent SQLite snapshot in memory. It encrypts the complete snapshot again
with AES-256-GCM and a separately supplied backup key. The authenticated backup
metadata binds its opaque ID, tenant, purpose, schema version, creation time,
and expiry. Neither the service master key nor the audit-integrity key is part
of the snapshot metadata or backup envelope.

A backup must expire after creation and no later than 30 days after creation.
The backup operator must remove each stored copy no later than `expiresAt`.
Restore rejects expired copies. Shorter production retention is allowed.

`restoreEncryptedBackup()` requires only the backup key. It never accepts a
service master key or audit key. It decrypts to a mode-`0600` isolated staging
file, validates SQLite integrity, foreign keys, tenant, and schema, removes all
staging sidecars, and publishes only to a new destination. It also restores the
authenticated audit-head anchor carried by the backup. It never overwrites a
live database. The restored session fields remain service-key ciphertext and
cannot be used until an authorized core runtime supplies the external service
and audit keys.

## Audit and diagnostics boundary

Audit writes use fixed event types and per-event field schemas. They contain
only internal IDs, generations, normalized result codes, counts, and times.
They cannot accept headers, session data, route material, envelopes, proxy
URLs, or platform payloads. SQLite triggers reject update and delete. Each
event has an HMAC-SHA-256 link to the previous event. A separate mode-`0600`,
HMAC-authenticated head and count anchor is updated after every committed audit
transaction. Startup compares the complete chain with this anchor before
account recovery or secret use, so tail and full-ledger deletion fail closed.
The audit key stays outside SQLite and backups; backups carry only the signed
anchor and authenticate it with the backup envelope. The ledger never hashes a
session, route credential, token, password, or other low-entropy secret.

`createSafeLogger()` and `createSafeTelemetry()` structurally redact byte
arrays, secret-named fields, generic exceptions, and credential-bearing text.
Runtime and backup errors discard upstream causes because SQLite and protocol
exceptions can contain request values.

## Worker custody boundary

The worker import surface is `@social-git/core/worker-contract`. Both its
JavaScript exports and its dedicated TypeScript declaration file expose no
database runtime, backup function, or encryption-key API. Its strict message
schema rejects unknown fields, including database paths, backup paths, and key
material. A worker receives only the session and route for one tenant-bound,
generation-bound, fenced lease.

Production must run the core and workers under distinct non-root identities.
Only the core identity can read the mode-`0600` database directory, backup
staging directory, and service-key mount. The worker filesystem must not mount
those paths. This OS sandbox control is also part of the worker/runtime
packaging gate; the JavaScript module boundary is not a substitute for file
permissions.

## Deterministic evidence map

| Security item | Evidence |
| --- | --- |
| SG-SEC-002 / TM-01 | `crypto.test.js` rejects every wrong context field, ciphertext tampering, malformed envelopes, and nonce reuse. `security-storage.test.js` proves master-key rotation and old-key rejection. |
| SG-SEC-003 | `runtime.test.js` proves expected native identity matching, quarantine and generation revocation on mismatch, stale-generation rejection, and no later worker dispatch. |
| SG-SEC-011 / TM-11 | `security-storage.test.js` scans audit, log, trace, metric, and a subprocess uncaught-exception capture for unique secret canaries. It proves append-only triggers, keyed-chain tamper detection, and rejection of valid-prefix and full-ledger deletion against the external authenticated head. |
| TM-05 | `security-storage.test.js` scans every file in the storage directory while WAL and SHM are live after import, session rotation, key rotation, backup, checkpoint, and revocation. It scans encrypted backup and restored output, and proves WAL/SHM/database/anchor modes, expiry, wrong-key, wrong-tenant, tamper, restore staging cleanup, and private-directory behavior. |
| Worker custody | `worker-contract.test.js` proves the worker JavaScript and TypeScript surfaces have no database, backup, or key APIs. Unknown custody fields are rejected by the strict command schema. |

Run the evidence with:

```sh
npm run test:core
```
