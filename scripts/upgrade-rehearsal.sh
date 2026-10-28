#!/usr/bin/env bash
# Upgrade rehearsal for the documented self-hosted deployment.
#
# Proves an operator can move from one committed revision to another without
# losing the installation: build both images from committed source, create a
# representative installation through the public API, take an encrypted
# backup, upgrade in place on the same volumes, and restore that pre-upgrade
# backup onto fresh volumes with the new image.
#
# The installation itself is created with the test-only Compose overlay
# (qa/compose.smoke.yaml), because a deterministic Reddit write must not touch
# the live platform. That is the same technique
# scripts/smoke-self-hosted-compose.sh uses. The backup, the in-place upgrade,
# and the restore then run on the documented production topology
# (compose.yaml), so readiness, owner login, API-key access, action history,
# webhook state, and audit verification are proven against the product path.
#
# Secrets stay in process memory: the generated owner password and the API-key
# secret are handed to an asserting Node helper over stdin and never printed or
# written to disk. The helper lives in a mode-0700 temporary directory removed
# on exit. The encrypted backup set never leaves its Docker volume; it is copied
# between volume names only.
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/upgrade-rehearsal.sh --from <old-commit> [--to <new-commit>]' \
    '' \
    'Build the old and new runtime images from committed source, install the old' \
    'release with the documented self-hosted Compose topology, create an owner,' \
    'scoped API key, account, action, and webhook subscription through the public' \
    'API, take an encrypted backup, upgrade in place on the same volumes, then' \
    'restore that pre-upgrade backup onto fresh volumes with the new image.' \
    '' \
    'Options:' \
    '  --from <commit>   Required. Baseline revision; must be an ancestor of --to.' \
    '  --to <commit>     Target revision. Defaults to HEAD.' \
    '  -h, --help        Show this help.' \
    '' \
    'Requires Docker Engine with Compose v2, Docker buildx, Node.js, Python 3, and tar.'
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)

from_revision=
to_revision=HEAD

while (($#)); do
  case "$1" in
    --from) from_revision=${2:?--from requires a commit}; shift ;;
    --to) to_revision=${2:?--to requires a commit}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if [[ -z "$from_revision" ]]; then
  usage >&2
  exit 2
fi

for tool in docker node python3 tar git; do
  command -v "$tool" >/dev/null || { printf 'error: %s is required\n' "$tool" >&2; exit 1; }
done
docker buildx version >/dev/null

from_commit=$(git -C "$repo_root" rev-parse --verify "${from_revision}^{commit}") || {
  printf 'error: --from is not a commit: %s\n' "$from_revision" >&2; exit 2;
}
to_commit=$(git -C "$repo_root" rev-parse --verify "${to_revision}^{commit}") || {
  printf 'error: --to is not a commit: %s\n' "$to_revision" >&2; exit 2;
}
for commit in "$from_commit" "$to_commit"; do
  git -C "$repo_root" merge-base --is-ancestor "$commit" HEAD || {
    printf 'error: revision is not reachable from HEAD: %s\n' "$commit" >&2; exit 2;
  }
done
git -C "$repo_root" merge-base --is-ancestor "$from_commit" "$to_commit" || {
  printf 'error: --from must be an ancestor of --to\n' >&2; exit 2;
}

platform=$(uname -m | "$script_dir/normalize-docker-platform.sh")
run_id="$$-$(date -u +%Y%m%d%H%M%S)"
from_short=$(printf '%s' "$from_commit" | cut -c1-12)
to_short=$(printf '%s' "$to_commit" | cut -c1-8)
image_old="social-git-runtime:upgrade-rehearsal-old-${from_short}-${run_id}"
image_new="social-git-runtime:upgrade-rehearsal-new-${to_short}-${run_id}"
project_old="sgup-old-${from_short}-${run_id}"
project_restore="sgup-restore-${to_short}-${run_id}"
backup_set="upgrade-rehearsal-preupgrade"

# Loopback-only plain HTTP is the documented cookie-mode exception for a local
# rehearsal, so it is exported for every stack this script starts. The one
# topology validation below runs with the variable removed, because it asserts
# the committed self-hosting default of a Secure cookie.
export SOCIAL_GIT_PORT=0
export SOCIAL_GIT_BIND_ADDRESS=127.0.0.1
export SOCIAL_GIT_SESSION_COOKIE_SECURE=false
export SOCIAL_GIT_TENANT_ID=default
export SOCIAL_GIT_LEDGER_ID=default-action-ledger

compose_base=(docker compose -f "$repo_root/compose.yaml")
compose_fixture=(docker compose -f "$repo_root/compose.yaml" -f "$repo_root/qa/compose.smoke.yaml")

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/social-git-upgrade-rehearsal.XXXXXX")
chmod 700 "$work_dir"

