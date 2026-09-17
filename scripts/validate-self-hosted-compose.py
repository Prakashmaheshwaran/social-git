#!/usr/bin/env python3
"""Validate the fresh-clone Compose topology and secret/state boundaries."""

from __future__ import annotations

import json
import sys
from typing import Any


def fail(message: str) -> None:
    raise SystemExit(message)


def targets(items: list[dict[str, Any] | str]) -> set[str]:
    values: set[str] = set()
    for item in items:
        if isinstance(item, str):
            values.add(item.split(":", 1)[-1])
        else:
            values.add(str(item.get("target") or item.get("source") or ""))
    return values


document = json.load(sys.stdin)
services = document.get("services") or {}
if set(services) != {"core", "reddit-worker", "x-worker", "secrets-init"}:
    fail("default Compose must contain only core, both isolated workers, and secrets-init")
core = services["core"]
worker = services["reddit-worker"]
x_worker = services["x-worker"]
initializer = services["secrets-init"]

for name, service, user in (
    ("core", core, "10001:10001"),
    ("reddit-worker", worker, "10002:10002"),
    ("x-worker", x_worker, "10002:10002"),
    ("secrets-init", initializer, "10001:10001"),
):
    if service.get("user") != user or service.get("read_only") is not True:
        fail(f"{name} must use its unprivileged identity and read-only root filesystem")
    if service.get("privileged") is True or "ALL" not in set(service.get("cap_drop") or []):
        fail(f"{name} must be unprivileged and drop all capabilities")
    if not any("no-new-privileges" in value for value in service.get("security_opt") or []):
        fail(f"{name} must set no-new-privileges")
    if not service.get("pids_limit") or not service.get("cpus") or not service.get("mem_limit"):
        fail(f"{name} must have explicit process, CPU, and memory limits")
if not core.get("build"):
    fail("Core must provide the fresh-clone local image build")
if len({core.get("image"), worker.get("image"), x_worker.get("image"), initializer.get("image")}) != 1:
    fail("all roles must use the one locally built runtime image")

if initializer.get("command") != ["secrets-init"] or initializer.get("restart") not in ("no", "\"no\""):
    fail("secrets-init must be a one-shot initializer")
if initializer.get("network_mode") != "none" or initializer.get("networks"):
    fail("secrets-init must use the network-disabled namespace")
if targets(initializer.get("volumes") or []) != {"/var/lib/social-git/secrets"}:
    fail("secrets-init must receive only the generated-secrets volume")

expected_core = {
    "/var/lib/social-git",
    "/var/lib/social-git/backups",
    "/var/lib/social-git/import",
    "/var/lib/social-git/restore",
    "/run/social-git-secrets",
}
if targets(core.get("volumes") or []) != expected_core:
    fail("Core state, staging, backup, and secret mounts must be exact")
if worker.get("volumes") or worker.get("secrets"):
    fail("Reddit worker must not receive volumes or secrets")
if x_worker.get("volumes") or x_worker.get("secrets"):
    fail("X worker must not receive volumes or secrets")
if worker.get("ports") or x_worker.get("ports"):
    fail("platform workers must not publish host ports")
if document.get("secrets"):
    fail("default Compose must not require pre-existing host secret files")

environment = core.get("environment") or {}
expected_environment = {
    "SOCIAL_GIT_MASTER_KEY_FILE": "/run/social-git-secrets/master-key",
    "SOCIAL_GIT_AUDIT_KEY_FILE": "/run/social-git-secrets/audit-key",
    "SOCIAL_GIT_AUTH_FILE": "",
    "SOCIAL_GIT_SESSION_IMPORT_DIR": "/var/lib/social-git/import",
    "SOCIAL_GIT_REDDIT_WORKER_URL": "http://reddit-worker:8081/v1/dispatch",
    "SOCIAL_GIT_X_WORKER_URL": "http://x-worker:8082/v1/dispatch",
    "SOCIAL_GIT_MODE": "production",
}
for key, value in expected_environment.items():
    if environment.get(key) != value:
        fail(f"Core environment {key} is incorrect")

depends = core.get("depends_on") or {}
if (depends.get("secrets-init") or {}).get("condition") != "service_completed_successfully":
    fail("Core must wait for successful secret initialization")
if (depends.get("reddit-worker") or {}).get("condition") != "service_healthy":
    fail("Core must wait for Reddit worker readiness")
if (depends.get("x-worker") or {}).get("condition") != "service_healthy":
    fail("Core must wait for X worker readiness")
if set((core.get("networks") or {}).keys()) != {"api", "worker-boundary"}:
    fail("Core network boundary is incorrect")
if set((worker.get("networks") or {}).keys()) != {"worker-boundary", "reddit-egress"}:
    fail("Reddit worker network boundary is incorrect")
if set((x_worker.get("networks") or {}).keys()) != {"worker-boundary", "twitter-egress"}:
    fail("X worker network boundary is incorrect")
if (document.get("networks") or {}).get("worker-boundary", {}).get("internal") is not True:
    fail("the Core-worker command network must be internal")
if core.get("command") != ["core"] or worker.get("command") != ["worker"] or x_worker.get("command") != ["x-worker"]:
    fail("Core and worker executable roles are incorrect")
if not core.get("healthcheck") or not worker.get("healthcheck") or not x_worker.get("healthcheck"):
    fail("Core and both worker health checks are required")
expected_health = ["CMD", "node", "/opt/social-git/runtime/healthcheck.mjs", "/readyz"]
for name, service in (("core", core), ("reddit-worker", worker), ("x-worker", x_worker)):
    if (service.get("healthcheck") or {}).get("test") != expected_health:
        fail(f"{name} must use the in-image readiness probe")

ports = core.get("ports") or []
if len(ports) != 1 or str(ports[0].get("host_ip")) != "127.0.0.1" or int(ports[0].get("target", 0)) != 8080:
    fail("default public listener must bind Core to 127.0.0.1")

print(json.dumps({"status": "ok", "topology": "web-api-core-plus-isolated-reddit-and-x-workers"}, sort_keys=True))
