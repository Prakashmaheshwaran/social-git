#!/usr/bin/env python3
"""Generate a deterministic source manifest and SPDX 2.3 SBOM."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path


EXCLUDED_DIRECTORIES = {
    ".git",
    ".secrets",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "work",
}
EXCLUDED_NAMES = {".DS_Store"}
EXCLUDED_SUFFIXES = {".log", ".sqlite", ".sqlite3", ".sqlite-shm", ".sqlite-wal"}


def source_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for directory, directory_names, file_names in os.walk(root, topdown=True):
        directory_names[:] = sorted(
            name for name in directory_names if name not in EXCLUDED_DIRECTORIES
        )
        base = Path(directory)
        for name in sorted(file_names):
            path = base / name
            relative = path.relative_to(root)
            if name in EXCLUDED_NAMES or any(name.endswith(suffix) for suffix in EXCLUDED_SUFFIXES):
                continue
            if relative.parts and relative.parts[0] == "secrets" and name != "README.md":
                continue
            if name == ".git" or path.is_symlink():
                continue
            files.append(relative)
    return sorted(files, key=lambda item: item.as_posix().encode("utf-8"))


def file_digest(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def spdx_id(relative: Path) -> str:
    digest = hashlib.sha256(relative.as_posix().encode("utf-8")).hexdigest()[:24]
    return f"SPDXRef-File-{digest}"


def generate(
    root: Path,
    output: Path,
    source_date_epoch: int,
    runtime_version: str,
    base_image: str,
) -> None:
    entries = [
        (path, file_digest(root / path, "sha256"), file_digest(root / path, "sha1"))
        for path in source_files(root)
    ]
    manifest_body = "".join(
        f"{sha256_digest}  {path.as_posix()}\n" for path, sha256_digest, _ in entries
    )
    manifest_digest = hashlib.sha256(manifest_body.encode("utf-8")).hexdigest()
    created = dt.datetime.fromtimestamp(source_date_epoch, tz=dt.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    package_id = "SPDXRef-Package-social-git-runtime"
    runtime_id = "SPDXRef-Package-python-runtime"
    files = [
        {
            "SPDXID": spdx_id(path),
            "checksums": [{"algorithm": "SHA256", "checksumValue": digest}],
            "fileName": f"./{path.as_posix()}",
        }
        for path, digest, _ in entries
    ]
    relationships = [
        {
            "relatedSpdxElement": runtime_id,
            "relationshipType": "DEPENDS_ON",
            "spdxElementId": package_id,
        }
    ]
    relationships.extend(
        {
            "relatedSpdxElement": spdx_id(path),
            "relationshipType": "CONTAINS",
            "spdxElementId": package_id,
        }
        for path, _, _ in entries
    )
    document = {
        "SPDXID": "SPDXRef-DOCUMENT",
        "creationInfo": {
            "created": created,
            "creators": ["Tool: social-git-generate-source-metadata/1"],
        },
        "dataLicense": "CC0-1.0",
        "documentDescribes": [package_id],
        "documentNamespace": f"https://social-git.invalid/spdx/source/{manifest_digest}",
        "files": files,
        "name": "social-git-runtime-source",
        "packages": [
            {
                "SPDXID": package_id,
                "checksums": [{"algorithm": "SHA256", "checksumValue": manifest_digest}],
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": True,
                "name": "social-git-runtime",
                "packageVerificationCode": {
                    "packageVerificationCodeValue": hashlib.sha1(
                        "".join(sorted(sha1_digest for _, _, sha1_digest in entries)).encode(
                            "ascii"
                        )
                    ).hexdigest()
                },
                "versionInfo": "0.1.0",
            },
            {
                "SPDXID": runtime_id,
                "downloadLocation": "NOASSERTION",
                "externalRefs": [
                    {
                        "referenceCategory": "PACKAGE-MANAGER",
                        "referenceLocator": f"pkg:docker/python@{runtime_version}",
                        "referenceType": "purl",
                    }
                ],
                "filesAnalyzed": False,
                "name": "python-runtime",
                "packageComment": f"Pinned container base: {base_image}",
                "versionInfo": runtime_version,
            },
        ],
        "relationships": relationships,
        "spdxVersion": "SPDX-2.3",
    }

    output.mkdir(mode=0o755, parents=True, exist_ok=True)
    (output / "source-manifest.sha256").write_text(manifest_body, encoding="utf-8")
    (output / "sbom.spdx.json").write_text(
        json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-date-epoch", type=int, required=True)
    parser.add_argument("--runtime-version", required=True)
    parser.add_argument("--base-image", required=True)
    args = parser.parse_args()
    if args.source_date_epoch < 0:
        parser.error("--source-date-epoch must be non-negative")
    generate(
        args.root.resolve(),
        args.output.resolve(),
        args.source_date_epoch,
        args.runtime_version,
        args.base_image,
    )


if __name__ == "__main__":
    main()
