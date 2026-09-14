#!/usr/bin/env bash
set -Eeuo pipefail

container=${1:?Usage: scripts/backup-restore-smoke.sh RUNNING_CORE_CONTAINER}
database=/var/lib/social-git/social-git.sqlite3
backup=/var/lib/social-git/backups/smoke.sqlite3
restored=/var/lib/social-git/restored.sqlite3

docker exec "$container" python -m runtime.backup backup \
  --database "$database" \
  --output "$backup"
docker exec "$container" python -m runtime.backup validate --database "$backup"
docker exec "$container" python -m runtime.backup restore \
  --backup "$backup" \
  --database "$restored" \
  --replace
docker exec "$container" python -m runtime.backup validate --database "$restored"
docker exec "$container" python -c '
import os
import sqlite3

path = "/var/lib/social-git/restored.sqlite3"
with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
    assert connection.execute("SELECT schema_version FROM runtime_meta WHERE singleton=1").fetchone() == (1,)
assert os.stat(path).st_mode & 0o777 == 0o600
print("backup_restore=ok")
'
