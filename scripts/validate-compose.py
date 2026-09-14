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

for name, service in (("core", core), ("reddit-worker", worker)):
    if service.get("read_only") is not True:
        fail(f"{name} must use a read-only root filesystem")
    if service.get("privileged") is True:
        fail(f"{name} must not be privileged")
    if service.get("user") != "10001:10001":
        fail(f"{name} must run as UID/GID 10001")
    if "ALL" not in set(service.get("cap_drop") or []):
        fail(f"{name} must drop all capabilities")
    if not any("no-new-privileges" in item for item in service.get("security_opt") or []):
        fail(f"{name} must set no-new-privileges")
    limits = ((service.get("deploy") or {}).get("resources") or {}).get("limits") or {}
    if not limits.get("cpus") or not limits.get("memory"):
        fail(f"{name} must declare CPU and memory limits")

core_volumes = target_names(core.get("volumes") or [])
worker_volumes = target_names(worker.get("volumes") or [])
core_secrets = target_names(core.get("secrets") or [])
worker_secrets = target_names(worker.get("secrets") or [])
if "/var/lib/social-git" not in core_volumes:
    fail("core persistent SQLite volume missing")
if worker_volumes:
    fail("worker must not receive volumes")
if "social_git_session_key" not in core_secrets:
    fail("core session-key secret mount missing")
if worker_secrets:
    fail("worker must not receive secrets")

core_networks = set((core.get("networks") or {}).keys())
worker_networks = set((worker.get("networks") or {}).keys())
if "worker-boundary" not in core_networks:
    fail("core worker-boundary network missing")
if worker_networks != {"worker-boundary"}:
    fail("worker must attach only to worker-boundary")

print(json.dumps({"boundary": "core-owns-state-and-secrets", "status": "ok"}, sort_keys=True))
