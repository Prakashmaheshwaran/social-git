#!/usr/bin/env bash
set -euo pipefail

readonly repository="https://github.com/ishan-parihar/reddit-lyr.git"
readonly revision="87ec32aff905923ecd156e7951c168adfdf6fac1"

for tool in git uv; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required tool is not installed: $tool" >&2
    exit 1
  fi
done

proof_base="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-${TMPDIR:-/tmp}}}"
mkdir -p "$proof_base"
proof_dir="$(mktemp -d "$proof_base/social-git-reddit-proof.XXXXXX")"
readonly proof_base proof_dir

cleanup() {
  case "$proof_dir" in
    "$proof_base"/social-git-reddit-proof.*)
      rm -rf -- "$proof_dir"
      ;;
  esac
}
trap cleanup EXIT

source_dir="$proof_dir/reddit-lyr"
profile_dir="$proof_dir/empty-profile"
mkdir -p "$profile_dir"

git clone --quiet --filter=blob:none --no-checkout "$repository" "$source_dir"
git -C "$source_dir" checkout --quiet --detach "$revision"

actual_revision="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$actual_revision" != "$revision" ]]; then
  echo "error: expected revision $revision, got $actual_revision" >&2
  exit 1
fi

cd "$source_dir"
REDDIT_MCP_PROFILE_DIR="$profile_dir" REDDIT_USE_DAEMON=false \
  uv sync --frozen --no-dev --quiet

REDDIT_MCP_PROFILE_DIR="$profile_dir" REDDIT_USE_DAEMON=false \
  uv run --no-sync python - <<'PY'
import asyncio

from reddit_mcp_server.scraping.api_client import RedditAPIClient


async def main() -> None:
    client = RedditAPIClient({"proof_cookie": "not-a-session"})
    calls: list[tuple[str, dict | None]] = []

    async def fake_post(path: str, data: dict | None = None) -> dict:
        calls.append((path, data))
        return {"proof": "ok"}

    client._post = fake_post
    await client.submit_text("example", "title", "body")
    await client.submit_link("example", "title", "https://example.invalid/")
    await client.comment("t3_example", "body")
    await client.vote("t3_example", 1)
    await client.save("t3_example")
    await client.unsave("t3_example")
    await client.delete_thing("t3_example")

    expected_paths = [
        "/api/submit",
        "/api/submit",
        "/api/comment",
        "/api/vote",
        "/api/save",
        "/api/unsave",
        "/api/del",
    ]
    assert [path for path, _ in calls] == expected_paths
    assert client._session is None, "proof unexpectedly created an HTTP session"

    print(
        "PASS: imported RedditAPIClient and verified seven write route "
        "mappings with no HTTP session"
    )


asyncio.run(main())
PY
