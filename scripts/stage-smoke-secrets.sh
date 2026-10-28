#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/stage-smoke-secrets.sh --image IMAGE --platform linux/ARCH UID:GID=PATH...' \
    '' \
    'Make staging files readable by the unprivileged UIDs the smoke containers run as.' \
    'On a Linux host a file created by the invoking user stays owned by that user, so a' \
    'container running as 10001/10002 cannot read a 0600 bind mount. macOS container' \
    'runtimes remap ownership and hide the difference; the GitHub ubuntu-24.04 runner does' \
    'not. This helper performs the ownership transfer with a capability-minimal, network-' \
    'isolated, read-only root container that can only CHOWN/FOWNER the explicitly mounted' \
    'files. It never relaxes a file mode: every staged file stays 0600.'
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image=
platform=
specs=()

while (($#)); do
  case "$1" in
    --image)
      image=${2:?--image requires a value}
      shift
      ;;
    --platform)
      platform=${2:?--platform requires a value}
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 2
      ;;
    *=*)
      specs+=("$1")
      ;;
    *)
      printf 'error: expected UID:GID=PATH, got: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

[[ -n "$image" ]] || { printf '%s\n' 'error: --image is required' >&2; exit 2; }
[[ "$platform" == linux/amd64 || "$platform" == linux/arm64 ]] || {
  printf 'error: unsupported platform: %s\n' "$platform" >&2
  exit 2
}
((${#specs[@]})) || { printf '%s\n' 'error: no staging files were given' >&2; exit 2; }

mounts=()
assignments=()
for spec in "${specs[@]}"; do
  owner=${spec%%=*}
  path=${spec#*=}
  uid=${owner%%:*}
  gid=${owner#*:}
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || {
    printf 'error: invalid owner %q for %s\n' "$owner" "$path" >&2
    exit 2
  }
  [[ -f "$path" && ! -L "$path" ]] || {
    printf 'error: staging file is missing or not a regular file: %s\n' "$path" >&2
    exit 2
  }
  name=${path##*/}
  mounts+=(--mount "type=bind,src=$path,dst=/stage/$name")
  assignments+=("$uid:$gid:/stage/$name")
done

# CHOWN transfers ownership; FOWNER authorises the follow-up chmod. Nothing else
# is granted, the root filesystem stays read-only, and there is no network.
docker run --rm \
  --platform "$platform" \
  --user 0:0 \
  --read-only \
  --network none \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add FOWNER \
  --security-opt no-new-privileges \
  --memory 64m \
  --cpus 0.5 \
  --pids-limit 32 \
  "${mounts[@]}" \
  --entrypoint node \
  "$image" \
  -e '
    const fs = require("node:fs");
    for (const spec of process.argv.slice(1)) {
      const first = spec.indexOf(":");
      const second = spec.indexOf(":", first + 1);
      const uid = Number(spec.slice(0, first));
      const gid = Number(spec.slice(first + 1, second));
      const path = spec.slice(second + 1);
      fs.chownSync(path, uid, gid);
      fs.chmodSync(path, 0o600);
    }
  ' "${assignments[@]}"
