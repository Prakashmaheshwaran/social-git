#!/usr/bin/env bash
set -Eeuo pipefail

image=${1:?Usage: scripts/inspect-image.sh IMAGE [linux/ARCH]}
platform=${2:-}
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

inspect_args=()
run_args=()
if [[ -n "$platform" ]]; then
  [[ "$platform" == linux/amd64 || "$platform" == linux/arm64 ]] || {
    printf 'error: unsupported platform: %s\n' "$platform" >&2
    exit 2
  }
  # `docker image inspect --platform` needs a newer CLI than GitHub's
  # ubuntu-24.04 runners ship (Docker 28.0). Use it when available; either way
  # the configuration check below asserts the inspected OS and architecture.
  if docker image inspect --help 2>/dev/null | grep -q -- '--platform'; then
    inspect_args+=(--platform "$platform")
  fi
  run_args+=(--platform "$platform")
fi

docker image inspect "${inspect_args[@]}" "$image" | python3 -c '
import json
import sys

document = json.load(sys.stdin)[0]
expected_platform = sys.argv[1]
if expected_platform:
    actual_platform = str(document.get("Os")) + "/" + str(document.get("Architecture"))
    if actual_platform != expected_platform:
        raise SystemExit("inspected image platform " + actual_platform + " is not " + expected_platform)
config = document.get("Config") or {}
user = config.get("User") or ""
if user not in {"10001", "10001:10001"}:
    raise SystemExit(f"image user is not non-root Core UID 10001: {user!r}")
if config.get("Entrypoint") != ["node", "/opt/social-git/runtime/entrypoint.mjs"]:
    raise SystemExit("image entrypoint is not the executable role dispatcher")
if config.get("Cmd") != ["core"]:
    raise SystemExit("image default command is not the Core gateway")
forbidden = {"reddit_client_id", "reddit_client_secret", "reddit_api_key", "praw_client_id", "praw_client_secret"}
names = {entry.split("=", 1)[0].casefold() for entry in config.get("Env") or []}
hits = sorted(names & forbidden)
if hits:
    raise SystemExit("forbidden official API configuration names: " + ", ".join(hits))
print(json.dumps({"configuredUser": user, "entrypoint": config["Entrypoint"], "officialApiConfigNames": [], "status": "ok"}, sort_keys=True))
' "$platform"

docker run --rm \
  "${run_args[@]}" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --mount "type=bind,src=$script_dir/image-policy.mjs,dst=/policy/image-policy.mjs,readonly" \
  --entrypoint node \
  "$image" /policy/image-policy.mjs
