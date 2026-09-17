#!/usr/bin/env bash
set -Eeuo pipefail

backup_set=${1:?Usage: scripts/social-git-restore.sh BACKUP_SET}
[[ "$backup_set" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || { printf 'error: invalid backup set name\n' >&2; exit 2; }
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
compose=(docker compose -f "$repo_root/compose.yaml")

"${compose[@]}" stop core >/dev/null
restart_core() { "${compose[@]}" up -d --no-deps core >/dev/null; }
trap restart_core EXIT

common=(--backup-key-file /run/social-git-secrets/backup-key)
"${compose[@]}" run --rm --no-deps core backup set-restore \
  --set-name "$backup_set" \
  --tenant-id "${SOCIAL_GIT_TENANT_ID:-default}" \
  --ledger-id "${SOCIAL_GIT_LEDGER_ID:-default-action-ledger}" \
  --directory "/var/lib/social-git/backups/$backup_set" \
  --output-directory "/var/lib/social-git/restore/$backup_set" \
  --audit-key-file /run/social-git-secrets/audit-key "${common[@]}"

"${compose[@]}" run --rm --no-deps core restore-promote "$backup_set"
trap - EXIT
restart_core
printf 'restore_set=%s status=ok\n' "$backup_set"
