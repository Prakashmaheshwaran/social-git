#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: qa/acceptance/run-image.sh --image IMAGE --platform linux/ARCH --candidate-ref REF --image-digest DIGEST --inventory FILE --output FILE' \
    '' \
    'Runs all public-boundary scenarios against one locally loaded, native-architecture image.'
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
image=
platform=
candidate_ref=
image_digest=
inventory=
output=

while (($#)); do
  case "$1" in
    --image) image=${2:?--image requires a value}; shift ;;
    --platform) platform=${2:?--platform requires a value}; shift ;;
    --candidate-ref) candidate_ref=${2:?--candidate-ref requires a value}; shift ;;
    --image-digest) image_digest=${2:?--image-digest requires a value}; shift ;;
    --inventory) inventory=${2:?--inventory requires a value}; shift ;;
    --output) output=${2:?--output requires a value}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$image" && -n "$platform" && -n "$candidate_ref" && -n "$image_digest" && -n "$inventory" && -n "$output" ]] || {
  usage >&2
  exit 2
}
[[ "$platform" == linux/amd64 || "$platform" == linux/arm64 ]] || {
  printf 'error: unsupported platform: %s\n' "$platform" >&2
  exit 2
}
[[ "$candidate_ref" =~ ^(git:)?[a-f0-9]{40}$ || "$candidate_ref" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf '%s\n' 'error: candidate reference is not immutable' >&2
  exit 2
}
[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf '%s\n' 'error: image digest is not immutable' >&2
  exit 2
}
[[ -f "$inventory" ]] || {
  printf 'error: independent inventory does not exist: %s\n' "$inventory" >&2
  exit 2
}
[[ ! -e "$output" ]] || {
  printf 'error: output already exists: %s\n' "$output" >&2
  exit 2
}

daemon_arch=$(docker info --format '{{.Architecture}}')
case "$daemon_arch" in
  amd64|x86_64) native_platform=linux/amd64 ;;
  arm64|aarch64) native_platform=linux/arm64 ;;
  *) printf 'error: unsupported Docker daemon architecture: %s\n' "$daemon_arch" >&2; exit 2 ;;
esac
[[ "$platform" == "$native_platform" ]] || {
  printf 'error: native %s Docker is required for %s acceptance\n' "${platform#linux/}" "$platform" >&2
  exit 2
}

node - "$inventory" "$image_digest" <<'NODE'
const { readFileSync } = require("node:fs");
const [path, digest] = process.argv.slice(2);
const value = JSON.parse(readFileSync(path, "utf8"));
if (value?.provenance !== "independent_inventory" || value?.source?.digest !== digest) {
  throw new Error("Independent inventory does not match the requested image digest");
}
if (!["image_tar", "oci_registry"].includes(value?.source?.kind)) {
  throw new Error("Independent inventory source kind is invalid");
}
NODE

"$repo_root/scripts/inspect-image.sh" "$image" "$platform" >/dev/null

scratch_base=${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-}}
if [[ -n "$scratch_base" ]]; then
  mkdir -p "$scratch_base"
  scratch_dir=$(mktemp -d "$scratch_base/social-git-image-acceptance.XXXXXX")
else
  scratch_dir=$(mktemp -d)
fi
container_name="social-git-acceptance-${platform#linux/}-$$"
data_volume="social-git-acceptance-data-${platform#linux/}-$$"
supervisor_pid=

cleanup() {
  exit_status=$?
  if ((exit_status != 0)); then
    printf '%s\n' 'candidate container logs after failed acceptance:' >&2
    docker logs "$container_name" >&2 2>/dev/null || true
    printf '%s\n' 'restart supervisor logs after failed acceptance:' >&2
    sed -E 's/(authorization|token|secret|cookie|csrf|password|session)[^[:space:]]*/\1=[REDACTED]/Ig' "$scratch_dir/supervisor.log" >&2 2>/dev/null || true
  fi
  if [[ -n "$supervisor_pid" ]]; then
    kill "$supervisor_pid" >/dev/null 2>&1 || true
    wait "$supervisor_pid" 2>/dev/null || true
  fi
  docker container rm --force "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" >/dev/null 2>&1 || true
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
for (const name of ["master-key", "audit-key"]) {
  const path = `${directory}/${name}`;
  writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
const token = randomBytes(32).toString("base64url");
writeFileSync(`${directory}/qa-token`, token, { mode: 0o600 });
writeFileSync(`${directory}/auth.json`, JSON.stringify({
  version: 1,
  principals: [{
    callerId: "qa-controller",
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    scopes: ["*"],
  }],
}), { mode: 0o600 });
NODE

docker volume create "$data_volume" >/dev/null
candidate_port=$(node <<'NODE'
const { createServer } = require("node:net");
const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an acceptance port");
  server.close(() => process.stdout.write(String(address.port)));
});
NODE
)
docker run -d \
  --platform "$platform" \
  --name "$container_name" \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=1770 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 512m \
  --cpus 1.0 \
  --pids-limit 128 \
  -p "127.0.0.1:$candidate_port:8080" \
  --mount "type=volume,src=$data_volume,dst=/var/lib/social-git" \
  --mount "type=bind,src=$scratch_dir/master-key,dst=/run/secrets/social_git_master_key,readonly" \
  --mount "type=bind,src=$scratch_dir/audit-key,dst=/run/secrets/social_git_audit_key,readonly" \
  --mount "type=bind,src=$scratch_dir/auth.json,dst=/run/secrets/social_git_auth,readonly" \
  -e NODE_ENV=test \
  -e SOCIAL_GIT_MODE=fixture \
  -e SOCIAL_GIT_WORKER_INTERVAL_MS=25 \
  "$image" core >/dev/null

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$candidate_port/readyz" >/dev/null; then break; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$candidate_port/readyz" >/dev/null

qa_token=$(<"$scratch_dir/qa-token")
qa_token_sha256=$(node -e 'const {createHash}=require("node:crypto"); process.stdout.write(createHash("sha256").update(process.argv[1]).digest("hex"))' "$qa_token")
SOCIAL_GIT_QA_CONTAINER="$container_name" \
SOCIAL_GIT_QA_TOKEN_SHA256="$qa_token_sha256" \
SOCIAL_GIT_QA_SUPERVISOR_PORT=0 \
  node "$script_dir/restart-supervisor.mjs" >"$scratch_dir/supervisor.log" 2>&1 &
supervisor_pid=$!

supervisor_url=
for _ in $(seq 1 100); do
  supervisor_url=$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$scratch_dir/supervisor.log" | tail -n 1)
  if [[ -n "$supervisor_url" ]]; then break; fi
  sleep 0.1
done
[[ -n "$supervisor_url" ]] || {
  printf '%s\n' 'error: restart supervisor did not become ready' >&2
  exit 1
}

SOCIAL_GIT_CANDIDATE_URL="http://127.0.0.1:$candidate_port" \
SOCIAL_GIT_QA_TOKEN="$qa_token" \
SOCIAL_GIT_QA_IMAGE_INVENTORY="$inventory" \
SOCIAL_GIT_QA_RESTART_URL="$supervisor_url" \
  npm --prefix "$repo_root" run qa:acceptance -- \
    --driver "$script_dir/service-driver.mjs" \
    --candidate-ref "$candidate_ref" \
    --image-digest "$image_digest" \
    --output "$output"
