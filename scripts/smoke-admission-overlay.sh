#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
image=social-git-runtime:smoke
platform=

while (($#)); do
  case "$1" in
    --platform)
      platform=${2:?--platform requires linux/amd64 or linux/arm64}
      shift
      ;;
    -h|--help)
      printf '%s\n' 'Usage: scripts/smoke-admission-overlay.sh [--platform linux/ARCH] [IMAGE]'
      exit 0
      ;;
    *) image=$1 ;;
  esac
  shift
done

if [[ -z "$platform" ]]; then
  architecture=$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null || docker info --format '{{.Architecture}}')
  platform=$(printf '%s' "$architecture" | "$script_dir/normalize-docker-platform.sh")
fi
if [[ "$platform" != linux/amd64 && "$platform" != linux/arm64 ]]; then
  printf 'error: unsupported platform: %s\n' "$platform" >&2
  exit 2
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  "$script_dir/build-images.sh" --load --platform "$platform" --tag "$image"
fi

scratch_base=${SOCIAL_GIT_SCRATCH_DIR:-}
if [[ -n "$scratch_base" ]]; then
  mkdir -p "$scratch_base"
  scratch_dir=$(mktemp -d "$scratch_base/social-git-admission-custody.XXXXXX")
else
  scratch_dir=$(mktemp -d)
fi
project_name="social-git-admission-custody-$$"

cleanup() {
  SOCIAL_GIT_IMAGE="$image" \
  SOCIAL_GIT_MASTER_KEY_FILE="$scratch_dir/master-key" \
  SOCIAL_GIT_AUDIT_KEY_FILE="$scratch_dir/audit-key" \
  SOCIAL_GIT_AUTH_FILE="$scratch_dir/auth.json" \
  SOCIAL_GIT_BACKUP_KEY_FILE="$scratch_dir/backup-key" \
  SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE="$scratch_dir/reddit-command-key" \
  SOCIAL_GIT_X_COMMAND_KEY_FILE="$scratch_dir/x-command-key" \
  SOCIAL_GIT_ADMISSION_ENVELOPE_FILE="$scratch_dir/admission-envelope.json" \
  SOCIAL_GIT_ADMISSION_QA_PUBLIC_KEY_FILE="$scratch_dir/qa-public.pem" \
  SOCIAL_GIT_ADMISSION_APPROVER_PUBLIC_KEY_FILE="$scratch_dir/approver-public.pem" \
  SOCIAL_GIT_ADMISSION_EVIDENCE_PRIVATE_KEY_FILE="$scratch_dir/evidence-private.pem" \
  SOCIAL_GIT_ADMISSION_EVIDENCE_PUBLIC_KEY_FILE="$scratch_dir/evidence-public.pem" \
    docker compose --project-name "$project_name" \
      -f "$repo_root/compose.prod.yaml" -f "$repo_root/compose.admission.yaml" \
      down --volumes --remove-orphans >/dev/null 2>&1 || true
  find "$scratch_dir" -type f -exec chmod 0600 {} + 2>/dev/null || true
  find "$scratch_dir" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$scratch_dir" 2>/dev/null || true
}
trap cleanup EXIT

