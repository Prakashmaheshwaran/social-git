#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/verify-release-reproducibility.sh --candidate ARCHIVE --tag NAME:TAG [--output REPORT] [--rebuilt-archive ARCHIVE]' \
    '' \
    'Rebuild committed HEAD from a clean detached clone and compare the OCI index and archive bytes.'
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
candidate=
image_tag=
output=$repo_root/dist/reproducibility.json
rebuilt_archive=

while (($#)); do
  case "$1" in
    --candidate)
      candidate=${2:?--candidate requires a value}
      shift
      ;;
    --tag)
      image_tag=${2:?--tag requires a value}
      shift
      ;;
    --output)
      output=${2:?--output requires a value}
      shift
      ;;
    --rebuilt-archive)
      rebuilt_archive=${2:?--rebuilt-archive requires a value}
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "$candidate" || -z "$image_tag" ]]; then
  usage >&2
  exit 2
fi
if [[ ! -f "$candidate" ]]; then
  printf 'error: candidate archive does not exist: %s\n' "$candidate" >&2
  exit 2
fi

command -v docker >/dev/null || {
  printf '%s\n' 'error: docker is required' >&2
  exit 1
}
command -v git >/dev/null || {
  printf '%s\n' 'error: git is required' >&2
  exit 1
}

guard_root=$(mktemp -d "${TMPDIR:-/tmp}/social-git-repro.XXXXXX")
cleanup() {
  rm -rf -- "$guard_root"
}
trap cleanup EXIT

candidate=$(python3 - "$candidate" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).resolve())
PY
)
output=$(python3 - "$output" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).resolve())
PY
)
if [[ -n "$rebuilt_archive" ]]; then
  rebuilt_archive=$(python3 - "$rebuilt_archive" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).resolve())
PY
)
else
  rebuilt_archive=$guard_root/rebuilt.oci.tar
fi
if [[ "$rebuilt_archive" == "$candidate" || "$output" == "$candidate" ]]; then
  printf '%s\n' 'error: output paths must not overwrite the candidate archive' >&2
  exit 2
fi

source_commit=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')
source_date_epoch=$(git -C "$repo_root" show -s --format=%ct "$source_commit")
candidate_metadata=$guard_root/candidate.json
rebuilt_metadata=$guard_root/rebuilt.json
review_candidate=$guard_root/runtime-review.json

python3 "$script_dir/verify-oci-layout.py" \
  --archive "$candidate" \
  --require-platform linux/amd64 \
  --require-platform linux/arm64 \
  --output "$candidate_metadata"

candidate_tag=$(python3 - "$candidate_metadata" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8")).get("refName") or "")
PY
)
expected_ref_name=${image_tag##*:}
if [[ "$candidate_tag" != "$expected_ref_name" ]]; then
  printf 'error: candidate tag mismatch: expected %s, observed %s\n' \
    "$expected_ref_name" "${candidate_tag:-<none>}" >&2
  exit 1
fi

git clone --quiet --no-local "$repo_root" "$guard_root/source"
git -C "$guard_root/source" checkout --quiet --detach "$source_commit"
if [[ -n "$(git -C "$guard_root/source" status --porcelain=v1 --untracked-files=all)" ]]; then
  printf '%s\n' 'error: detached verification clone is not clean' >&2
  exit 1
fi

mkdir -p "$(dirname -- "$rebuilt_archive")"
SOURCE_DATE_EPOCH=$source_date_epoch VCS_REF=$source_commit \
  "$guard_root/source/scripts/build-images.sh" \
    --no-cache \
    --tag "$image_tag" \
    --output "$rebuilt_archive" \
    --review-candidate "$review_candidate"

python3 "$guard_root/source/scripts/verify-oci-layout.py" \
  --archive "$rebuilt_archive" \
  --require-platform linux/amd64 \
  --require-platform linux/arm64 \
  --output "$rebuilt_metadata"

archives_equal=false
if cmp -s "$candidate" "$rebuilt_archive"; then
  archives_equal=true
fi

mkdir -p "$(dirname -- "$output")"
python3 - \
  "$candidate" \
  "$candidate_metadata" \
  "$rebuilt_archive" \
  "$rebuilt_metadata" \
  "$source_commit" \
  "$image_tag" \
  "$archives_equal" \
  "$output" <<'PY'
import hashlib
import json
from pathlib import Path
import sys


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


candidate = Path(sys.argv[1])
candidate_metadata = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
rebuilt = Path(sys.argv[3])
rebuilt_metadata = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
archives_equal = sys.argv[7] == "true"
metadata_equal = all(
    candidate_metadata[field] == rebuilt_metadata[field]
    for field in ("indexJsonDigest", "platformManifests", "releaseDigest")
)
status = "ok" if archives_equal and metadata_equal else "mismatch"
report = {
    "archivesByteEqual": archives_equal,
    "candidate": {
        "archiveSha256": sha256_file(candidate),
        **candidate_metadata,
    },
    "cleanDetachedRebuild": {
        "archiveSha256": sha256_file(rebuilt),
        **rebuilt_metadata,
    },
    "imageTag": sys.argv[6],
    "schema": "social-git-release-reproducibility/v1",
    "sourceCommit": sys.argv[5],
    "status": status,
}
Path(sys.argv[8]).write_text(
    json.dumps(report, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
print(json.dumps(report, sort_keys=True))
if status != "ok":
    raise SystemExit(1)
PY
