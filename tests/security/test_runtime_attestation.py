from __future__ import annotations

import io
import tarfile
import unittest

from tools.security.attest_runtime import (
    AttestationError,
    FileEntry,
    ImageRecord,
    LayeredFilesystem,
    image_policy_checks,
    merge_review_components,
    parse_debian_status,
)


def make_layer(entries: list[tuple[str, bytes | str | None, str]]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for path, value, kind in entries:
            member = tarfile.TarInfo(path)
            member.mtime = 0
            if kind == "file":
                assert isinstance(value, bytes)
                member.size = len(value)
                member.mode = 0o644
                archive.addfile(member, io.BytesIO(value))
            elif kind == "directory":
                member.type = tarfile.DIRTYPE
                member.mode = 0o755
                archive.addfile(member)
            elif kind == "symlink":
                assert isinstance(value, str)
                member.type = tarfile.SYMTYPE
                member.linkname = value
                archive.addfile(member)
            else:
                raise AssertionError(kind)
    return output.getvalue()


def component(platform: str, version: str = "1.0.0") -> dict[str, object]:
    return {
        "architecture": platform.split("/", 1)[1],
        "contentSha256": "a" * 64,
        "ecosystem": "deb",
        "installScripts": [],
        "key": "deb:safe",
        "licenseEvidence": {
            "markers": ["MIT"],
            "path": "/usr/share/doc/safe/copyright",
            "sha256": "b" * 64,
        },
        "name": "safe",
        "source": {
            "locator": "https://example.invalid/safe",
            "name": "safe",
            "version": version,
        },
        "version": version,
    }


class RuntimeAttestationTests(unittest.TestCase):
    def test_layer_overlay_resolves_directory_symlink_and_whiteout(self) -> None:
        filesystem = LayeredFilesystem()
        filesystem.apply(
            make_layer(
                [
                    ("usr/share/doc/real/copyright", b"License: MIT\n", "file"),
                    ("usr/share/doc/alias", "real", "symlink"),
                    ("opt/social-git/old.py", b"old", "file"),
                ]
            )
        )
        self.assertEqual(
            b"License: MIT\n", filesystem.read("usr/share/doc/alias/copyright")
        )

        filesystem.apply(
            make_layer(
                [
                    ("opt/social-git/.wh.old.py", None, "directory"),
                    ("opt/social-git/new.py", b"new", "file"),
                ]
            )
        )
        self.assertNotIn("opt/social-git/old.py", filesystem.entries)
        self.assertEqual(b"new", filesystem.read("opt/social-git/new.py"))

    def test_rejects_parent_traversal_in_layer(self) -> None:
        filesystem = LayeredFilesystem()
        layer = make_layer([("../escape", b"bad", "file")])
        with self.assertRaisesRegex(AttestationError, "unsafe path"):
            filesystem.apply(layer)

    def test_parses_debian_continuation_fields_without_corrupting_version(self) -> None:
        status = b"""Package: safe
Status: install ok installed
Architecture: amd64
Version: 1.2.3-1
Conffiles:
 /etc/safe.conf abcdef

Package: removed
Status: deinstall ok config-files
Architecture: amd64
Version: 9
"""
        self.assertEqual(
            [
                {
                    "Architecture": "amd64",
                    "Conffiles": "\n/etc/safe.conf abcdef",
                    "Package": "safe",
                    "Status": "install ok installed",
                    "Version": "1.2.3-1",
                }
            ],
            parse_debian_status(status),
        )

    def test_merges_matching_closure_with_architecture_integrity(self) -> None:
        merged = merge_review_components(
            {
                "linux/amd64": [component("linux/amd64")],
                "linux/arm64": [component("linux/arm64")],
            }
        )
        self.assertEqual(["deb:safe"], [item["key"] for item in merged])
        self.assertEqual(
            {"linux/amd64", "linux/arm64"}, set(merged[0]["artifacts"])
        )

    def test_rejects_architecture_specific_version_drift(self) -> None:
        with self.assertRaisesRegex(AttestationError, "architecture-specific dependency drift"):
            merge_review_components(
                {
                    "linux/amd64": [component("linux/amd64")],
                    "linux/arm64": [component("linux/arm64", version="2.0.0")],
                }
            )

    def test_image_policy_finds_browser_config_component_and_root_user(self) -> None:
        filesystem = LayeredFilesystem()
        filesystem.entries = {
            "opt/social-git/runtime/config.py": FileEntry(
                kind="file",
                mode=0o444,
                size=33,
                sha256="a" * 64,
                data=b"https://oauth.reddit.com/example",
            ),
            "usr/bin/chromedriver": FileEntry(
                kind="file", mode=0o755, size=1, sha256="b" * 64
            ),
            "usr/bin/pip3": FileEntry(
                kind="file", mode=0o755, size=1, sha256="c" * 64
            ),
        }
        image = ImageRecord(
            platform="linux/amd64",
            release_digest="sha256:" + "1" * 64,
            manifest_digest="sha256:" + "2" * 64,
            config_digest="sha256:" + "3" * 64,
            layer_digests=("sha256:" + "4" * 64,),
            config={"config": {"Env": ["REDDIT_CLIENT_ID=hidden"], "User": "0"}},
            filesystem=filesystem,
        )
        checks = image_policy_checks(
            image,
            [{"ecosystem": "pypi", "name": "playwright", "version": "1.2.3"}],
        )

        self.assertTrue(checks["forbiddenApplicationConfig"])
        self.assertEqual(["pypi:playwright@1.2.3"], checks["forbiddenComponents"])
        self.assertEqual(["/usr/bin/chromedriver"], checks["forbiddenExecutables"])
        self.assertEqual(["0"], checks["unexpectedUser"])
        self.assertEqual(["/usr/bin/pip3"], checks["unexpectedRuntimeTooling"])


if __name__ == "__main__":
    unittest.main()