umask 077
node - "$scratch_dir" <<'NODE'
const { randomBytes } = require("node:crypto");
const { chmodSync, writeFileSync } = require("node:fs");
const directory = process.argv[2];
const values = {
  "master-key": randomBytes(32).toString("base64url"),
  "audit-key": randomBytes(32).toString("base64url"),
  "backup-key": randomBytes(32).toString("base64url"),
  "reddit-command-key": randomBytes(32).toString("base64url"),
  "x-command-key": randomBytes(32).toString("base64url"),
  "auth.json": "{}",
  "admission-envelope.json": '{"version":2}',
  "qa-public.pem": "qa-public-fixture",
  "approver-public.pem": "approver-public-fixture",
  "evidence-private.pem": "evidence-private-fixture",
  "evidence-public.pem": "evidence-public-fixture",
};
for (const [name, value] of Object.entries(values)) {
  const path = `${directory}/${name}`;
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
NODE

export SOCIAL_GIT_IMAGE="$image"
export SOCIAL_GIT_MASTER_KEY_FILE="$scratch_dir/master-key"
export SOCIAL_GIT_AUDIT_KEY_FILE="$scratch_dir/audit-key"
export SOCIAL_GIT_AUTH_FILE="$scratch_dir/auth.json"
export SOCIAL_GIT_BACKUP_KEY_FILE="$scratch_dir/backup-key"
export SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE="$scratch_dir/reddit-command-key"
export SOCIAL_GIT_X_COMMAND_KEY_FILE="$scratch_dir/x-command-key"
export SOCIAL_GIT_ADMISSION_ENVELOPE_FILE="$scratch_dir/admission-envelope.json"
export SOCIAL_GIT_ADMISSION_QA_PUBLIC_KEY_FILE="$scratch_dir/qa-public.pem"
export SOCIAL_GIT_ADMISSION_APPROVER_PUBLIC_KEY_FILE="$scratch_dir/approver-public.pem"
export SOCIAL_GIT_ADMISSION_EVIDENCE_PRIVATE_KEY_FILE="$scratch_dir/evidence-private.pem"
export SOCIAL_GIT_ADMISSION_EVIDENCE_PUBLIC_KEY_FILE="$scratch_dir/evidence-public.pem"

compose=(docker compose --project-name "$project_name" -f "$repo_root/compose.prod.yaml" -f "$repo_root/compose.admission.yaml")
"${compose[@]}" config --format json | python3 "$script_dir/validate-compose.py"

assert_denied='const fs=require("node:fs"); for (const path of process.argv.slice(1)) { try { fs.readFileSync(path); process.exit(1); } catch (error) { if (!["ENOENT","EACCES"].includes(error.code)) throw error; } }'

"${compose[@]}" run --rm --no-deps --entrypoint node core -e '
  const fs=require("node:fs");
  if (process.getuid() !== 10001 || process.getgid() !== 10001) process.exit(1);
  for (const path of [
    "/run/secrets/social_git_admission_envelope",
    "/run/secrets/social_git_admission_qa_public_key",
    "/run/secrets/social_git_admission_approver_public_key",
    "/run/secrets/social_git_admission_evidence_private_key",
    "/run/secrets/social_git_admission_evidence_public_key",
  ]) if (fs.readFileSync(path).length < 1) process.exit(1);
  console.log("admission_core_private_evidence_custody=ok");
'

"${compose[@]}" run --rm --no-deps --entrypoint node reddit-worker -e "$assert_denied" \
  /run/secrets/social_git_admission_envelope \
  /run/secrets/social_git_admission_qa_public_key \
  /run/secrets/social_git_admission_approver_public_key \
  /run/secrets/social_git_admission_evidence_private_key \
  /run/secrets/social_git_admission_evidence_public_key
printf 'admission_reddit_worker_has_no_admission_material=ok\n'

"${compose[@]}" run --rm --no-deps --entrypoint node x-worker -e '
  const fs=require("node:fs");
  if (process.getuid() !== 10002 || process.getgid() !== 10002) process.exit(1);
  for (const path of [
    "/run/secrets/social_git_admission_envelope",
    "/run/secrets/social_git_admission_qa_public_key",
    "/run/secrets/social_git_admission_approver_public_key",
  ]) if (fs.readFileSync(path).length < 1) process.exit(1);
  for (const path of [
    "/run/secrets/social_git_admission_evidence_private_key",
    "/run/secrets/social_git_admission_evidence_public_key",
    "/run/secrets/social_git_reddit_command_key",
  ]) {
    try { fs.readFileSync(path); process.exit(1); }
    catch (error) { if (!["ENOENT","EACCES"].includes(error.code)) throw error; }
  }
  console.log("admission_x_worker_public_approval_only=ok");
'

printf 'admission_overlay_custody_smoke=ok image=%s platform=%s\n' "$image" "$platform"
