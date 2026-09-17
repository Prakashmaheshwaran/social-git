#!/usr/bin/env python3
"""Validate the core/worker security boundary in rendered Compose JSON."""

from __future__ import annotations

import json
import sys
from typing import Any


def target_names(items: list[dict[str, Any] | str]) -> set[str]:
    names: set[str] = set()
    for item in items:
        if isinstance(item, str):
            names.add(item)
        else:
            names.add(str(item.get("target") or item.get("source") or ""))
    return names


def fail(message: str) -> None:
    raise SystemExit(message)


document = json.load(sys.stdin)
services = document.get("services") or {}
core = services.get("core") or fail("core service missing")
worker = services.get("reddit-worker") or fail("reddit-worker service missing")
x_worker = services.get("x-worker") or fail("x-worker service missing")

expected_users = {"core": "10001:10001", "reddit-worker": "10002:10002", "x-worker": "10002:10002"}
for name, service in (("core", core), ("reddit-worker", worker), ("x-worker", x_worker)):
    if service.get("read_only") is not True:
        fail(f"{name} must use a read-only root filesystem")
    if service.get("privileged") is True:
        fail(f"{name} must not be privileged")
    if service.get("user") != expected_users[name]:
        fail(f"{name} must run as {expected_users[name]}")
    if "ALL" not in set(service.get("cap_drop") or []):
        fail(f"{name} must drop all capabilities")
    if not any("no-new-privileges" in item for item in service.get("security_opt") or []):
        fail(f"{name} must set no-new-privileges")
    limits = ((service.get("deploy") or {}).get("resources") or {}).get("limits") or {}
    if not limits.get("cpus") or not limits.get("memory"):
        fail(f"{name} must declare CPU and memory limits")

core_volumes = target_names(core.get("volumes") or [])
worker_volumes = target_names(worker.get("volumes") or [])
x_worker_volumes = target_names(x_worker.get("volumes") or [])
core_secrets = target_names(core.get("secrets") or [])
worker_secrets = target_names(worker.get("secrets") or [])
x_worker_secrets = target_names(x_worker.get("secrets") or [])
required_core_volumes = {
    "/var/lib/social-git",
    "/var/lib/social-git/backups",
    "/var/lib/social-git/import",
    "/var/lib/social-git/restore",
}
if core_volumes != required_core_volumes:
    fail("core database, backup, import, and restore volumes must be exact")
if worker_volumes:
    fail("worker must not receive volumes")
if x_worker_volumes:
    fail("X worker must not receive volumes")
required_core_secrets = {
    "social_git_master_key",
    "social_git_audit_key",
    "social_git_auth",
    "social_git_backup_key",
}
if core_secrets != required_core_secrets:
    fail("core master, audit, authentication, and backup secrets must be exact")
for secret in core.get("secrets") or []:
    if secret.get("uid") != "10001" or secret.get("gid") != "10001" or str(secret.get("mode")) != "0400":
        fail("every Core secret must be owned by 10001:10001 with mode 0400")
if worker_secrets:
    fail("worker must not receive secrets")
if x_worker_secrets:
    fail("X worker must not receive secrets")

core_networks = set((core.get("networks") or {}).keys())
worker_networks = set((worker.get("networks") or {}).keys())
x_worker_networks = set((x_worker.get("networks") or {}).keys())
if not {"reddit-command", "twitter-command"}.issubset(core_networks):
    fail("core platform-command networks missing")
if "reddit-egress" in core_networks:
    fail("core must not attach to the Reddit egress network")
if "twitter-egress" in core_networks:
    fail("core must not attach to the X egress network")
if worker_networks != {"reddit-command", "reddit-egress"}:
    fail("worker must attach only to its private command network and Reddit egress")
if x_worker_networks != {"twitter-command", "twitter-egress"}:
    fail("X worker must attach only to its private command network and X egress")
if worker_networks & x_worker_networks:
    fail("platform workers must not share a network")

if core.get("command") != ["core"]:
    fail("core must start the executable gateway")
if worker.get("command") != ["worker"]:
    fail("worker must start the executable Reddit worker")
if x_worker.get("command") != ["x-worker"]:
    fail("X worker must start the fail-closed candidate worker")

core_environment = core.get("environment") or {}
worker_environment = worker.get("environment") or {}
x_worker_environment = x_worker.get("environment") or {}
for forbidden in ("SOCIAL_GIT_DATA_DIR", "SOCIAL_GIT_MASTER_KEY_FILE", "SOCIAL_GIT_AUDIT_KEY_FILE", "SOCIAL_GIT_BACKUP_KEY_FILE", "SOCIAL_GIT_AUTH_FILE"):
    if forbidden in worker_environment:
        fail(f"worker must not receive {forbidden}")
    if forbidden in x_worker_environment:
        fail(f"X worker must not receive {forbidden}")
if core_environment.get("SOCIAL_GIT_MODE") != "production":
    fail("core must default to production mode")
if core_environment.get("SOCIAL_GIT_REDDIT_WORKER_URL") != "http://reddit-worker:8081/v1/dispatch":
    fail("core must use the internal Reddit worker dispatch endpoint")
if core_environment.get("SOCIAL_GIT_X_WORKER_URL") != "http://x-worker:8082/v1/dispatch":
    fail("core must use the internal X worker dispatch endpoint")
if ((core.get("depends_on") or {}).get("reddit-worker") or {}).get("condition") != "service_healthy":
    fail("core must wait for Reddit worker readiness")
if ((core.get("depends_on") or {}).get("x-worker") or {}).get("condition") != "service_healthy":
    fail("core must wait for X worker readiness")

print(json.dumps({"boundary": "core-owns-state-and-secrets", "status": "ok"}, sort_keys=True))
