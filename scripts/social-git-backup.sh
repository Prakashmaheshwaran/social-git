#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
compose=(docker compose -f "$repo_root/compose.yaml")
backup_set=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
[[ "$backup_set" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || { printf 'error: invalid backup set name\n' >&2; exit 2; }

was_running=false
container_id=$("${compose[@]}" ps -q core)
if [[ -n "$container_id" && $(docker inspect --format '{{.State.Running}}' "$container_id") == true ]]; then
  was_running=true
  "${compose[@]}" stop core >/dev/null
fi
restart_core() {
  if [[ "$was_running" == true ]]; then "${compose[@]}" up -d --no-deps core >/dev/null; fi
}
trap restart_core EXIT

"${compose[@]}" run --rm --no-deps -e SOCIAL_GIT_BACKUP_SET="$backup_set" --entrypoint node core \
  -e 'const {mkdirSync}=require("node:fs"); const n=process.env.SOCIAL_GIT_BACKUP_SET; if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(n)) process.exit(2); mkdirSync(`/var/lib/social-git/backups/${n}`,{mode:0o700});'

common=(--backup-key-file /run/social-git-secrets/backup-key)
"${compose[@]}" run --rm --no-deps core backup create \
  --tenant-id "${SOCIAL_GIT_TENANT_ID:-default}" \
  --database /var/lib/social-git/sessions.sqlite \
  --output "/var/lib/social-git/backups/$backup_set/sessions.backup" \
  --master-key-file /run/social-git-secrets/master-key \
  --audit-key-file /run/social-git-secrets/audit-key "${common[@]}"
"${compose[@]}" run --rm --no-deps core backup ledger-create \
  --ledger-id "${SOCIAL_GIT_LEDGER_ID:-default-action-ledger}" \
  --database /var/lib/social-git/actions.sqlite \
  --output "/var/lib/social-git/backups/$backup_set/actions.backup" "${common[@]}"
"${compose[@]}" run --rm --no-deps core backup identity-create \
  --tenant-id "${SOCIAL_GIT_TENANT_ID:-default}" \
  --database /var/lib/social-git/identity.sqlite \
  --output "/var/lib/social-git/backups/$backup_set/identity.backup" "${common[@]}"

printf 'backup_set=%s status=ok location=social-git-backups-volume\n' "$backup_set"
