#!/usr/bin/env bash
set -Eeuo pipefail

image=${1:?Usage: scripts/inspect-image.sh IMAGE}
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

docker image inspect "$image" | python3 -c '
import json
import sys

document = json.load(sys.stdin)[0]
config = document.get("Config") or {}
user = config.get("User") or ""
if user not in {"10001", "10001:10001"}:
    raise SystemExit(f"image user is not non-root UID 10001: {user!r}")
forbidden = {
    "reddit_client_id",
    "reddit_client_secret",
    "reddit_api_key",
    "praw_client_id",
    "praw_client_secret",
}
names = {entry.split("=", 1)[0].casefold() for entry in config.get("Env") or []}
hits = sorted(names & forbidden)
if hits:
    raise SystemExit("forbidden official API configuration names: " + ", ".join(hits))
print(json.dumps({"configuredUser": user, "officialApiConfigNames": [], "status": "ok"}, sort_keys=True))
'

docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --mount "type=bind,src=$script_dir/image-policy.py,dst=/policy/image-policy.py,readonly" \
  --entrypoint python \
  "$image" /policy/image-policy.py
