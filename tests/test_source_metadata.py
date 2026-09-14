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
    "python:3.13.7-slim-bookworm@"
    "sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d"
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
                "--runtime-version",
                "3.13.7",
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
