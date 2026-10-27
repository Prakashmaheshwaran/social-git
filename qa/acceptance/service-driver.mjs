import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const READ_PATHS = Object.freeze({
  "read.account-profile": ({ accountId }) => `/v1/accounts/${accountId}/profile`,
  "read.subreddit-metadata": ({ accountId, subreddit }) => `/v1/accounts/${accountId}/subreddits/${encodeURIComponent(subreddit)}`,
  "read.feed": ({ accountId, subreddit }) => `/v1/accounts/${accountId}/feed?subreddit=${encodeURIComponent(subreddit)}`,
  "read.post": ({ accountId, nativeId }) => `/v1/accounts/${accountId}/posts/${encodeURIComponent(nativeId)}`,
  "read.comments": ({ accountId, nativeId }) => `/v1/accounts/${accountId}/posts/${encodeURIComponent(nativeId)}/comments`,
  "read.search": ({ accountId, query }) => `/v1/accounts/${accountId}/search?query=${encodeURIComponent(query)}`,
});

const WRITE_INPUTS = Object.freeze({
  "write.post.text": (value) => ({ kind: "text_post", subreddit: value.subreddit, title: value.title, text: value.body }),
  "write.post.link": (value) => ({ kind: "link_post", subreddit: value.subreddit, title: value.title, url: value.url }),
  "write.post.media": (value) => ({ kind: "media_post", subreddit: value.subreddit, title: value.title, mediaRef: value.mediaFixture }),
  "write.comment": (value) => ({ kind: "comment", postId: value.targetNativeId, text: value.body }),
  "write.reply": (value) => ({ kind: "reply", commentId: value.parentNativeId, text: value.body }),
  "write.edit-own": (value) => ({ kind: "edit", targetId: value.targetNativeId, text: value.body }),
  "write.vote": (value) => ({ kind: "vote", targetId: value.targetNativeId, direction: value.direction }),
  "write.save": (value) => ({ kind: "save", targetId: value.targetNativeId }),
  "write.unsave": (value) => ({ kind: "unsave", targetId: value.targetNativeId }),
  "write.subscribe": (value) => ({ kind: "subscribe", subreddit: value.subreddit }),
  "write.unsubscribe": (value) => ({ kind: "unsubscribe", subreddit: value.subreddit }),
  "write.delete": (value) => ({ kind: "delete", targetId: value.targetNativeId }),
});

