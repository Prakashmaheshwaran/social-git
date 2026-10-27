import { createHash } from "node:crypto";

import { PLATFORM_FAILURES, READ_OPERATIONS, WRITE_OPERATIONS } from "../contract.mjs";

const FIXTURE_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const failureByOutcome = new Map(PLATFORM_FAILURES.map(([outcome, status, code]) => (
  [outcome, { status, code }]
)));

function clone(value) {
  return structuredClone(value);
}

function ok(data, status = 200) {
  return { status, body: { data } };
}

function actionResult(data, status = 200) {
  return { status, body: { result: data } };
}

function failure(status, code, message = code) {
  return { status, body: { error: { code, message } } };
}

function fingerprint(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function canonicalUrlFor(operation, accountId, nativeId) {
  if (operation === "read.account-profile") {
    return `https://www.reddit.com/user/${accountId}/`;
  }
  if (operation === "read.subreddit-metadata"
    || operation === "write.subscribe"
    || operation === "write.unsubscribe") {
    return "https://www.reddit.com/r/qualityassurance/";
  }
  return `https://www.reddit.com/r/qualityassurance/comments/fixture/${nativeId}/`;
}

function nativePrefix(operation) {
  if (operation.includes("comment") || operation === "write.reply") {
    return "t1";
  }
  if (operation === "write.subscribe" || operation === "write.unsubscribe") {
    return "t5";
  }
  return "t3";
}

function requiresCallerOwnership(operation) {
  return operation === "write.delete" || operation === "write.edit-own";
}

export function createFixtureDriver({ faults = {} } = {}) {
  let state;

  function newState() {
    return {
      platformSessions: new Map(),
      accounts: new Map(),
      owned: new Map(),
      nextOutcomes: new Map(),
      crashAfterSubmit: new Set(),
      reconciliationOutcomes: new Map(),
      platformCalls: [],
      logs: [],
      auditEvents: [],
      storageRecords: [],
      ledger: new Map(),
      actions: new Map(),
      actionSequence: 0,
      restartSequence: 0,
    };
  }

  function log(event, input = null) {
    const entry = { event, sensitive: "[REDACTED]" };
    if (faults.leakSecrets && input?.syntheticSensitiveFields) {
      entry.unsafe = input.syntheticSensitiveFields;
    }
    state.logs.push(entry);
  }

  function audit(event, accountId = null) {
    state.auditEvents.push({ event, accountId });
  }

  function activeAccount(accountId) {
    const account = state.accounts.get(accountId);
    if (!account || account.state === "WRONG_IDENTITY") {
      return { error: failure(401, "SESSION_NOT_ACTIVE", "Session is not active") };
    }
    if (account.state === "REVOKED") {
      return { error: failure(401, "SESSION_REVOKED", "Session was revoked") };
    }
    return { account };
  }

  function platformCall(account, operation) {
    const routeId = faults.wrongRoute && account.accountId === "acct-beta"
      ? "route-alpha"
      : account.routeId;
    state.platformCalls.push({
      accountId: account.accountId,
      identity: account.identity,
      operation,
      routeId,
    });

    const key = `${account.accountId}:${operation}`;
    const outcome = state.nextOutcomes.get(key);
    state.nextOutcomes.delete(key);
    if (!outcome) {
      return null;
    }

    if (faults.retryPlatformFailures) {
      state.platformCalls.push({
        accountId: account.accountId,
        identity: account.identity,
        operation,
        routeId,
      });
    }
    return failureByOutcome.get(outcome) ?? { status: 500, code: "FIXTURE_OUTCOME_UNKNOWN" };
  }

  function readResult(operation, account) {
    const suffix = `${operation.replaceAll(".", "-")}-${account.accountId}`;
    const nativeId = operation === "read.account-profile"
      ? `user-${account.identity}`
      : `${nativePrefix(operation)}_${suffix}`;
    return {
      nativeId,
      canonicalUrl: canonicalUrlFor(operation, account.accountId, nativeId),
      identity: operation === "read.account-profile"
        ? (faults.crossAccountLeak ? "qa_alpha" : account.identity)
        : undefined,
      items: operation === "read.feed" || operation === "read.comments" || operation === "read.search"
        ? []
        : undefined,
    };
  }

  function writeResult(operation, input, actionId) {
    const sequence = actionId.slice(4);
    const nativeId = operation === "write.delete" || operation === "write.edit-own"
      ? input.targetNativeId
      : operation === "write.subscribe" || operation === "write.unsubscribe"
        ? `t5_${String(input.subreddit).toLowerCase()}`
        : `${nativePrefix(operation)}_${operation.replaceAll(".", "-")}-${sequence}`;
    return {
      actionId,
      state: "CONFIRMED",
      nativeId,
      canonicalUrl: canonicalUrlFor(operation, input.accountId, nativeId),
    };
  }

  async function write(operation, input, context) {
    const active = activeAccount(input.accountId);
    if (active.error) {
      return active.error;
    }
    const { account } = active;
    const requiredScope = `reddit.${operation}`;
    if (!context?.scopes?.includes(requiredScope)) {
      return failure(403, "SCOPE_REQUIRED", `Missing scope ${requiredScope}`);
    }
    if (!context.idempotencyKey) {
      return failure(400, "IDEMPOTENCY_KEY_REQUIRED", "Write requires an idempotency key");
    }

    if (requiresCallerOwnership(operation)) {
      const owned = state.owned.get(input.accountId) ?? new Set();
      if (!owned.has(input.targetNativeId)) {
        return failure(403, "OWNERSHIP_REQUIRED", "Only caller-owned items can be mutated");
      }
    }

    const ledgerKey = [
      context.callerId,
      input.accountId,
      operation,
      context.idempotencyKey,
    ].join(":");
    const inputFingerprint = fingerprint(input);
    const existing = state.ledger.get(ledgerKey);
    if (existing) {
      if (existing.fingerprint !== inputFingerprint) {
        return failure(409, "IDEMPOTENCY_CONFLICT", "Key was used for a different request");
      }
      const response = await existing.promise;
      if (faults.retryUnknown && response.body?.result?.state === "UNKNOWN") {
        platformCall(account, operation);
      }
      return clone(response);
    }

    const ledgerEntry = {
      fingerprint: inputFingerprint,
      promise: null,
      response: null,
    };
    ledgerEntry.promise = (async () => {
      await Promise.resolve();
      const platformFailure = platformCall(account, operation);
      if (platformFailure) {
        const response = failure(platformFailure.status, platformFailure.code, platformFailure.code);
        ledgerEntry.response = response;
        return response;
      }

      const actionId = `act-${String(++state.actionSequence).padStart(3, "0")}`;
      const crashKey = `${input.accountId}:${operation}`;
      if (state.crashAfterSubmit.delete(crashKey)) {
        const unknown = {
          actionId,
          state: "UNKNOWN",
        };
        const response = actionResult(unknown, 202);
        state.actions.set(actionId, { data: unknown, ledgerEntry });
        ledgerEntry.response = response;
        audit("action.unknown", input.accountId);
        return response;
      }

      const confirmed = writeResult(operation, input, actionId);
      const response = actionResult(confirmed);
      state.actions.set(actionId, { data: confirmed, ledgerEntry });
      ledgerEntry.response = response;
      const owned = state.owned.get(input.accountId) ?? new Set();
      if (operation.startsWith("write.post.") || operation === "write.comment" || operation === "write.reply") {
        owned.add(confirmed.nativeId);
        state.owned.set(input.accountId, owned);
      }
      if (operation === "write.delete") {
        owned.delete(input.targetNativeId);
      }
      audit("action.confirmed", input.accountId);
      return response;
    })();
    state.ledger.set(ledgerKey, ledgerEntry);
    return clone(await ledgerEntry.promise);
  }

  async function call(operation, input = {}, context = {}) {
    log(`call.${operation}`, input);

    if (operation === "session.import") {
      const platformSession = state.platformSessions.get(input.sessionFixture);
      if (!platformSession) {
        return failure(401, "SESSION_INVALID", "Fixture session is not valid");
      }
      if (!input.routeId) {
        return failure(400, "NETWORK_ROUTE_REQUIRED", "Account requires a network route");
      }
      const account = {
        accountId: input.accountId,
        expectedIdentity: input.expectedIdentity,
        identity: platformSession.nativeIdentity,
        routeId: input.routeId,
        generation: 1,
        state: platformSession.nativeIdentity === input.expectedIdentity
          ? "ACTIVE"
          : "WRONG_IDENTITY",
      };
      state.accounts.set(input.accountId, account);
      state.storageRecords.push(
        {
          encrypted: true,
          accountId: input.accountId,
          purpose: "session",
          generation: 1,
          nonceId: `nonce-session-${input.accountId}`,
          ciphertextFixture: `encrypted-session-${input.accountId}`,
        },
        {
          encrypted: true,
          accountId: input.accountId,
          purpose: "network-route",
          generation: 1,
          nonceId: `nonce-route-${input.accountId}`,
          ciphertextFixture: `encrypted-route-${input.accountId}`,
        },
      );
      platformCall(account, "session.import");
      if (account.state === "WRONG_IDENTITY") {
        audit("session.wrong_identity", input.accountId);
        return failure(409, "WRONG_IDENTITY", "Session identity does not match the expected identity");
      }
      audit("session.imported", input.accountId);
      return ok({
        accountId: input.accountId,
        identity: account.identity,
        state: account.state,
      }, 201);
    }

    if (operation === "session.refresh") {
      const active = activeAccount(input.accountId);
      if (active.error) {
        return active.error;
      }
      const platformSession = state.platformSessions.get(input.sessionFixture);
      if (!platformSession) {
        return failure(401, "SESSION_INVALID", "Fixture session is not valid");
      }
      if (!input.routeId) {
        return failure(400, "NETWORK_ROUTE_REQUIRED", "Account requires a network route");
      }
      if (input.generation !== active.account.generation + 1) {
        return failure(422, "VALIDATION_FAILED", "Refresh requires the next session generation");
      }
      active.account.identity = platformSession.nativeIdentity;
      active.account.routeId = input.routeId;
      active.account.generation = input.generation;
      active.account.state = platformSession.nativeIdentity === active.account.expectedIdentity
        ? "ACTIVE"
        : "WRONG_IDENTITY";
      state.storageRecords.push(
        {
          encrypted: true,
          accountId: input.accountId,
          purpose: "session",
          generation: input.generation,
          nonceId: `nonce-session-${input.accountId}-${input.generation}`,
          ciphertextFixture: `encrypted-session-${input.accountId}-${input.generation}`,
        },
        {
          encrypted: true,
          accountId: input.accountId,
          purpose: "network-route",
          generation: input.generation,
          nonceId: `nonce-route-${input.accountId}-${input.generation}`,
          ciphertextFixture: `encrypted-route-${input.accountId}-${input.generation}`,
        },
      );
      platformCall(active.account, "session.refresh");
      if (active.account.state === "WRONG_IDENTITY") {
        audit("session.wrong_identity", input.accountId);
        return failure(409, "WRONG_IDENTITY", "Session identity does not match the expected identity");
      }
      audit("session.refreshed", input.accountId);
      return ok({
        accountId: input.accountId,
        identity: active.account.identity,
        state: active.account.state,
        generation: active.account.generation,
      });
    }

    if (operation === "session.validate") {
      const active = activeAccount(input.accountId);
      if (active.error) {
        return active.error;
      }
      const platformFailure = platformCall(active.account, operation);
      if (platformFailure) {
        return failure(platformFailure.status, platformFailure.code, platformFailure.code);
      }
      return ok({ state: "ACTIVE", identity: active.account.identity });
    }

    if (operation === "session.revoke") {
      const account = state.accounts.get(input.accountId);
      if (!account) {
        return failure(404, "ACCOUNT_NOT_FOUND", "Account does not exist");
      }
      account.state = "REVOKED";
      audit("session.revoked", input.accountId);
      return ok({ state: "REVOKED" }, 204);
    }

    if (operation === "account.health") {
      const account = state.accounts.get(input.accountId);
      if (!account) {
        return failure(404, "ACCOUNT_NOT_FOUND", "Account does not exist");
      }
      return ok({ state: account.state });
    }

    if (operation === "action.get") {
      const action = state.actions.get(input.actionId);
      return action
        ? actionResult(clone(action.data))
        : failure(404, "ACTION_NOT_FOUND", "Action does not exist");
    }

    if (operation === "action.reconcile") {
      const action = state.actions.get(input.actionId);
      if (!action) {
        return failure(404, "ACTION_NOT_FOUND", "Action does not exist");
      }
      const reconciliation = state.reconciliationOutcomes.get(input.actionId);
      if (!reconciliation || reconciliation.outcome === "not_found") {
        return actionResult(clone(action.data), 202);
      }
      action.data = {
        actionId: input.actionId,
        state: "CONFIRMED",
        nativeId: reconciliation.nativeId,
        canonicalUrl: reconciliation.canonicalUrl,
      };
      action.ledgerEntry.response = actionResult(clone(action.data));
      action.ledgerEntry.promise = Promise.resolve(action.ledgerEntry.response);
      audit("action.reconciled");
      return clone(action.ledgerEntry.response);
    }

    if (READ_OPERATIONS.includes(operation)) {
      const active = activeAccount(input.accountId);
      if (active.error) {
        return active.error;
      }
      const platformFailure = platformCall(active.account, operation);
      if (platformFailure) {
        return failure(platformFailure.status, platformFailure.code, platformFailure.code);
      }
      return ok(readResult(operation, active.account));
    }

    if (WRITE_OPERATIONS.includes(operation)) {
      return write(operation, input, context);
    }

    return failure(400, "OPERATION_UNSUPPORTED", "Fixture operation is not supported");
  }

  async function control(command, payload = {}) {
    if (command === "platform-session") {
      state.platformSessions.set(payload.sessionFixture, {
        nativeIdentity: payload.nativeIdentity,
      });
      return;
    }
    if (command === "seed-owned") {
      state.owned.set(payload.accountId, new Set(payload.nativeIds));
      return;
    }
    if (command === "next-platform-outcome") {
      state.nextOutcomes.set(`${payload.accountId}:${payload.operation}`, payload.outcome);
      return;
    }
    if (command === "crash-after-submit") {
      state.crashAfterSubmit.add(`${payload.accountId}:${payload.operation}`);
      return;
    }
    if (command === "reconciliation-outcome") {
      state.reconciliationOutcomes.set(payload.actionId, clone(payload));
      return;
    }
    if (command === "restart") {
      state.restartSequence += 1;
      log("runtime.restart");
      return;
    }
    throw new Error(`Unknown fixture control command: ${command}`);
  }

  async function inspect(target) {
    if (target === "platform-calls") {
      return clone(state.platformCalls);
    }
    if (target === "logs") {
      return clone(state.logs);
    }
    if (target === "audit-events") {
      return clone(state.auditEvents);
    }
    if (target === "storage-records") {
      return clone(state.storageRecords);
    }
    if (target === "production-image") {
      return {
        source: {
          kind: "image_tar",
          digest: FIXTURE_IMAGE_DIGEST,
        },
        provenance: "independent_inventory",
        dependencies: faults.browserDependency
          ? ["fixture-server", "playwright"]
          : ["fixture-server"],
        runtimeFiles: ["/app/server.mjs"],
        imageCommands: ["node", "/app/server.mjs"],
        runtimeProcesses: ["node /app/server.mjs"],
        browserExecutables: faults.browserDependency ? ["/usr/bin/browser-shell"] : [],
      };
    }
    throw new Error(`Unknown fixture inspection target: ${target}`);
  }

  state = newState();
  return {
    metadata: {
      kind: "fixture_self_test",
      candidateRef: null,
      imageDigest: FIXTURE_IMAGE_DIGEST,
    },
    async reset() {
      state = newState();
    },
    call,
    control,
    inspect,
    async close() {},
  };
}

// This alias lets the candidate runner reach and test its explicit fixture
// rejection path. metadata.kind still prevents this driver from issuing a
// candidate verdict.
export const createDriver = createFixtureDriver;
