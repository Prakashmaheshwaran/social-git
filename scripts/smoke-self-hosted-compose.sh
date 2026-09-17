#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
export COMPOSE_PROJECT_NAME="social-git-smoke-$$"
export SOCIAL_GIT_PORT=0
export SOCIAL_GIT_IMAGE="social-git-runtime:dyn113-smoke-$$"
compose=(docker compose -f "$repo_root/compose.yaml")
smoke_compose=(docker compose -f "$repo_root/compose.yaml" -f "$repo_root/qa/compose.smoke.yaml")
backup_set=smoke-restore
smoke_password=$(node -e 'process.stdout.write(`Smoke-${require("node:crypto").randomBytes(24).toString("base64url")}!`)')

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$SOCIAL_GIT_IMAGE" >/dev/null 2>&1 || true
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
  "${compose[@]}" logs --no-color core reddit-worker x-worker secrets-init >&2
  return 1
}
wait_ready

current_base_url() { printf 'http://%s' "$("${compose[@]}" port core 8080)"; }
base_url=$(current_base_url)
BASE_URL="$base_url" SMOKE_PASSWORD="$smoke_password" node <<'NODE'
const base = process.env.BASE_URL;
const password = process.env.SMOKE_PASSWORD;
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.idempotency ? { "idempotency-key": options.idempotency } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: response.status === 204 ? {} : await response.json() };
};
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
const noDefault = await request("/v1/auth/login", {
  method: "POST", body: { email: "admin@example.invalid", password: "admin-password-123!" },
});
if (noDefault.response.status !== 401) throw new Error("fresh install unexpectedly accepted default credentials");
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
const created = await fetch(`${base}/v1/setup/owner`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "smoke@example.invalid", displayName: "Smoke Owner", password }),
});
const body = await created.json();
if (created.status !== 201 || body.authenticated !== true || body.role !== "owner") throw new Error("owner setup failed");
const login = await request("/v1/auth/login", {
  method: "POST", body: { email: "smoke@example.invalid", password },
});
if (login.response.status !== 200 || login.body.authenticated !== true) throw new Error("owner login failed");
const setCookie = login.response.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";", 1)[0];
if (!cookie.startsWith("social_git_session=")) throw new Error("owner login did not return the session cookie");
const createdKey = await request("/v1/control-plane/api-keys", {
  method: "POST", cookie, csrf: login.body.csrfToken,
  body: { name: "compose-production-smoke", scopes: ["accounts:read", "accounts:write", "social:write"] },
});
if (createdKey.response.status !== 201 || !createdKey.body.secret?.startsWith("sgk_")) throw new Error("API key creation failed");
const authorization = `Bearer ${createdKey.body.secret}`;
if ((await request("/v1/accounts", { authorization })).response.status !== 200) throw new Error("API key authentication failed");
const fixtureRoute = await request("/__fixture/control", {
  method: "POST", authorization, body: { command: "reset", payload: {} },
});
if (fixtureRoute.response.status !== 404) throw new Error("production exposed fixture controls");
console.log("production_first_run_login_api_key_and_product_write_readiness=ok");
NODE

core_id=$("${compose[@]}" ps -q core)
docker exec "$core_id" node --input-type=module -e '
  const reddit = await fetch("http://reddit-worker:8081/readyz");
  const x = await fetch("http://x-worker:8082/readyz");
  const dispatch = await fetch("http://x-worker:8082/v1/dispatch", {method:"POST", body:"{}"});
  const body = await dispatch.json();
  if (reddit.status !== 200 || x.status !== 200 || dispatch.status !== 503 || body.code !== "X_TRANSPORT_NOT_ADMITTED") process.exit(1);
  console.log("isolated_workers_and_x_fail_closed_admission=ok");
'

