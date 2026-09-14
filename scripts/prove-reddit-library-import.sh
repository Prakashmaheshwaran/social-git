#!/usr/bin/env bash
set -euo pipefail

readonly repository="https://github.com/ishan-parihar/reddit-lyr.git"
readonly revision="87ec32aff905923ecd156e7951c168adfdf6fac1"

if ! command -v git >/dev/null 2>&1; then
  echo "error: required tool is not installed: git" >&2
  exit 1
fi

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

git clone --quiet --filter=blob:none --no-checkout "$repository" "$source_dir"
git -C "$source_dir" checkout --quiet --detach "$revision"

actual_revision="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$actual_revision" != "$revision" ]]; then
  echo "error: expected revision $revision, got $actual_revision" >&2
  exit 1
fi

proof_python_mode=""
proof_python_command=()

for candidate in "${PROOF_PYTHON:-}" python3.11 python3.12 python3.13 python3.14 python3; do
  if [[ -z "$candidate" ]] || ! command -v "$candidate" >/dev/null 2>&1; then
    continue
  fi
  if "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))'; then
    proof_python_command=("$candidate")
    proof_python_mode="installed interpreter"
    break
  fi
done

if [[ ${#proof_python_command[@]} -eq 0 ]]; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "error: Python 3.11+ or uv is required for the upstream source" >&2
    exit 1
  fi
  proof_python_command=(uv run --quiet --no-project --python 3.11 python)
  proof_python_mode="uv-managed interpreter; no project or dependency install"
fi

echo "source_revision=$actual_revision"
echo "source_blob=$(git -C "$source_dir" hash-object reddit_mcp_server/scraping/api_client.py)"
echo "python_mode=$proof_python_mode"

PROOF_SOURCE_DIR="$source_dir" "${proof_python_command[@]}" - <<'PY'
import asyncio
import importlib
import inspect
import os
import platform
import sys
import types
from pathlib import Path

source_dir = Path(os.environ["PROOF_SOURCE_DIR"])
client_source = source_dir / "reddit_mcp_server" / "scraping" / "api_client.py"


class NoRuntimeAsyncSession:
    """Fail if the source-only proof tries to create an HTTP session."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        raise AssertionError("proof attempted to create a curl_cffi runtime session")


# The selected module has one third-party import. Stub only that import so this
# proof loads the exact upstream source without installing or executing a native
# curl_cffi wheel. The stub fails closed if a test path tries to use HTTP.
curl_cffi = types.ModuleType("curl_cffi")
curl_requests = types.ModuleType("curl_cffi.requests")
curl_requests.AsyncSession = NoRuntimeAsyncSession
curl_cffi.requests = curl_requests
sys.modules["curl_cffi"] = curl_cffi
sys.modules["curl_cffi.requests"] = curl_requests
sys.path.insert(0, str(source_dir))

client_module = importlib.import_module("reddit_mcp_server.scraping.api_client")
RedditAPIClient = client_module.RedditAPIClient

assert Path(inspect.getsourcefile(RedditAPIClient) or "").resolve() == client_source.resolve()
assert client_module.AsyncSession is NoRuntimeAsyncSession


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


asyncio.run(main())

print(f"platform={platform.system()} {platform.machine()}")
print(f"python={platform.python_version()} ({sys.implementation.name})")
print("dependency_install=none")
print("transport=fail-closed curl_cffi stub")
print(
    "PASS: imported exact RedditAPIClient source and verified seven write "
    "route mappings with no HTTP session"
)
PY
