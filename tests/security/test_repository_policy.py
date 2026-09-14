from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.security.check_repository_policy import check_repository, scan_sbom


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class RepositoryPolicyTests(unittest.TestCase):
    def test_repository_has_no_forbidden_production_integration(self) -> None:
        self.assertEqual([], check_repository(REPOSITORY_ROOT))

    def test_detects_browser_runtime_in_production_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text(
                json.dumps({"dependencies": {"playwright": "1.0.0"}}),
                encoding="utf-8",
            )
            violations = check_repository(root)

        self.assertTrue(
            any("playwright" in violation.detail for violation in violations),
            violations,
        )

    def test_dev_only_browser_tool_does_not_describe_production_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text(
                json.dumps({"devDependencies": {"@playwright/test": "1.0.0"}}),
                encoding="utf-8",
            )
            self.assertEqual([], check_repository(root))

    def test_detects_reddit_official_api_client(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requirements.txt").write_text("praw==7.8.1\n", encoding="utf-8")
            violations = check_repository(root)

        self.assertTrue(any("praw" in violation.detail for violation in violations), violations)

    def test_detects_direct_official_oauth_endpoint_in_worker_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = root / "workers" / "reddit.py"
            worker.parent.mkdir(parents=True)
            worker.write_text(
                'TOKEN_URL = "https://www.reddit.com/api/v1/access_token"\n',
                encoding="utf-8",
            )
            violations = check_repository(root)

        self.assertTrue(
            any("official OAuth/API endpoint" in violation.rule for violation in violations),
            violations,
        )

    def test_detects_transitive_forbidden_component_in_runtime_sbom(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sbom = Path(directory) / "runtime.cdx.json"
            sbom.write_text(
                json.dumps(
                    {
                        "bomFormat": "CycloneDX",
                        "components": [
                            {"type": "library", "name": "safe-library", "version": "1.0.0"},
                            {"type": "library", "name": "puppeteer-core", "version": "24.0.0"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            violations = scan_sbom(sbom)

        self.assertEqual(1, len(violations))
        self.assertEqual("puppeteer-core", violations[0].detail)


if __name__ == "__main__":
    unittest.main()
