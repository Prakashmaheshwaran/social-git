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
  SOCIAL_GIT_ADMISSION_X_WORKER_ENVELOPE_FILE="$scratch_dir/x-worker-admission-envelope.json" \
  SOCIAL_GIT_ADMISSION_X_WORKER_QA_PUBLIC_KEY_FILE="$scratch_dir/x-worker-qa-public.pem" \
  SOCIAL_GIT_ADMISSION_X_WORKER_APPROVER_PUBLIC_KEY_FILE="$scratch_dir/x-worker-approver-public.pem" \
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
  // Byte-identical per-consumer copies: non-Swarm Compose bind-mounts the host
  // file as-is, so the X worker cannot share Core's 0600 host file.
  "x-worker-admission-envelope.json": '{"version":2}',
  "x-worker-qa-public.pem": "qa-public-fixture",
  "x-worker-approver-public.pem": "approver-public-fixture",
};
for (const [name, value] of Object.entries(values)) {
  const path = `${directory}/${name}`;
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
NODE

# The per-consumer copies must carry identical bytes. A divergent X-worker copy
# cannot weaken custody, because the worker re-verifies both detached signatures
# and both key fingerprints against the committed trust roots in
# src/admission-trust.ts, but a mismatch here would mean the operator handed the
# two processes different documents. Hash the pairs before the staging chown, so
# the comparison runs as the file owner and needs no extra privilege.
node - "$scratch_dir" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const directory = process.argv[2];
const digest = (name) => createHash("sha256").update(readFileSync(`${directory}/${name}`)).digest("hex");
for (const [core, worker] of [
  ["admission-envelope.json", "x-worker-admission-envelope.json"],
  ["qa-public.pem", "x-worker-qa-public.pem"],
  ["approver-public.pem", "x-worker-approver-public.pem"],
]) {
  if (digest(core) !== digest(worker)) throw new Error(`${core} and ${worker} must be byte-identical`);
}
NODE
printf 'admission_per_consumer_copies_byte_identical=ok\n'

# Core is uid 10001 and the X worker uid 10002. On Linux the staged files stay
# owned by the invoking user, so hand each consumer's copies to the UID that
# reads them, keeping every mode at 0600.
"$script_dir/stage-smoke-secrets.sh" --image "$image" --platform "$platform" \
  10001:10001="$scratch_dir/master-key" \
  10001:10001="$scratch_dir/audit-key" \
  10001:10001="$scratch_dir/auth.json" \
  10001:10001="$scratch_dir/backup-key" \
  10001:10001="$scratch_dir/reddit-command-key" \
  10001:10001="$scratch_dir/x-command-key" \
  10001:10001="$scratch_dir/admission-envelope.json" \
  10001:10001="$scratch_dir/qa-public.pem" \
  10001:10001="$scratch_dir/approver-public.pem" \
  10001:10001="$scratch_dir/evidence-private.pem" \
  10001:10001="$scratch_dir/evidence-public.pem" \
  10002:10002="$scratch_dir/x-worker-admission-envelope.json" \
  10002:10002="$scratch_dir/x-worker-qa-public.pem" \
  10002:10002="$scratch_dir/x-worker-approver-public.pem"

export SOCIAL_GIT_IMAGE="$image"
export REPO_ROOT="$repo_root"
export COMPOSE_PROJECT_NAME="$project_name"
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
export SOCIAL_GIT_ADMISSION_X_WORKER_ENVELOPE_FILE="$scratch_dir/x-worker-admission-envelope.json"
export SOCIAL_GIT_ADMISSION_X_WORKER_QA_PUBLIC_KEY_FILE="$scratch_dir/x-worker-qa-public.pem"
export SOCIAL_GIT_ADMISSION_X_WORKER_APPROVER_PUBLIC_KEY_FILE="$scratch_dir/x-worker-approver-public.pem"

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

# Each consumer gets only its own host copies. Two independent proofs:
#
# 1. Structural: the rendered Compose binds Core's five sources to Core and the
#    X worker's three distinct sources to the X worker, with no overlap either
#    way. This holds on every host.
# 2. Ownership: the X worker's copies are owned by 10002:10002 and Core's by
#    10001:10001, mode 0600, so neither UID can read the other's files. This is
#    asserted against the host files directly, because macOS bind mounts remap
#    ownership to the reading UID and would mask the distinction.
python3 - "$scratch_dir" <<'PY'
import json, os, subprocess, sys

scratch = sys.argv[1]
render = subprocess.run(
    ["docker", "compose", "--project-name", os.environ["COMPOSE_PROJECT_NAME"],
     "-f", "compose.prod.yaml", "-f", "compose.admission.yaml", "config", "--format", "json"],
    capture_output=True, text=True, check=True, cwd=os.environ["REPO_ROOT"],
)
services = json.loads(render.stdout)["services"]
sources = {name: {s["source"] for s in services[name].get("secrets") or []} for name in ("core", "x-worker")}
core_copies = {
    "social_git_admission_envelope", "social_git_admission_qa_public_key",
    "social_git_admission_approver_public_key", "social_git_admission_evidence_private_key",
    "social_git_admission_evidence_public_key",
}
x_copies = {
    "social_git_admission_x_worker_envelope", "social_git_admission_x_worker_qa_public_key",
    "social_git_admission_x_worker_approver_public_key",
}
if sources["core"] & x_copies:
    raise SystemExit("Core must not mount the X worker's admission copies")
if sources["x-worker"] & core_copies:
    raise SystemExit("X worker must not mount Core's admission copies")
if sources["x-worker"] & x_copies != x_copies:
    raise SystemExit("X worker must mount all three of its own admission copies")

expected = {
    "admission-envelope.json": "10001:10001",
    "qa-public.pem": "10001:10001",
    "approver-public.pem": "10001:10001",
    "evidence-private.pem": "10001:10001",
    "evidence-public.pem": "10001:10001",
    "x-worker-admission-envelope.json": "10002:10002",
    "x-worker-qa-public.pem": "10002:10002",
    "x-worker-approver-public.pem": "10002:10002",
}

# Where the kernel enforces on-disk ownership (Linux), assert it directly: this
# is what makes each consumer's copies unreadable to the other UID. Hosts whose
# container runtime remaps bind-mount ownership to the reading UID cannot
# express the distinction in the filesystem at all, so there we assert the
# in-container view and state plainly that the cross-read denial is not
# expressible rather than pretending it passed.
remapping = sys.platform == "darwin"
for name, owner in expected.items():
    path = os.path.join(scratch, name)
    if remapping:
        continue
    stat = os.stat(path)
    if (stat.st_uid, stat.st_gid) != tuple(int(part) for part in owner.split(":")):
        raise SystemExit(f"{name} must be owned by {owner}")
    if stat.st_mode & 0o077:
        raise SystemExit(f"{name} must not be group- or world-accessible")
if remapping:
    print("admission_per_consumer_host_ownership=not-expressible-with-bind-mount-remapping")
else:
    print("admission_per_consumer_host_ownership=ok")
print("admission_per_consumer_custody_boundary=ok")
PY

# The consumer's own container view must show the expected owner and a private
# mode on every host: the runtime's privateFile check reads these same bits.
"${compose[@]}" run --rm --no-deps --entrypoint node core -e '
  const fs=require("node:fs");
  if (process.getuid() !== 10001 || process.getgid() !== 10001) process.exit(1);
  for (const path of [
    "/run/secrets/social_git_admission_envelope",
    "/run/secrets/social_git_admission_qa_public_key",
    "/run/secrets/social_git_admission_approver_public_key",
    "/run/secrets/social_git_admission_evidence_private_key",
    "/run/secrets/social_git_admission_evidence_public_key",
  ]) {
    const st = fs.statSync(path);
    if (st.uid !== 10001 || st.gid !== 10001 || (st.mode & 0o077) !== 0 || st.size < 1) process.exit(1);
  }
  console.log("admission_core_secret_ownership=ok");
'

"${compose[@]}" run --rm --no-deps --entrypoint node x-worker -e '
  const fs=require("node:fs");
  if (process.getuid() !== 10002 || process.getgid() !== 10002) process.exit(1);
  for (const path of [
    "/run/secrets/social_git_admission_envelope",
    "/run/secrets/social_git_admission_qa_public_key",
    "/run/secrets/social_git_admission_approver_public_key",
  ]) {
    const st = fs.statSync(path);
    if (st.uid !== 10002 || st.gid !== 10002 || (st.mode & 0o077) !== 0 || st.size < 1) process.exit(1);
  }
  console.log("admission_x_worker_secret_ownership=ok");
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
