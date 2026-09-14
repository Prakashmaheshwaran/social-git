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


def collect_platforms(
    archive: OciArchive,
    descriptor: dict[str, Any],
) -> dict[str, str]:
    media_type = descriptor.get("mediaType", "")
    document = archive.blob_json(descriptor["digest"])
    if media_type.endswith(".image.index.v1+json") or "manifests" in document:
        platforms: dict[str, str] = {}
        for child in document.get("manifests", []):
            for platform, digest in collect_platforms(archive, child).items():
                if platform in platforms:
                    raise ArchiveError(f"duplicate OCI platform: {platform}")
                platforms[platform] = digest
        return platforms
    if not (media_type.endswith(".image.manifest.v1+json") or "config" in document):
        return {}
    platform = descriptor.get("platform") or {}
    architecture = platform.get("architecture")
    operating_system = platform.get("os")
    if not architecture or not operating_system:
        config = archive.blob_json(document["config"]["digest"])
        architecture = config.get("architecture")
        operating_system = config.get("os")
    if architecture == "unknown" or operating_system == "unknown":
        return {}
    return {f"{operating_system}/{architecture}": descriptor["digest"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--require-platform", action="append", default=[])
    parser.add_argument("--expect-release-digest")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    archive = OciArchive(args.archive)
    try:
        layout = archive.json("oci-layout")
        if layout.get("imageLayoutVersion") != "1.0.0":
            raise ArchiveError("unsupported OCI layout version")
        index_body = archive.read("index.json")
        index = json.loads(index_body)
        roots = index.get("manifests", [])
        if len(roots) != 1 or not isinstance(roots[0], dict):
            raise ArchiveError("OCI archive must contain one immutable release index")
        root = roots[0]
        release_digest = root.get("digest")
        if not isinstance(release_digest, str):
            raise ArchiveError("release index descriptor has no digest")
        platforms = collect_platforms(archive, root)
    finally:
        archive.close()

    missing = sorted(set(args.require_platform) - set(platforms))
    if missing:
        raise SystemExit(f"missing required OCI platforms: {', '.join(missing)}")
    if args.expect_release_digest and release_digest != args.expect_release_digest:
        raise SystemExit(
            "release digest mismatch: "
            f"expected {args.expect_release_digest}, observed {release_digest}"
        )

    result = {
        "indexJsonDigest": f"sha256:{hashlib.sha256(index_body).hexdigest()}",
        "platformManifests": dict(sorted(platforms.items())),
        "refName": root.get("annotations", {}).get("org.opencontainers.image.ref.name"),
        "releaseDigest": release_digest,
        "status": "ok",
    }
    body = json.dumps(result, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body + "\n", encoding="utf-8")
    print(body)


if __name__ == "__main__":
    main()
