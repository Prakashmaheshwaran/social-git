import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AdapterContractError,
  CORE_ERROR_CODES,
  IPC_PROTOCOL_VERSION,
  MAX_IPC_MESSAGE_BYTES,
  REDDIT_CAPABILITIES,
  assertBoundedIPCMessage,
  assertIPCEnvelope,
  assertSupportedOperation
} from "./contract.mjs";
import {
  idempotencyDigest,
  validateOperationInput,
  validateWorkerSession,
  validateWriteControls
} from "./validation.mjs";

const WORKER_PATH = fileURLToPath(new URL("./fixture-worker.mjs", import.meta.url));

export class RedditFixtureAdapter {
  #scenario;
  #worker = null;
  #ready = null;
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
          this.#idempotency.set(cacheKey, { digest, result });
          return result;
        })
        .catch((error) => {
          if (this.#idempotency.get(cacheKey)?.promise === promise) {
            this.#idempotency.delete(cacheKey);
          }
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
      throw new AdapterContractError(
        CORE_ERROR_CODES.INVALID_REQUEST,
        "UNKNOWN action is not owned by this adapter instance"
      );
    }

    this.#recoveryChecks += 1;
    const result = await this.#dispatch("action.recover", { action: cached.result.action }, context);
    if (cached && result.status !== "UNKNOWN") {
      this.#idempotency.set(cacheKey, { digest: cached.digest, result });
    }
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
      workerRunning: Boolean(this.#worker?.connected)
    });
  }

  async close() {
    const worker = this.#worker;
    this.#worker = null;
    this.#ready = null;
    if (!worker || worker.exitCode !== null) {
      return;
    }
    await new Promise((resolve) => {
      worker.once("exit", resolve);
      worker.kill("SIGTERM");
    });
  }

  #validateContext(context) {
    if (
      !context ||
      typeof context.accountId !== "string" ||
      context.accountId.length === 0 ||
      typeof context.expectedNativeIdentity !== "string" ||
      context.expectedNativeIdentity.length === 0
    ) {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "Account and expected native identity are required");
    }
    validateWorkerSession(context.session, context, this.#now());
  }

  async #ensureWorker() {
    if (this.#worker?.connected && this.#ready) {
      await this.#ready;
      return this.#worker;
    }

    const worker = fork(WORKER_PATH, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
      execArgv: [],
      env: {
        NODE_ENV: "test",
        SOCIAL_GIT_FIXTURE_WORKER: "1",
        SOCIAL_GIT_FIXTURE_SCENARIO: JSON.stringify(this.#scenario)
      }
    });
    this.#worker = worker;
    this.#ready = new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.version === IPC_PROTOCOL_VERSION && message?.kind === "ready") {
          worker.off("message", onMessage);
          worker.off("exit", onEarlyExit);
          resolve();
        }
      };
      const onEarlyExit = () => {
        worker.off("message", onMessage);
        reject(new AdapterContractError(CORE_ERROR_CODES.WORKER_UNAVAILABLE, "Fixture worker exited during startup"));
      };
      worker.on("message", onMessage);
      worker.once("exit", onEarlyExit);
    });
    worker.on("message", (message) => this.#handleMessage(message));
    worker.on("exit", () => this.#handleExit(worker));
    worker.on("error", () => this.#handleExit(worker));
    await this.#ready;
    return worker;
  }

  async #dispatch(operation, input, context) {
    const requestId = `reddit-fixture-${++this.#requestSequence}`;
    const request = {
      version: IPC_PROTOCOL_VERSION,
      kind: "request",
      requestId,
      operation,
      input: input ?? {},
      ...(context
        ? {
            accountId: context.accountId,
            expectedNativeIdentity: context.expectedNativeIdentity,
            session: cloneIPCValue(context.session),
            ...(context.idempotency ? { idempotency: context.idempotency } : {})
          }
        : {})
    };
    assertBoundedIPCMessage(request, this.#maxMessageBytes);
    const worker = await this.#ensureWorker();

    return new Promise((resolve) => {
      this.#pending.set(requestId, {
        resolve,
        operation,
        accountId: context?.accountId,
        callerId: context?.idempotency?.callerId,
        idempotencyKey: context?.idempotency?.key,
        submission: null
      });
      worker.send(request, (error) => {
        if (!error) {
          return;
        }
        const pending = this.#pending.get(requestId);
        if (pending) {
          this.#pending.delete(requestId);
          pending.resolve(immutableResult({
            status: "FAILED",
            operation,
            accountId: context?.accountId,
            error: {
              code: CORE_ERROR_CODES.WORKER_UNAVAILABLE,
              message: "The isolated Reddit worker rejected the request before submission",
              retryable: true,
              actionRequired: false
            }
          }));
        }
      });
    });
  }

  #handleMessage(message) {
    try {
      assertIPCEnvelope(message, message?.kind, this.#maxMessageBytes);
    } catch {
      const pending = message?.requestId ? this.#pending.get(message.requestId) : null;
      if (pending) {
        this.#pending.delete(message.requestId);
        pending.resolve(protocolDriftResult(pending));
      }
      return;
    }

    if (message.kind === "submission_started") {
      const pending = this.#pending.get(message.requestId);
      if (pending && !pending.submission) {
        pending.submission = { native: message.native, submittedAt: message.submittedAt };
        this.#submissionAttempts += 1;
      }
      return;
    }

    if (message.kind === "response") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.requestId);
      try {
        pending.resolve(redactWorkerResult(message.result, pending));
      } catch {
        pending.resolve(protocolDriftResult(pending));
      }
    }
  }

  #handleExit(worker) {
    if (this.#worker === worker) {
      this.#worker = null;
      this.#ready = null;
    }
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
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
        pending.resolve(immutableResult({
          status: "FAILED",
          operation: pending.operation,
          accountId: pending.accountId,
          error: {
            code: CORE_ERROR_CODES.WORKER_UNAVAILABLE,
            message: "The isolated Reddit worker exited before submission",
            retryable: true,
            actionRequired: false
          }
        }));
      }
    }
  }
}

