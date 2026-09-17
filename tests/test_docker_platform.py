from __future__ import annotations

import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
NORMALIZER = REPOSITORY_ROOT / "scripts" / "normalize-docker-platform.sh"
SMOKE = REPOSITORY_ROOT / "scripts" / "smoke-container.sh"


class DockerPlatformTests(unittest.TestCase):
    def normalize(self, output: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(NORMALIZER)],
            input=output,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_normalizes_whitespace_and_blank_lines(self) -> None:
        for output, expected in (
            ("\n aarch64 \n\n", "linux/arm64\n"),
            ("\n\tarm64\r\n", "linux/arm64\n"),
            ("  x86_64\n", "linux/amd64\n"),
            ("\n amd64 \n", "linux/amd64\n"),
        ):
            with self.subTest(output=output):
                result = self.normalize(output)
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertEqual(expected, result.stdout)

    def test_rejects_unknown_blank_and_multiple_architectures(self) -> None:
        for output in ("", "\n \t\n", "s390x\n", "aarch64\namd64\n", "arm64\narm64\n"):
            with self.subTest(output=output):
                result = self.normalize(output)
                self.assertNotEqual(0, result.returncode)
                self.assertEqual("", result.stdout)

    def test_omitted_platform_uses_normalized_fallback_architecture(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            docker = root / "docker"
            log = root / "docker.log"
            docker.write_text(
                textwrap.dedent(
                    """\
                    #!/bin/sh
                    printf '%s\\n' "$*" >> "$DOCKER_TEST_LOG"
                    if [ "$1" = image ] && [ "$2" = inspect ] && [ "$3" = --format ]; then
                      printf '\\n'
                      exit 1
                    fi
                    if [ "$1" = info ]; then
                      printf ' aarch64 \\n'
                      exit 0
                    fi
                    if [ "$1" = image ] && [ "$2" = inspect ]; then
                      exit 0
                    fi
                    if [ "$1" = volume ]; then
                      exit 0
                    fi
                    if [ "$1" = run ]; then
                      exit 42
                    fi
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            docker.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = f"{root}:{environment['PATH']}"
            environment["DOCKER_TEST_LOG"] = str(log)
            environment["PAPERCLIP_RUN_SCRATCH_DIR"] = str(root / "scratch")

            result = subprocess.run(
                [str(SMOKE), "fixture:image"],
                text=True,
                capture_output=True,
                env=environment,
                check=False,
            )

            self.assertEqual(42, result.returncode, result.stderr)
            commands = log.read_text(encoding="utf-8").splitlines()
            self.assertIn("image inspect --format {{.Architecture}} fixture:image", commands)
            self.assertIn("info --format {{.Architecture}}", commands)
            self.assertTrue(
                any(command.startswith("run -d --platform linux/arm64 ") for command in commands),
                commands,
            )


if __name__ == "__main__":
    unittest.main()
