#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
image=${1:-social-git-runtime:smoke}

if ! docker image inspect "$image" >/dev/null 2>&1; then
  architecture=$(docker info --format '{{.Architecture}}')
  case "$architecture" in
    aarch64|arm64) platform=linux/arm64 ;;
    x86_64|amd64) platform=linux/amd64 ;;
    *)
      printf 'error: unsupported Docker architecture: %s\n' "$architecture" >&2
      exit 1
      ;;
  esac
  "$script_dir/build-images.sh" --load --platform "$platform" --tag "$image"
fi

scratch_base=${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-}}
if [[ -n "$scratch_base" ]]; then
  mkdir -p "$scratch_base"
  scratch_dir=$(mktemp -d "$scratch_base/dyn-34-smoke.XXXXXX")
else
  scratch_dir=$(mktemp -d)
fi
core_container="social-git-core-smoke-$$"
worker_container="social-git-worker-smoke-$$"
data_volume="social-git-smoke-$$"

cleanup() {
  docker rm -f "$core_container" "$worker_container" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" >/dev/null 2>&1 || true
  find "$scratch_dir" -type f -exec chmod 0600 {} + 2>/dev/null || true
  rm -rf "$scratch_dir"
}
trap cleanup EXIT

umask 077
python3 -c 'import secrets,sys; sys.stdout.buffer.write(secrets.token_bytes(32))' \
  >"$scratch_dir/session-key"
docker volume create "$data_volume" >/dev/null

docker run -d \
  --name "$core_container" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=1770 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 384m \
  --cpus 1.0 \
  --pids-limit 128 \
  --mount "type=volume,src=$data_volume,dst=/var/lib/social-git" \
  --mount "type=bind,src=$scratch_dir/session-key,dst=/run/secrets/social_git_session_key,readonly" \
  "$image" core >/dev/null

ready=false
for _ in $(seq 1 30); do
  if docker exec "$core_container" python -m runtime.healthcheck --path /readyz; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$core_container" >&2
  printf '%s\n' 'error: core readiness check did not pass' >&2
  exit 1
fi

docker exec "$core_container" python -c '
import json
import os
import urllib.request

assert os.getuid() == 10001
for path in ("/healthz", "/readyz"):
    with urllib.request.urlopen(f"http://127.0.0.1:8080{path}", timeout=2) as response:
        assert response.status == 200
        assert json.load(response)["role"] == "core"
print("core_health=ok")
'
[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$core_container") == true ]]
"$script_dir/backup-restore-smoke.sh" "$core_container"

docker run -d \
  --name "$worker_container" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=1770 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --memory 256m \
  --cpus 0.5 \
  --pids-limit 128 \
  -e SOCIAL_GIT_PORT=8081 \
  "$image" worker >/dev/null

worker_ready=false
for _ in $(seq 1 30); do
  if docker exec "$worker_container" python -m runtime.healthcheck --path /readyz; then
    worker_ready=true
    break
  fi
  sleep 1
done
if [[ "$worker_ready" != true ]]; then
  docker logs "$worker_container" >&2
  printf '%s\n' 'error: worker readiness check did not pass' >&2
  exit 1
fi

docker inspect --format '{{json .Mounts}}' "$worker_container" | python3 -c '
import json
import sys

mounts = json.load(sys.stdin)
assert mounts == [], f"worker unexpectedly received mounts: {mounts}"
print("worker_isolation=ok")
'

SOCIAL_GIT_SESSION_KEY_FILE="$scratch_dir/session-key" \
  docker compose -f "$repo_root/compose.dev.yaml" config --format json \
  | python3 "$script_dir/validate-compose.py"
SOCIAL_GIT_IMAGE="$image" \
SOCIAL_GIT_SESSION_KEY_FILE="$scratch_dir/session-key" \
  docker compose -f "$repo_root/compose.prod.yaml" config --format json \
  | python3 "$script_dir/validate-compose.py"

"$script_dir/inspect-image.sh" "$image"
printf 'container_smoke=ok image=%s\n' "$image"
