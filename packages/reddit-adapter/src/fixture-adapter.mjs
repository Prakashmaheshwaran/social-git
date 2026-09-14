import { fileURLToPath } from "node:url";
import {
  BoundedFrameDecoder,
  IpcFence,
  PlatformStopCircuit,
  WORKER_IPC_VERSION,
  decodeBoundedJson,
  decodeWorkerMessage,
  encodeCoreRequest,
  forkIsolatedWorker,
  inspectIsolatedWorker,
  writeLengthPrefixedFrame
} from "../../worker-security/src/index.mjs";
import {
  AdapterContractError,
  CORE_ERROR_CODES,
  MAX_IPC_MESSAGE_BYTES,
  REDDIT_CAPABILITIES,
  assertSupportedOperation
} from "./contract.mjs";
import {
  idempotencyDigest,
  validateOperationInput,
  validateWorkerSession,
  validateWriteControls
} from "./validation.mjs";

const WORKER_PATH = fileURLToPath(new URL("./fixture-worker.mjs", import.meta.url));
const ADAPTER_SOURCE_PATH = fileURLToPath(new URL("./", import.meta.url));
const SECURITY_SOURCE_PATH = fileURLToPath(new URL("../../worker-security/src/", import.meta.url));
const FIXTURE_TENANT_ID = "fixture-tenant";
const FIXTURE_ROUTE_ID = "reddit-fixture-route";
const DEFAULT_DEADLINE_MS = 5_000;
const capabilityByOperation = new Map(REDDIT_CAPABILITIES.map((item) => [item.operation, item.authorizationScope]));

export class RedditFixtureAdapter {
  #scenario;
  #worker = null;
  #workerInspection = null;
  #ready = null;
  #readyResolve = null;
  #readyReject = null;
  #startupTimer = null;
  #frameDecoder = null;
  #peerId = null;
  #fence = new IpcFence();
  #stopCircuit = new PlatformStopCircuit();
  #pending = new Map();
  #idempotency = new Map();
  #requestSequence = 0;
  #submissionAttempts = 0;
  #recoveryChecks = 0;
  #maxMessageBytes;
  #now;

  constructor({ scenario = {}, maxMessageBytes = MAX_IPC_MESSAGE_BYTES, now = Date.now } = {}) {
    this.#scenario = Object.freeze({ ...scenario });
    this.#maxMessageBytes = maxMessageBytes;
    this.#now = now;
  }

  capabilities() {
    return REDDIT_CAPABILITIES;
  }

  async importSession(context) {
    this.#validateContext(context);
    return this.#dispatch("session.import", {}, context);
  }

