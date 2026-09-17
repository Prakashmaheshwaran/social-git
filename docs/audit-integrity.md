# Audit integrity and identity projection

Social Git authenticates three append-only streams with HMAC-SHA-256 and the
installation audit key:

- action and operator audit events in `actions.sqlite`;
- durable webhook events in `actions.sqlite`;
- local identity and authorization events in `identity.sqlite`.

Every record covers its stream name, installation context, contiguous
sequence, stable event ID, previous MAC, timestamp, outcome, and canonical
bounded payload. The database retains the current head in the same transaction
as the event. Update and delete triggers prevent ordinary application paths
from rewriting history. Verification checks every record, the retained
database head, SQLite integrity, and backup context. The audit key is not in
either database or an encrypted database backup.

## Identity outbox

An identity mutation and its redacted audit event/outbox row commit in one
identity-database transaction. A runtime bridge projects the oldest pending
event into the public audit cursor using the same event ID and source sequence,
then acknowledges it in the identity database. The public projection has a
unique event ID and payload hash. A crash after public insertion but before
acknowledgement therefore replays the same event instead of creating a second
record. Later identity events cannot overtake an earlier unacknowledged event.

Audit details are structurally redacted and limited to 4096 bytes. Oversized
details become only a byte count and SHA-256 digest. Passwords, cookies,
session material, invitation/API-key secrets, CSRF values, webhook secrets, and
native social credentials must never be passed as audit details.

## Operator verification and external heads

Run the verifier while Core is stopped or inside the same maintenance window
used for backups. Paths must be absolute and the audit-key file must be a
private regular file:

```sh
node runtime/audit-verify.mjs \
  --action-database /var/lib/social-git/actions.sqlite \
  --identity-database /var/lib/social-git/identity.sqlite \
  --ledger-id default-action-ledger \
  --tenant-id default \
  --audit-key-file /run/social-git-secrets/audit-key \
  > audit-heads.json
```

Store `audit-heads.json` outside the Social Git host, with an immutable backup
manifest or transparency service. On the next verification, add:

```sh
  --expected-head /absolute/path/to/previous-audit-heads.json
```

The expected head makes whole-database rollback or authenticated tail
truncation detectable. A database-only verifier cannot distinguish an intact
older snapshot from a legitimate current database; retaining heads externally
is therefore mandatory for rollback evidence. The head contains identifiers
and MACs, not secrets, but operators should still treat it as security
evidence.

## Migration, backup, and recovery

Schema migration backfills old records in original sequence with the configured
audit key, writes a head, then installs append-only guards. Startup fails closed
if a migrated chain is discontinuous or if an existing MAC is invalid.

Action and identity backup creation, restore, and validation require the same
audit key. The encrypted backup anchor includes all three chain heads and event
counts. Restore fails on a wrong key, modified record, missing tail with an
unmodified database head, schema mismatch, or backup-envelope tampering. After
disaster recovery, compare the restored heads to the last externally retained
head before accepting new writes.
