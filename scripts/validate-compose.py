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


def source_names(items: list[dict[str, Any] | str]) -> set[str]:
    return {str(item.get("source")) for item in items if isinstance(item, dict)}


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
# Source names, not targets: the X worker's admission targets are deliberately
# identical to Core's, so only the source distinguishes the two consumers.
core_sources = source_names(core.get("secrets") or [])
worker_sources = source_names(worker.get("secrets") or [])
x_worker_sources = source_names(x_worker.get("secrets") or [])
required_core_volumes = {
    "/var/lib/social-git",
    "/var/lib/social-git/backups",
    "/var/lib/social-git/import",
    "/var/lib/social-git/restore",
}
if core_volumes != required_core_volumes:
    fail("core database, backup, import, and restore volumes must be exact")
if worker_volumes:
    fail("worker must not receive volumes in file-secret Compose modes")
if x_worker_volumes != {"/var/lib/social-git-x-worker"}:
    fail("X worker must receive only its durable certification replay state volume")
if (x_worker.get("environment") or {}).get("SOCIAL_GIT_X_CERTIFICATION_DATABASE") != "/var/lib/social-git-x-worker/certification.sqlite":
    fail("X worker certification database must use the private durable worker volume")
required_core_secrets = {
    "social_git_master_key",
    "social_git_audit_key",
    "social_git_auth",
    "social_git_backup_key",
    "social_git_reddit_command_key",
    "social_git_x_command_key",
}
admission_core_secrets = {
    "social_git_admission_envelope",
    "social_git_admission_qa_public_key",
    "social_git_admission_approver_public_key",
    "social_git_admission_evidence_private_key",
    "social_git_admission_evidence_public_key",
}
# Non-Swarm Compose ignores uid/gid/mode and bind-mounts the host file as-is, so
# a single host file cannot be both owner-only for Core and readable by the X
# worker. Each consumer gets its own byte-identical host copy.
admission_worker_public = {
    "social_git_admission_x_worker_envelope",
    "social_git_admission_x_worker_qa_public_key",
    "social_git_admission_x_worker_approver_public_key",
}
admission_enabled = "SOCIAL_GIT_ADMISSION_ENVELOPE_FILE" in (core.get("environment") or {})
if admission_enabled:
    required_core_secrets |= admission_core_secrets
if core_secrets != required_core_secrets:
    fail("core master, audit, authentication, and backup secrets must be exact")
for secret in core.get("secrets") or []:
    if secret.get("uid") != "10001" or secret.get("gid") != "10001" or str(secret.get("mode")) != "0400":
        fail("every Core secret must be owned by 10001:10001 with mode 0400")
if worker_secrets != {"social_git_reddit_command_key"}:
    fail("Reddit worker must receive only the distinct Reddit command-authentication secret")
expected_x_worker_sources = {"social_git_x_command_key"} | (admission_worker_public if admission_enabled else set())
# Source-based: the X worker's admission targets deliberately equal Core's, so
# only the source names can distinguish the two consumers.
if x_worker_sources != expected_x_worker_sources:
    fail("X worker must receive only the X command secret and its own admission copies")
