#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
export COMPOSE_PROJECT_NAME="social-git-smoke-$$"
export SOCIAL_GIT_PORT=0
compose=(docker compose -f "$repo_root/compose.yaml")
backup_set=smoke-restore

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" config --format json | python3 "$script_dir/validate-self-hosted-compose.py"
"${compose[@]}" up -d --build

wait_ready() {
  for _ in $(seq 1 120); do
    container_id=$("${compose[@]}" ps -q core)
    if [[ -n "$container_id" \
      && $(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true) == true \
      && $(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true) == healthy \
      ]] && docker exec "$container_id" node /opt/social-git/runtime/healthcheck.mjs /readyz >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  "${compose[@]}" ps >&2
  "${compose[@]}" logs --no-color core reddit-worker secrets-init >&2
  return 1
}
wait_ready

current_base_url() { printf 'http://%s' "$("${compose[@]}" port core 8080)"; }
base_url=$(current_base_url)
BASE_URL="$base_url" node <<'NODE'
import { randomBytes } from "node:crypto";
const base = process.env.BASE_URL;
const before = await fetch(`${base}/v1/setup/status`);
const beforeBody = await before.json();
if (before.status !== 200 || beforeBody.required !== true) throw new Error("fresh install did not require owner setup");
const ready = await fetch(`${base}/readyz`);
const readyBody = await ready.json();
if (
  ready.status !== 200 ||
  readyBody.checks?.actionWorker !== true ||
  readyBody.checks?.productWritesReady !== true ||
  readyBody.checks?.certificationGrantActive !== false ||
  readyBody.checks?.writeExecutionMode !== "product"
) throw new Error("default production product-write path is not ready without a QA grant");
const openapi = await fetch(`${base}/openapi.json`);
const contract = await openapi.json();
const redditFeed = contract.paths?.["/v1/accounts/{accountId}/feed"]?.get;
const redditParameters = new Map((redditFeed?.parameters ?? []).map((parameter) => [parameter.name, parameter.schema]));
if (
  openapi.status !== 200 ||
  redditFeed?.operationId !== "reads.feed" ||
  !redditParameters.get("sort")?.enum?.includes("rising") ||
  !redditParameters.get("timeframe")?.enum?.includes("all") ||
  contract.paths?.["/v1/accounts/{accountId}/x/timelines/home"]?.get?.operationId !== "x.timelines.home" ||
  contract.paths?.["/v1/accounts/{accountId}/x/actions"]?.post?.operationId !== "x.actions.create"
) throw new Error("rebased Reddit and X contracts are missing from the container");
const password = `Smoke-${randomBytes(24).toString("base64url")}!`;
const created = await fetch(`${base}/v1/setup/owner`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "smoke@example.invalid", displayName: "Smoke Owner", password }),
});
const body = await created.json();
if (created.status !== 201 || body.authenticated !== true || body.role !== "owner") throw new Error("owner setup failed");
console.log("first_run_owner_contracts_and_product_write_path=ok");
NODE

"$script_dir/social-git-backup.sh" "$backup_set"
wait_ready
base_url=$(current_base_url)
"${compose[@]}" restart core >/dev/null
wait_ready
base_url=$(current_base_url)
BASE_URL="$base_url" node <<'NODE'
const response = await fetch(`${process.env.BASE_URL}/v1/setup/status`);
const body = await response.json();
if (response.status !== 200 || body.required !== false) throw new Error("owner did not persist across restart");
console.log("restart_persistence=ok");
NODE

"$script_dir/social-git-restore.sh" "$backup_set"
wait_ready
base_url=$(current_base_url)
BASE_URL="$base_url" node <<'NODE'
const health = await fetch(`${process.env.BASE_URL}/healthz`);
const ready = await fetch(`${process.env.BASE_URL}/readyz`);
const setup = await fetch(`${process.env.BASE_URL}/v1/setup/status`);
if (health.status !== 200 || ready.status !== 200 || setup.status !== 200 || (await setup.json()).required !== false) {
  throw new Error("restored service is not healthy and initialized");
}
console.log("restore_recovery=ok");
NODE

init_result=$("${compose[@]}" run --rm --no-deps secrets-init secrets-init)
[[ "$init_result" == *'"created":0'* && "$init_result" == *'"existing":3'* ]]
worker_id=$("${compose[@]}" ps -q reddit-worker)
[[ $(docker inspect --format '{{json .Mounts}}' "$worker_id") == '[]' ]]
printf 'clean_host_compose_smoke=ok project=%s\n' "$COMPOSE_PROJECT_NAME"