"$script_dir/social-git-backup.sh" "$backup_set"
wait_ready
base_url=$(current_base_url)
"${compose[@]}" restart core >/dev/null
wait_ready
base_url=$(current_base_url)
BASE_URL="$base_url" SMOKE_PASSWORD="$smoke_password" node <<'NODE'
const response = await fetch(`${process.env.BASE_URL}/v1/setup/status`);
const body = await response.json();
if (response.status !== 200 || body.required !== false) throw new Error("owner did not persist across restart");
const login = await fetch(`${process.env.BASE_URL}/v1/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "smoke@example.invalid", password: process.env.SMOKE_PASSWORD }),
});
const loginBody = await login.json();
const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
const keys = await fetch(`${process.env.BASE_URL}/v1/control-plane/api-keys`, { headers: { cookie } });
if (login.status !== 200 || keys.status !== 200 || (await keys.json()).items.length !== 1) throw new Error("owner or API key metadata did not persist across restart");
console.log("restart_owner_and_api_key_persistence=ok");
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

"${smoke_compose[@]}" up -d --no-build --force-recreate core
compose=("${smoke_compose[@]}")
wait_ready
base_url=$(current_base_url)
BASE_URL="$base_url" SMOKE_PASSWORD="$smoke_password" node <<'NODE'
const base = process.env.BASE_URL;
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.idempotency ? { "idempotency-key": options.idempotency } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: response.status === 204 ? {} : await response.json() };
};
const login = await request("/v1/auth/login", {
  method: "POST", body: { email: "smoke@example.invalid", password: process.env.SMOKE_PASSWORD },
});
if (login.response.status !== 200) throw new Error("fixture smoke owner login failed");
const cookie = (login.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
const csrf = login.body.csrfToken;
const key = await request("/v1/control-plane/api-keys", {
  method: "POST", cookie, csrf,
  body: { name: "compose-fixture-smoke", scopes: [
    "accounts:read", "accounts:write", "connections:read", "connections:write",
    "social:read", "social:write", "actions:read", "webhooks:read", "webhooks:write",
  ] },
});
if (key.response.status !== 201) throw new Error("fixture API key creation failed");
const authorization = `Bearer ${key.body.secret}`;
const subscription = await request("/v1/webhooks/subscriptions", {
  method: "POST", authorization, idempotency: "compose-webhook-subscription",
  body: {
    url: "https://receiver.example/events",
    eventTypes: ["account.connected", "action.queued", "action.succeeded"],
  },
});
if (subscription.response.status !== 201 || !subscription.body.secret) throw new Error("webhook subscription failed");
const staged = await request("/__fixture/control", {
  method: "POST", cookie, csrf,
  body: { command: "stage-session", payload: {
    vaultHandle: "compose-reddit-session", nativeIdentity: "fixture_owner", routeId: "fixture-direct",
    syntheticSensitiveFields: { cookie: "COMPOSE_COOKIE_CANARY", csrf: "COMPOSE_CSRF_CANARY" },
  } },
});
if (staged.response.status !== 200) throw new Error("fixture session staging failed");
const account = await request("/v1/accounts", {
  method: "POST", authorization, body: { platform: "reddit", expectedNativeUserId: "fixture_owner" },
});
if (account.response.status !== 201) throw new Error("fixture Reddit account creation failed");
const accountId = account.body.account.id;
const connected = await request(`/v1/accounts/${accountId}/connections`, {
  method: "POST", authorization, body: { vaultHandle: "compose-reddit-session", generation: 1 },
});
if (connected.response.status !== 200) throw new Error("fixture Reddit connection failed");
const profile = await request(`/v1/accounts/${accountId}/profile`, { authorization });
if (profile.response.status !== 200 || profile.body.username !== "fixture_owner") throw new Error("fixture Reddit read failed");
const action = await request(`/v1/accounts/${accountId}/actions`, {
  method: "POST", authorization, idempotency: "compose-reddit-write",
  body: { kind: "text_post", subreddit: "qualityassurance", title: "Compose smoke", text: "deterministic fixture" },
});
if (action.response.status !== 202) throw new Error("fixture Reddit write was not queued");
let terminal;
for (let attempt = 0; attempt < 100; attempt += 1) {
  const result = await request(`/v1/actions/${action.body.action.id}`, { authorization });
  if (!["queued", "running"].includes(result.body.action?.state)) { terminal = result.body.action; break; }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (terminal?.state !== "succeeded" || !terminal.result?.nativeId) throw new Error("fixture Reddit write did not succeed with native evidence");
let deliveries = [];
for (let attempt = 0; attempt < 100; attempt += 1) {
  const result = await request(`/v1/webhooks/deliveries?subscriptionId=${subscription.body.subscription.id}`, { authorization });
  deliveries = result.body.items ?? [];
  if (deliveries.length >= 3 && deliveries.every((item) => item.state === "delivered")) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const types = new Set(deliveries.map((item) => item.eventType));
if (!["account.connected", "action.queued", "action.succeeded"].every((type) => types.has(type))) {
  throw new Error("deterministic webhook deliveries are incomplete");
}
console.log("fixture_reddit_read_write_and_webhook_delivery=ok");
NODE

core_id=$("${compose[@]}" ps -q core)
docker exec "$core_id" node -e '
  const fs=require("node:fs");
  const path="/var/lib/social-git/webhook-smoke.jsonl";
  const stat=fs.statSync(path);
  const lines=fs.readFileSync(path,"utf8").trim().split("\n").map(JSON.parse);
  if ((stat.mode & 0o777) !== 0o600 || lines.length < 3 || lines.some((line) => !line.headers["x-social-git-signature"] || !line.headers["x-social-git-event-id"] || !line.body)) process.exit(1);
  console.log("private_signed_webhook_sink=ok");
'

"${compose[@]}" restart core >/dev/null
wait_ready
base_url=$(current_base_url)
BASE_URL="$base_url" SMOKE_PASSWORD="$smoke_password" node <<'NODE'
const login = await fetch(`${process.env.BASE_URL}/v1/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "smoke@example.invalid", password: process.env.SMOKE_PASSWORD }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
const accounts = await fetch(`${process.env.BASE_URL}/v1/accounts`, { headers: { cookie } });
if (login.status !== 200 || accounts.status !== 200 || (await accounts.json()).items.length < 1) throw new Error("fixture account state did not persist across restart");
console.log("fixture_restart_persistence=ok");
NODE

init_result=$("${compose[@]}" run --rm --no-deps secrets-init secrets-init)
[[ "$init_result" == *'"created":0'* && "$init_result" == *'"existing":3'* ]]
worker_id=$("${compose[@]}" ps -q reddit-worker)
x_worker_id=$("${compose[@]}" ps -q x-worker)
[[ $(docker inspect --format '{{json .Mounts}}' "$worker_id") == '[]' ]]
[[ $(docker inspect --format '{{json .Mounts}}' "$x_worker_id") == '[]' ]]
docker inspect "$worker_id" "$x_worker_id" | node -e '
  let source="";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    const [reddit, x] = JSON.parse(source);
    const redditNetworks = new Set(Object.keys(reddit.NetworkSettings.Networks));
    const shared = Object.keys(x.NetworkSettings.Networks).filter((name) => redditNetworks.has(name));
    if (shared.length !== 0) throw new Error(`platform workers share networks: ${shared.join(",")}`);
    console.log("platform_worker_network_separation=ok");
  });
'
printf 'clean_host_compose_smoke=ok project=%s\n' "$COMPOSE_PROJECT_NAME"
