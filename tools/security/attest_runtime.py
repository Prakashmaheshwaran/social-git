#!/usr/bin/env python3
"""Attest a multi-platform Social Git OCI runtime without executing it.

The tool reads the final OCI layers directly, inventories installed Debian and
Python components, enforces the browser-free/non-root image policy, compares
the two architecture closures, checks the committed dependency review, and
emits one digest-bound SPDX document per platform.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import os
import posixpath
import re
import tarfile
import urllib.parse
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


REQUIRED_PLATFORMS = ("linux/amd64", "linux/arm64")
ATTESTATION_SCHEMA = "social-git-runtime-attestation/v1"
REVIEW_SCHEMA = "social-git-runtime-dependency-review/v1"
TOOL_NAME = "social-git-runtime-attestor"
MAX_RETAINED_FILE_SIZE = 2 * 1024 * 1024

FORBIDDEN_COMPONENT_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(^|[-_.])chrom(e|ium)([-_.]|$)",
        r"chromedriver",
        r"chrome-remote-interface",
        r"(^|[-_.])cypress([-_.]|$)",
        r"firefox",
        r"geckodriver",
        r"msedgedriver",
        r"phantomjs",
        r"playwright",
        r"puppeteer",
        r"pyppeteer",
        r"selenium",
        r"webdriver",
        r"xvfb",
        r"(^|[-_.])asyncpraw([-_.]|$)",
        r"(^|[-_.])praw(core)?([-_.]|$)",
        r"go-reddit",
        r"(^|[-_.])jraw([-_.]|$)",
        r"reddit-api-client",
        r"redditwarp",
        r"snoowrap",
    )
)

FORBIDDEN_EXECUTABLES = frozenset(
    {
        "chrome",
        "chrome-sandbox",
        "chromedriver",
        "chromium",
        "chromium-browser",
        "firefox",
        "firefox-esr",
        "geckodriver",
        "google-chrome",
        "google-chrome-stable",
        "headless_shell",
        "msedgedriver",
        "phantomjs",
        "playwright",
        "selenium",
        "xvfb",
        "xvfb-run",
    }
)

FORBIDDEN_CONFIG_MARKERS = (
    b"reddit_client_id",
    b"reddit_client_secret",
    b"reddit_api_key",
    b"praw_client_id",
    b"praw_client_secret",
    b"oauth.reddit.com",
    b"reddit.com/api/v1/access_token",
    b"chrome-remote-interface",
    b"--remote-debugging-port",
    b"devtools://",
)

FORBIDDEN_RUNTIME_TOOL = re.compile(
    r"^(?:apt(?:-.+)?|dpkg(?:-.+)?|pip(?:3(?:\.\d+)?)?|cc|c\+\+|g\+\+|gcc(?:-\d+)?|clang(?:-\d+)?|make)$",
    re.IGNORECASE,
)

INSTALL_SCRIPT_SUFFIXES = (
    ".config",
    ".postinst",
    ".postrm",
    ".preinst",
    ".prerm",
    ".triggers",
)


class AttestationError(RuntimeError):
    """Raised when an image cannot be safely attested."""


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_json(value: object) -> str:
    return f"sha256:{sha256_bytes(canonical_json(value))}"


def normalize_layer_path(raw: str) -> str:
    candidate = raw
    while candidate.startswith("./"):
        candidate = candidate[2:]
    if candidate.startswith("/"):
        raise AttestationError(f"absolute path in OCI layer: {raw!r}")
    path = PurePosixPath(candidate)
    if not candidate or candidate == "." or ".." in path.parts:
        raise AttestationError(f"unsafe path in OCI layer: {raw!r}")
    return str(path)


@dataclass(frozen=True)
class FileEntry:
    kind: str
    mode: int
    size: int = 0
    sha256: str | None = None
    data: bytes | None = None
    link_target: str | None = None


class LayeredFilesystem:
    """Minimal in-memory metadata view of a final OCI filesystem."""

    def __init__(self) -> None:
        self.entries: dict[str, FileEntry] = {}

    @staticmethod
    def _retain(path: str, size: int) -> bool:
        if size > MAX_RETAINED_FILE_SIZE:
            return False
        if path == "var/lib/dpkg/status":
            return True
        if path.startswith("var/lib/dpkg/info/") and (
            path.endswith(".list") or path.endswith(INSTALL_SCRIPT_SUFFIXES)
        ):
            return True
        if path.startswith("usr/share/doc/") and path.endswith("/copyright"):
            return True
        if path.endswith((".dist-info/METADATA", ".dist-info/RECORD")):
            return True
        if path.endswith(".dist-info/entry_points.txt"):
            return True
        if path in {
            "usr/local/include/python3.13/patchlevel.h",
            "usr/local/lib/python3.13/LICENSE.txt",
        }:
            return True
        return path.startswith("opt/social-git/")

    def apply(self, layer: bytes) -> None:
        whiteouts: list[tuple[str, str]] = []
        additions: dict[str, FileEntry] = {}
        try:
            archive = tarfile.open(fileobj=io.BytesIO(layer), mode="r:")
        except tarfile.TarError as exc:
            raise AttestationError(f"invalid OCI layer tar: {exc}") from exc

        with archive:
            for member in archive:
                if member.name in {"", ".", "./"}:
                    continue
                path = normalize_layer_path(member.name)
                base = posixpath.basename(path)
                parent = posixpath.dirname(path)
                if base == ".wh..wh..opq":
                    whiteouts.append(("opaque", parent))
                    continue
                if base.startswith(".wh."):
                    whiteouts.append(("remove", posixpath.join(parent, base[4:])))
                    continue

                if member.isfile():
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise AttestationError(f"unreadable file in OCI layer: {path}")
                    body = stream.read()
                    additions[path] = FileEntry(
                        kind="file",
                        mode=member.mode,
                        size=len(body),
                        sha256=sha256_bytes(body),
                        data=body if self._retain(path, len(body)) else None,
                    )
                elif member.isdir():
                    additions[path] = FileEntry(kind="directory", mode=member.mode)
                elif member.issym():
                    additions[path] = FileEntry(
                        kind="symlink", mode=member.mode, link_target=member.linkname
                    )
                elif member.islnk():
                    additions[path] = FileEntry(
                        kind="hardlink", mode=member.mode, link_target=member.linkname
                    )
                else:
                    additions[path] = FileEntry(kind="special", mode=member.mode)

        for operation, target in whiteouts:
            prefix = f"{target}/" if target else ""
            if operation == "opaque":
                self.entries = {
                    path: entry
                    for path, entry in self.entries.items()
                    if not path.startswith(prefix)
                }
            else:
                self.entries = {
                    path: entry
                    for path, entry in self.entries.items()
                    if path != target and not path.startswith(prefix)
                }
        self.entries.update(additions)

    def _link_destination(self, path: str, target: str) -> str:
        if target.startswith("/"):
            candidate = posixpath.normpath(target.lstrip("/"))
        else:
            candidate = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
        if candidate == ".." or candidate.startswith("../"):
            raise AttestationError(f"unsafe link target in final image: {path} -> {target}")
        return candidate

    def resolve(self, path: str) -> tuple[str, FileEntry]:
        current = posixpath.normpath(path.lstrip("/"))
        for _ in range(32):
            parts = current.split("/")
            replaced_prefix = False
            for position in range(1, len(parts)):
                prefix = "/".join(parts[:position])
                prefix_entry = self.entries.get(prefix)
                if prefix_entry is None or prefix_entry.kind != "symlink":
                    continue
                if prefix_entry.link_target is None:
                    raise AttestationError(f"link without target in final image: /{prefix}")
                destination = self._link_destination(prefix, prefix_entry.link_target)
                current = posixpath.join(destination, *parts[position:])
                replaced_prefix = True
                break
            if replaced_prefix:
                continue
            entry = self.entries.get(current)
            if entry is None:
                raise AttestationError(f"missing final-image path: /{current}")
            if entry.kind not in {"symlink", "hardlink"}:
                return current, entry
            if entry.link_target is None:
                raise AttestationError(f"link without target in final image: /{current}")
            current = self._link_destination(current, entry.link_target)
        raise AttestationError(f"link cycle in final image: /{path.lstrip('/')}")

    def read(self, path: str) -> bytes:
        resolved, entry = self.resolve(path)
        if entry.kind != "file" or entry.data is None:
            raise AttestationError(f"final-image file was not retained: /{resolved}")
        return entry.data

    def fingerprint(self, path: str) -> str:
        normalized = posixpath.normpath(path.lstrip("/"))
        entry = self.entries.get(normalized)
        if entry is None:
            return f"{normalized}\0missing"
        if entry.kind in {"symlink", "hardlink"}:
            return (
                f"{normalized}\0{entry.kind}\0{entry.mode:o}\0"
                f"{entry.link_target or ''}"
            )
        return (
            f"{normalized}\0{entry.kind}\0{entry.mode:o}\0{entry.size}\0"
            f"{entry.sha256 or ''}"
        )

    def content_digest(self, paths: Iterable[str]) -> str:
        digest = hashlib.sha256()
        for path in sorted(set(paths), key=lambda value: value.encode("utf-8")):
            digest.update(self.fingerprint(path).encode("utf-8"))
            digest.update(b"\n")
        return digest.hexdigest()


class OciArchive:
    def __init__(self, path: Path) -> None:
        self.path = path
        try:
            self.archive = tarfile.open(path, mode="r:*")
        except (OSError, tarfile.TarError) as exc:
            raise AttestationError(f"cannot open OCI archive {path}: {exc}") from exc

    def close(self) -> None:
        self.archive.close()

    def read(self, name: str) -> bytes:
        try:
            member = self.archive.getmember(name)
        except KeyError as exc:
            raise AttestationError(f"missing OCI archive member: {name}") from exc
        stream = self.archive.extractfile(member)
        if stream is None:
            raise AttestationError(f"unreadable OCI archive member: {name}")
        return stream.read()

    def json(self, name: str) -> dict[str, Any]:
        try:
            value = json.loads(self.read(name))
        except json.JSONDecodeError as exc:
            raise AttestationError(f"invalid JSON in OCI archive member {name}: {exc}") from exc
        if not isinstance(value, dict):
            raise AttestationError(f"OCI JSON member is not an object: {name}")
        return value

    def blob(self, descriptor: dict[str, Any]) -> bytes:
        digest = descriptor.get("digest")
        size = descriptor.get("size")
        if not isinstance(digest, str) or not digest.startswith("sha256:"):
            raise AttestationError("OCI descriptor does not use a sha256 digest")
        value = digest.removeprefix("sha256:")
        body = self.read(f"blobs/sha256/{value}")
        if sha256_bytes(body) != value:
            raise AttestationError(f"OCI blob digest mismatch: {digest}")
        if not isinstance(size, int) or len(body) != size:
            raise AttestationError(f"OCI blob size mismatch: {digest}")
        return body

    def blob_json(self, descriptor: dict[str, Any]) -> dict[str, Any]:
        try:
            value = json.loads(self.blob(descriptor))
        except json.JSONDecodeError as exc:
            raise AttestationError(
                f"invalid OCI JSON blob {descriptor.get('digest')}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise AttestationError(f"OCI JSON blob is not an object: {descriptor.get('digest')}")
        return value


@dataclass(frozen=True)
class ImageRecord:
    platform: str
    release_digest: str
    manifest_digest: str
    config_digest: str
    layer_digests: tuple[str, ...]
    config: dict[str, Any]
    filesystem: LayeredFilesystem


def _decompress_layer(media_type: str, body: bytes) -> bytes:
    if media_type.endswith("+gzip"):
        try:
            return gzip.decompress(body)
        except OSError as exc:
            raise AttestationError(f"invalid gzip OCI layer: {exc}") from exc
    if media_type.endswith("+zstd"):
        raise AttestationError("zstd OCI layers are unsupported by the dependency-free attestor")
    if media_type.endswith(".tar") or media_type.endswith(".tar.nondistributable.v1"):
        return body
    raise AttestationError(f"unsupported OCI layer media type: {media_type}")


def _collect_image_descriptors(
    archive: OciArchive, descriptor: dict[str, Any], result: list[dict[str, Any]]
) -> None:
    document = archive.blob_json(descriptor)
    if isinstance(document.get("manifests"), list):
        for child in document["manifests"]:
            if not isinstance(child, dict):
                raise AttestationError("non-object descriptor in OCI image index")
            _collect_image_descriptors(archive, child, result)
        return
    if not isinstance(document.get("config"), dict) or not isinstance(
        document.get("layers"), list
    ):
        raise AttestationError(f"unknown OCI leaf object: {descriptor.get('digest')}")
    result.append(descriptor)


def inspect_oci(path: Path) -> dict[str, ImageRecord]:
    archive = OciArchive(path)
    try:
        layout = archive.json("oci-layout")
        if layout.get("imageLayoutVersion") != "1.0.0":
            raise AttestationError("unsupported OCI image layout version")
        index = archive.json("index.json")
        roots = index.get("manifests")
        if not isinstance(roots, list) or len(roots) != 1 or not isinstance(roots[0], dict):
            raise AttestationError("OCI archive must contain one immutable release index")
        root_descriptor = roots[0]
        release_digest = root_descriptor.get("digest")
        if not isinstance(release_digest, str):
            raise AttestationError("release index descriptor has no digest")

        leaves: list[dict[str, Any]] = []
        _collect_image_descriptors(archive, root_descriptor, leaves)
        images: dict[str, ImageRecord] = {}
        for descriptor in leaves:
            manifest = archive.blob_json(descriptor)
            config_descriptor = manifest["config"]
            config = archive.blob_json(config_descriptor)
            platform_data = descriptor.get("platform")
            if not isinstance(platform_data, dict):
                platform_data = {}
            operating_system = platform_data.get("os") or config.get("os")
            architecture = platform_data.get("architecture") or config.get("architecture")
            if not isinstance(operating_system, str) or not isinstance(architecture, str):
                raise AttestationError("OCI image has no operating system or architecture")
            if operating_system == "unknown" or architecture == "unknown":
                raise AttestationError("OCI image has an unknown platform")
            platform = f"{operating_system}/{architecture}"
            if platform in images:
                raise AttestationError(f"duplicate OCI image platform: {platform}")

            rootfs = config.get("rootfs", {})
            diff_ids = rootfs.get("diff_ids", []) if isinstance(rootfs, dict) else []
            layers = manifest["layers"]
            if not isinstance(diff_ids, list) or len(diff_ids) != len(layers):
                raise AttestationError(f"layer/diff-id mismatch for {platform}")
            filesystem = LayeredFilesystem()
            layer_digests: list[str] = []
            for position, layer_descriptor in enumerate(layers):
                if not isinstance(layer_descriptor, dict):
                    raise AttestationError(f"invalid layer descriptor for {platform}")
                compressed = archive.blob(layer_descriptor)
                uncompressed = _decompress_layer(
                    str(layer_descriptor.get("mediaType", "")), compressed
                )
                expected_diff_id = diff_ids[position]
                actual_diff_id = f"sha256:{sha256_bytes(uncompressed)}"
                if expected_diff_id != actual_diff_id:
                    raise AttestationError(
                        f"uncompressed layer digest mismatch for {platform}: {expected_diff_id}"
                    )
                filesystem.apply(uncompressed)
                layer_digests.append(str(layer_descriptor["digest"]))

            images[platform] = ImageRecord(
                platform=platform,
                release_digest=release_digest,
                manifest_digest=str(descriptor["digest"]),
                config_digest=str(config_descriptor["digest"]),
                layer_digests=tuple(layer_digests),
                config=config,
                filesystem=filesystem,
            )
    finally:
        archive.close()

    if set(images) != set(REQUIRED_PLATFORMS):
        raise AttestationError(
            "runtime index platforms differ from required set: "
            f"found {', '.join(sorted(images)) or 'none'}"
        )
    return images


def parse_debian_status(body: bytes) -> list[dict[str, str]]:
    packages: list[dict[str, str]] = []
    for paragraph in body.decode("utf-8", errors="replace").split("\n\n"):
        fields: dict[str, str] = {}
        current: str | None = None
        for line in paragraph.splitlines():
            if line[:1].isspace() and current is not None:
                fields[current] = f"{fields[current]}\n{line[1:]}"
                continue
            if ":" not in line:
                current = None
                continue
            current, value = line.split(":", 1)
            fields[current] = value.lstrip()
        if fields.get("Status") == "install ok installed":
            required = ("Package", "Version", "Architecture")
            if not all(fields.get(field) for field in required):
                raise AttestationError("installed Debian package has incomplete metadata")
            packages.append(fields)
    return sorted(packages, key=lambda item: item["Package"].encode("utf-8"))


def _debian_source(package: dict[str, str]) -> dict[str, str]:
    raw_source = package.get("Source", "").strip()
    match = re.fullmatch(r"([^ ]+)(?: \(([^)]+)\))?", raw_source) if raw_source else None
    source_name = match.group(1) if match else package["Package"]
    source_version = match.group(2) if match and match.group(2) else package["Version"]
    source_version = re.sub(r"\+b\d+$", "", source_version)
    locator = (
        "https://snapshot.debian.org/package/"
        f"{urllib.parse.quote(source_name, safe='')}/"
        f"{urllib.parse.quote(source_version, safe='')}/"
    )
    return {"name": source_name, "version": source_version, "locator": locator}


def _copyright_markers(body: bytes) -> list[str]:
    markers: set[str] = set()
    for line in body.decode("utf-8", errors="replace").splitlines():
        if line.startswith("License:"):
            value = line.split(":", 1)[1].strip()
            if value:
                markers.add(value)
    return sorted(markers, key=lambda value: value.encode("utf-8")) or [
        "legacy-debian-copyright-format"
    ]


def _package_info_file(
    filesystem: LayeredFilesystem, package: str, architecture: str, suffix: str
) -> str | None:
    candidates = (
        f"var/lib/dpkg/info/{package}.{suffix}",
        f"var/lib/dpkg/info/{package}:{architecture}.{suffix}",
    )
    return next((path for path in candidates if path in filesystem.entries), None)


def inventory_debian(image: ImageRecord) -> list[dict[str, Any]]:
    filesystem = image.filesystem
    packages = parse_debian_status(filesystem.read("var/lib/dpkg/status"))
    result: list[dict[str, Any]] = []
    for package in packages:
        name = package["Package"]
        architecture = package["Architecture"]
        list_path = _package_info_file(filesystem, name, architecture, "list")
        if list_path is None:
            raise AttestationError(f"installed Debian package has no file list: {name}")
        installed_paths = [
            line.strip()
            for line in filesystem.read(list_path).decode("utf-8", errors="replace").splitlines()
            if line.strip() and line.strip() != "/."
        ]
        copyright_path = f"usr/share/doc/{name}/copyright"
        copyright_body = filesystem.read(copyright_path)
        install_scripts = []
        for suffix in INSTALL_SCRIPT_SUFFIXES:
            script_path = _package_info_file(filesystem, name, architecture, suffix[1:])
            if script_path is not None:
                script_body = filesystem.read(script_path)
                normalized_name = re.sub(
                    rf":(?:amd64|arm64)(?=\.{re.escape(suffix[1:])}$)",
                    "",
                    posixpath.basename(script_path),
                )
                install_scripts.append(
                    {"name": normalized_name, "sha256": sha256_bytes(script_body)}
                )
        result.append(
            {
                "architecture": architecture,
                "contentSha256": filesystem.content_digest(installed_paths),
                "ecosystem": "deb",
                "installScripts": sorted(install_scripts, key=lambda item: item["name"]),
                "key": f"deb:{name}",
                "licenseEvidence": {
                    "markers": _copyright_markers(copyright_body),
                    "path": f"/{copyright_path}",
                    "sha256": sha256_bytes(copyright_body),
                },
                "name": name,
                "source": _debian_source(package),
                "version": package["Version"],
            }
        )
    return result


def _metadata_fields(body: bytes) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for line in body.decode("utf-8", errors="replace").splitlines():
        if ":" in line and not line[:1].isspace():
            name, value = line.split(":", 1)
            result.setdefault(name, []).append(value.lstrip())
    return result


def _record_paths(metadata_path: str, body: bytes) -> list[str]:
    site_packages = posixpath.dirname(posixpath.dirname(metadata_path))
    paths: list[str] = []
    reader = csv.reader(io.StringIO(body.decode("utf-8", errors="replace")))
    for row in reader:
        if not row:
            continue
        normalized = posixpath.normpath(posixpath.join(site_packages, row[0]))
        if normalized == ".." or normalized.startswith("../"):
            raise AttestationError(f"unsafe Python RECORD path: {row[0]!r}")
        paths.append(normalized)
    return paths


def inventory_python(image: ImageRecord) -> list[dict[str, Any]]:
    filesystem = image.filesystem
    result: list[dict[str, Any]] = []
    owned_python_paths: set[str] = set()
    metadata_paths = sorted(
        path for path in filesystem.entries if path.endswith(".dist-info/METADATA")
    )
    for metadata_path in metadata_paths:
        metadata = _metadata_fields(filesystem.read(metadata_path))
        name = (metadata.get("Name") or [""])[0]
        version = (metadata.get("Version") or [""])[0]
        if not name or not version:
            raise AttestationError(f"Python distribution has incomplete metadata: /{metadata_path}")
        record_path = f"{posixpath.dirname(metadata_path)}/RECORD"
        if record_path not in filesystem.entries:
            raise AttestationError(f"Python distribution has no RECORD: {name}=={version}")
        paths = _record_paths(metadata_path, filesystem.read(record_path))
        owned_python_paths.update(paths)
        source_urls = []
        for value in metadata.get("Project-URL", []):
            if "," in value:
                label, url = value.split(",", 1)
                if label.strip().casefold() in {"homepage", "repository", "source"}:
                    source_urls.append(url.strip())
        source_url = (
            sorted(set(source_urls))[0]
            if source_urls
            else (metadata.get("Home-page") or [f"https://pypi.org/project/{name}/{version}/"])[0]
        )
        license_markers = metadata.get("License-Expression") or metadata.get("License") or [
            "NOASSERTION"
        ]
        install_scripts = []
        entry_points_path = f"{posixpath.dirname(metadata_path)}/entry_points.txt"
        if entry_points_path in filesystem.entries:
            install_scripts.append(
                {
                    "name": posixpath.basename(entry_points_path),
                    "sha256": sha256_bytes(filesystem.read(entry_points_path)),
                }
            )
        result.append(
            {
                "architecture": image.platform.split("/", 1)[1],
                "contentSha256": filesystem.content_digest(paths),
                "ecosystem": "pypi",
                "installScripts": install_scripts,
                "key": f"pypi:{name.casefold().replace('_', '-')}",
                "licenseEvidence": {
                    "markers": sorted(set(license_markers)),
                    "path": f"/{metadata_path}",
                    "sha256": sha256_bytes(filesystem.read(metadata_path)),
                },
                "name": name,
                "source": {"name": name, "version": version, "locator": source_url},
                "version": version,
            }
        )

    patchlevel_path = "usr/local/include/python3.13/patchlevel.h"
    patchlevel = filesystem.read(patchlevel_path).decode("utf-8", errors="replace")
    match = re.search(r'^#define\s+PY_VERSION\s+"([^"]+)"', patchlevel, re.MULTILINE)
    if match is None:
        raise AttestationError("cannot determine Python runtime version")
    python_version = match.group(1)
    license_path = "usr/local/lib/python3.13/LICENSE.txt"
    license_body = filesystem.read(license_path)
    runtime_paths = [
        path
        for path in filesystem.entries
        if path.startswith("usr/local/") and path not in owned_python_paths
    ]
    result.append(
        {
            "architecture": image.platform.split("/", 1)[1],
            "contentSha256": filesystem.content_digest(runtime_paths),
            "ecosystem": "python-runtime",
            "installScripts": [],
            "key": "python-runtime:cpython",
            "licenseEvidence": {
                "markers": ["PSF-2.0"],
                "path": f"/{license_path}",
                "sha256": sha256_bytes(license_body),
            },
            "name": "CPython",
            "source": {
                "name": "cpython",
                "version": python_version,
                "locator": f"https://github.com/python/cpython/tree/v{python_version}",
            },
            "version": python_version,
        }
    )
    return sorted(result, key=lambda item: item["key"])


def image_policy_checks(image: ImageRecord, components: list[dict[str, Any]]) -> dict[str, list[str]]:
    filesystem = image.filesystem
    config_section = image.config.get("config", {})
    if not isinstance(config_section, dict):
        config_section = {}
    user = config_section.get("User")
    environment = config_section.get("Env", [])
    environment_names = {
        value.split("=", 1)[0].casefold()
        for value in environment
        if isinstance(value, str) and "=" in value
    }
    forbidden_names = {
        marker.decode("ascii") for marker in FORBIDDEN_CONFIG_MARKERS[:5]
    }
    executable_hits = sorted(
        f"/{path}"
        for path, entry in filesystem.entries.items()
        if posixpath.basename(path).casefold() in FORBIDDEN_EXECUTABLES
        and (entry.kind in {"symlink", "hardlink"} or entry.mode & 0o111)
    )
    runtime_tooling_hits = sorted(
        f"/{path}"
        for path, entry in filesystem.entries.items()
        if (
            (
                FORBIDDEN_RUNTIME_TOOL.fullmatch(posixpath.basename(path))
                and entry.kind in {"file", "symlink", "hardlink"}
                and (entry.kind in {"symlink", "hardlink"} or entry.mode & 0o111)
            )
            or "/ensurepip" in f"/{path}"
            or "/site-packages/pip/" in f"/{path}"
            or "/site-packages/pip-" in f"/{path}"
        )
    )
    component_hits = sorted(
        f"{component['ecosystem']}:{component['name']}@{component['version']}"
        for component in components
        if any(pattern.search(str(component["name"])) for pattern in FORBIDDEN_COMPONENT_PATTERNS)
    )
    config_hits: set[str] = set(environment_names & forbidden_names)
    install_script_hits: set[str] = set()
    install_script_forbidden_hits: set[str] = set()
    for path, entry in filesystem.entries.items():
        if path.startswith("var/lib/dpkg/info/") and path.endswith(INSTALL_SCRIPT_SUFFIXES):
            body = filesystem.read(path).decode("utf-8", errors="replace")
            executable_lines = "\n".join(
                line for line in body.splitlines() if not line.lstrip().startswith("#")
            )
            if re.search(
                r"(^|[;|&\s])(?:curl|wget|ftp|nc|npm|pip|apt-get)(?:[;|&\s]|$)",
                executable_lines,
                re.IGNORECASE,
            ):
                install_script_hits.add(f"/{path}")
            if any(marker in body.casefold() for marker in (
                "asyncpraw",
                "playwright",
                "puppeteer",
                "selenium",
                "chromium",
                "chromedriver",
                "chrome-remote-interface",
                "firefox",
                "geckodriver",
                "oauth.reddit.com",
                "praw",
                "reddit.com/api/v1/access_token",
                "redditwarp",
                "snoowrap",
                "webdriver",
            )):
                install_script_forbidden_hits.add(f"/{path}")
        if not path.startswith("opt/social-git/") or entry.kind != "file" or entry.data is None:
            continue
        lowered = entry.data.lower()
        for marker in FORBIDDEN_CONFIG_MARKERS:
            if marker in lowered:
                config_hits.add(f"/{path}:{marker.decode('ascii')}")
    return {
        "forbiddenApplicationConfig": sorted(config_hits),
        "forbiddenComponents": component_hits,
        "forbiddenExecutables": executable_hits,
        "forbiddenInstallScriptContent": sorted(install_script_forbidden_hits),
        "installScriptNetworkCommands": sorted(install_script_hits),
        "unexpectedUser": [] if str(user) == "10001:10001" else [str(user)],
        "unexpectedRuntimeTooling": runtime_tooling_hits,
    }


def inspect_components(image: ImageRecord) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    components = inventory_debian(image) + inventory_python(image)
    components = sorted(components, key=lambda item: item["key"])
    duplicate_keys = sorted(
        key
        for key in {component["key"] for component in components}
        if sum(component["key"] == key for component in components) > 1
    )
    if duplicate_keys:
        raise AttestationError(f"duplicate runtime component keys: {', '.join(duplicate_keys)}")
    checks = image_policy_checks(image, components)
    failures = {name: values for name, values in checks.items() if values}
    if failures:
        raise AttestationError(
            f"final-image policy failed for {image.platform}: "
            f"{json.dumps(failures, sort_keys=True)}"
        )
    return components, checks


def _component_common(component: dict[str, Any]) -> dict[str, Any]:
    return {
        key: component[key]
        for key in (
            "ecosystem",
            "key",
            "licenseEvidence",
            "name",
            "source",
            "version",
        )
    }


def merge_review_components(
    inventories: dict[str, list[dict[str, Any]]]
) -> list[dict[str, Any]]:
    platforms = sorted(inventories)
    keyed = {
        platform: {component["key"]: component for component in components}
        for platform, components in inventories.items()
    }
    key_sets = {platform: set(components) for platform, components in keyed.items()}
    first_keys = key_sets[platforms[0]]
    for platform in platforms[1:]:
        if key_sets[platform] != first_keys:
            raise AttestationError(
                f"architecture-specific dependency drift: {platform} component keys differ"
            )

    merged: list[dict[str, Any]] = []
    for key in sorted(first_keys):
        first = keyed[platforms[0]][key]
        common = _component_common(first)
        for platform in platforms[1:]:
            candidate = _component_common(keyed[platform][key])
            if candidate != common:
                raise AttestationError(
                    f"architecture-specific dependency drift for {key}: "
                    "version, source, or license evidence differs"
                )
        common["artifacts"] = {
            platform: {
                "architecture": keyed[platform][key]["architecture"],
                "contentSha256": keyed[platform][key]["contentSha256"],
                "installScripts": keyed[platform][key]["installScripts"],
            }
            for platform in platforms
        }
        merged.append(common)
    return merged


def base_image_reference(image: ImageRecord) -> str:
    config = image.config.get("config", {})
    labels = config.get("Labels", {}) if isinstance(config, dict) else {}
    reference = labels.get("com.social-git.base-image") if isinstance(labels, dict) else None
    if not isinstance(reference, str) or not re.search(r"@sha256:[0-9a-f]{64}$", reference):
        raise AttestationError("final image does not record a pinned base-image digest")
    return reference


def build_review_candidate(
    images: dict[str, ImageRecord], inventories: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    references = {base_image_reference(image) for image in images.values()}
    if len(references) != 1:
        raise AttestationError("architecture-specific base-image reference drift")
    reference = references.pop()
    components = merge_review_components(inventories)
    return {
        "baseImage": {
            "indexDigest": reference.rsplit("@", 1)[1],
            "reference": reference,
            "source": "https://github.com/docker-library/python",
        },
        "closureSha256": digest_json(components),
        "components": components,
        "review": {
            "decision": "pending",
            "installScriptReview": "pending",
            "licenseReview": "pending",
            "reviewedAt": None,
            "reviewerRole": None,
            "sourceReview": "pending",
        },
        "schema": REVIEW_SCHEMA,
    }


def load_review(path: Path) -> dict[str, Any]:
    try:
        review = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AttestationError(f"cannot read dependency review {path}: {exc}") from exc
    if not isinstance(review, dict) or review.get("schema") != REVIEW_SCHEMA:
        raise AttestationError("unsupported runtime dependency review schema")
    decision = review.get("review")
    if not isinstance(decision, dict) or decision.get("decision") != "approved":
        raise AttestationError("runtime dependency review is not approved")
    for field in ("sourceReview", "licenseReview", "installScriptReview"):
        if not isinstance(decision.get(field), str) or decision[field] in {"", "pending"}:
            raise AttestationError(f"runtime dependency review has no {field}")
    components = review.get("components")
    if not isinstance(components, list) or not components:
        raise AttestationError("runtime dependency review has no components")
    if review.get("closureSha256") != digest_json(components):
        raise AttestationError("runtime dependency review closure digest mismatch")
    return review


def verify_review(
    review: dict[str, Any], images: dict[str, ImageRecord], inventories: dict[str, list[dict[str, Any]]]
) -> list[dict[str, Any]]:
    current = merge_review_components(inventories)
    if current != review["components"]:
        expected = {component["key"]: component for component in review["components"]}
        found = {component["key"]: component for component in current}
        unknown = sorted(set(found) - set(expected))
        missing = sorted(set(expected) - set(found))
        changed = sorted(
            key for key in set(found) & set(expected) if found[key] != expected[key]
        )
        raise AttestationError(
            "runtime dependency closure is not the reviewed closure: "
            f"unknown={unknown}, missing={missing}, changed={changed}"
        )
    references = {base_image_reference(image) for image in images.values()}
    expected_reference = review.get("baseImage", {}).get("reference")
    if references != {expected_reference}:
        raise AttestationError("runtime base image is not the reviewed pinned base image")
    return current


def _package_comment(component: dict[str, Any], platform: str) -> str:
    return json.dumps(
        {
            "contentSha256": component["contentSha256"],
            "installScripts": component["installScripts"],
            "licenseEvidence": component["licenseEvidence"],
            "reviewKey": component["key"],
            "source": component["source"],
            "platform": platform,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def make_spdx(
    image: ImageRecord,
    components: list[dict[str, Any]],
    review: dict[str, Any],
) -> dict[str, Any]:
    platform_slug = image.platform.replace("/", "-")
    root_id = f"SPDXRef-Package-social-git-runtime-{platform_slug}"
    created = "1970-01-01T00:00:00Z"
    config = image.config.get("config", {})
    labels = config.get("Labels", {}) if isinstance(config, dict) else {}
    if isinstance(labels, dict):
        candidate = labels.get("org.opencontainers.image.created")
        if isinstance(candidate, str) and re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", candidate
        ):
            created = candidate
    attestation = {
        "baseImage": review["baseImage"]["reference"],
        "closureSha256": review["closureSha256"],
        "configDigest": image.config_digest,
        "imageDigest": image.manifest_digest,
        "layerDigests": list(image.layer_digests),
        "platform": image.platform,
        "releaseDigest": image.release_digest,
        "reviewSchema": review["schema"],
        "schema": ATTESTATION_SCHEMA,
    }
    packages: list[dict[str, Any]] = [
        {
            "SPDXID": root_id,
            "checksums": [
                {
                    "algorithm": "SHA256",
                    "checksumValue": image.manifest_digest.removeprefix("sha256:"),
                }
            ],
            "downloadLocation": "NOASSERTION",
            "externalRefs": [
                {
                    "referenceCategory": "OTHER",
                    "referenceLocator": image.manifest_digest,
                    "referenceType": "oci-manifest-digest",
                }
            ],
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION",
            "name": "social-git-runtime",
            "primaryPackagePurpose": "APPLICATION",
            "supplier": "Organization: Social Git",
            "versionInfo": "0.1.0",
        }
    ]
    relationships = []
    for position, component in enumerate(components, start=1):
        component_id = f"SPDXRef-Package-{position:03d}-{sha256_bytes(component['key'].encode())[:12]}"
        packages.append(
            {
                "SPDXID": component_id,
                "checksums": [
                    {"algorithm": "SHA256", "checksumValue": component["contentSha256"]}
                ],
                "comment": _package_comment(component, image.platform),
                "downloadLocation": component["source"]["locator"],
                "externalRefs": [
                    {
                        "referenceCategory": "PACKAGE-MANAGER",
                        "referenceLocator": (
                            f"pkg:{component['ecosystem']}/"
                            f"{urllib.parse.quote(component['name'], safe='')}@"
                            f"{urllib.parse.quote(component['version'], safe='')}"
                        ),
                        "referenceType": "purl",
                    }
                ],
                "filesAnalyzed": False,
                "licenseComments": (
                    "Reviewed license evidence: "
                    f"{component['licenseEvidence']['path']} "
                    f"sha256:{component['licenseEvidence']['sha256']}"
                ),
                "licenseConcluded": "NOASSERTION",
                "licenseDeclared": "NOASSERTION",
                "name": component["name"],
                "primaryPackagePurpose": "LIBRARY",
                "sourceInfo": (
                    f"Reviewed source {component['source']['name']}@"
                    f"{component['source']['version']}"
                ),
                "supplier": (
                    "Organization: Debian Project"
                    if component["ecosystem"] == "deb"
                    else "NOASSERTION"
                ),
                "versionInfo": component["version"],
            }
        )
        relationships.append(
            {
                "relatedSpdxElement": component_id,
                "relationshipType": "CONTAINS",
                "spdxElementId": root_id,
            }
        )
    return {
        "SPDXID": "SPDXRef-DOCUMENT",
        "creationInfo": {
            "created": created,
            "creators": [f"Tool: {TOOL_NAME}"],
            "licenseListVersion": "3.25",
        },
        "dataLicense": "CC0-1.0",
        "documentComment": json.dumps(attestation, sort_keys=True, separators=(",", ":")),
        "documentDescribes": [root_id],
        "documentNamespace": (
            "https://social-git.invalid/spdx/runtime/"
            f"{image.manifest_digest.removeprefix('sha256:')}"
        ),
        "name": f"social-git-runtime-{platform_slug}",
        "packages": packages,
        "relationships": relationships,
        "spdxVersion": "SPDX-2.3",
    }


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def compare_images(first: dict[str, ImageRecord], second: dict[str, ImageRecord]) -> None:
    for platform in REQUIRED_PLATFORMS:
        first_image = first[platform]
        second_image = second[platform]
        fields = ("release_digest", "manifest_digest", "config_digest", "layer_digests")
        changed = [field for field in fields if getattr(first_image, field) != getattr(second_image, field)]
        if changed:
            raise AttestationError(
                f"non-reproducible {platform} image fields: {', '.join(changed)}"
            )


def attest(
    archive_path: Path,
    review_path: Path,
    output_dir: Path,
    comparison_path: Path | None = None,
) -> dict[str, Any]:
    images = inspect_oci(archive_path)
    inventories: dict[str, list[dict[str, Any]]] = {}
    checks: dict[str, dict[str, list[str]]] = {}
    for platform, image in images.items():
        inventories[platform], checks[platform] = inspect_components(image)
    review = load_review(review_path)
    verify_review(review, images, inventories)

    if comparison_path is not None:
        comparison_images = inspect_oci(comparison_path)
        comparison_inventories = {
            platform: inspect_components(image)[0]
            for platform, image in comparison_images.items()
        }
        verify_review(review, comparison_images, comparison_inventories)
        compare_images(images, comparison_images)

    output_dir.mkdir(parents=True, exist_ok=True)
    platforms: dict[str, Any] = {}
    for platform in REQUIRED_PLATFORMS:
        image = images[platform]
        output = output_dir / f"{platform.replace('/', '-')}.spdx.json"
        _write_json(output, make_spdx(image, inventories[platform], review))
        platforms[platform] = {
            "componentCount": len(inventories[platform]),
            "configDigest": image.config_digest,
            "imageDigest": image.manifest_digest,
            "layerDigests": list(image.layer_digests),
            "sbom": output.name,
        }
    summary = {
        "archiveSha256": sha256_bytes(archive_path.read_bytes()),
        "checks": checks,
        "comparison": (
            {
                "archive": comparison_path.name,
                "archiveSha256": sha256_bytes(comparison_path.read_bytes()),
                "status": "reproducible",
            }
            if comparison_path is not None
            else None
        ),
        "dependencyReview": {
            "closureSha256": review["closureSha256"],
            "path": "security/runtime-dependency-review.json",
            "status": "approved",
        },
        "platforms": platforms,
        "releaseDigest": next(iter(images.values())).release_digest,
        "schema": ATTESTATION_SCHEMA,
        "status": "ok",
    }
    _write_json(output_dir / "attestation-summary.json", summary)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--compare-archive", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--review",
        type=Path,
        default=Path(__file__).resolve().parents[2]
        / "security"
        / "runtime-dependency-review.json",
    )
    parser.add_argument("--write-review-candidate", type=Path)
    args = parser.parse_args(argv)

    try:
        if args.write_review_candidate is not None:
            if args.compare_archive is not None or args.output_dir is not None:
                parser.error(
                    "--write-review-candidate cannot be combined with output or comparison options"
                )
            images = inspect_oci(args.archive)
            inventories = {}
            for platform, image in images.items():
                inventories[platform], _ = inspect_components(image)
            candidate = build_review_candidate(images, inventories)
            _write_json(args.write_review_candidate, candidate)
            print(
                json.dumps(
                    {
                        "componentCount": len(candidate["components"]),
                        "output": os.fspath(args.write_review_candidate),
                        "status": "review-required",
                    },
                    sort_keys=True,
                )
            )
            return 0
        if args.output_dir is None:
            parser.error("--output-dir is required unless --write-review-candidate is used")
        summary = attest(args.archive, args.review, args.output_dir, args.compare_archive)
        print(json.dumps(summary, sort_keys=True))
        return 0
    except AttestationError as exc:
        parser.exit(1, f"runtime attestation failed: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
