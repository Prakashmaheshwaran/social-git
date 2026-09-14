#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/build-images.sh [--load] [--no-cache] [--platform linux/ARCH] [--tag NAME:TAG] [--output PATH] [--attestation-output PATH] [--review-candidate PATH]' \
    '' \
    'Default: build linux/amd64 and linux/arm64 into an OCI archive without publishing.'
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
mode=oci
platforms=linux/amd64,linux/arm64
image_tag=${IMAGE_TAG:-social-git-runtime:local}
oci_output=${OCI_OUTPUT:-$repo_root/dist/social-git-runtime.oci.tar}
attestation_output=${ATTESTATION_OUTPUT:-$repo_root/dist/attestations}
no_cache=false
review_candidate=

while (($#)); do
  case "$1" in
    --load)
      mode=load
      ;;
    --no-cache)
      no_cache=true
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
    --attestation-output)
      attestation_output=${2:?--attestation-output requires a value}
      shift
      ;;
    --review-candidate)
      review_candidate=${2:?--review-candidate requires a value}
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
if [[ "$mode" == load && -n "$review_candidate" ]]; then
  printf '%s\n' 'error: --review-candidate requires an OCI archive build' >&2
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
base_image='node:26.3.1-bookworm-slim@sha256:9898bb74f4ee319780e87819df703b3633113bc3422f151fd11155cf974a2749'

python3 "$script_dir/generate-source-metadata.py" \
  --root "$repo_root" \
  --output "$repo_root/build/metadata" \
  --source-date-epoch "$source_date_epoch" \
  --runtime-name node \
  --runtime-version 26.3.1 \
  --base-image "$base_image"

build_args=(
  --file "$repo_root/Dockerfile"
  --platform "$platforms"
  --tag "$image_tag"
  --build-arg "CREATED=$created"
  --build-arg BUILDKIT_MULTI_PLATFORM=1
  --build-arg "SOURCE_DATE_EPOCH=$source_date_epoch"
  --build-arg "VCS_REF=$revision"
  --network none
  --provenance=false
  --sbom=false
)

if [[ "$no_cache" == true ]]; then
  build_args+=(--no-cache)
fi

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
  if [[ -n "$review_candidate" ]]; then
    python3 "$repo_root/tools/security/attest_runtime.py" \
      --archive "$oci_output" \
      --write-review-candidate "$review_candidate"
  else
    python3 "$repo_root/tools/security/attest_runtime.py" \
      --archive "$oci_output" \
      --review "$repo_root/security/runtime-dependency-review.json" \
      --output-dir "$attestation_output"
  fi
  printf 'Created %s\n' "$oci_output"
  if [[ -n "$review_candidate" ]]; then
    printf 'Review required: %s\n' "$review_candidate"
  else
    printf 'Attested %s\n' "$attestation_output"
  fi
fi
