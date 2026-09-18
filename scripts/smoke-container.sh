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
      printf '%s\n' 'Usage: scripts/smoke-container.sh [--platform linux/ARCH] [IMAGE]'
      exit 0
      ;;
    *)
      image=$1
      ;;
  esac
  shift
done

if [[ -z "$platform" ]]; then
  architecture=$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null || docker info --format '{{.Architecture}}')
  if ! platform=$(printf '%s' "$architecture" | "$script_dir/normalize-docker-platform.sh"); then
    printf 'error: unsupported Docker architecture: %s\n' "$architecture" >&2
    exit 1
  fi
fi
if [[ "$platform" != linux/amd64 && "$platform" != linux/arm64 ]]; then
  printf 'error: unsupported platform: %s\n' "$platform" >&2
  exit 2
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  "$script_dir/build-images.sh" --load --platform "$platform" --tag "$image"
fi

scratch_base=${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-}}
if [[ -n "$scratch_base" ]]; then
  mkdir -p "$scratch_base"
  scratch_dir=$(mktemp -d "$scratch_base/dyn-61-smoke.XXXXXX")
else
  scratch_dir=$(mktemp -d)
fi
core_container="social-git-core-smoke-$$"
worker_container="social-git-worker-smoke-$$"
data_volume="social-git-data-smoke-$$"
backup_volume="social-git-backup-smoke-$$"
import_volume="social-git-import-smoke-$$"
restore_volume="social-git-restore-smoke-$$"

cleanup() {
  docker container rm --force "$core_container" "$worker_container" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$backup_volume" "$import_volume" "$restore_volume" >/dev/null 2>&1 || true
  find "$scratch_dir" -type f -exec chmod 0600 {} + 2>/dev/null || true
  find "$scratch_dir" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$scratch_dir" 2>/dev/null || true
}
trap cleanup EXIT

umask 077
node - "$scratch_dir" <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const { createHash, randomBytes } = require("node:crypto");
const directory = process.argv[2];
for (const name of ["master-key", "audit-key", "backup-key", "reddit-command-key", "x-command-key"]) {
  const path = `${directory}/${name}`;
  writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
const token = "fixture-smoke-token";
const auth = {
  version: 1,
  principals: [{ callerId: "fixture-smoke", tokenSha256: createHash("sha256").update(token).digest("hex"), scopes: ["*"] }],
};
writeFileSync(`${directory}/auth.json`, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
chmodSync(`${directory}/auth.json`, 0o600);
NODE

for volume in "$data_volume" "$backup_volume" "$import_volume" "$restore_volume"; do
  docker volume create "$volume" >/dev/null
done

docker run -d \
  --platform "$platform" \
  --name "$core_container" \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=1770 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 512m \
  --cpus 1.0 \
  --pids-limit 128 \
  --mount "type=volume,src=$data_volume,dst=/var/lib/social-git" \
  --mount "type=volume,src=$backup_volume,dst=/var/lib/social-git/backups" \
  --mount "type=volume,src=$import_volume,dst=/var/lib/social-git/import" \
  --mount "type=volume,src=$restore_volume,dst=/var/lib/social-git/restore" \
  --mount "type=bind,src=$scratch_dir/master-key,dst=/run/secrets/social_git_master_key,readonly" \
  --mount "type=bind,src=$scratch_dir/audit-key,dst=/run/secrets/social_git_audit_key,readonly" \
  --mount "type=bind,src=$scratch_dir/backup-key,dst=/run/secrets/social_git_backup_key,readonly" \
  --mount "type=bind,src=$scratch_dir/auth.json,dst=/run/secrets/social_git_auth,readonly" \
  -e NODE_ENV=test \
  -e SOCIAL_GIT_MODE=fixture \
  "$image" core >/dev/null

wait_ready() {
  local container=$1
  local path=${2:-/readyz}
  for _ in $(seq 1 60); do
    if docker exec "$container" node /opt/social-git/runtime/healthcheck.mjs "$path"; then return 0; fi
    sleep 0.5
  done
  docker logs "$container" >&2
  return 1
}
wait_ready "$core_container"

docker exec -i "$core_container" node <<'NODE'
const base = "http://127.0.0.1:8080";
const health = await fetch(`${base}/healthz`);
const ready = await fetch(`${base}/readyz`);
const openapi = await fetch(`${base}/openapi.json`);
const mcp = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: "Bearer fixture-smoke-token", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
const healthBody = await health.json();
const readyBody = await ready.json();
const openapiBody = await openapi.json();
const mcpBody = await mcp.json();
if (health.status !== 200 || healthBody.status !== "ok") throw new Error("health check failed");
if (ready.status !== 200 || readyBody.status !== "ready") throw new Error("readiness check failed");
if (openapi.status !== 200 || openapiBody.openapi !== "3.1.0") throw new Error("OpenAPI check failed");
if (mcp.status !== 200 || mcpBody.result?.serverInfo?.name !== "social-git") throw new Error("MCP initialization failed");

// Seed one bounded record in both authenticated audit databases so the
// offline image verifier proves more than schema initialization.
const setup = await fetch(`${base}/v1/setup/owner`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "image-smoke@example.test", displayName: "Image Smoke", password: "image-smoke-password-42!" }),
});
const setupBody = await setup.json();
if (setup.status !== 201 || typeof setupBody.csrfToken !== "string") throw new Error("owner fixture setup failed");
const ownerCookie = (setup.headers.get("set-cookie") ?? "").split(";", 1)[0];
const account = await fetch(`${base}/v1/accounts`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": setupBody.csrfToken },
  body: JSON.stringify({ platform: "reddit", expectedNativeUserId: "reddit:t2_image_smoke" }),
});
if (account.status !== 201) throw new Error("audit account fixture failed");
console.log("rest_openapi_mcp=ok");
NODE

