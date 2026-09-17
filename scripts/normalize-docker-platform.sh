#!/usr/bin/env bash
set -Eeuo pipefail

architecture=$(sed -e '/^[[:space:]]*$/d' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

case "$architecture" in
  aarch64|arm64) printf '%s\n' 'linux/arm64' ;;
  x86_64|amd64) printf '%s\n' 'linux/amd64' ;;
  *) exit 1 ;;
esac
