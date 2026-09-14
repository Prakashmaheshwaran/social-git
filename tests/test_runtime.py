from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from runtime.backup import BackupError, backup_database, restore_database, validate_database
from runtime.service import SCHEMA_VERSION, ensure_database


REPO_ROOT = Path(__file__).resolve().parents[1]


def unused_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class ServiceProcess:
    def __init__(self, role: str, directory: Path, with_key: bool = True) -> None:
        self.port = unused_port()
        self.database = directory / f"{role}.sqlite3"
        key_file = directory / "session-key"
        if with_key:
            key_file.write_bytes(b"unit-test-key-material-is-not-live")
            key_file.chmod(0o600)
        environment = os.environ.copy()
        environment.update(
            {
                "PYTHONPATH": str(REPO_ROOT),
                "SOCIAL_GIT_DATABASE_PATH": str(self.database),
                "SOCIAL_GIT_PORT": str(self.port),
                "SOCIAL_GIT_SESSION_KEY_FILE": str(key_file),
            }
        )
        self.process = subprocess.Popen(
            [sys.executable, "-m", "runtime.service", role, "--host", "127.0.0.1"],
            cwd=REPO_ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.wait_for_health()

    def wait_for_health(self) -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                output = self.process.stdout.read() if self.process.stdout else ""
                raise AssertionError(f"service stopped before health check: {output}")
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{self.port}/healthz", timeout=0.2
                ) as response:
                    if response.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                time.sleep(0.05)
        raise AssertionError("service did not become healthy")

    def get(self, path: str) -> tuple[int, dict[str, object]]:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}{path}", timeout=1
            ) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.load(error)
            finally:
                error.close()

    def stop(self) -> str:
        if self.process.poll() is None:
            self.process.terminate()
        output, _ = self.process.communicate(timeout=5)
        return output


class RuntimeServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.services: list[ServiceProcess] = []

    def tearDown(self) -> None:
        for service in self.services:
            if service.process.poll() is None:
                service.stop()
        self.temporary.cleanup()

    def service(self, role: str, with_key: bool = True) -> ServiceProcess:
        service = ServiceProcess(role, self.directory, with_key)
        self.services.append(service)
        return service

    def test_core_health_and_readiness_require_key_and_database(self) -> None:
        service = self.service("core")
        self.assertEqual(service.get("/healthz"), (200, {"role": "core", "status": "ok"}))
        self.assertEqual(
            service.get("/readyz"),
            (200, {"reasons": [], "role": "core", "status": "ready"}),
        )
        with sqlite3.connect(service.database) as connection:
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone(), ("wal",))
            self.assertEqual(
                connection.execute(
                    "SELECT schema_version FROM runtime_meta WHERE singleton=1"
                ).fetchone(),
                (SCHEMA_VERSION,),
            )
        self.assertEqual(service.database.stat().st_mode & 0o777, 0o600)

    def test_core_is_live_but_not_ready_without_key(self) -> None:
        service = self.service("core", with_key=False)
        self.assertEqual(service.get("/healthz")[0], 200)
        status, payload = service.get("/readyz")
        self.assertEqual(status, 503)
        self.assertEqual(payload["reasons"], ["session_key_unavailable"])

    def test_worker_has_no_database_or_secret_dependency(self) -> None:
        service = self.service("worker", with_key=False)
        self.assertEqual(
            service.get("/readyz"),
            (200, {"reasons": [], "role": "worker", "status": "ready"}),
        )
        self.assertFalse(service.database.exists())

    def test_logs_do_not_contain_key_material(self) -> None:
        service = self.service("core")
        service.get("/readyz")
        output = service.stop()
        self.assertNotIn("unit-test-key-material-is-not-live", output)


class BackupTests(unittest.TestCase):
    def test_backup_restore_and_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            database = directory / "source.sqlite3"
            backup = directory / "backup.sqlite3"
            restored = directory / "restored.sqlite3"
            ensure_database(database)
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE proof(value TEXT NOT NULL) STRICT")
                connection.execute("INSERT INTO proof(value) VALUES ('fixture-only')")
                connection.commit()

            backup_database(database, backup)
            validate_database(backup)
            restore_database(backup, restored)
            validate_database(restored)
            with sqlite3.connect(restored) as connection:
                self.assertEqual(connection.execute("SELECT value FROM proof").fetchone(), ("fixture-only",))
            self.assertEqual(restored.stat().st_mode & 0o777, 0o600)

    def test_corrupt_backup_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            corrupt = Path(temporary) / "corrupt.sqlite3"
            corrupt.write_bytes(b"not a sqlite database")
            with self.assertRaises(BackupError):
                validate_database(corrupt)