"$script_dir/backup-restore-smoke.sh" "$core_container"
docker restart --time 5 "$core_container" >/dev/null
wait_ready "$core_container"
printf 'core_restart=ok\n'

docker run -d \
  --platform "$platform" \
  --name "$worker_container" \
  --user 10002:10002 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=10002,gid=10002,mode=1770 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --memory 256m \
  --cpus 0.5 \
  --pids-limit 32 \
  --mount "type=bind,src=$scratch_dir/reddit-command-key,dst=/run/secrets/social_git_reddit_command_key,readonly" \
  -e SOCIAL_GIT_PORT=8081 \
  "$image" worker >/dev/null
wait_ready "$worker_container" /healthz

docker exec -i "$worker_container" node <<'NODE'
const health = await fetch("http://127.0.0.1:8081/healthz");
const ready = await fetch("http://127.0.0.1:8081/readyz");
if (health.status !== 200) throw new Error("worker /healthz failed");
if (ready.status !== 401) throw new Error("unauthenticated worker /readyz did not fail closed");
const malformed = await fetch("http://127.0.0.1:8081/v1/dispatch", { method: "POST", body: Buffer.from("{}") });
const body = await malformed.json();
if (malformed.status !== 401 || body.code !== "REDDIT_COMMAND_UNAUTHENTICATED") throw new Error("worker dispatch boundary did not fail closed");
console.log("worker_startup_and_dispatch=ok");
NODE

