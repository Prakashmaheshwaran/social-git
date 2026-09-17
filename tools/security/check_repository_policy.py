#!/usr/bin/env python3
"""Reject forbidden production dependencies and runtime integrations.

This check is intentionally dependency-free so it can run before application
dependencies are installed. It checks direct production manifests and selected
production source roots. A final-image CycloneDX or SPDX JSON SBOM can be
provided to check transitive runtime components.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    tomllib = None  # type: ignore[assignment]


BROWSER_DEPENDENCIES = frozenset(
    {
        "@playwright/test",
        "chrome-remote-interface",
        "chromedriver",
        "chromedp",
        "playwright",
        "playwright-core",
        "puppeteer",
        "puppeteer-core",
        "pyppeteer",
        "selenium",
        "selenium-webdriver",
        "undetected-chromedriver",
        "webdriverio",
    }
)

OFFICIAL_REDDIT_API_CLIENTS = frozenset(
    {
        "asyncpraw",
        "go-reddit",
        "jraw",
        "praw",
        "prawcore",
        "reddit-api-client",
        "redditwarp",
        "snoowrap",
    }
)

UNADMITTED_X_RUNTIME_CLIENTS = frozenset(
    {
        "twikit",
        "twifork",
        "twscrape",
        "twitter-api-client",
        "tweeterpy",
        "twikit-ng",
    }
)

FORBIDDEN_DEPENDENCIES = BROWSER_DEPENDENCIES | OFFICIAL_REDDIT_API_CLIENTS | UNADMITTED_X_RUNTIME_CLIENTS

PRODUCTION_SOURCE_ROOTS = (
    "app",
    "apps",
    "lib",
    "packages",
    "runtime",
    "server",
    "services",
    "src",
    "worker",
    "workers",
)

SOURCE_SUFFIXES = frozenset(
    {".cjs", ".go", ".java", ".js", ".jsx", ".kt", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".ts", ".tsx"}
)

SKIPPED_SOURCE_PARTS = frozenset(
    {"__tests__", "docs", "examples", "fixtures", "node_modules", "test", "tests", "vendor"}
)

SOURCE_RULES = (
    (
        "browser runtime import",
        re.compile(
            r"(?:from\s+|import\s+|require\s*\(\s*['\"]|from\s*['\"])(?:@playwright/test|playwright|playwright-core|puppeteer|puppeteer-core|selenium(?:-webdriver)?|pyppeteer|chromedp|chrome-remote-interface)(?:['\"./\s]|$)",
            re.IGNORECASE,
        ),
    ),
    (
        "Reddit official-API client import",
        re.compile(
            r"(?:from\s+|import\s+|require\s*\(\s*['\"]|from\s*['\"])(?:asyncpraw|praw|prawcore|snoowrap|redditwarp|jraw|go-reddit)(?:['\"./\s]|$)",
            re.IGNORECASE,
        ),
    ),
    (
        "Reddit official OAuth/API endpoint",
        re.compile(
            r"(?:oauth\.reddit\.com|reddit\.com/api/v1/access_token)",
            re.IGNORECASE,
        ),
    ),
)

CONTAINER_BROWSER_RULE = re.compile(
    r"\b(?:chromium|chromium-browser|google-chrome|chromedriver|firefox-esr|xvfb)\b",
    re.IGNORECASE,
)

RUNTIME_ATTESTATION_SCHEMA = "social-git-runtime-attestation/v1"
RUNTIME_REVIEW_SCHEMA = "social-git-runtime-dependency-review/v1"
REQUIRED_RUNTIME_PLATFORMS = {"linux/amd64", "linux/arm64"}
SHA256_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256_VALUE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, order=True)
class Violation:
    path: str
    rule: str
    detail: str

    def render(self) -> str:
        return f"{self.path}: {self.rule}: {self.detail}"


def _canonical_dependency(raw: str) -> str:
    value = raw.strip().strip("'\"").lower()
    value = re.split(r"[\s<>=!~;\[]", value, maxsplit=1)[0]
    return value.rstrip(",")


def _is_forbidden_dependency(raw: str) -> str | None:
    canonical = _canonical_dependency(raw)
    if canonical in FORBIDDEN_DEPENDENCIES:
        return canonical

    path_parts = {part for part in re.split(r"[/\\]", canonical) if part}
    for forbidden in FORBIDDEN_DEPENDENCIES:
        if forbidden in path_parts:
            return forbidden
    return None


def _json_dependencies(path: Path) -> Iterator[tuple[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if path.name == "package.json":
        for group in ("dependencies", "optionalDependencies", "peerDependencies"):
            values = data.get(group, {})
            if isinstance(values, dict):
                for name in values:
                    yield group, str(name)
    elif path.name == "composer.json":
        values = data.get("require", {})
        if isinstance(values, dict):
            for name in values:
                yield "require", str(name)


def _pyproject_dependencies(path: Path) -> Iterator[tuple[str, str]]:
    if tomllib is None:
        return
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    project = data.get("project", {})
    for item in project.get("dependencies", []):
        yield "project.dependencies", str(item)
    for group, items in project.get("optional-dependencies", {}).items():
        if group.lower() not in {"dev", "docs", "lint", "qa", "test", "tests"}:
            for item in items:
                yield f"project.optional-dependencies.{group}", str(item)

    poetry = data.get("tool", {}).get("poetry", {})
    for name in poetry.get("dependencies", {}):
        if str(name).lower() != "python":
            yield "tool.poetry.dependencies", str(name)


def _cargo_dependencies(path: Path) -> Iterator[tuple[str, str]]:
    if tomllib is None:
        return
    data = tomllib.loads(path.read_text(encoding="utf-8"))

    def walk(value: object, trail: tuple[str, ...] = ()) -> Iterator[tuple[str, str]]:
        if not isinstance(value, dict):
            return
        for key, child in value.items():
            next_trail = trail + (str(key),)
            if str(key) in {"dependencies", "build-dependencies"} and isinstance(child, dict):
                for name in child:
                    yield ".".join(next_trail), str(name)
            elif str(key) != "dev-dependencies":
                yield from walk(child, next_trail)

    yield from walk(data)


def _requirements_dependencies(path: Path) -> Iterator[tuple[str, str]]:
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "-")):
            continue
        yield "requirement", stripped


def _go_mod_dependencies(path: Path) -> Iterator[tuple[str, str]]:
    in_require = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.split("//", 1)[0].strip()
        if stripped == "require (":
            in_require = True
            continue
        if in_require and stripped == ")":
            in_require = False
            continue
        if stripped.startswith("require "):
            stripped = stripped.removeprefix("require ").strip()
        elif not in_require:
            continue
        if stripped:
            yield "require", stripped.split()[0]


def _gemfile_dependencies(path: Path) -> Iterator[tuple[str, str]]:
    pattern = re.compile(r"^\s*gem\s+['\"]([^'\"]+)['\"]")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            yield "gem", match.group(1)


def _manifest_dependencies(path: Path) -> Iterable[tuple[str, str]]:
    if path.name in {"package.json", "composer.json"}:
        return _json_dependencies(path)
    if path.name == "pyproject.toml":
        return _pyproject_dependencies(path)
    if path.name == "Cargo.toml":
        return _cargo_dependencies(path)
    if path.name == "go.mod":
        return _go_mod_dependencies(path)
    if path.name == "Gemfile":
        return _gemfile_dependencies(path)
    if path.name.startswith("requirements") and path.suffix in {".lock", ".txt"}:
        return _requirements_dependencies(path)
    return ()


def _production_manifests(root: Path) -> Iterator[Path]:
    names = {"Cargo.toml", "Gemfile", "composer.json", "go.mod", "package.json", "pyproject.toml"}
    ignored_parts = {".git", "dist", "node_modules", "test", "tests", "vendor"}
    for path in root.rglob("*"):
        if not path.is_file() or ignored_parts.intersection(path.parts):
            continue
        if path.name in names:
            yield path
            continue
        if path.name.startswith("requirements") and path.suffix in {".lock", ".txt"}:
            lowered = path.name.lower()
            if not any(label in lowered for label in ("dev", "docs", "lint", "qa", "test")):
                yield path


def scan_manifests(root: Path) -> list[Violation]:
    violations: list[Violation] = []
    for path in _production_manifests(root):
        try:
            dependencies = _manifest_dependencies(path)
            for group, raw_name in dependencies:
                forbidden = _is_forbidden_dependency(raw_name)
                if forbidden:
                    violations.append(
                        Violation(
                            str(path.relative_to(root)),
                            "forbidden production dependency",
                            f"{forbidden} in {group}",
                        )
                    )
        except (json.JSONDecodeError, OSError, ValueError) as exc:
            violations.append(
                Violation(str(path.relative_to(root)), "unreadable production manifest", str(exc))
            )
    return violations


def _production_source_files(root: Path) -> Iterator[Path]:
    for source_root_name in PRODUCTION_SOURCE_ROOTS:
        source_root = root / source_root_name
        if not source_root.is_dir():
            continue
        for path in source_root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in SOURCE_SUFFIXES:
                continue
            if SKIPPED_SOURCE_PARTS.intersection(path.relative_to(source_root).parts):
                continue
            yield path


def scan_source(root: Path) -> list[Violation]:
    violations: list[Violation] = []
    for path in _production_source_files(root):
        try:
            body = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            violations.append(Violation(str(path.relative_to(root)), "unreadable source", str(exc)))
            continue
        for rule, pattern in SOURCE_RULES:
            if pattern.search(body):
                violations.append(Violation(str(path.relative_to(root)), rule, pattern.pattern))

    for path in root.rglob("Dockerfile*"):
        if any(part in {".git", "node_modules", "test", "tests", "vendor"} for part in path.parts):
            continue
        body = path.read_text(encoding="utf-8", errors="replace")
        match = CONTAINER_BROWSER_RULE.search(body)
        if match:
            violations.append(
                Violation(
                    str(path.relative_to(root)),
                    "browser executable in production container definition",
                    match.group(0),
                )
            )
    return violations


def _sbom_component_names(data: object) -> Iterator[str]:
    if not isinstance(data, dict):
        return
    components = data.get("components", [])  # CycloneDX
    if isinstance(components, list):
        for component in components:
            if isinstance(component, dict) and isinstance(component.get("name"), str):
                yield component["name"]
    packages = data.get("packages", [])  # SPDX JSON
    if isinstance(packages, list):
        for package in packages:
            if isinstance(package, dict) and isinstance(package.get("name"), str):
                yield package["name"]


def scan_sbom(path: Path) -> list[Violation]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return [Violation(str(path), "unreadable SBOM", str(exc))]

    violations: list[Violation] = []
    for name in _sbom_component_names(data):
        forbidden = _is_forbidden_dependency(name)
        if forbidden:
            violations.append(
                Violation(str(path), "forbidden production SBOM component", forbidden)
            )
    return violations


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _load_runtime_review(path: Path) -> tuple[dict[str, object] | None, list[Violation]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return None, [Violation(str(path), "unreadable runtime dependency review", str(exc))]
    if not isinstance(data, dict):
        return None, [Violation(str(path), "invalid runtime dependency review", "not an object")]

    violations: list[Violation] = []
    if data.get("schema") != RUNTIME_REVIEW_SCHEMA:
        violations.append(
            Violation(str(path), "invalid runtime dependency review", "unsupported schema")
        )
    review = data.get("review")
    if not isinstance(review, dict) or review.get("decision") != "approved":
        violations.append(
            Violation(str(path), "unreviewed runtime dependency closure", "decision is not approved")
        )
    else:
        for field in ("sourceReview", "licenseReview", "installScriptReview"):
            if not isinstance(review.get(field), str) or not review[field].strip():
                violations.append(
                    Violation(
                        str(path),
                        "incomplete runtime dependency review",
                        f"missing {field}",
                    )
                )
        for field in ("reviewedAt", "reviewerRole"):
            if not isinstance(review.get(field), str) or not review[field].strip():
                violations.append(
                    Violation(
                        str(path),
                        "incomplete runtime dependency review",
                        f"missing {field}",
                    )
                )

    base_image = data.get("baseImage")
    if not isinstance(base_image, dict) or not (
        isinstance(base_image.get("reference"), str)
        and re.search(r"@sha256:[0-9a-f]{64}$", base_image["reference"])
        and base_image.get("indexDigest") == base_image["reference"].rsplit("@", 1)[1]
        and isinstance(base_image.get("source"), str)
        and bool(base_image["source"])
    ):
        violations.append(
            Violation(str(path), "invalid reviewed base image", "exact source or digest absent")
        )

    components = data.get("components")
    if not isinstance(components, list) or not components:
        violations.append(
            Violation(str(path), "invalid runtime dependency review", "components are absent")
        )
        return data, violations
    closure_digest = "sha256:" + hashlib.sha256(_canonical_json(components)).hexdigest()
    if data.get("closureSha256") != closure_digest:
        violations.append(
            Violation(str(path), "invalid runtime dependency review", "closure digest mismatch")
        )

    keys: set[str] = set()
    for component in components:
        if not isinstance(component, dict):
            violations.append(
                Violation(str(path), "invalid reviewed component", "component is not an object")
            )
            continue
        key = component.get("key")
        name = component.get("name")
        version = component.get("version")
        if not all(isinstance(value, str) and value for value in (key, name, version)):
            violations.append(
                Violation(str(path), "invalid reviewed component", "missing key, name, or version")
            )
            continue
        if key in keys:
            violations.append(Violation(str(path), "duplicate reviewed component", str(key)))
        keys.add(str(key))
        forbidden = _is_forbidden_dependency(str(name))
        if forbidden:
            violations.append(
                Violation(str(path), "forbidden reviewed runtime component", forbidden)
            )
        source = component.get("source")
        license_evidence = component.get("licenseEvidence")
        artifacts = component.get("artifacts")
        if not isinstance(source, dict) or not all(
            isinstance(source.get(field), str) and source[field]
            for field in ("name", "version", "locator")
        ):
            violations.append(Violation(str(path), "unreviewed component source", str(key)))
        if not isinstance(license_evidence, dict) or not (
            isinstance(license_evidence.get("path"), str)
            and SHA256_VALUE.fullmatch(str(license_evidence.get("sha256", "")))
            and isinstance(license_evidence.get("markers"), list)
            and bool(license_evidence.get("markers"))
        ):
            violations.append(Violation(str(path), "unreviewed component license", str(key)))
        if not isinstance(artifacts, dict) or set(artifacts) != REQUIRED_RUNTIME_PLATFORMS:
            violations.append(
                Violation(str(path), "architecture-specific dependency drift", str(key))
            )
            continue
        for platform, artifact in artifacts.items():
            if not isinstance(artifact, dict) or not SHA256_VALUE.fullmatch(
                str(artifact.get("contentSha256", ""))
            ):
                violations.append(
                    Violation(str(path), "unreviewed component integrity", f"{key} on {platform}")
                )
                continue
            if artifact.get("architecture") not in {
                "all",
                platform.split("/", 1)[1],
            }:
                violations.append(
                    Violation(str(path), "architecture-specific dependency drift", f"{key} on {platform}")
                )
            scripts = artifact.get("installScripts")
            if not isinstance(scripts, list):
                violations.append(
                    Violation(str(path), "unreviewed install scripts", f"{key} on {platform}")
                )
                continue
            for script in scripts:
                if not isinstance(script, dict) or not (
                    isinstance(script.get("name"), str)
                    and SHA256_VALUE.fullmatch(str(script.get("sha256", "")))
                ):
                    violations.append(
                        Violation(
                            str(path),
                            "unreviewed install script",
                            f"{key} on {platform}",
                        )
                    )
    return data, violations


def _parse_attestation(path: Path, data: dict[str, object]) -> tuple[dict[str, object] | None, list[Violation]]:
    raw_comment = data.get("documentComment")
    try:
        attestation = json.loads(raw_comment) if isinstance(raw_comment, str) else None
    except json.JSONDecodeError:
        attestation = None
    if not isinstance(attestation, dict) or attestation.get("schema") != RUNTIME_ATTESTATION_SCHEMA:
        return None, [
            Violation(str(path), "runtime SBOM is not digest-bound", "attestation metadata absent")
        ]
    violations: list[Violation] = []
    for field in ("imageDigest", "configDigest", "releaseDigest"):
        if not SHA256_DIGEST.fullmatch(str(attestation.get(field, ""))):
            violations.append(
                Violation(str(path), "runtime SBOM is not digest-bound", f"invalid {field}")
            )
    layers = attestation.get("layerDigests")
    if not isinstance(layers, list) or not layers or not all(
        SHA256_DIGEST.fullmatch(str(digest)) for digest in layers
    ):
        violations.append(
            Violation(str(path), "runtime SBOM is not digest-bound", "invalid layer digests")
        )
    if attestation.get("platform") not in REQUIRED_RUNTIME_PLATFORMS:
        violations.append(
            Violation(str(path), "runtime SBOM has unsupported platform", str(attestation.get("platform")))
        )
    return attestation, violations


def _spdx_checksum(package: dict[str, object]) -> str | None:
    checksums = package.get("checksums")
    if not isinstance(checksums, list):
        return None
    for checksum in checksums:
        if (
            isinstance(checksum, dict)
            and checksum.get("algorithm") == "SHA256"
            and SHA256_VALUE.fullmatch(str(checksum.get("checksumValue", "")))
        ):
            return str(checksum["checksumValue"])
    return None


def _scan_runtime_sbom_review(
    path: Path, data: dict[str, object], review: dict[str, object]
) -> tuple[str | None, list[Violation]]:
    attestation, violations = _parse_attestation(path, data)
    if attestation is None:
        return None, violations
    platform = str(attestation.get("platform"))
    if attestation.get("closureSha256") != review.get("closureSha256"):
        violations.append(
            Violation(str(path), "runtime SBOM uses unreviewed closure", "closure digest mismatch")
        )
    base_image = review.get("baseImage")
    expected_base = base_image.get("reference") if isinstance(base_image, dict) else None
    if attestation.get("baseImage") != expected_base:
        violations.append(
            Violation(str(path), "runtime SBOM uses unreviewed base image", "reference mismatch")
        )

    packages = data.get("packages")
    described = data.get("documentDescribes")
    if not isinstance(packages, list) or not isinstance(described, list) or len(described) != 1:
        violations.append(Violation(str(path), "invalid SPDX runtime SBOM", "package graph absent"))
        return platform, violations
    root_id = described[0]
    root = next(
        (
            package
            for package in packages
            if isinstance(package, dict) and package.get("SPDXID") == root_id
        ),
        None,
    )
    if not isinstance(root, dict):
        violations.append(Violation(str(path), "invalid SPDX runtime SBOM", "root package absent"))
        return platform, violations
    manifest_value = str(attestation.get("imageDigest", "")).removeprefix("sha256:")
    if _spdx_checksum(root) != manifest_value:
        violations.append(
            Violation(str(path), "runtime SBOM root digest mismatch", str(root.get("name")))
        )

    reviewed_components = review.get("components")
    expected = {
        str(component["key"]): component
        for component in reviewed_components
        if isinstance(reviewed_components, list)
        and isinstance(component, dict)
        and isinstance(component.get("key"), str)
    }
    seen: set[str] = set()
    for package in packages:
        if not isinstance(package, dict) or package.get("SPDXID") == root_id:
            continue
        raw_comment = package.get("comment")
        try:
            evidence = json.loads(raw_comment) if isinstance(raw_comment, str) else None
        except json.JSONDecodeError:
            evidence = None
        if not isinstance(evidence, dict) or not isinstance(evidence.get("reviewKey"), str):
            violations.append(
                Violation(str(path), "unknown or unreviewed SBOM component", str(package.get("name")))
            )
            continue
        key = str(evidence["reviewKey"])
        if key in seen:
            violations.append(Violation(str(path), "duplicate runtime SBOM component", key))
            continue
        seen.add(key)
        reviewed = expected.get(key)
        if reviewed is None:
            violations.append(Violation(str(path), "unknown runtime SBOM component", key))
            continue
        artifacts = reviewed.get("artifacts")
        artifact = artifacts.get(platform) if isinstance(artifacts, dict) else None
        if not isinstance(artifact, dict):
            violations.append(
                Violation(str(path), "architecture-specific dependency drift", f"{key} on {platform}")
            )
            continue
        expected_evidence = {
            "contentSha256": artifact.get("contentSha256"),
            "installScripts": artifact.get("installScripts"),
            "licenseEvidence": reviewed.get("licenseEvidence"),
            "platform": platform,
            "reviewKey": key,
            "source": reviewed.get("source"),
        }
        if evidence != expected_evidence:
            violations.append(
                Violation(str(path), "runtime SBOM review evidence mismatch", key)
            )
        if package.get("name") != reviewed.get("name") or package.get("versionInfo") != reviewed.get(
            "version"
        ):
            violations.append(Violation(str(path), "runtime SBOM component drift", key))
        if _spdx_checksum(package) != artifact.get("contentSha256"):
            violations.append(Violation(str(path), "runtime SBOM integrity mismatch", key))

    missing = sorted(set(expected) - seen)
    for key in missing:
        violations.append(Violation(str(path), "reviewed runtime component missing from SBOM", key))
    return platform, violations


def check_repository(root: Path, sboms: Iterable[Path] = ()) -> list[Violation]:
    violations = scan_manifests(root) + scan_source(root)
    review_path = root / "security" / "runtime-dependency-review.json"
    review: dict[str, object] | None = None
    if review_path.is_file():
        review, review_violations = _load_runtime_review(review_path)
        violations.extend(review_violations)
    sbom_paths = list(sboms)
    runtime_platforms: set[str] = set()
    for sbom in sbom_paths:
        violations.extend(scan_sbom(sbom))
        if review is not None:
            try:
                sbom_data = json.loads(sbom.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if isinstance(sbom_data, dict):
                platform, runtime_violations = _scan_runtime_sbom_review(
                    sbom, sbom_data, review
                )
                violations.extend(runtime_violations)
                if platform is not None:
                    runtime_platforms.add(platform)
    if review is not None and sbom_paths and runtime_platforms != REQUIRED_RUNTIME_PLATFORMS:
        violations.append(
            Violation(
                "runtime SBOM set",
                "architecture-specific dependency drift",
                f"expected {sorted(REQUIRED_RUNTIME_PLATFORMS)}, found {sorted(runtime_platforms)}",
            )
        )
    return sorted(set(violations))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root (default: inferred from this script)",
    )
    parser.add_argument(
        "--sbom",
        action="append",
        default=[],
        type=Path,
        help="CycloneDX or SPDX JSON SBOM from the final runtime image; repeatable",
    )
    args = parser.parse_args(argv)

    violations = check_repository(args.root.resolve(), args.sbom)
    if violations:
        print("Production repository policy check failed:", file=sys.stderr)
        for violation in violations:
            print(f"- {violation.render()}", file=sys.stderr)
        return 1

    sbom_note = f" and {len(args.sbom)} runtime SBOM(s)" if args.sbom else ""
    print(f"Production repository policy check passed{sbom_note}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