if admission_enabled:
    if core_sources & admission_core_secrets != admission_core_secrets:
        fail("Core must receive all five admission sources")
    if worker_sources & (admission_core_secrets | admission_worker_public):
        fail("Reddit worker must not receive admission envelope, approval, or evidence keys")
    if core_sources & admission_worker_public:
        fail("Core must not receive the X worker's admission copies")
    if x_worker_sources & (admission_core_secrets | admission_worker_public) != admission_worker_public:
        fail("X worker must receive exactly its own three admission copies")
    if x_worker_sources & {"social_git_admission_evidence_private_key", "social_git_admission_evidence_public_key", "social_git_reddit_command_key"}:
        fail("X worker must not receive evidence keys or the Reddit command key")
    expected_core_admission_environment = {
        "SOCIAL_GIT_ADMISSION_ENVELOPE_FILE": "/run/secrets/social_git_admission_envelope",
        "SOCIAL_GIT_ADMISSION_QA_PUBLIC_KEY_FILE": "/run/secrets/social_git_admission_qa_public_key",
        "SOCIAL_GIT_ADMISSION_APPROVER_PUBLIC_KEY_FILE": "/run/secrets/social_git_admission_approver_public_key",
        "SOCIAL_GIT_ADMISSION_EVIDENCE_PRIVATE_KEY_FILE": "/run/secrets/social_git_admission_evidence_private_key",
        "SOCIAL_GIT_ADMISSION_EVIDENCE_PUBLIC_KEY_FILE": "/run/secrets/social_git_admission_evidence_public_key",
    }
    for name, path in expected_core_admission_environment.items():
        if (core.get("environment") or {}).get(name) != path:
            fail(f"Core admission path {name} is incorrect")
    for name in ("SOCIAL_GIT_ADMISSION_ENVELOPE_FILE", "SOCIAL_GIT_ADMISSION_QA_PUBLIC_KEY_FILE", "SOCIAL_GIT_ADMISSION_APPROVER_PUBLIC_KEY_FILE"):
        if (x_worker.get("environment") or {}).get(name) != expected_core_admission_environment[name]:
            fail(f"X worker public admission path {name} is incorrect")
    if "SOCIAL_GIT_ADMISSION_EVIDENCE_PRIVATE_KEY_FILE" in (x_worker.get("environment") or {}):
        fail("X worker must never receive the evidence private-key path")
for secret in x_worker.get("secrets") or []:
    if secret.get("uid") != "10002" or secret.get("gid") != "10002" or str(secret.get("mode")) != "0400":
        fail("the X command secret must be owned by 10002:10002 with mode 0400")
for secret in worker.get("secrets") or []:
    if secret.get("uid") != "10002" or secret.get("gid") != "10002" or str(secret.get("mode")) != "0400":
        fail("the Reddit command secret must be owned by 10002:10002 with mode 0400")

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
if core_environment.get("SOCIAL_GIT_SESSION_COOKIE_SECURE") != "true":
    fail("core must default to secure session cookies")
if core_environment.get("SOCIAL_GIT_REDDIT_WORKER_URL") != "http://reddit-worker:8081/v1/dispatch":
    fail("core must use the internal Reddit worker dispatch endpoint")
if core_environment.get("SOCIAL_GIT_X_WORKER_URL") != "http://x-worker:8082/v1/dispatch":
    fail("core must use the internal X worker dispatch endpoint")
if core_environment.get("SOCIAL_GIT_X_COMMAND_KEY_FILE") != "/run/secrets/social_git_x_command_key":
    fail("core X command-authentication key path is incorrect")
if x_worker_environment.get("SOCIAL_GIT_X_COMMAND_KEY_FILE") != "/run/secrets/social_git_x_command_key":
    fail("X worker command-authentication key path is incorrect")
if core_environment.get("SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE") != "/run/secrets/social_git_reddit_command_key":
    fail("core Reddit command-authentication key path is incorrect")
if worker_environment.get("SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE") != "/run/secrets/social_git_reddit_command_key":
    fail("Reddit worker command-authentication key path is incorrect")
if ((core.get("depends_on") or {}).get("reddit-worker") or {}).get("condition") != "service_healthy":
    fail("core must wait for Reddit worker readiness")
if ((core.get("depends_on") or {}).get("x-worker") or {}).get("condition") != "service_healthy":
    fail("core must wait for X worker readiness")
expected_ready = ["CMD", "node", "/opt/social-git/runtime/healthcheck.mjs", "/readyz"]
expected_x_liveness = ["CMD", "node", "/opt/social-git/runtime/healthcheck.mjs", "/healthz"]
if (core.get("healthcheck") or {}).get("test") != expected_ready:
    fail("Core must use the in-image readiness probe")
if (worker.get("healthcheck") or {}).get("test") != expected_x_liveness or (x_worker.get("healthcheck") or {}).get("test") != expected_x_liveness:
    fail("workers must use the unauthenticated in-image liveness probe")

print(json.dumps({"boundary": "core-owns-state-and-secrets", "status": "ok"}, sort_keys=True))
