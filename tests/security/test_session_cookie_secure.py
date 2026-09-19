from __future__ import annotations

import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILES = ("compose.yaml", "compose.prod.yaml", "compose.dev.yaml")


class SessionCookieSecureTests(unittest.TestCase):
    def test_compose_defaults_to_secure_cookies(self) -> None:
        for relative in COMPOSE_FILES:
            text = (REPOSITORY_ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("SOCIAL_GIT_SESSION_COOKIE_SECURE", text, relative)
            self.assertIn("${SOCIAL_GIT_SESSION_COOKIE_SECURE:-true}", text, relative)
            self.assertNotIn("${SOCIAL_GIT_SESSION_COOKIE_SECURE:-false}", text, relative)

    def test_deployment_docs_describe_loopback_only_escape_hatch(self) -> None:
        self_hosting = (REPOSITORY_ROOT / "docs/self-hosting.md").read_text(encoding="utf-8")
        readme = (REPOSITORY_ROOT / "README.md").read_text(encoding="utf-8")
        for text, name in ((self_hosting, "docs/self-hosting.md"), (readme, "README.md")):
            self.assertIn("SOCIAL_GIT_SESSION_COOKIE_SECURE", text, name)
            self.assertIn("loopback-only", text, name)
        self.assertIn("`true`", self_hosting)

    def test_validators_enforce_secure_default(self) -> None:
        self_hosted = (REPOSITORY_ROOT / "scripts/validate-self-hosted-compose.py").read_text(encoding="utf-8")
        prod = (REPOSITORY_ROOT / "scripts/validate-compose.py").read_text(encoding="utf-8")
        self.assertIn('"SOCIAL_GIT_SESSION_COOKIE_SECURE": "true"', self_hosted)
        self.assertIn('core_environment.get("SOCIAL_GIT_SESSION_COOKIE_SECURE") != "true"', prod)


if __name__ == "__main__":
    unittest.main()
