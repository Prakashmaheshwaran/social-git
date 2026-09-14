#!/usr/bin/env python3
"""Inspect a running image filesystem without printing secret values."""

from __future__ import annotations

import importlib.metadata
import json
import os
import platform
from pathlib import Path


FORBIDDEN_EXECUTABLES = {
    "chrome",
    "chromedriver",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "playwright",
    "selenium",
    "xvfb",
    "xvfb-run",
}
FORBIDDEN_PACKAGES = {"chromium", "chromium-common", "playwright", "selenium", "xvfb"}
FORBIDDEN_CONFIG_MARKERS = (
    b"reddit_client_id",
    b"reddit_client_secret",
    b"reddit_api_key",
    b"praw_client_id",
    b"praw_client_secret",
    b"oauth.reddit.com",
    b"reddit.com/api/v1/access_token",
)


def executable_hits() -> list[str]:
    hits: list[str] = []
    skipped = {"/dev", "/proc", "/sys", "/policy"}
    for directory, directory_names, file_names in os.walk("/", topdown=True):
        directory_names[:] = [
            name
            for name in directory_names
            if str(Path(directory) / name) not in skipped
        ]
        for name in file_names:
            if name.casefold() not in FORBIDDEN_EXECUTABLES:
                continue
            path = Path(directory) / name
            if path.is_file() and os.access(path, os.X_OK):
                hits.append(str(path))
    return sorted(hits)


def python_package_hits() -> list[str]:
    names = {
        (distribution.metadata.get("Name") or "").casefold()
        for distribution in importlib.metadata.distributions()
    }
    return sorted(names & FORBIDDEN_PACKAGES)


def operating_system_package_hits() -> list[str]:
    status_file = Path("/var/lib/dpkg/status")
    if not status_file.exists():
        return []
    names = {
        line.split(":", 1)[1].strip().casefold()
        for line in status_file.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.startswith("Package:")
    }
    return sorted(names & FORBIDDEN_PACKAGES)


def application_config_hits() -> list[str]:
    hits: set[str] = set()
    root = Path("/opt/social-git")
    for path in root.rglob("*"):
        if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
            continue
        content = path.read_bytes().lower()
        for marker in FORBIDDEN_CONFIG_MARKERS:
            if marker in content:
                hits.add(marker.decode("ascii"))
    environment_names = {name.casefold().encode("ascii", errors="ignore") for name in os.environ}
    for marker in FORBIDDEN_CONFIG_MARKERS[:5]:
        if marker in environment_names:
            hits.add(marker.decode("ascii"))
    return sorted(hits)


def main() -> int:
    checks = {
        "forbidden_application_config": application_config_hits(),
        "forbidden_executables": executable_hits(),
        "forbidden_os_packages": operating_system_package_hits(),
        "forbidden_python_packages": python_package_hits(),
        "metadata_missing": [
            str(path)
            for path in (
                Path("/opt/social-git/share/source-manifest.sha256"),
                Path("/opt/social-git/share/sbom.spdx.json"),
            )
            if not path.is_file()
        ],
        "unexpected_uid": [] if os.getuid() == 10001 else [str(os.getuid())],
    }
    passed = not any(checks.values())
    print(
        json.dumps(
            {
                "architecture": platform.machine(),
                "checks": checks,
                "status": "ok" if passed else "failed",
            },
            sort_keys=True,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
