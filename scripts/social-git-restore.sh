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

"${compose[@]}" run --rm --no-deps -e SOCIAL_GIT_BACKUP_SET="$backup_set" --entrypoint node core \
  -e 'const{mkdirSync,rmSync}=require("node:fs");const n=process.env.SOCIAL_GIT_BACKUP_SET;if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(n))process.exit(2);const p=`/var/lib/social-git/restore/${n}`;rmSync(p,{recursive:true,force:true});mkdirSync(p,{mode:0o700});'

common=(--backup-key-file /run/social-git-secrets/backup-key)
"${compose[@]}" run --rm --no-deps core backup restore \
  --tenant-id "${SOCIAL_GIT_TENANT_ID:-default}" \
  --backup "/var/lib/social-git/backups/$backup_set/sessions.backup" \
  --database "/var/lib/social-git/restore/$backup_set/sessions.sqlite" "${common[@]}"
"${compose[@]}" run --rm --no-deps core backup ledger-restore \
  --ledger-id "${SOCIAL_GIT_LEDGER_ID:-default-action-ledger}" \
  --backup "/var/lib/social-git/backups/$backup_set/actions.backup" \
  --database "/var/lib/social-git/restore/$backup_set/actions.sqlite" "${common[@]}"
"${compose[@]}" run --rm --no-deps core backup identity-restore \
  --tenant-id "${SOCIAL_GIT_TENANT_ID:-default}" \
  --backup "/var/lib/social-git/backups/$backup_set/identity.backup" \
  --database "/var/lib/social-git/restore/$backup_set/identity.sqlite" "${common[@]}"

"${compose[@]}" run --rm --no-deps core restore-promote "$backup_set"
trap - EXIT
restart_core
printf 'restore_set=%s status=ok\n' "$backup_set"
