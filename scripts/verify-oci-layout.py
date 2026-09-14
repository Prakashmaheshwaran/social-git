#!/usr/bin/env python3
"""Verify that an OCI archive contains the required runnable platforms."""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
from pathlib import Path
from typing import Any


class ArchiveError(RuntimeError):
    pass


class OciArchive:
    def __init__(self, path: Path) -> None:
        self.archive = tarfile.open(path, mode="r:*")

    def close(self) -> None:
        self.archive.close()

    def read(self, name: str) -> bytes:
        member = self.archive.getmember(name)
        source = self.archive.extractfile(member)
        if source is None:
            raise ArchiveError(f"missing archive member: {name}")
        return source.read()

    def json(self, name: str) -> dict[str, Any]:
        return json.loads(self.read(name))

    def blob(self, digest: str) -> bytes:
        algorithm, value = digest.split(":", 1)
        if algorithm != "sha256":
            raise ArchiveError("unsupported OCI digest algorithm")
        data = self.read(f"blobs/sha256/{value}")
        if hashlib.sha256(data).hexdigest() != value:
            raise ArchiveError(f"OCI digest mismatch: {digest}")
        return data

    def blob_json(self, digest: str) -> dict[str, Any]:
        return json.loads(self.blob(digest))


def collect_platforms(archive: OciArchive, descriptor: dict[str, Any]) -> set[str]:
    media_type = descriptor.get("mediaType", "")
    document = archive.blob_json(descriptor["digest"])
    if media_type.endswith(".image.index.v1+json") or "manifests" in document:
        platforms: set[str] = set()
        for child in document.get("manifests", []):
            platforms.update(collect_platforms(archive, child))
        return platforms
    if not (media_type.endswith(".image.manifest.v1+json") or "config" in document):
        return set()
    platform = descriptor.get("platform") or {}
    architecture = platform.get("architecture")
    operating_system = platform.get("os")
    if not architecture or not operating_system:
        config = archive.blob_json(document["config"]["digest"])
        architecture = config.get("architecture")
        operating_system = config.get("os")
    if architecture == "unknown" or operating_system == "unknown":
        return set()
    return {f"{operating_system}/{architecture}"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--require-platform", action="append", default=[])
    args = parser.parse_args()

    archive = OciArchive(args.archive)
    try:
        layout = archive.json("oci-layout")
        if layout.get("imageLayoutVersion") != "1.0.0":
            raise ArchiveError("unsupported OCI layout version")
        index = archive.json("index.json")
        platforms: set[str] = set()
        for descriptor in index.get("manifests", []):
            platforms.update(collect_platforms(archive, descriptor))
    finally:
        archive.close()

    missing = sorted(set(args.require_platform) - platforms)
    if missing:
        raise SystemExit(f"missing required OCI platforms: {', '.join(missing)}")
    print(json.dumps({"platforms": sorted(platforms), "status": "ok"}, sort_keys=True))


if __name__ == "__main__":
    main()