owner_password=$(node -e 'process.stdout.write(`Rehearsal-${require("node:crypto").randomBytes(24).toString("base64url")}!`)')
owner_email="upgrade-rehearsal@example.invalid"
# Held in process memory only. The installer fills them in from its own
# response; they are never printed or written to disk.
api_key_secret=
api_key_prefix=
base_url=
survivals=

lock_held=0
lock_waited=0
# Optional host-wide serialization. Every run already uses unique Compose
# project names, so concurrent runs cannot touch each other's resources; set
# SOCIAL_GIT_REHEARSAL_LOCK_DIR only to keep Docker-heavy jobs on a shared host
# from overlapping. When it is unset no lock is taken.
lock_dir=${SOCIAL_GIT_REHEARSAL_LOCK_DIR:-}
# docker_lock <timeout-seconds, 0 = wait forever>
# A bounded wait lets a failing run still tear down its own project instead of
# hanging in the exit trap if another job holds the lock.
docker_lock() {
  local timeout=${1:-0}
  if [[ -z "$lock_dir" ]] || ((lock_held == 1)); then
    return 0
  fi
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if ((timeout > 0 && lock_waited >= timeout)); then
      lock_waited=$((lock_waited + 5))
      return 1
    fi
    sleep 5
    lock_waited=$((lock_waited + 5))
  done
  lock_waited=0
  lock_held=1
}
docker_unlock() {
  if ((lock_held == 1)); then
    rmdir "$lock_dir" 2>/dev/null || true
    lock_held=0
  fi
}
phase_started=0
phase() { printf '\n== %s ==\n' "$1"; phase_started=$(date +%s); }
phase_done() { printf '   ok (%ss)\n' "$(( $(date +%s) - phase_started ))"; }

dumped=0
dump_diagnostics() {
  ((dumped == 0)) || return 0
  dumped=1
  printf '\n== failure diagnostics ==\n' >&2
  docker_lock 60 || return 0
  for project in "$project_old" "$project_restore"; do
    printf -- '-- project %s --\n' "$project" >&2
    COMPOSE_PROJECT_NAME="$project" SOCIAL_GIT_IMAGE="$image_new" "${compose_base[@]}" ps >&2 2>/dev/null || true
    COMPOSE_PROJECT_NAME="$project" SOCIAL_GIT_IMAGE="$image_new" "${compose_base[@]}" logs --no-color --tail=200 core reddit-worker x-worker secrets-init >&2 2>/dev/null || true
  done
}

