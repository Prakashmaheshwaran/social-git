#!/usr/bin/env python3
"""Reject forbidden production dependencies and runtime integrations.

This check is intentionally dependency-free so it can run before application
dependencies are installed. It checks direct production manifests and selected
production source roots. A final-image CycloneDX or SPDX JSON SBOM can be
provided to check transitive runtime components.
"""

from __future__ import annotations

import argparse
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

FORBIDDEN_DEPENDENCIES = BROWSER_DEPENDENCIES | OFFICIAL_REDDIT_API_CLIENTS

PRODUCTION_SOURCE_ROOTS = (
    "app",
    "apps",
    "lib",
    "packages",
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
    if path.name.startswith("requirements") and path.suffix == ".txt":
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
        if path.name.startswith("requirements") and path.suffix == ".txt":
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


def check_repository(root: Path, sboms: Iterable[Path] = ()) -> list[Violation]:
    violations = scan_manifests(root) + scan_source(root)
    for sbom in sboms:
        violations.extend(scan_sbom(sbom))
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