  async execute(operation, input, context) {
    const capability = assertSupportedOperation(operation);
    this.#validateContext(context);
    const requestInput = cloneIPCValue(input);
    validateOperationInput(operation, requestInput);

    if (capability.mode === "write") {
      const idempotency = validateWriteControls(capability, context, this.#now());
      const cacheKey = `${idempotency.callerId}\u0000${idempotency.key}`;
      const digest = idempotencyDigest(operation, context.accountId, requestInput);
      const cached = this.#idempotency.get(cacheKey);
      if (cached) {
        if (cached.digest !== digest) {
          throw new AdapterContractError(
            CORE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "The caller-scoped idempotency key was already used for different input"
          );
        }
        return cached.promise ?? cached.result;
      }

      const promise = this.#dispatch(operation, requestInput, context)
        .then((result) => {
          if (result.status === "FAILED" && result.error?.retryable === true) {
            if (this.#idempotency.get(cacheKey)?.promise === promise) this.#idempotency.delete(cacheKey);
          } else {
            this.#idempotency.set(cacheKey, { digest, result });
          }
          return result;
        })
        .catch((error) => {
          if (this.#idempotency.get(cacheKey)?.promise === promise) this.#idempotency.delete(cacheKey);
          throw error;
        });
      this.#idempotency.set(cacheKey, { digest, promise });
      return promise;
    }

    return this.#dispatch(operation, requestInput, context);
  }

  async recoverUnknown(unknownResult, context) {
    this.#validateContext(context);
    if (unknownResult?.status !== "UNKNOWN" || unknownResult?.action?.state !== "UNKNOWN") {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "Only an UNKNOWN action can be recovered");
    }
    if (unknownResult.action.accountId !== context.accountId) {
      throw new AdapterContractError(CORE_ERROR_CODES.WRONG_IDENTITY, "UNKNOWN action belongs to another account");
    }

    const cacheKey = `${unknownResult.action.callerId}\u0000${unknownResult.action.idempotencyKey}`;
    const cached = this.#idempotency.get(cacheKey);
    if (!cached?.result || cached.result.status !== "UNKNOWN") {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "UNKNOWN action is not owned by this adapter instance");
    }

    this.#recoveryChecks += 1;
    const result = await this.#dispatch("action.recover", { action: cached.result.action }, context);
    if (result.status !== "UNKNOWN") this.#idempotency.set(cacheKey, { digest: cached.digest, result });
    return result;
  }

  async inspectFixtureIsolation() {
    return this.#dispatch("fixture.diagnostics", {}, null);
  }

  diagnostics() {
    return Object.freeze({
      submissionAttempts: this.#submissionAttempts,
      recoveryChecks: this.#recoveryChecks,
      pendingRequests: this.#pending.size,
      workerRunning: Boolean(this.#worker && this.#worker.exitCode === null),
      workerRuntime: this.#workerInspection
    });
  }

  async close() {
    const worker = this.#worker;
    this.#resetWorker(worker);
    if (!worker || worker.exitCode !== null) return;
    await new Promise((resolve) => {
      worker.once("exit", resolve);
      worker.kill("SIGTERM");
    });
  }

  #validateContext(context) {
    if (
      !context || typeof context.accountId !== "string" || context.accountId.length === 0 ||
      typeof context.expectedNativeIdentity !== "string" || context.expectedNativeIdentity.length === 0
    ) {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "Account and expected native identity are required");
    }
    try {
      exact(context, ["accountId", "expectedNativeIdentity", "session"], ["authorization", "idempotency"]);
    } catch {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "Request context contains an unrecognized authority field");
    }
    validateWorkerSession(context.session, context, this.#now());
  }

  async #ensureWorker() {
    if (this.#worker && this.#worker.exitCode === null && this.#ready) {
      await this.#ready;
      return this.#worker;
    }

