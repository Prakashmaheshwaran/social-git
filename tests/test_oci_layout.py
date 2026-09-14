from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VERIFIER = REPO_ROOT / "scripts" / "verify-oci-layout.py"


def canonical(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def descriptor(value: object, media_type: str, **extra: object) -> tuple[dict, bytes]:
    body = canonical(value)
    return (
        {
            "digest": f"sha256:{hashlib.sha256(body).hexdigest()}",
            "mediaType": media_type,
            "size": len(body),
            **extra,
        },
        body,
    )


class OciLayoutTests(unittest.TestCase):
    def make_archive(self, path: Path, ref_name: str = "social-git:test") -> str:
        blobs: dict[str, bytes] = {}
        manifests = []
        for architecture in ("amd64", "arm64"):
            config_descriptor, config_body = descriptor(
                {"architecture": architecture, "os": "linux"},
                "application/vnd.oci.image.config.v1+json",
            )
            blobs[config_descriptor["digest"]] = config_body
            manifest_descriptor, manifest_body = descriptor(
                {
                    "config": config_descriptor,
                    "layers": [],
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "schemaVersion": 2,
                },
                "application/vnd.oci.image.manifest.v1+json",
                platform={"architecture": architecture, "os": "linux"},
            )
            blobs[manifest_descriptor["digest"]] = manifest_body
            manifests.append(manifest_descriptor)

        release_descriptor, release_body = descriptor(
            {
                "manifests": manifests,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "schemaVersion": 2,
            },
            "application/vnd.oci.image.index.v1+json",
            annotations={"org.opencontainers.image.ref.name": ref_name},
        )
        blobs[release_descriptor["digest"]] = release_body
        index = {"manifests": [release_descriptor], "schemaVersion": 2}
        layout = {"imageLayoutVersion": "1.0.0"}

        with tarfile.open(path, "w") as archive:
            for name, body in (
                ("oci-layout", canonical(layout)),
                ("index.json", canonical(index)),
            ):
                member = tarfile.TarInfo(name)
                member.size = len(body)
                archive.addfile(member, io.BytesIO(body))
            for digest, body in sorted(blobs.items()):
                name = f"blobs/sha256/{digest.removeprefix('sha256:')}"
                member = tarfile.TarInfo(name)
                member.size = len(body)
                archive.addfile(member, io.BytesIO(body))
        return release_descriptor["digest"]

    def test_reports_and_checks_release_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "image.tar"
            output = Path(temporary) / "metadata.json"
            release_digest = self.make_archive(archive)
            result = subprocess.run(
                [
                    sys.executable,
                    str(VERIFIER),
                    "--archive",
                    str(archive),
                    "--require-platform",
                    "linux/amd64",
                    "--require-platform",
                    "linux/arm64",
                    "--expect-release-digest",
                    release_digest,
                    "--output",
                    str(output),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(result.stdout)
            self.assertEqual(report, json.loads(output.read_text()))
            self.assertEqual(report["releaseDigest"], release_digest)
            self.assertEqual(report["refName"], "social-git:test")
            self.assertEqual(
                set(report["platformManifests"]),
                {"linux/amd64", "linux/arm64"},
            )

            mismatch = subprocess.run(
                [
                    sys.executable,
                    str(VERIFIER),
                    "--archive",
                    str(archive),
                    "--expect-release-digest",
                    "sha256:" + "0" * 64,
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("release digest mismatch", mismatch.stderr)


if __name__ == "__main__":
    unittest.main()