# Teardown must never wait indefinitely: if the lock cannot be taken within the
# grace period, force-remove this run's own named containers, volumes, and
# networks, which need no shared lock. Everything this script creates carries
# its unique project name, so nothing else can be touched.
cleanup() {
  local project volume network
  if docker_lock 120; then
    COMPOSE_PROJECT_NAME="$project_old" SOCIAL_GIT_IMAGE="$image_new" "${compose_base[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    COMPOSE_PROJECT_NAME="$project_restore" SOCIAL_GIT_IMAGE="$image_new" "${compose_base[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  else
    printf 'warning: could not take the Docker lock for teardown; removing this run by name\n' >&2
    for project in "$project_old" "$project_restore"; do
      docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' 2>/dev/null \
        | while read -r container; do [[ -n "$container" ]] && docker rm -f "$container" >/dev/null 2>&1; done || true
      docker volume ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null \
        | while read -r volume; do [[ -n "$volume" ]] && docker volume rm -f "$volume" >/dev/null 2>&1; done || true
      docker network ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null \
        | while read -r network; do [[ -n "$network" ]] && docker network rm "$network" >/dev/null 2>&1; done || true
    done
  fi
  docker image rm -f "$image_old" >/dev/null 2>&1 || true
  docker image rm -f "$image_new" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
  docker_unlock
}

on_error() {
  local status=$1
  dump_diagnostics
  printf '\nerror: upgrade rehearsal failed (exit %s)\n' "$status" >&2
  exit "$status"
}

# SIGINT/SIGTERM must not abort the exit trap: teardown has to run.
on_signal() {
  printf '\nerror: upgrade rehearsal interrupted\n' >&2
  exit 130
}

trap cleanup EXIT
trap 'on_error $?' ERR
trap on_signal INT TERM

# ---------------------------------------------------------------------------
# Asserting Node helper. Request material arrives on stdin; nothing secret is
# written into the file.
# ---------------------------------------------------------------------------
cat > "$work_dir/api-check.mjs" <<'NODE'
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const cfg = JSON.parse(raw);

const check = (condition, message) => { if (!condition) throw new Error(message); };

async function call(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.idempotency) headers["idempotency-key"] = options.idempotency;
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body = {};
  if (text) { try { body = JSON.parse(text); } catch { body = {}; } }
  return { status: response.status, body, headers: response.headers };
}

const databaseTuple = (ready) => {
  const databases = ready?.checks?.databases;
  if (!databases) return null;
  return {
    actions: databases.actions?.migration?.current ?? null,
    sessions: databases.sessions?.migration?.current ?? null,
    identity: databases.identity?.migration?.current ?? null,
  };
};

async function readReadiness() {
  const response = await call("/readyz");
  return { status: response.status, body: response.body, tuple: databaseTuple(response.body) };
}

async function createInstallation() {
  const status = await call("/v1/setup/status");
  check(status.status === 200 && status.body.required === true, "a fresh installation did not require owner setup");

  const ready = await readReadiness();
  check(ready.status === 200, `the baseline installation is not ready (HTTP ${ready.status})`);
  const baselineTuple = ready.tuple;
  check(baselineTuple && Object.values(baselineTuple).every(Number.isInteger), "the baseline readiness response has no database schema tuple");

  const created = await call("/v1/setup/owner", {
    method: "POST",
    body: { email: cfg.ownerEmail, displayName: "Upgrade Rehearsal Owner", password: cfg.ownerPassword },
  });
  check(created.status === 201 && created.body.authenticated === true && created.body.role === "owner", "owner setup failed");

  const login = await call("/v1/auth/login", {
    method: "POST",
    body: { email: cfg.ownerEmail, password: cfg.ownerPassword },
  });
  check(login.status === 200 && login.body.authenticated === true, "owner login failed on the baseline installation");
  const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
  check(cookie.startsWith("social_git_session="), "owner login did not return the session cookie");
  const csrf = login.body.csrfToken;
  check(typeof csrf === "string" && csrf.length > 0, "owner login did not return a CSRF token");

  const createdKey = await call("/v1/control-plane/api-keys", {
    method: "POST", cookie, csrf,
    body: { name: "upgrade-rehearsal", scopes: [
      "accounts:read", "accounts:write", "connections:read", "connections:write",
      "social:read", "social:write", "actions:read", "webhooks:read", "webhooks:write",
    ] },
  });
  check(createdKey.status === 201 && /^sgk_/.test(createdKey.body.secret ?? ""), "API key creation failed");
  const bearer = createdKey.body.secret;

  const staged = await call("/__fixture/control", {
    method: "POST", cookie, csrf,
    body: { command: "stage-session", payload: {
      vaultHandle: "upgrade-rehearsal-session", nativeIdentity: "fixture_owner", routeId: "fixture-direct",
      syntheticSensitiveFields: { cookie: "REHEARSAL_COOKIE_CANARY", csrf: "REHEARSAL_CSRF_CANARY" },
    } },
  });
  check(staged.status === 200, "fixture session staging failed");

  // Subscribe before the account exists: the outbox only fans out events to
  // subscriptions that already exist, so an account.connected event raised
  // before the subscription would never be delivered. This is the same order
  // scripts/smoke-self-hosted-compose.sh uses.
  const subscription = await call("/v1/webhooks/subscriptions", {
    method: "POST", bearer, idempotency: "upgrade-rehearsal-webhook",
    body: { url: "https://receiver.example/events", eventTypes: ["account.connected", "action.queued", "action.succeeded"] },
  });
  check(subscription.status === 201 && typeof subscription.body.secret === "string", "webhook subscription creation failed");
  const subscriptionId = subscription.body.subscription.id;

  const account = await call("/v1/accounts", {
    method: "POST", bearer,
    body: { platform: "reddit", expectedNativeUserId: "fixture_owner", label: "upgrade rehearsal" },
  });
  check(account.status === 201, "account creation failed");
  const accountId = account.body.account.id;

  const connected = await call(`/v1/accounts/${accountId}/connections`, {
    method: "POST", bearer, body: { vaultHandle: "upgrade-rehearsal-session", generation: 1 },
  });
  check(connected.status === 200, "connection import failed");

  const queued = await call(`/v1/accounts/${accountId}/actions`, {
    method: "POST", bearer, idempotency: "upgrade-rehearsal-text-post",
    body: { kind: "text_post", subreddit: "qualityassurance", title: "Upgrade rehearsal", text: "deterministic pre-upgrade write" },
  });
  check(queued.status === 202, `the deterministic write was not queued (HTTP ${queued.status})`);
  const actionId = queued.body.action.id;

  let terminal;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await call(`/v1/actions/${actionId}`, { bearer });
    check(result.status === 200, "reading the action failed");
    if (!["queued", "running"].includes(result.body.action?.state)) { terminal = result.body.action; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(terminal?.state === "succeeded", `the deterministic write did not succeed (state ${terminal?.state})`);
  check(typeof terminal.result?.nativeId === "string" && terminal.result.nativeId.length > 0, "the deterministic write returned no native identifier");

  let deliveries = [];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await call(`/v1/webhooks/deliveries?subscriptionId=${subscriptionId}`, { bearer });
    check(result.status === 200, "reading webhook deliveries failed");
    deliveries = result.body.items ?? [];
    if (deliveries.length >= 3 && deliveries.every((item) => item.state === "delivered")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const deliveredTypes = new Set(deliveries.map((item) => item.eventType));
  for (const type of ["account.connected", "action.queued", "action.succeeded"]) {
    check(deliveredTypes.has(type), `the ${type} webhook was not delivered (saw ${[...deliveredTypes].join(",")})`);
  }
  check(deliveries.every((item) => item.state === "delivered"), "a durable webhook delivery is not in the delivered state");

  return {
    baselineDatabaseTuple: baselineTuple,
    install: {
      ownerEmail: cfg.ownerEmail,
      accountId,
      expectedNativeUserId: "fixture_owner",
      actionId,
      actionKind: "text_post",
      nativeId: terminal.result.nativeId,
      subscriptionId,
      subscriptionUrl: "https://receiver.example/events",
      subscriptionEventTypes: ["account.connected", "action.queued", "action.succeeded"],
      deliveryEventIds: deliveries.map((item) => item.eventId).sort(),
    },
    apiKeySecret: createdKey.body.secret,
    apiKeyPrefix: createdKey.body.apiKey?.prefix ?? null,
  };
}

async function verifyInstallation(survivals) {
  const check_ = check;

  const health = await call("/healthz");
  check_(health.status === 200, "liveness failed");

  const ready = await readReadiness();
  check_(ready.status === 200, `readiness failed (HTTP ${ready.status})`);
  check_(ready.body.contractVersion === 1, "the readiness contract version is not 1");
  check_(ready.body.checks?.maintenance?.state === "idle", "the instance reports an active maintenance window");
  check_(ready.body.checks?.productWritesReady === true, "product-write readiness is not satisfied");
  check_(ready.body.checks?.workers?.action?.ready === true, "the action worker is not ready");
  check_(ready.body.checks?.workers?.webhook?.ready === true, "the webhook worker is not ready");
  check_(ready.body.checks?.workers?.reddit?.reachable === true, "the Reddit worker is not reachable");
  check_(ready.body.checks?.identityAudit?.ready === true, "the identity audit projection is not healthy");

  const tuple = ready.tuple;
  check_(tuple && Object.values(tuple).every(Number.isInteger), "the readiness response has no database schema tuple");
  for (const name of ["actions", "sessions", "identity"]) {
    const fields = ready.body.checks.databases[name];
    check_(fields?.ready === true, `${name} database is not ready`);
    check_(fields?.migration?.current === fields?.migration?.expected, `${name} schema does not match this runtime`);
    check_(fields?.migration?.current === cfg.schemaTuple[name], `${name} schema tuple is not the target image tuple`);
  }

  const setup = await call("/v1/setup/status");
  check_(setup.status === 200 && setup.body.required === false, "owner identity did not survive");

  const login = await call("/v1/auth/login", {
    method: "POST", body: { email: survivals.ownerEmail, password: cfg.ownerPassword },
  });
  check_(login.status === 200 && login.body.authenticated === true, "owner login failed");

  const bearer = cfg.apiKeySecret;
  check_(typeof bearer === "string" && bearer.length > 0, "no API key secret was retained for the survival check");

  const accounts = await call("/v1/accounts", { bearer });
  check_(accounts.status === 200, "the API key no longer authenticates");
  const account = (accounts.body.items ?? []).find((item) => item.id === survivals.accountId);
  check_(account, "the registered account did not survive");
  check_(account.platform === "reddit", "the surviving account changed platform");
  check_(account.actualNativeUserId === survivals.expectedNativeUserId, "the surviving account lost its verified native identity");
  check_(account.connectionHealth === "healthy", `the surviving account changed connection health (${account.connectionHealth})`);

  const action = await call(`/v1/actions/${survivals.actionId}`, { bearer });
  check_(action.status === 200, "action history did not survive");
  check_(action.body.action?.state === "succeeded", "the surviving action changed state");
  check_(action.body.action?.kind === survivals.actionKind, "the surviving action changed kind");
  check_(action.body.action?.result?.nativeId === survivals.nativeId, "the surviving action lost its native evidence");

  const queue = await call(`/v1/actions?accountId=${survivals.accountId}`, { bearer });
  check_(queue.status === 200, "the action queue is unreadable");
  check_((queue.body.items ?? []).some((item) => item.id === survivals.actionId), "the durable action is missing from the queue");

  const subscriptions = await call("/v1/webhooks/subscriptions", { bearer });
  check_(subscriptions.status === 200, "webhook subscriptions are unreadable");
  const subscription = (subscriptions.body.items ?? []).find((item) => item.id === survivals.subscriptionId);
  check_(subscription, "the webhook subscription did not survive");
  check_(subscription.url === survivals.subscriptionUrl, "the surviving webhook subscription changed URL");
  check_(subscription.status === "active", "the surviving webhook subscription is no longer active");
  check_(JSON.stringify(subscription.eventTypes) === JSON.stringify(survivals.subscriptionEventTypes), "the surviving webhook subscription changed event types");

  const deliveries = await call(`/v1/webhooks/deliveries?subscriptionId=${survivals.subscriptionId}`, { bearer });
  check_(deliveries.status === 200, "webhook deliveries are unreadable");
  const delivered = new Set((deliveries.body.items ?? []).filter((item) => item.state === "delivered").map((item) => item.eventId));
  for (const eventId of survivals.deliveryEventIds) check_(delivered.has(eventId), `webhook delivery ${eventId} did not survive`);

  return {
    databaseTuple: tuple,
    actionState: action.body.action.state,
    nativeId: action.body.action.result.nativeId,
    deliveredEvents: survivals.deliveryEventIds.length,
    apiKeyPrefix: cfg.apiKeyPrefix,
  };
}

try {
  if (cfg.phase === "install") {
    process.stdout.write(JSON.stringify(await createInstallation()));
  } else if (cfg.phase === "verify") {
    process.stdout.write(JSON.stringify(await verifyInstallation(cfg.survivals)));
  } else {
    throw new Error(`unknown phase: ${cfg.phase}`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
NODE

json_escape() {
  printf '%s' "$1" | node -e 'let raw="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>raw+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(raw)))'
}

# api <phase> [extra json fields beginning with a comma]
api() {
  local phase=$1 extra=${2:-} payload
  payload=$(printf '{"phase":"%s","baseUrl":%s,"ownerEmail":%s,"ownerPassword":%s,"apiKeySecret":%s,"apiKeyPrefix":%s%s}' \
    "$phase" "$(json_escape "$base_url")" "$(json_escape "$owner_email")" \
    "$(json_escape "$owner_password")" "$(json_escape "$api_key_secret")" \
    "$(json_escape "$api_key_prefix")" "$extra")
  printf '%s' "$payload" | node "$work_dir/api-check.mjs"
}

json_field() {
  # json_field <json> <dotted.path>
  JSON_TEXT=$1 JSON_PATH=$2 node -e '
    let value = JSON.parse(process.env.JSON_TEXT);
    for (const key of process.env.JSON_PATH.split(".")) value = value?.[key];
    if (value === undefined || value === null) process.stdout.write("");
    else process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  '
}

# last_json_line <captured output>
# docker compose run can interleave its own status lines with container stdout;
# return the last line that parses as a JSON object.
last_json_line() {
  printf '%s\n' "$1" | node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => raw += chunk);
    process.stdin.on("end", () => {
      const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].startsWith("{")) continue;
        try {
          const parsed = JSON.parse(lines[index]);
          process.stdout.write(JSON.stringify(parsed));
          return;
        } catch { /* not the payload line */ }
      }
      throw new Error("no JSON object was found in the captured output");
    });
  '
}

# ---------------------------------------------------------------------------
# Compose helpers. COMPOSE_PROJECT_NAME and SOCIAL_GIT_IMAGE are exported per
# phase so the documented backup/restore scripts inherit the same project.
# ---------------------------------------------------------------------------
wait_ready() {
  local -a compose=("$@")
  local container_id
  for _ in $(seq 1 180); do
    container_id=$("${compose[@]}" ps -q core 2>/dev/null || true)
    if [[ -n "$container_id" \
      && $(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true) == true \
      && $(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true) == healthy \
      ]] && docker exec "$container_id" node /opt/social-git/runtime/healthcheck.mjs /readyz >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  "${compose[@]}" ps >&2 || true
  "${compose[@]}" logs --no-color --tail=200 core reddit-worker x-worker secrets-init >&2 || true
  return 1
}

core_base_url() { printf 'http://%s' "$("${compose_base[@]}" port core 8080)"; }
# Emit each mount as one sorted line so the comparison between two inspections
# is independent of the order Docker happens to report them in.
core_mounts() {
  docker inspect --format '{{range .Mounts}}{{.Destination}}={{.Name}}{{"\n"}}{{end}}' "$("${compose_base[@]}" ps -q core)" | LC_ALL=C sort
}
core_image() { docker inspect --format '{{.Config.Image}}' "$("${compose_base[@]}" ps -q core)"; }

image_schema_tuple() {
  docker run --rm --network none --entrypoint node "$1" --input-type=module -e '
    const { MIGRATIONS } = await import("/opt/social-git/src/persistence.ts");
    const { IDENTITY_SCHEMA_VERSION } = await import("/opt/social-git/src/identity.ts");
    const core = await import("/opt/social-git/packages/core/src/runtime.js");
    process.stdout.write(JSON.stringify({
      actions: MIGRATIONS.at(-1).version,
      identity: IDENTITY_SCHEMA_VERSION,
      sessions: core.SESSION_RUNTIME_SCHEMA_VERSION,
    }));
  '
}

# audit_verify [expected-heads-json]
audit_verify() {
  local expected=${1:-}
  if [[ -n "$expected" ]]; then
    HEADS_JSON="$expected" "${compose_base[@]}" run --rm -T --no-deps \
      -e HEADS_JSON --entrypoint sh core -c '
        umask 077
        printf "%s" "$HEADS_JSON" > /tmp/expected-heads.json
        exec node /opt/social-git/runtime/audit-verify.mjs \
          --action-database /var/lib/social-git/actions.sqlite \
          --identity-database /var/lib/social-git/identity.sqlite \
          --ledger-id "$SOCIAL_GIT_LEDGER_ID" \
          --tenant-id "$SOCIAL_GIT_TENANT_ID" \
          --audit-key-file /run/social-git-secrets/audit-key \
          --expected-head /tmp/expected-heads.json
      '
  else
    "${compose_base[@]}" run --rm -T --no-deps --entrypoint node core \
      /opt/social-git/runtime/audit-verify.mjs \
      --action-database /var/lib/social-git/actions.sqlite \
      --identity-database /var/lib/social-git/identity.sqlite \
      --ledger-id "$SOCIAL_GIT_LEDGER_ID" \
      --tenant-id "$SOCIAL_GIT_TENANT_ID" \
      --audit-key-file /run/social-git-secrets/audit-key
  fi
}

# seed_volume <source-volume> <target-volume> <mount-path-in-image>
# Mounting the target at its real image path makes Docker populate a fresh
# volume with the image's directory ownership and mode; the copy then preserves
# each key file's own owner, group, and mode.
seed_volume() {
  local source=$1 target=$2 mount_path=$3
  docker run --rm --user 0:0 \
    -v "$source:/from:ro" -v "$target:$mount_path" \
    --entrypoint sh "$image_new" -c 'set -eu; cp -a /from/. "$1"/' sh "$mount_path"
}

# ---------------------------------------------------------------------------
# 1. Build both images from committed source.
# ---------------------------------------------------------------------------
phase "build old image (${from_short})"
"$script_dir/build-images.sh" --load --source-commit "$from_commit" --platform "$platform" --tag "$image_old" >/dev/null
phase_done
phase "build new image (${to_short})"
"$script_dir/build-images.sh" --load --source-commit "$to_commit" --platform "$platform" --tag "$image_new" >/dev/null
phase_done

docker_lock
old_schema_tuple=$(image_schema_tuple "$image_old")
new_schema_tuple=$(image_schema_tuple "$image_new")
docker_unlock
printf '   old schema tuple: %s\n   new schema tuple: %s\n' "$old_schema_tuple" "$new_schema_tuple"

# Hold the shared Docker lock for the rest of the run. Every phase from here on
# creates, inspects, or removes containers, and holding it once avoids stealing
# the lock back and forth with other engineers on the same host. Teardown has a
# bounded fallback if the lock cannot be reacquired.
phase "acquire the shared Docker lock for the run"
docker_lock
phase_done

# ---------------------------------------------------------------------------
# 2. Install the OLD release and create state through the public API.
# ---------------------------------------------------------------------------
export COMPOSE_PROJECT_NAME="$project_old"
export SOCIAL_GIT_IMAGE="$image_old"

phase "start old release ($project_old, deterministic fixture overlay)"
env -u SOCIAL_GIT_SESSION_COOKIE_SECURE "${compose_base[@]}" config --format json \
  | python3 "$script_dir/validate-self-hosted-compose.py"
"${compose_fixture[@]}" up -d --no-build
wait_ready "${compose_fixture[@]}"
base_url=$(core_base_url)
old_mounts=$(core_mounts)
printf '   base url: %s\n' "$base_url"
phase_done

phase "create owner, scoped API key, account, action, and webhook subscription through the public API"
install_result=$(api install)
api_key_secret=$(json_field "$install_result" apiKeySecret)
api_key_prefix=$(json_field "$install_result" apiKeyPrefix)
survivals=$(json_field "$install_result" install)
baseline_tuple=$(json_field "$install_result" baselineDatabaseTuple)
install_result=
[[ -n "$api_key_secret" ]] || { printf 'error: no API key secret was captured\n' >&2; exit 1; }
# Compare the tuples as values: the two producers emit the same three keys in
# a different order, so a string comparison would report a false mismatch.
tuple_equal() {
  LEFT=$1 RIGHT=$2 node -e '
    const left = JSON.parse(process.env.LEFT);
    const right = JSON.parse(process.env.RIGHT);
    const keys = ["actions", "sessions", "identity"];
    if (!left || !right) process.exit(1);
    for (const key of keys) if (left[key] !== right[key]) process.exit(1);
  '
}
tuple_equal "$baseline_tuple" "$old_schema_tuple" || {
  printf 'error: the running baseline reports schema %s but its image declares %s\n' "$baseline_tuple" "$old_schema_tuple" >&2
  exit 1
}
printf '   recorded: %s\n' "$(printf '%s' "$survivals" | node -e 'let raw="";process.stdin.on("data",(c)=>raw+=c);process.stdin.on("end",()=>{const s=JSON.parse(raw);process.stdout.write(JSON.stringify({account:s.accountId,action:s.actionId,nativeId:s.nativeId,subscription:s.subscriptionId,deliveries:s.deliveryEventIds.length}))})')"
phase_done

# ---------------------------------------------------------------------------
# 3. Stop the old release, retain its audit heads, and take an encrypted backup.
# ---------------------------------------------------------------------------
phase "stop old release and retain pre-upgrade audit heads"
"${compose_base[@]}" stop core >/dev/null
pre_upgrade_heads=$(last_json_line "$(audit_verify)")
printf '%s' "$pre_upgrade_heads" | node -e 'let raw="";process.stdin.on("data",(c)=>raw+=c);process.stdin.on("end",()=>{const h=JSON.parse(raw);const ok=h.version===1&&Number.isInteger(h.action?.audit?.sequence)&&Number.isInteger(h.action?.webhooks?.sequence)&&Number.isInteger(h.identity?.sequence);if(!ok)throw new Error("the audit verifier did not return chain heads");process.stdout.write(`   heads: action=${h.action.audit.sequence} webhooks=${h.action.webhooks.sequence} identity=${h.identity.sequence}\n`)})'
phase_done

phase "create the encrypted pre-upgrade backup ($backup_set)"
"$script_dir/social-git-backup.sh" "$backup_set"
backup_listing=$(docker run --rm --network none -v "${project_old}_social-git-backups:/backups:ro" \
  --entrypoint sh "$image_new" -c "ls -1 /backups/$backup_set")
for artifact in manifest.json sessions.backup actions.backup identity.backup; do
  printf '%s\n' "$backup_listing" | grep -qx "$artifact" || { printf 'error: the backup set is missing %s\n' "$artifact" >&2; exit 1; }
done
printf '   artifacts: %s\n' "$(printf '%s' "$backup_listing" | tr '\n' ' ')"
phase_done

# ---------------------------------------------------------------------------
# 4. In-place upgrade on the same volumes with the documented topology.
# ---------------------------------------------------------------------------
export SOCIAL_GIT_IMAGE="$image_new"
phase "upgrade in place to $image_new on the same volumes"
"${compose_base[@]}" up -d --no-build
wait_ready "${compose_base[@]}"
base_url=$(core_base_url)
new_mounts=$(core_mounts)
running_image=$(core_image)
secrets_init=$("${compose_base[@]}" run --rm --no-deps secrets-init secrets-init)
[[ "$running_image" == "$image_new" ]] || { printf 'error: core is not running the upgraded image (%s)\n' "$running_image" >&2; exit 1; }
[[ "$new_mounts" == "$old_mounts" ]] || {
  printf 'error: the in-place upgrade changed the volume set\n  before: %s\n  after:  %s\n' "$old_mounts" "$new_mounts" >&2
  exit 1
}
[[ "$secrets_init" == *'"created":0'* && "$secrets_init" == *'"existing":5'* ]] || {
  printf 'error: the upgrade did not preserve the installation key set: %s\n' "$secrets_init" >&2
  exit 1
}
printf '   base url: %s\n' "$base_url"
phase_done

phase "assert upgrade survivals (readiness, schema tuple, login, API key, action, webhooks)"
upgraded=$(api verify ",\"survivals\":$survivals,\"schemaTuple\":$new_schema_tuple")
printf '   observed: %s\n' "$upgraded"
phase_done

phase "verify post-upgrade audit integrity extends the retained heads"
"${compose_base[@]}" stop core >/dev/null
post_upgrade_heads=$(last_json_line "$(audit_verify "$pre_upgrade_heads")")
printf '%s' "$post_upgrade_heads" | node -e 'let raw="";process.stdin.on("data",(c)=>raw+=c);process.stdin.on("end",()=>{const h=JSON.parse(raw);process.stdout.write(`   heads: action=${h.action.audit.sequence} webhooks=${h.action.webhooks.sequence} identity=${h.identity.sequence}\n`)})'
phase_done

# ---------------------------------------------------------------------------
# 5. Restore the pre-upgrade backup onto fresh volumes with the NEW image.
# ---------------------------------------------------------------------------
export COMPOSE_PROJECT_NAME="$project_restore"
phase "seed fresh volumes with the installation key set and the pre-upgrade backup"
# Each run uses a unique project name, so any volume that already carries it is
# a leftover from this exact run and must not be seeded twice.
existing_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$project_restore")
[[ -z "$existing_volumes" ]] || {
  printf 'error: the restore project already has volumes:\n%s\n' "$existing_volumes" >&2; exit 1;
}
seed_volume "${project_old}_social-git-secrets" "${project_restore}_social-git-secrets" /var/lib/social-git/secrets
seed_volume "${project_old}_social-git-reddit-command-secrets" "${project_restore}_social-git-reddit-command-secrets" /var/lib/social-git/reddit-command-secrets
seed_volume "${project_old}_social-git-x-command-secrets" "${project_restore}_social-git-x-command-secrets" /var/lib/social-git/x-command-secrets
seed_volume "${project_old}_social-git-backups" "${project_restore}_social-git-backups" /var/lib/social-git/backups
phase_done

phase "restore the pre-upgrade backup into the fresh installation"
"$script_dir/social-git-restore.sh" "$backup_set"
"${compose_base[@]}" up -d --no-build
wait_ready "${compose_base[@]}"
base_url=$(core_base_url)
restored_image=$(core_image)
[[ "$restored_image" == "$image_new" ]] || { printf 'error: the restored installation is not running the new image (%s)\n' "$restored_image" >&2; exit 1; }
printf '   base url: %s\n' "$base_url"
phase_done

phase "assert restore survivals (readiness, schema tuple, login, API key, action, webhooks)"
restored=$(api verify ",\"survivals\":$survivals,\"schemaTuple\":$new_schema_tuple")
printf '   observed: %s\n' "$restored"
phase_done

phase "verify restored audit integrity against the retained pre-upgrade heads"
"${compose_base[@]}" stop core >/dev/null
restored_heads=$(last_json_line "$(audit_verify "$pre_upgrade_heads")")
PRE="$pre_upgrade_heads" RESTORED="$restored_heads" node -e '
  const pre = JSON.parse(process.env.PRE);
  const restored = JSON.parse(process.env.RESTORED);
  if (restored.version !== 1) throw new Error("the restored audit heads are malformed");
  // audit-verify already proved every chain extends the retained pre-upgrade
  // head. No new social event occurred after the restore, so the webhook chain
  // must be exactly the pre-upgrade one; the action and identity chains may
  // only be longer because the survival check signed the owner in.
  const same = (left, right) => left.sequence === right.sequence && left.eventId === right.eventId && left.mac === right.mac;
  if (!same(restored.action.webhooks, pre.action.webhooks)) throw new Error("the restored webhook audit chain is not the pre-upgrade snapshot");
  if (restored.action.audit.sequence < pre.action.audit.sequence) throw new Error("the restored action audit chain is behind the pre-upgrade snapshot");
  if (restored.identity.sequence < pre.identity.sequence) throw new Error("the restored identity audit chain is behind the pre-upgrade snapshot");
  process.stdout.write(`   restored heads extend the retained pre-upgrade heads: action=${restored.action.audit.sequence} (from ${pre.action.audit.sequence}) webhooks=${restored.action.webhooks.sequence} identity=${restored.identity.sequence} (from ${pre.identity.sequence})\n`);
'
phase_done

printf '\nupgrade_rehearsal=ok from=%s to=%s platform=%s old_schema=%s new_schema=%s\n' \
  "$from_commit" "$to_commit" "$platform" "$old_schema_tuple" "$new_schema_tuple"