    const worker = forkIsolatedWorker(WORKER_PATH, {
      readPaths: [ADAPTER_SOURCE_PATH, SECURITY_SOURCE_PATH],
      environment: {
        NODE_ENV: "test",
        SOCIAL_GIT_FIXTURE_WORKER: "1",
        SOCIAL_GIT_FIXTURE_SCENARIO: JSON.stringify(this.#scenario)
      }
    });
    this.#worker = worker;
    worker.stderr.resume();
    this.#workerInspection = inspectIsolatedWorker(worker);
    this.#peerId = `worker-pid:${worker.pid}`;
    this.#fence = new IpcFence();
    this.#frameDecoder = new BoundedFrameDecoder({
      maxBytes: this.#maxMessageBytes,
      onFrame: (frame) => this.#handleFrame(worker, frame)
    });
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#startupTimer = setTimeout(() => {
      this.#readyReject?.(new AdapterContractError(CORE_ERROR_CODES.WORKER_UNAVAILABLE, "Fixture worker attestation timed out"));
      worker.kill("SIGTERM");
    }, DEFAULT_DEADLINE_MS);
    worker.stdout.on("data", (chunk) => {
      try {
        this.#frameDecoder.push(chunk);
      } catch {
        this.#protocolFailure(worker);
      }
    });
    worker.stdout.once("end", () => {
      try {
        this.#frameDecoder?.end();
      } catch {
        this.#protocolFailure(worker);
      }
    });
    worker.once("exit", () => this.#handleExit(worker));
    worker.once("error", () => this.#handleExit(worker));
    await this.#ready;
    return worker;
  }

  async #dispatch(operation, input, context) {
    const requestId = `reddit-fixture-${++this.#requestSequence}`;
    const actionId = `action-${requestId}`;
    const accountId = context?.accountId ?? "fixture-system";
    const generation = context?.session?.generation ?? 1;
    const capability = capabilityForOperation(operation);
    const dispatchBinding = {
      platform: "reddit",
      tenantId: FIXTURE_TENANT_ID,
      accountId,
      routeId: FIXTURE_ROUTE_ID,
      generation,
      actionId
    };
    if (context) {
      try {
        this.#stopCircuit.assertCanDispatch(dispatchBinding);
      } catch {
        const stopped = this.#stopCircuit.inspect("reddit").circuit;
        return failureResult(operation, accountId, stopped?.code ?? CORE_ERROR_CODES.PROTOCOL_DRIFT,
          "Reddit dispatch is stopped until an authorized newer generation is active");
      }
    }
    const sessionDeadline = context ? Date.parse(context.session.expiresAt) : Number.POSITIVE_INFINITY;
    const deadlineEpochMs = Math.min(this.#now() + DEFAULT_DEADLINE_MS, sessionDeadline);
    const request = {
      protocolVersion: WORKER_IPC_VERSION,
      kind: "request",
      requestId,
      actionId,
      tenantId: FIXTURE_TENANT_ID,
      accountId,
      routeId: FIXTURE_ROUTE_ID,
      generation,
      capability,
      deadlineEpochMs,
      payload: {
        operation,
        input: input ?? {},
        ...(context ? {
          expectedNativeIdentity: context.expectedNativeIdentity,
          session: cloneIPCValue(context.session),
          ...(context.idempotency && operation !== "action.recover"
            ? { idempotency: cloneIPCValue(context.idempotency) }
            : {})
        } : {})
      }
    };
    let encoded;
    try {
      encoded = encodeCoreRequest(request);
    } catch {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The worker request exceeds the bounded IPC schema");
    }
    const worker = await this.#ensureWorker();
    this.#fence.register(this.#peerId, request);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        this.#fence.expire(this.#now());
        pending.resolve(failureResult(operation, accountId, CORE_ERROR_CODES.WORKER_UNAVAILABLE,
          "The isolated Reddit worker exceeded its total deadline", true));
        worker.kill("SIGTERM");
      }, Math.max(1, deadlineEpochMs - this.#now()));
      this.#pending.set(requestId, {
        resolve,
        timer,
        operation,
        accountId: context?.accountId,
        binding: dispatchBinding,
        callerId: context?.idempotency?.callerId,
        idempotencyKey: context?.idempotency?.key,
        recoveryAction: operation === "action.recover" ? input.action : null,
        submission: null
      });
      writeLengthPrefixedFrame(worker.stdin, encoded, this.#maxMessageBytes).catch(() => this.#handleExit(worker));
    });
  }

  #handleFrame(worker, frame) {
    if (this.#worker !== worker) return;
    const value = decodeBoundedJson(frame);
    if (value?.kind === "ready") {
      validateReady(value, worker.pid, this.#workerInspection.osSandbox);
      clearTimeout(this.#startupTimer);
      this.#startupTimer = null;
      this.#readyResolve?.();
      this.#readyResolve = null;
      this.#readyReject = null;
      return;
    }

    const message = decodeWorkerMessage(frame);
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      this.#protocolFailure(worker);
      return;
    }
    let accepted;
    try {
      accepted = this.#fence.accept(this.#peerId, message, this.#now());
    } catch {
      this.#pending.delete(message.requestId);
      clearTimeout(pending.timer);
      const result = protocolDriftResult(pending);
      this.#stopCircuit.observe(pending.binding, result);
      pending.resolve(result);
      this.#protocolFailure(worker);
      return;
    }
    if (message.kind === "event") {
      pending.submission = { native: accepted.native, submittedAt: accepted.submittedAt };
      this.#submissionAttempts += 1;
      return;
    }

    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    let result;
    try {
      validateWorkerOutcome(pending.operation, accepted);
      result = redactWorkerResult(accepted, pending);
    } catch {
      result = protocolDriftResult(pending);
    }
    this.#stopCircuit.observe(pending.binding, result);
    pending.resolve(result);
  }

  #protocolFailure(worker) {
    if (worker.exitCode === null) worker.kill("SIGTERM");
    this.#handleExit(worker);
  }

  #handleExit(worker) {
    if (this.#worker !== worker) return;
    this.#readyReject?.(new AdapterContractError(CORE_ERROR_CODES.WORKER_UNAVAILABLE, "Fixture worker exited during startup"));
    this.#resetWorker(worker);
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      if (pending.submission) {
        pending.resolve(immutableResult({
          status: "UNKNOWN",
          operation: pending.operation,
          accountId: pending.accountId,
          action: {
            state: "UNKNOWN",
            operation: pending.operation,
            accountId: pending.accountId,
            callerId: pending.callerId,
            idempotencyKey: pending.idempotencyKey,
            submittedAt: pending.submission.submittedAt,
            native: pending.submission.native,
            retryPermitted: false
          }
        }));
      } else {
        pending.resolve(failureResult(
          pending.operation,
          pending.accountId,
          CORE_ERROR_CODES.WORKER_UNAVAILABLE,
          "The isolated Reddit worker exited before submission",
          true
        ));
      }
    }
  }

  #resetWorker(worker) {
    if (worker && this.#worker !== worker) return;
    clearTimeout(this.#startupTimer);
    this.#startupTimer = null;
    this.#worker = null;
    this.#workerInspection = null;
    this.#ready = null;
    this.#readyResolve = null;
    this.#readyReject = null;
    this.#frameDecoder = null;
    this.#peerId = null;
    this.#fence = new IpcFence();
  }
}

