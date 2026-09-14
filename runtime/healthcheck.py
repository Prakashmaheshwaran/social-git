"""Dependency-free container health/readiness probe."""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", default="/readyz", choices=("/healthz", "/readyz"))
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    port = args.port or int(os.environ.get("SOCIAL_GIT_PORT", "8080"))
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{args.path}",
        headers={"User-Agent": "social-git-healthcheck/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            return 0 if response.status == 200 else 1
    except (OSError, urllib.error.URLError):
        return 1


if __name__ == "__main__":
    sys.exit(main())