export async function createDriver({ candidateRef, imageDigest }) {
  const baseUrl = requiredEnv("SOCIAL_GIT_CANDIDATE_URL").replace(/\/$/u, "");
  const token = requiredEnv("SOCIAL_GIT_QA_TOKEN");
  const inventoryPath = requiredEnv("SOCIAL_GIT_QA_IMAGE_INVENTORY");
  const platformSessions = new Map();
  const accounts = new Map();
  const accountIdentities = new Map();
  const actionAccounts = new Map();
  const platformCallHistory = [];

  async function http(path, { method = "GET", body, caller = {}, scopes = [] } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-fixture-caller-id": caller.callerId ?? "qa-caller-a",
        "x-fixture-scopes": scopes.join(","),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(caller.idempotencyKey ? { "idempotency-key": caller.idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? {} : await response.json() };
  }

  async function fixtureControl(command, payload = {}) {
    const response = await http("/__fixture/control", {
      method: "POST",
      body: { command, payload },
      caller: { callerId: "qa-controller" },
      scopes: ["fixture:control"],
    });
    if (response.status !== 200) throw new Error(`Fixture control failed: ${JSON.stringify(response.body)}`);
    return response.body.data;
  }

  async function fixtureInspect(target) {
    const response = await http(`/__fixture/inspect?target=${encodeURIComponent(target)}`, {
      caller: { callerId: "qa-controller" }, scopes: ["fixture:control"],
    });
    if (response.status !== 200) throw new Error(`Fixture inspection failed: ${JSON.stringify(response.body)}`);
    return response.body.data;
  }

  function actualAccount(externalId) {
    const value = accounts.get(externalId);
    if (!value) return null;
    return value;
  }

  function externalAccount(internalId) {
    for (const [externalId, value] of accounts) {
      if (value === internalId) return externalId;
    }
    return internalId;
  }

  async function call(operation, input = {}, caller = {}) {
    if (operation === "session.import") {
      if (!input.routeId) return failure(400, "NETWORK_ROUTE_REQUIRED");
      const platform = platformSessions.get(input.sessionFixture);
      if (!platform) return failure(401, "SESSION_INVALID");
      const vaultHandle = `qa-${input.accountId}-${Date.now()}`.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 128);
      await fixtureControl("stage-session", {
        vaultHandle,
        sessionFixture: input.sessionFixture,
        nativeIdentity: platform.nativeIdentity,
        routeId: input.routeId,
        syntheticSensitiveFields: input.syntheticSensitiveFields ?? {},
      });
      const created = await http("/v1/accounts", {
        method: "POST",
        body: { platform: "reddit", expectedNativeUserId: input.expectedIdentity },
        caller,
        scopes: ["accounts:write"],
      });
      if (created.status >= 400) return publicFailure(created);
      const accountId = created.body.account.id;
      const connected = await http(`/v1/accounts/${accountId}/connections`, {
        method: "POST",
        body: { vaultHandle, generation: 1 },
        caller,
        scopes: ["connections:write"],
      });
      if (connected.status >= 400) return publicFailure(connected);
      accounts.set(input.accountId, accountId);
      accountIdentities.set(input.accountId, platform.nativeIdentity);
      return ok({ accountId: input.accountId, identity: platform.nativeIdentity, state: "ACTIVE" }, 201);
    }

    if (operation === "session.refresh") {
      const accountId = actualAccount(input.accountId);
      if (!accountId) return failure(404, "ACCOUNT_NOT_FOUND");
      if (!input.routeId) return failure(400, "NETWORK_ROUTE_REQUIRED");
      const platform = platformSessions.get(input.sessionFixture);
      if (!platform) return failure(401, "SESSION_INVALID");
      const vaultHandle = `qa-refresh-${input.accountId}-${Date.now()}`.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 128);
      await fixtureControl("stage-session", {
        vaultHandle,
        sessionFixture: input.sessionFixture,
        nativeIdentity: platform.nativeIdentity,
        routeId: input.routeId,
        syntheticSensitiveFields: input.syntheticSensitiveFields ?? {},
      });
      const refreshed = await http(`/v1/accounts/${accountId}/connection/refresh`, {
        method: "POST",
        body: { vaultHandle, generation: input.generation },
        caller,
        scopes: ["connections:write"],
      });
      if (refreshed.status >= 400) return publicFailure(refreshed);
      accountIdentities.set(input.accountId, platform.nativeIdentity);
      return ok({
        accountId: input.accountId,
        identity: platform.nativeIdentity,
        state: "ACTIVE",
        generation: refreshed.body.connection.generation,
      });
    }

    if (operation === "session.validate" || operation === "account.health") {
      const accountId = actualAccount(input.accountId);
      if (!accountId) return failure(404, "ACCOUNT_NOT_FOUND");
      const response = await http(`/v1/accounts/${accountId}/connection`, { caller, scopes: ["connections:read"] });
      if (response.status >= 400) return publicFailure(response);
      return ok({ state: response.body.connection.status === "active" ? "ACTIVE" : "REVOKED", identity: accountIdentities.get(input.accountId) });
    }

    if (operation === "session.revoke") {
      const accountId = actualAccount(input.accountId);
      if (!accountId) return failure(404, "ACCOUNT_NOT_FOUND");
      const response = await http(`/v1/accounts/${accountId}/revoke`, { method: "POST", body: {}, caller, scopes: ["connections:write"] });
      return response.status >= 400 ? publicFailure(response) : ok({ state: "REVOKED" }, 204);
    }

    if (operation in READ_PATHS) {
      const accountId = actualAccount(input.accountId);
      if (!accountId) return failure(401, "SESSION_NOT_ACTIVE");
      const response = await http(READ_PATHS[operation]({ ...input, accountId }), { caller, scopes: ["social:read"] });
      if (response.status >= 400) return publicFailure(response);
      const first = response.body.items?.[0];
      const projected = first ? { ...first, items: response.body.items } : response.body;
      return ok(operation === "read.account-profile"
        ? { ...projected, identity: accountIdentities.get(input.accountId) }
        : projected);
    }

    if (operation in WRITE_INPUTS) {
      const accountId = actualAccount(input.accountId);
      if (!accountId) return failure(401, "SESSION_NOT_ACTIVE");
      const normalizedScope = `reddit.${operation}`;
      const allowed = caller.scopes?.includes(normalizedScope);
      let writeInput = WRITE_INPUTS[operation](input);
      if (operation === "write.post.media" && allowed) {
        const staged = await http(`/v1/accounts/${accountId}/media`, {
          method: "POST",
          body: {
            filename: "acceptance.png",
            mimeType: "image/png",
            dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64"),
          },
          caller,
          scopes: ["social:write"],
        });
        if (staged.status >= 400) return publicFailure(staged);
        writeInput = { ...writeInput, mediaRef: staged.body.media.mediaRef };
      }
      const response = await http(`/v1/accounts/${accountId}/actions`, {
        method: "POST",
        body: writeInput,
        caller,
        scopes: allowed ? ["social:write"] : [],
      });
      if (response.status >= 400) return publicFailure(response, allowed ? undefined : "SCOPE_REQUIRED");
      const actionId = response.body.action.id;
      actionAccounts.set(actionId, accountId);
      return actionResponse(await waitForAction(actionId, caller), response.status);
    }

    if (operation === "action.get" || operation === "action.reconcile") {
      const method = operation === "action.reconcile" ? "POST" : "GET";
      const suffix = operation === "action.reconcile" ? "/reconcile" : "";
      const response = await http(`/v1/actions/${input.actionId}${suffix}`, {
        method,
        ...(method === "POST" ? { body: {} } : {}),
        caller,
        scopes: [operation === "action.reconcile" ? "social:write" : "actions:read"],
      });
      if (response.status >= 400) return publicFailure(response);
      return actionResponse(response.body.action, response.body.reconciled === false ? 202 : 200);
    }
    return failure(400, "OPERATION_UNSUPPORTED");
  }

  async function waitForAction(actionId, caller) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await http(`/v1/actions/${actionId}`, { caller, scopes: ["actions:read"] });
      if (response.status >= 400) return response;
      if (!["queued", "running"].includes(response.body.action.state)) return response.body.action;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`Action ${actionId} did not reach a terminal state`);
  }

  return {
    metadata: { kind: "integration_candidate", candidateRef, imageDigest },
    async reset() {
      await fixtureControl("reset");
      platformSessions.clear();
      accounts.clear();
      accountIdentities.clear();
      actionAccounts.clear();
      platformCallHistory.length = 0;
    },
    call,
    async control(command, payload = {}) {
      if (command === "platform-session") {
        platformSessions.set(payload.sessionFixture, { nativeIdentity: payload.nativeIdentity });
        return;
      }
      if (command === "next-platform-outcome" || command === "crash-after-submit" || command === "seed-owned") {
        const accountId = actualAccount(payload.accountId);
        if (!accountId) throw new Error("Fixture account is not active");
        await fixtureControl(command, { ...payload, accountId });
        return;
      }
      if (command === "restart") {
        const calls = await fixtureInspect("platform-calls");
        if (!Array.isArray(calls)) throw new Error("Fixture platform-call inspection returned an invalid result");
        platformCallHistory.push(...calls);
        const restartUrl = requiredEnv("SOCIAL_GIT_QA_RESTART_URL");
        const response = await fetch(restartUrl, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Candidate restart failed with ${response.status}`);
        await waitForReadiness(baseUrl);
        return;
      }
      if (command === "reconciliation-outcome") {
        await fixtureControl(command, payload);
        return;
      }
      throw new Error(`Unsupported service driver control: ${command}`);
    },
    async inspect(target) {
      if (target === "production-image") {
        const inventory = JSON.parse(await readFile(resolve(inventoryPath), "utf8"));
        if (inventory?.source?.digest !== imageDigest || inventory.provenance !== "independent_inventory") {
          throw new Error("Independent image inventory does not match the requested candidate digest");
        }
        return inventory;
      }
      const current = await fixtureInspect(target);
      const evidence = target === "platform-calls"
        ? [...platformCallHistory, ...(Array.isArray(current) ? current : [])]
        : current;
      if (target === "platform-calls" && !Array.isArray(current)) {
        throw new Error("Fixture platform-call inspection returned an invalid result");
      }
      return normalizeInspection(evidence, externalAccount);
    },
    async close() {},
  };
}

export async function waitForReadiness(baseUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, { headers: { connection: "close" } });
      const body = await response.json();
      if (response.status === 200 && body?.status === "ready") return;
    } catch {
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Candidate did not become ready within 30 seconds after restart");
}

function normalizeInspection(value, externalAccount) {
  if (Array.isArray(value)) return value.map((item) => normalizeInspection(item, externalAccount));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "accountId" && typeof item === "string"
      ? externalAccount(item)
      : normalizeInspection(item, externalAccount),
  ]));
}

function actionResponse(action, status = 200) {
  if (action?.body?.error) return action;
  if (action.state === "failed" || action.state === "action_required") {
    const code = action.error?.code ?? "PROTOCOL_DRIFT";
    return failure(statusFor(code), code);
  }
  const result = {
    actionId: action.id,
    state: action.state === "succeeded" ? "CONFIRMED" : action.state,
    ...(action.result ?? {}),
  };
  return { status: action.state === "UNKNOWN" ? 202 : 200, body: { result } };
}

function publicFailure(response, overrideCode) {
  const code = overrideCode ?? response.body?.error?.code ?? "INTERNAL";
  return failure(statusFor(code, response.status), code, response.body?.error?.message);
}

function statusFor(code, fallback = 400) {
  if (code === "RATE_LIMITED") return 429;
  if (["CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED", "CAPTCHA_REQUIRED"].includes(code)) return 423;
  if (code === "PROTOCOL_DRIFT") return 502;
  if (["SESSION_REVOKED", "SESSION_NOT_ACTIVE"].includes(code)) return 401;
  if (["FORBIDDEN", "SCOPE_REQUIRED", "OWNERSHIP_REQUIRED"].includes(code)) return 403;
  if (["IDENTITY_MISMATCH", "WRONG_IDENTITY", "IDEMPOTENCY_CONFLICT"].includes(code)) return 409;
  return fallback;
}

function ok(data, status = 200) { return { status, body: { data } }; }
function failure(status, code, message = code) { return { status, body: { error: { code, message: message ?? code } } }; }
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the public-boundary candidate driver`);
  return value;
}