function capabilityForOperation(operation) {
  if (capabilityByOperation.has(operation)) return capabilityByOperation.get(operation);
  if (operation === "session.import") return "reddit.session.import";
  if (operation === "action.recover") return "reddit.action.recover";
  if (operation === "fixture.diagnostics") return "reddit.fixture.diagnostics";
  throw new AdapterContractError(CORE_ERROR_CODES.UNKNOWN_OPERATION, "Worker capability is not registered");
}

function validateReady(value, pid, osSandbox) {
  exact(value, ["protocolVersion", "kind", "pid", "runtime"]);
  if (value.protocolVersion !== WORKER_IPC_VERSION || value.kind !== "ready" || value.pid !== pid) throw new Error("bad ready");
  exact(value.runtime, [
    "permissionModel", "networkGranted", "filesystemWriteGranted", "childProcessGranted",
    "workerThreadGranted", "nativeAddonGranted", "forbiddenEnvironmentVisible", "osSandbox"
  ]);
  if (
    value.runtime.permissionModel !== true || value.runtime.networkGranted !== false ||
    value.runtime.filesystemWriteGranted !== false || value.runtime.childProcessGranted !== false ||
    value.runtime.workerThreadGranted !== false || value.runtime.nativeAddonGranted !== false ||
    value.runtime.forbiddenEnvironmentVisible !== false || value.runtime.osSandbox !== osSandbox
  ) throw new Error("worker authority");
}

function validateWorkerOutcome(operation, result) {
  if (result.status === "FAILED") {
    exact(result, ["status", "error"], ["rateLimit"]);
    exact(result.error, ["code", "message", "retryable", "actionRequired"]);
    if (!Object.values(CORE_ERROR_CODES).includes(result.error.code) || typeof result.error.message !== "string" ||
        typeof result.error.retryable !== "boolean" || typeof result.error.actionRequired !== "boolean") throw new Error("bad failure");
    if (result.rateLimit) validateRateLimitShape(result.rateLimit);
    return;
  }
  if (result.status === "UNKNOWN") {
    exact(result, ["status", "recoveryCheckedAt"]);
    if (operation !== "action.recover" || !Number.isFinite(Date.parse(result.recoveryCheckedAt))) throw new Error("bad unknown");
    return;
  }
  exact(result, ["status", "native", "data", "rateLimit"]);
  if (result.status !== "SUCCEEDED") throw new Error("bad status");
  if (result.native !== null) validateNativeShape(result.native);
  validateRateLimitShape(result.rateLimit);
  validateDataShape(operation, result.data);
}