docker inspect --format '{{json .Mounts}}' "$worker_container" | python3 -c '
import json, sys
mounts = json.load(sys.stdin)
assert len(mounts) == 1, f"worker unexpectedly received mounts: {mounts}"
assert mounts[0]["Destination"] == "/run/secrets/social_git_reddit_command_key", mounts
assert mounts[0]["RW"] is False, mounts
print("worker_isolation=ok")
'
[[ $(docker inspect --format '{{.Config.User}}' "$worker_container") == 10002:10002 ]]
[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$core_container") == true ]]
[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$worker_container") == true ]]

SOCIAL_GIT_MASTER_KEY_FILE="$scratch_dir/master-key" \
SOCIAL_GIT_AUDIT_KEY_FILE="$scratch_dir/audit-key" \
SOCIAL_GIT_AUTH_FILE="$scratch_dir/auth.json" \
SOCIAL_GIT_BACKUP_KEY_FILE="$scratch_dir/backup-key" \
SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE="$scratch_dir/reddit-command-key" \
SOCIAL_GIT_X_COMMAND_KEY_FILE="$scratch_dir/x-command-key" \
  docker compose -f "$repo_root/compose.dev.yaml" config --format json \
  | python3 "$script_dir/validate-compose.py"
SOCIAL_GIT_IMAGE="$image" \
SOCIAL_GIT_MASTER_KEY_FILE="$scratch_dir/master-key" \
SOCIAL_GIT_AUDIT_KEY_FILE="$scratch_dir/audit-key" \
SOCIAL_GIT_AUTH_FILE="$scratch_dir/auth.json" \
SOCIAL_GIT_BACKUP_KEY_FILE="$scratch_dir/backup-key" \
SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE="$scratch_dir/reddit-command-key" \
SOCIAL_GIT_X_COMMAND_KEY_FILE="$scratch_dir/x-command-key" \
  docker compose -f "$repo_root/compose.prod.yaml" config --format json \
  | python3 "$script_dir/validate-compose.py"

docker stop --time 5 "$worker_container" "$core_container" >/dev/null
[[ $(docker inspect --format '{{.State.ExitCode}}' "$core_container") == 0 ]]
[[ $(docker inspect --format '{{.State.ExitCode}}' "$worker_container") == 0 ]]
docker logs "$core_container" 2>&1 | rg -q 'runtime.shutdown'
docker logs "$worker_container" 2>&1 | rg -q 'reddit_worker.shutdown'
printf 'graceful_shutdown=ok\n'

# Exercise the verifier packaged in the immutable image. Only its bounded
# fixture databases, the private audit key, and then the non-secret retained
# head are mounted; the verifier source itself must come from the image.
audit_heads=$(
  docker run --rm \
    --platform "$platform" \
    --user 10001:10001 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --network none \
    --memory 256m \
    --cpus 0.5 \
    --pids-limit 32 \
    --mount "type=volume,src=$data_volume,dst=/var/lib/social-git" \
    --mount "type=bind,src=$scratch_dir/audit-key,dst=/run/secrets/social_git_audit_key,readonly" \
    --entrypoint node \
    "$image" /opt/social-git/runtime/audit-verify.mjs \
      --action-database /var/lib/social-git/actions.sqlite \
      --identity-database /var/lib/social-git/identity.sqlite \
      --ledger-id default-action-ledger \
      --tenant-id default \
      --audit-key-file /run/secrets/social_git_audit_key
)
AUDIT_HEADS="$audit_heads" node - "$scratch_dir/audit-heads.json" <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const raw = process.env.AUDIT_HEADS ?? "";
if (Buffer.byteLength(raw, "utf8") > 16 * 1024) throw new Error("audit head fixture is oversized");
const document = JSON.parse(raw);
if (document.version !== 1 || document.action?.audit?.sequence < 1 || document.identity?.sequence < 1) {
  throw new Error("audit head fixture does not cover both non-empty chains");
}
writeFileSync(process.argv[2], `${raw}\n`, { mode: 0o444 });
chmodSync(process.argv[2], 0o444);
NODE
verified_heads=$(
  docker run --rm \
    --platform "$platform" \
    --user 10001:10001 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --network none \
    --memory 256m \
    --cpus 0.5 \
    --pids-limit 32 \
    --mount "type=volume,src=$data_volume,dst=/var/lib/social-git" \
    --mount "type=bind,src=$scratch_dir/audit-key,dst=/run/secrets/social_git_audit_key,readonly" \
    --mount "type=bind,src=$scratch_dir/audit-heads.json,dst=/run/audit-heads.json,readonly" \
    --entrypoint node \
    "$image" /opt/social-git/runtime/audit-verify.mjs \
      --action-database /var/lib/social-git/actions.sqlite \
      --identity-database /var/lib/social-git/identity.sqlite \
      --ledger-id default-action-ledger \
      --tenant-id default \
      --audit-key-file /run/secrets/social_git_audit_key \
      --expected-head /run/audit-heads.json
)
[[ "$verified_heads" == "$audit_heads" ]]
printf 'packaged_audit_verifier=ok platform=%s\n' "$platform"

"$script_dir/inspect-image.sh" "$image" "$platform"
"$script_dir/smoke-admission-overlay.sh" --platform "$platform" "$image"
printf 'container_smoke=ok image=%s platform=%s\n' "$image" "$platform"