function redactWorkerResult(result, pending) {
  if (!result || typeof result !== "object") {
    return protocolDriftResult(pending);
  }

  if (result.status === "FAILED" && result.error && typeof result.error === "object") {
    return immutableResult({
      status: "FAILED",
      operation: pending.operation,
      accountId: pending.accountId,
      error: {
        code: String(result.error.code),
        message: String(result.error.message),
        retryable: result.error.retryable === true,
        actionRequired: result.error.actionRequired === true
      },
      ...(result.rateLimit ? { rateLimit: normalizeRateLimit(result.rateLimit) } : {})
    });
  }

  if (result.status === "SUCCEEDED" && result.data && typeof result.data === "object") {
    const operation = pending.operation === "action.recover" ? result.operation : pending.operation;
    return immutableResult({
      status: "SUCCEEDED",
      operation,
      accountId: result.accountId ?? pending.accountId,
      native: result.native === null || result.native === undefined ? null : normalizeNative(result.native),
      data: structuredClone(result.data),
      ...(result.rateLimit ? { rateLimit: normalizeRateLimit(result.rateLimit) } : {})
    });
  }

  if (result.status === "UNKNOWN" && result.action?.state === "UNKNOWN") {
    const action = result.action;
    return immutableResult({
      status: "UNKNOWN",
      operation: action.operation,
      accountId: action.accountId,
      action: {
        state: "UNKNOWN",
        operation: action.operation,
        accountId: action.accountId,
        callerId: action.callerId,
        idempotencyKey: action.idempotencyKey,
        submittedAt: action.submittedAt,
        native: normalizeNative(action.native),
        retryPermitted: false,
        ...(action.recoveryCheckedAt ? { recoveryCheckedAt: action.recoveryCheckedAt } : {})
      }
    });
  }

  return protocolDriftResult(pending);
}

function normalizeNative(native) {
  if (
    !native ||
    typeof native.nativeId !== "string" ||
    !/^t[0-9]+_[a-z0-9]+$/.test(native.nativeId) ||
    typeof native.canonicalUrl !== "string" ||
    !native.canonicalUrl.startsWith("https://www.reddit.com/")
  ) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Worker returned an invalid native reference");
  }
  return { nativeId: native.nativeId, canonicalUrl: native.canonicalUrl };
}

function normalizeRateLimit(rateLimit) {
  if (
    !rateLimit ||
    !Number.isSafeInteger(rateLimit.limit) ||
    !Number.isSafeInteger(rateLimit.remaining) ||
    typeof rateLimit.resetAt !== "string" ||
    !Number.isFinite(Date.parse(rateLimit.resetAt))
  ) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Worker returned an invalid rate limit");
  }
  return {
    limit: rateLimit.limit,
    remaining: rateLimit.remaining,
    resetAt: rateLimit.resetAt,
    ...(Number.isSafeInteger(rateLimit.retryAfterMs) ? { retryAfterMs: rateLimit.retryAfterMs } : {})
  };
}

function protocolDriftResult(pending) {
  return immutableResult({
    status: "FAILED",
    operation: pending.operation,
    accountId: pending.accountId,
    error: {
      code: CORE_ERROR_CODES.PROTOCOL_DRIFT,
      message: "The worker returned an invalid versioned response",
      retryable: false,
      actionRequired: true
    }
  });
}

function immutableResult(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    immutableResult(child);
  }
  return Object.freeze(value);
}

function cloneIPCValue(value) {
  try {
    return structuredClone(value);
  } catch {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "IPC input must contain cloneable data");
  }
}
