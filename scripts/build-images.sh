#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/build-images.sh [--load] [--platform linux/ARCH] [--tag NAME:TAG] [--output PATH]' \
    '' \
    'Default: build linux/amd64 and linux/arm64 into an OCI archive without publishing.'
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
mode=oci
platforms=linux/amd64,linux/arm64
image_tag=${IMAGE_TAG:-social-git-runtime:local}
oci_output=${OCI_OUTPUT:-$repo_root/dist/social-git-runtime.oci.tar}

while (($#)); do
  case "$1" in
    --load)
      mode=load
      ;;
    --platform)
      platforms=${2:?--platform requires a value}
      shift
      ;;
    --tag)
      image_tag=${2:?--tag requires a value}
      shift
      ;;
    --output)
      oci_output=${2:?--output requires a value}
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

if [[ "$mode" == load && "$platforms" == *,* ]]; then
  printf '%s\n' 'error: --load accepts exactly one platform' >&2
  exit 2
fi

command -v docker >/dev/null || {
  printf '%s\n' 'error: docker is required' >&2
  exit 1
}
docker buildx version >/dev/null

source_date_epoch=${SOURCE_DATE_EPOCH:-}
if [[ -z "$source_date_epoch" ]]; then
  source_date_epoch=$(git -C "$repo_root" log -1 --format=%ct 2>/dev/null || printf '0')
fi
if [[ ! "$source_date_epoch" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'error: SOURCE_DATE_EPOCH must be a non-negative integer' >&2
  exit 2
fi

created=$(python3 - "$source_date_epoch" <<'PY'
import datetime as dt
import sys

print(dt.datetime.fromtimestamp(int(sys.argv[1]), tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)
revision=${VCS_REF:-$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || printf 'unknown')}
base_image='python:3.13.7-slim-bookworm@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d'

python3 "$script_dir/generate-source-metadata.py" \
  --root "$repo_root" \
  --output "$repo_root/build/metadata" \
  --source-date-epoch "$source_date_epoch" \
  --runtime-version 3.13.7 \
  --base-image "$base_image"

build_args=(
  --file "$repo_root/Dockerfile"
  --platform "$platforms"
  --tag "$image_tag"
  --build-arg "CREATED=$created"
  --build-arg BUILDKIT_MULTI_PLATFORM=1
  --build-arg "SOURCE_DATE_EPOCH=$source_date_epoch"
  --build-arg "VCS_REF=$revision"
  --provenance=false
  --sbom=false
)

if [[ "$mode" == load ]]; then
  docker buildx build "${build_args[@]}" --load "$repo_root"
  printf 'Loaded %s for %s\n' "$image_tag" "$platforms"
else
  mkdir -p "$(dirname -- "$oci_output")"
  docker buildx build "${build_args[@]}" \
    --output "type=oci,dest=$oci_output,rewrite-timestamp=true" \
    "$repo_root"
  python3 "$script_dir/verify-oci-layout.py" \
    --archive "$oci_output" \
    --require-platform linux/amd64 \
    --require-platform linux/arm64
  printf 'Created %s\n' "$oci_output"
fi
