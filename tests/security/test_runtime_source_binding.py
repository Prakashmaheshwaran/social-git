from __future__ import annotations

import datetime as dt
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools.security.check_repository_policy import _approved_runtime_source_violations


class RuntimeSourceBindingTests(unittest.TestCase):
    def git(self, root: Path, *arguments: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()

    def fixture(self, root: Path) -> tuple[dict[str, object], str, str]:
        root.joinpath("scripts").mkdir()
        root.joinpath("package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        root.joinpath(".dockerignore").write_text(
            "**\n!Dockerfile\n!package.json\n!scripts/\n!scripts/generate-source-metadata.py\n",
            encoding="utf-8",
        )
        root.joinpath("scripts/generate-source-metadata.py").write_text(
            "# fixture\n", encoding="utf-8"
        )
        root.joinpath("Dockerfile").write_text(
            """FROM scratch AS application-source
COPY package.json /package.json
FROM scratch AS metadata
COPY --from=application-source / /source/
FROM ${NODE_IMAGE} AS runtime
COPY --from=application-source --chown=10001:10001 /package.json ./package.json
""",
            encoding="utf-8",
        )
        for compose in ("compose.yaml", "compose.dev.yaml"):
            root.joinpath(compose).write_text(
                """x-build:
  args:
    CREATED: ${CREATED:-pending}
    SOURCE_DATE_EPOCH: ${SOURCE_DATE_EPOCH:-0}
    VCS_REF: ${VCS_REF:-pending}
""",
                encoding="utf-8",
            )
        self.git(root, "init", "--quiet")
        self.git(root, "config", "user.name", "Runtime Source Test")
        self.git(root, "config", "user.email", "runtime-source@example.invalid")
        self.git(root, "add", ".")
        self.git(root, "commit", "--quiet", "-m", "candidate")
        source_commit = self.git(root, "rev-parse", "HEAD")
        epoch = self.git(root, "show", "-s", "--format=%ct", source_commit)
        created = dt.datetime.fromtimestamp(int(epoch), tz=dt.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        pinned = f"""x-build:
  args:
    CREATED: ${{CREATED:-{created}}}
    SOURCE_DATE_EPOCH: ${{SOURCE_DATE_EPOCH:-{epoch}}}
    VCS_REF: ${{VCS_REF:-{source_commit}}}
"""
        for compose in ("compose.yaml", "compose.dev.yaml"):
            root.joinpath(compose).write_text(pinned, encoding="utf-8")
        return {"sourceCommit": source_commit}, source_commit, pinned

    def test_accepts_approval_only_drift_and_rejects_runtime_or_compose_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            review, _, pinned = self.fixture(root)
            self.assertEqual([], _approved_runtime_source_violations(root, review))

            root.joinpath("package.json").write_text('{"name":"changed"}\n', encoding="utf-8")
            violations = _approved_runtime_source_violations(root, review)
            self.assertTrue(
                any(violation.rule == "approved runtime source drift" for violation in violations)
            )

            self.git(root, "restore", "package.json")
            root.joinpath("compose.yaml").write_text(
                pinned.replace("VCS_REF:-", "VCS_REF:-wrong-"), encoding="utf-8"
            )
            violations = _approved_runtime_source_violations(root, review)
            self.assertTrue(
                any(
                    violation.path == "compose.yaml"
                    and violation.rule
                    == "default build metadata is not the approved runtime source"
                    for violation in violations
                )
            )


if __name__ == "__main__":
    unittest.main()
