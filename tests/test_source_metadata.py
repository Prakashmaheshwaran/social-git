from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
GENERATOR = REPO_ROOT / "scripts" / "generate-source-metadata.py"
BASE_IMAGE = (
    "node:26.3.1-bookworm-slim@"
    "sha256:9898bb74f4ee319780e87819df703b3633113bc3422f151fd11155cf974a2749"
)
APPLICATION_SOURCE_INPUTS = (
    "package.json",
    "src",
    "web",
    "runtime/entrypoint.mjs",
    "runtime/healthcheck.mjs",
    "runtime/backup.mjs",
    "runtime/audit-verify.mjs",
    "runtime/secrets-init.mjs",
    "runtime/promote-restore.mjs",
    "packages/core/package.json",
    "packages/core/src",
    "packages/core/migrations",
    "packages/reddit-adapter/package.json",
    "packages/reddit-adapter/src",
    "packages/reddit-adapter/THIRD_PARTY_NOTICES.md",
    "packages/x-adapter/package.json",
    "packages/x-adapter/src",
    "packages/x-adapter/THIRD_PARTY_NOTICES.md",
    "packages/security/package.json",
    "packages/security/src",
    "packages/worker-security/package.json",
    "packages/worker-security/src",
)


class SourceMetadataTests(unittest.TestCase):
    def generate(self, source: Path, output: Path, epoch: int = 0) -> None:
        subprocess.run(
            [
                sys.executable,
                str(GENERATOR),
                "--root",
                str(source),
                "--output",
                str(output),
                "--source-date-epoch",
                str(epoch),
                "--runtime-name",
                "node",
                "--runtime-version",
                "26.3.1",
                "--base-image",
                BASE_IMAGE,
            ],
            check=True,
        )

    def stage_application_source(self, destination: Path) -> list[str]:
        paths: list[str] = []
        for relative in APPLICATION_SOURCE_INPUTS:
            source = REPO_ROOT / relative
            target = destination / relative
            if source.is_dir():
                shutil.copytree(source, target)
                paths.extend(
                    path.relative_to(destination).as_posix()
                    for path in target.rglob("*")
                    if path.is_file() and not path.is_symlink()
                )
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                paths.append(relative)
        return sorted(paths, key=lambda value: value.encode("utf-8"))

    def test_dockerfile_metadata_and_runtime_share_one_exact_source_set(self) -> None:
        dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
        source_stage = dockerfile.split("FROM scratch AS application-source\n", 1)[1].split(
            "\nFROM ", 1
        )[0]
        staged = tuple(
            match.group(1)
            for match in re.finditer(r"^COPY ([^ ]+) /[^ ]+$", source_stage, re.MULTILINE)
        )
        self.assertEqual(APPLICATION_SOURCE_INPUTS, staged)

        runtime_stage = dockerfile.split("FROM ${NODE_IMAGE} AS runtime\n", 1)[1]
        installed = tuple(
            match.group(1).removeprefix("/")
            for match in re.finditer(
                r"^COPY --from=application-source --chown=10001:10001 ([^ ]+) [^ ]+$",
                runtime_stage,
                re.MULTILINE,
            )
        )
        self.assertEqual(APPLICATION_SOURCE_INPUTS, installed)
        self.assertIn("COPY --from=application-source / /source/", dockerfile)
        self.assertNotIn("COPY . .", dockerfile)

    def test_build_context_is_deny_by_default(self) -> None:
        rules = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
        self.assertEqual("**", rules[0])
        for excluded in (
            "!test/",
            "!tests/",
            "!docs/",
            "!security/",
            "!tools/",
            "!compose.yaml",
            "!.dockerignore",
        ):
            self.assertNotIn(excluded, rules)
        self.assertIn("!scripts/generate-source-metadata.py", rules)

    def test_outputs_are_deterministic_and_valid_spdx(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            expected_paths = self.stage_application_source(source)
            first = Path(temporary) / "first"
            second = Path(temporary) / "second"
            self.generate(source, first)
            self.generate(source, second)
            self.assertEqual(
                (first / "source-manifest.sha256").read_bytes(),
                (second / "source-manifest.sha256").read_bytes(),
            )
            self.assertEqual(
                (first / "sbom.spdx.json").read_bytes(),
                (second / "sbom.spdx.json").read_bytes(),
            )

            manifest = (first / "source-manifest.sha256").read_text().splitlines()
            paths = [line.split("  ", 1)[1] for line in manifest]
            self.assertEqual(expected_paths, paths)
            self.assertEqual(paths, sorted(paths, key=lambda value: value.encode("utf-8")))
            self.assertNotIn(".git", paths)
            self.assertFalse(any(path.startswith("build/") for path in paths))
            self.assertEqual(131, len(paths))
            self.assertFalse(
                any(
                    path.startswith(prefix)
                    for path in paths
                    for prefix in ("test/", "tests/", "docs/", "security/", "tools/", "scripts/")
                )
            )

            sbom = json.loads((first / "sbom.spdx.json").read_text())
            self.assertEqual(sbom["spdxVersion"], "SPDX-2.3")
            self.assertEqual(sbom["creationInfo"]["created"], "1970-01-01T00:00:00Z")
            self.assertEqual(sbom["documentDescribes"], ["SPDXRef-Package-social-git-runtime"])
            self.assertEqual(len(sbom["files"]), len(manifest))

    def test_only_runtime_source_or_epoch_can_change_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            self.stage_application_source(source)
            baseline = root / "baseline"
            external_change = root / "external-change"
            runtime_change = root / "runtime-change"
            epoch_change = root / "epoch-change"
            self.generate(source, baseline)

            (root / "test" / "policy-only.txt").parent.mkdir()
            (root / "test" / "policy-only.txt").write_text("not installed\n", encoding="utf-8")
            self.generate(source, external_change)
            self.assertEqual(
                (baseline / "source-manifest.sha256").read_bytes(),
                (external_change / "source-manifest.sha256").read_bytes(),
            )
            self.assertEqual(
                (baseline / "sbom.spdx.json").read_bytes(),
                (external_change / "sbom.spdx.json").read_bytes(),
            )

            package = source / "package.json"
            package.write_bytes(package.read_bytes() + b"\n")
            self.generate(source, runtime_change)
            self.assertNotEqual(
                (baseline / "source-manifest.sha256").read_bytes(),
                (runtime_change / "source-manifest.sha256").read_bytes(),
            )

            package.write_bytes(package.read_bytes()[:-1])
            self.generate(source, epoch_change, epoch=1)
            self.assertEqual(
                (baseline / "source-manifest.sha256").read_bytes(),
                (epoch_change / "source-manifest.sha256").read_bytes(),
            )
            self.assertNotEqual(
                (baseline / "sbom.spdx.json").read_bytes(),
                (epoch_change / "sbom.spdx.json").read_bytes(),
            )


if __name__ == "__main__":
    unittest.main()
