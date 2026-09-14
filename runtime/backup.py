"""Crash-safe SQLite backup, validation, and restore helpers."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

from runtime.service import SCHEMA_VERSION, _database_uri


class BackupError(RuntimeError):
    """A redacted backup or restore failure."""


def validate_database(path: Path) -> None:
    if not path.is_file() or path.is_symlink():
        raise BackupError("database_missing")
    try:
        with sqlite3.connect(_database_uri(path, "ro"), uri=True, timeout=5.0) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            if integrity != ("ok",):
                raise BackupError("database_integrity_failed")
            schema = connection.execute(
                "SELECT schema_version FROM runtime_meta WHERE singleton = 1"
            ).fetchone()
            if schema != (SCHEMA_VERSION,):
                raise BackupError("database_schema_invalid")
    except sqlite3.Error as error:
        raise BackupError("database_validation_failed") from error


def _temporary_path(destination: Path) -> Path:
    return destination.with_name(f".{destination.name}.tmp-{os.getpid()}")


def backup_database(database: Path, destination: Path) -> None:
    if database.resolve() == destination.resolve():
        raise BackupError("source_matches_destination")
    validate_database(database)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = _temporary_path(destination)
    try:
        temporary.unlink(missing_ok=True)
        with sqlite3.connect(_database_uri(database, "ro"), uri=True, timeout=5.0) as source:
            with sqlite3.connect(temporary, timeout=5.0) as target:
                source.backup(target)
        os.chmod(temporary, 0o600)
        validate_database(temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def restore_database(backup: Path, destination: Path, replace: bool = False) -> None:
    if backup.resolve() == destination.resolve():
        raise BackupError("source_matches_destination")
    validate_database(backup)
    if destination.exists() and not replace:
        raise BackupError("destination_exists")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = _temporary_path(destination)
    try:
        temporary.unlink(missing_ok=True)
        with sqlite3.connect(_database_uri(backup, "ro"), uri=True, timeout=5.0) as source:
            with sqlite3.connect(temporary, timeout=5.0) as target:
                source.backup(target)
        os.chmod(temporary, 0o600)
        validate_database(temporary)
        if replace:
            destination.with_name(f"{destination.name}-wal").unlink(missing_ok=True)
            destination.with_name(f"{destination.name}-shm").unlink(missing_ok=True)
        os.replace(temporary, destination)
        validate_database(destination)
    finally:
        temporary.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage the Social Git SQLite database")
    subparsers = parser.add_subparsers(dest="operation", required=True)

    backup_parser = subparsers.add_parser("backup")
    backup_parser.add_argument("--database", type=Path, required=True)
    backup_parser.add_argument("--output", type=Path, required=True)

    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--backup", type=Path, required=True)
    restore_parser.add_argument("--database", type=Path, required=True)
    restore_parser.add_argument("--replace", action="store_true")

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--database", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.operation == "backup":
            backup_database(args.database, args.output)
        elif args.operation == "restore":
            restore_database(args.backup, args.database, args.replace)
        else:
            validate_database(args.database)
    except (BackupError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"operation": args.operation, "status": "ok"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
