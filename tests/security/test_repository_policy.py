from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tools.security.check_repository_policy import check_repository, scan_sbom


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class RepositoryPolicyTests(unittest.TestCase):
    def write_review_and_sboms(self, root: Path) -> tuple[Path, Path]:
        component = {
            "artifacts": {
                platform: {
                    "architecture": platform.split("/", 1)[1],
                    "contentSha256": hashlib.sha256(platform.encode()).hexdigest(),
                    "installScripts": [],
                }
                for platform in ("linux/amd64", "linux/arm64")
            },
            "ecosystem": "pypi",
            "key": "pypi:safe-library",
            "licenseEvidence": {
                "markers": ["MIT"],
                "path": "/safe-library.dist-info/METADATA",
                "sha256": "1" * 64,
            },
            "name": "safe-library",
            "source": {
                "locator": "https://example.invalid/safe-library",
                "name": "safe-library",
                "version": "1.0.0",
            },
            "version": "1.0.0",
        }
        closure = "sha256:" + hashlib.sha256(
            json.dumps([component], sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        base_image = "python@example.invalid@sha256:" + "2" * 64
        review = {
            "baseImage": {
                "indexDigest": "sha256:" + "2" * 64,
                "reference": base_image,
                "source": "https://example.invalid/python",
            },
            "closureSha256": closure,
            "components": [component],
            "review": {
                "decision": "approved",
                "installScriptReview": "reviewed",
                "licenseReview": "reviewed",
                "reviewedAt": "2026-09-14",
                "reviewerRole": "test",
                "sourceReview": "reviewed",
            },
            "schema": "social-git-runtime-dependency-review/v1",
        }
        review_path = root / "security" / "runtime-dependency-review.json"
        review_path.parent.mkdir(parents=True)
        review_path.write_text(json.dumps(review), encoding="utf-8")

        sboms = []
        for platform in ("linux/amd64", "linux/arm64"):
            image_digest = "sha256:" + ("3" if platform.endswith("amd64") else "4") * 64
            content_digest = component["artifacts"][platform]["contentSha256"]
            evidence = {
                "contentSha256": content_digest,
                "installScripts": [],
                "licenseEvidence": component["licenseEvidence"],
                "platform": platform,
                "reviewKey": component["key"],
                "source": component["source"],
            }
            attestation = {
                "baseImage": base_image,
                "closureSha256": closure,
                "configDigest": "sha256:" + "5" * 64,
                "imageDigest": image_digest,
                "layerDigests": ["sha256:" + "6" * 64],
                "platform": platform,
                "releaseDigest": "sha256:" + "7" * 64,
                "reviewSchema": "social-git-runtime-dependency-review/v1",
                "schema": "social-git-runtime-attestation/v1",
            }
            sbom = {
                "documentComment": json.dumps(attestation),
                "documentDescribes": ["SPDXRef-root"],
                "packages": [
                    {
                        "SPDXID": "SPDXRef-root",
                        "checksums": [
                            {
                                "algorithm": "SHA256",
                                "checksumValue": image_digest.removeprefix("sha256:"),
                            }
                        ],
                        "name": "social-git-runtime",
                    },
                    {
                        "SPDXID": "SPDXRef-safe",
                        "checksums": [
                            {"algorithm": "SHA256", "checksumValue": content_digest}
                        ],
                        "comment": json.dumps(evidence),
                        "name": "safe-library",
                        "versionInfo": "1.0.0",
                    },
                ],
                "spdxVersion": "SPDX-2.3",
            }
            path = root / f"{platform.replace('/', '-')}.spdx.json"
            path.write_text(json.dumps(sbom), encoding="utf-8")
            sboms.append(path)
        return sboms[0], sboms[1]
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

    def test_detects_unadmitted_x_runtime_client(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requirements.txt").write_text("twikit==2.3.3\n", encoding="utf-8")
            violations = check_repository(root)

        self.assertTrue(any("twikit" in violation.detail for violation in violations), violations)

    def test_x_source_corpus_is_not_installed_and_notice_is_packaged(self) -> None:
        lock = json.loads((REPOSITORY_ROOT / "package-lock.json").read_text(encoding="utf-8"))
        serialized = json.dumps(lock).lower()
        self.assertNotIn('"twikit"', serialized)
        self.assertNotIn('"twifork"', serialized)
        dockerfile = (REPOSITORY_ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("x-adapter/THIRD_PARTY_NOTICES.md", dockerfile)
        notice = (REPOSITORY_ROOT / "packages/x-adapter/THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        self.assertIn("6a73ab97f4de09f79139f6308c9fb80029a9f5f7", notice)
        self.assertIn("02c0ce95a5556628b8508cdbf1d05d39aef689a3", notice)
        self.assertIn("71fec6fa5605fe7958564251e54ac0a8f7658a4690b6bef784b1680e2915e2aa", notice)
        self.assertIn("MIT License", notice)

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

    def test_accepts_digest_bound_dual_architecture_reviewed_sboms(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sboms = self.write_review_and_sboms(root)
            self.assertEqual([], check_repository(root, sboms))

    def test_rejects_unknown_component_even_when_sbom_is_digest_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sboms = self.write_review_and_sboms(root)
            data = json.loads(sboms[0].read_text(encoding="utf-8"))
            evidence = json.loads(data["packages"][1]["comment"])
            evidence["reviewKey"] = "pypi:unknown-library"
            data["packages"][1]["comment"] = json.dumps(evidence)
            sboms[0].write_text(json.dumps(data), encoding="utf-8")
            violations = check_repository(root, sboms)

        self.assertTrue(
            any("unknown runtime SBOM component" in violation.rule for violation in violations),
            violations,
        )

    def test_rejects_incomplete_architecture_sbom_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            amd64, _ = self.write_review_and_sboms(root)
            violations = check_repository(root, [amd64])

        self.assertTrue(
            any("architecture-specific dependency drift" in violation.rule for violation in violations),
            violations,
        )

if __name__ == "__main__":
    unittest.main()
