from __future__ import annotations

import json
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


class SourceMetadataTests(unittest.TestCase):
    def generate(self, output: Path) -> None:
        subprocess.run(
            [
                sys.executable,
                str(GENERATOR),
                "--root",
                str(REPO_ROOT),
                "--output",
                str(output),
                "--source-date-epoch",
                "0",
                "--runtime-name",
                "node",
                "--runtime-version",
                "26.3.1",
                "--base-image",
                BASE_IMAGE,
            ],
            check=True,
        )

    def test_outputs_are_deterministic_and_valid_spdx(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first"
            second = Path(temporary) / "second"
            self.generate(first)
            self.generate(second)
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
            self.assertEqual(paths, sorted(paths, key=lambda value: value.encode("utf-8")))
            self.assertNotIn(".git", paths)
            self.assertFalse(any(path.startswith("build/") for path in paths))

            sbom = json.loads((first / "sbom.spdx.json").read_text())
            self.assertEqual(sbom["spdxVersion"], "SPDX-2.3")
            self.assertEqual(sbom["creationInfo"]["created"], "1970-01-01T00:00:00Z")
            self.assertEqual(sbom["documentDescribes"], ["SPDXRef-Package-social-git-runtime"])
            self.assertEqual(len(sbom["files"]), len(manifest))


if __name__ == "__main__":
    unittest.main()
