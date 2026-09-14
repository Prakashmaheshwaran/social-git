"""Minimal core/worker process contract for hardened container packaging.

The core owns SQLite and the session-key mount. The worker deliberately has no
database or secret integration. Product services can replace the request
handler while preserving these process and readiness contracts.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import stat
import sys
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
MINIMUM_SESSION_KEY_BYTES = 32
MAXIMUM_SESSION_KEY_BYTES = 4096


def _database_uri(path: Path, mode: str) -> str:
    return f"file:{path.resolve().as_posix()}?mode={mode}"


def ensure_database(path: Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=5.0) as connection:
        journal_mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        if str(journal_mode).lower() != "wal":
            raise RuntimeError("sqlite_wal_unavailable")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS runtime_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                schema_version INTEGER NOT NULL CHECK (schema_version > 0)
            ) STRICT
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO runtime_meta(singleton, schema_version) VALUES (1, ?)",
            (SCHEMA_VERSION,),
        )
        connection.commit()
    os.chmod(path, 0o600)


def database_is_ready(path: Path) -> bool:
    try:
        with sqlite3.connect(_database_uri(path, "ro"), uri=True, timeout=1.0) as connection:
            row = connection.execute(
                "SELECT schema_version FROM runtime_meta WHERE singleton = 1"
            ).fetchone()
            return row == (SCHEMA_VERSION,)
    except (OSError, sqlite3.Error):
        return False


def session_key_is_ready(path: Path) -> bool:
    try:
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            return False
        with path.open("rb") as key_file:
            size = len(key_file.read(MAXIMUM_SESSION_KEY_BYTES + 1))
        return MINIMUM_SESSION_KEY_BYTES <= size <= MAXIMUM_SESSION_KEY_BYTES
    except OSError:
        return False


class ReadinessProbe(Protocol):
    role: str

    def readiness(self) -> tuple[bool, list[str]]: ...


@dataclass(frozen=True)
class CoreReadiness:
    database_path: Path
    session_key_path: Path
    role: str = "core"

    def readiness(self) -> tuple[bool, list[str]]:
        reasons: list[str] = []
        if not session_key_is_ready(self.session_key_path):
            reasons.append("session_key_unavailable")
        try:
            ensure_database(self.database_path)
        except (OSError, sqlite3.Error, RuntimeError):
            reasons.append("database_unavailable")
        if "database_unavailable" not in reasons and not database_is_ready(self.database_path):
            reasons.append("database_unavailable")
        return not reasons, reasons


@dataclass(frozen=True)
class WorkerReadiness:
    role: str = "worker"

    def readiness(self) -> tuple[bool, list[str]]:
        return True, []


class RuntimeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], probe: ReadinessProbe) -> None:
        self.probe = probe
        super().__init__(address, RuntimeHandler)


class RuntimeHandler(BaseHTTPRequestHandler):
    server: RuntimeServer
    protocol_version = "HTTP/1.1"

    def _reply(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _dispatch(self) -> None:
        path = urlsplit(self.path).path
        if path == "/healthz":
            self._reply(
                HTTPStatus.OK,
                {"role": self.server.probe.role, "status": "ok"},
            )
            return
        if path == "/readyz":
            ready, reasons = self.server.probe.readiness()
            self._reply(
                HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "reasons": reasons,
                    "role": self.server.probe.role,
                    "status": "ready" if ready else "not_ready",
                },
            )
            return
        self._reply(HTTPStatus.NOT_FOUND, {"status": "not_found"})

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        self._dispatch()

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        self._dispatch()

    def log_message(self, message_format: str, *args: object) -> None:
        del message_format, args
        record = {
            "method": self.command,
            "path": urlsplit(self.path).path,
            "role": self.server.probe.role,
        }
        print(json.dumps(record, separators=(",", ":"), sort_keys=True), flush=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a Social Git container process")
    parser.add_argument("role", choices=("core", "worker"))
    parser.add_argument("--host", default=os.environ.get("SOCIAL_GIT_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int)
    return parser.parse_args(argv)


def build_probe(role: str) -> ReadinessProbe:
    if role == "worker":
        return WorkerReadiness()
    return CoreReadiness(
        database_path=Path(
            os.environ.get(
                "SOCIAL_GIT_DATABASE_PATH",
                "/var/lib/social-git/social-git.sqlite3",
            )
        ),
        session_key_path=Path(
            os.environ.get(
                "SOCIAL_GIT_SESSION_KEY_FILE",
                "/run/secrets/social_git_session_key",
            )
        ),
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    port = args.port or int(
        os.environ.get("SOCIAL_GIT_PORT", "8080" if args.role == "core" else "8081")
    )
    if not 1 <= port <= 65535:
        print("error: invalid listen port", file=sys.stderr)
        return 2

    server = RuntimeServer((args.host, port), build_probe(args.role))

    def stop_server(signum: int, frame: object) -> None:
        del signum, frame
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    print(
        json.dumps(
            {"event": "started", "port": port, "role": args.role},
            separators=(",", ":"),
            sort_keys=True,
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
