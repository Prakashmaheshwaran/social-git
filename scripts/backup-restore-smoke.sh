#!/usr/bin/env bash
set -Eeuo pipefail

container=${1:?Usage: scripts/backup-restore-smoke.sh RUNNING_CORE_CONTAINER}
database=/var/lib/social-git/sessions.sqlite
backup=/var/lib/social-git/backups/sessions.backup
restored=/var/lib/social-git/restore/sessions.sqlite
ledger_backup=/var/lib/social-git/backups/actions.backup
ledger_restored=/var/lib/social-git/restore/actions.sqlite

docker exec "$container" node /opt/social-git/runtime/backup.mjs create \
  --tenant-id default \
  --database "$database" \
  --output "$backup" \
  --master-key-file /run/secrets/social_git_master_key \
  --audit-key-file /run/secrets/social_git_audit_key \
  --backup-key-file /run/secrets/social_git_backup_key
docker exec "$container" node /opt/social-git/runtime/backup.mjs restore \
  --tenant-id default \
  --backup "$backup" \
  --database "$restored" \
  --backup-key-file /run/secrets/social_git_backup_key
docker exec "$container" node /opt/social-git/runtime/backup.mjs validate \
  --tenant-id default \
  --database "$restored" \
  --master-key-file /run/secrets/social_git_master_key \
  --audit-key-file /run/secrets/social_git_audit_key

docker exec "$container" node /opt/social-git/runtime/backup.mjs ledger-create \
  --ledger-id default-action-ledger \
  --database /var/lib/social-git/actions.sqlite \
  --output "$ledger_backup" \
  --audit-key-file /run/secrets/social_git_audit_key \
  --backup-key-file /run/secrets/social_git_backup_key
docker exec "$container" node /opt/social-git/runtime/backup.mjs ledger-restore \
  --ledger-id default-action-ledger \
  --backup "$ledger_backup" \
  --database "$ledger_restored" \
  --audit-key-file /run/secrets/social_git_audit_key \
  --backup-key-file /run/secrets/social_git_backup_key
docker exec "$container" node /opt/social-git/runtime/backup.mjs ledger-validate \
  --ledger-id default-action-ledger \
  --database "$ledger_restored" \
  --audit-key-file /run/secrets/social_git_audit_key

mode=$(docker exec "$container" node -e "const {statSync}=require('node:fs'); process.stdout.write((statSync('$restored').mode & 0o777).toString(8))")
ledger_mode=$(docker exec "$container" node -e "const {statSync}=require('node:fs'); process.stdout.write((statSync('$ledger_restored').mode & 0o777).toString(8))")
[[ "$mode" == 600 ]]
[[ "$ledger_mode" == 600 ]]
printf 'backup_restore=ok session_mode=%s ledger_mode=%s\n' "$mode" "$ledger_mode"