function validateDataShape(operation, data) {
  switch (operation) {
    case "session.import":
      exact(data, ["nativeIdentity", "validated"]);
      if (typeof data.nativeIdentity !== "string" || data.validated !== true) throw new Error("bad import");
      return;
    case "fixture.diagnostics":
      exact(data, ["databaseEnvironmentVisible", "fixtureWorker", "workerProcessId", "runtime"]);
      if (data.databaseEnvironmentVisible !== false || data.fixtureWorker !== true || !Number.isSafeInteger(data.workerProcessId)) throw new Error("bad diagnostics");
      exact(data.runtime, [
        "permissionModel", "networkGranted", "filesystemWriteGranted", "childProcessGranted",
        "workerThreadGranted", "nativeAddonGranted", "forbiddenEnvironmentVisible", "osSandbox"
      ]);
      return;
    case "profile.get":
      exact(data, ["username", "karma"]); exact(data.karma, ["post", "comment"]); return;
    case "subreddit.get":
      exact(data, ["name", "subscribers"]); return;
    case "listing.list":
      exact(data, ["items", "page"]); data.items.forEach(validatePostShape); validatePageShape(data.page); return;
    case "post.get":
      validatePostShape(data); return;
    case "comments.list":
      exact(data, ["items", "page"]); data.items.forEach(validateCommentShape); validatePageShape(data.page); return;
    case "search.query":
      exact(data, ["query", "items", "page"]); data.items.forEach(validatePostShape); validatePageShape(data.page); return;
    case "post.createText":
    case "post.createLink":
      exact(data, ["created", "kind"]); return;
    case "post.createMedia":
      exact(data, ["created", "kind", "media"]); exact(data.media, ["state"]); return;
    case "comment.create":
    case "reply.create":
      exact(data, ["created", "kind"]); return;
    case "vote.set":
      exact(data, ["applied", "direction"]); return;
    case "save.set":
    case "save.unset":
      exact(data, ["saved"]); return;
    case "item.deleteOwn":
      exact(data, ["deleted"]); return;
    case "action.recover":
      exact(data, ["recovered"]); return;
    default:
      throw new Error("missing output schema");
  }
}

function validatePostShape(value) {
  exact(value, ["nativeId", "canonicalUrl", "title", "author"]);
  validateNativeShape(value);
}

function validateCommentShape(value) {
  exact(value, ["nativeId", "canonicalUrl", "body", "author"]);
  validateNativeShape(value);
}

function validatePageShape(value) {
  exact(value, ["after", "before"]);
}

function validateNativeShape(native) {
  if (typeof native.nativeId !== "string" || !/^t[0-9]+_[a-z0-9]+$/.test(native.nativeId) ||
      typeof native.canonicalUrl !== "string" || !native.canonicalUrl.startsWith("https://www.reddit.com/")) throw new Error("bad native");
}

function validateRateLimitShape(rateLimit) {
  exact(rateLimit, ["limit", "remaining", "resetAt"], ["retryAfterMs"]);
  if (!Number.isSafeInteger(rateLimit.limit) || !Number.isSafeInteger(rateLimit.remaining) ||
      !Number.isFinite(Date.parse(rateLimit.resetAt)) ||
      (rateLimit.retryAfterMs !== undefined && !Number.isSafeInteger(rateLimit.retryAfterMs))) throw new Error("bad rate limit");
}

function redactWorkerResult(result, pending) {
  if (result.status === "FAILED") {
    return immutableResult({
      status: "FAILED",
      operation: pending.operation,
      accountId: pending.accountId,
      error: { ...result.error },
      ...(result.rateLimit ? { rateLimit: { ...result.rateLimit } } : {})
    });
  }
  if (result.status === "UNKNOWN") {
    const action = pending.recoveryAction;
    return immutableResult({
      status: "UNKNOWN",
      operation: action.operation,
      accountId: action.accountId,
      action: { ...action, recoveryCheckedAt: result.recoveryCheckedAt }
    });
  }
  return immutableResult({
    status: "SUCCEEDED",
    operation: pending.operation === "action.recover" ? pending.recoveryAction.operation : pending.operation,
    accountId: pending.operation === "action.recover" ? pending.recoveryAction.accountId : pending.accountId,
    native: result.native,
    data: structuredClone(result.data),
    rateLimit: { ...result.rateLimit }
  });
}

function protocolDriftResult(pending) {
  return failureResult(pending.operation, pending.accountId, CORE_ERROR_CODES.PROTOCOL_DRIFT,
    "The worker returned an invalid versioned response");
}

function failureResult(operation, accountId, code, message, retryable = false) {
  return immutableResult({
    status: "FAILED",
    operation,
    accountId,
    error: { code, message, retryable, actionRequired: !retryable }
  });
}

function exact(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("not plain");
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error("wrong fields");
}

function immutableResult(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutableResult(child);
  return Object.freeze(value);
}

function cloneIPCValue(value) {
  try {
    return structuredClone(value);
  } catch {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "IPC input must contain cloneable data");
  }
}
