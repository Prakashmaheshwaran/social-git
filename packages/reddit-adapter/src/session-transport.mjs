import { createHash } from "node:crypto";
import {
  PlatformStopCircuit,
  decodeBoundedPlatformBody,
  decodeHostilePlatformJson
} from "../../worker-security/src/index.mjs";
import {
  AdapterContractError,
  CORE_ERROR_CODES,
  PROTOCOL_MAPPING_STATUS,
  assertSupportedOperation,
  isWriteOperation
} from "./contract.mjs";
import { buildRedditProtocolRequest } from "./protocol-corpus.mjs";
import { normalizeRedditOperationResponse } from "./protocol-normalizers.mjs";

const DEFAULT_DEADLINE_MS = 10_000;
const EXISTING_ITEM_WRITES = new Set(["vote.set", "save.set", "save.unset", "item.deleteOwn"]);
const DEFAULT_STOP_CIRCUIT = new PlatformStopCircuit();

export class RedditTransportError extends Error {
  constructor(code, message, {
    retryable = false,
    actionRequired = false,
    submissionMayHaveStarted = false,
    rateLimit
  } = {}) {
    super(message);
    this.name = "RedditTransportError";
    this.code = code;
    this.retryable = retryable;
    this.actionRequired = actionRequired;
    this.submissionMayHaveStarted = submissionMayHaveStarted;
    if (rateLimit) this.rateLimit = Object.freeze({ ...rateLimit });
  }
}

/**
 * A production transport instance is permanently bound to one tenant, account,
 * route, and session generation. The supplied route authority remains in Core;
 * workers can supply only admitted origin-relative protocol descriptors.
 */
export class RedditSessionTransport {
  #authority;
  #lease;
  #binding;
  #expectedNativeIdentity;
  #identity = null;
  #identityResult = null;
  #stopCircuit;
  #deadlineMs;
  #now;
  #sequence = 0;
  #revoked = false;
  #idempotency = new Map();
  #requests = 0;
  #writeAttempts = 0;

  constructor({
    routeAuthority,
    binding,
    expectedNativeIdentity,
    stopCircuit = DEFAULT_STOP_CIRCUIT,
    deadlineMs = DEFAULT_DEADLINE_MS,
    now = Date.now
  }) {
    if (!routeAuthority || typeof routeAuthority.issueLease !== "function" || typeof routeAuthority.request !== "function") {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "A trusted Core route authority is required");
    }
    validateBinding(binding);
    if (typeof expectedNativeIdentity !== "string" || expectedNativeIdentity.length < 1 || expectedNativeIdentity.length > 256) {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "An expected Reddit identity is required");
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000 || typeof now !== "function") {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The transport deadline or clock is invalid");
    }
    this.#authority = routeAuthority;
    this.#binding = Object.freeze(structuredClone(binding));
    this.#lease = routeAuthority.issueLease(this.#binding);
    this.#expectedNativeIdentity = expectedNativeIdentity;
    this.#stopCircuit = stopCircuit;
    this.#deadlineMs = deadlineMs;
    this.#now = now;
  }

  binding() {
    return this.#binding;
  }

  diagnostics() {
    return Object.freeze({
      binding: this.#binding,
      identityValidated: this.#identity !== null,
      revoked: this.#revoked,
      requests: this.#requests,
      writeAttempts: this.#writeAttempts,
      idempotencyEntries: this.#idempotency.size
    });
  }

  async verifyIdentity() {
    this.#assertActive("identity");
    if (this.#identityResult) return this.#identityResult;
    const result = await this.#perform("profile.get", {}, { actionId: this.#nextActionId("identity") });
    const observed = {
      nativeId: result.native.nativeId,
      username: result.data.username,
      canonicalUrl: result.native.canonicalUrl
    };
    if (!identityMatches(this.#expectedNativeIdentity, observed)) {
      const error = new RedditTransportError(
        CORE_ERROR_CODES.WRONG_IDENTITY,
        "The authenticated Reddit identity does not match the immutable account binding",
        { actionRequired: true }
      );
      this.#observeStop(this.#nextActionId("identity-mismatch"), error);
      throw error;
    }
    this.#identity = Object.freeze(observed);
    this.#identityResult = Object.freeze(result);
    return this.#identityResult;
  }

  async execute(operation, input, controls = {}) {
    const capability = assertSupportedOperation(operation);
    if (capability.protocolMapping !== PROTOCOL_MAPPING_STATUS.MAPPED) {
      throw new RedditTransportError(
        CORE_ERROR_CODES.CAPABILITY_DISABLED,
        `Reddit capability ${operation} is not admitted for production`,
        { actionRequired: true }
      );
    }
    this.#assertActive(controls.actionId ?? operation);
    if (operation === "profile.get") return this.verifyIdentity();
    await this.verifyIdentity();

    if (capability.mode !== "write") {
      return this.#perform(operation, input, { actionId: controls.actionId ?? this.#nextActionId("read") });
    }
    return this.#executeWrite(operation, input, controls);
  }

  revoke() {
    this.#revoked = true;
    this.#identity = null;
    this.#identityResult = null;
    this.#idempotency.clear();
  }

  refresh({ routeAuthority, binding, expectedNativeIdentity }) {
    validateBinding(binding);
    if (
      binding.tenantId !== this.#binding.tenantId ||
      binding.accountId !== this.#binding.accountId ||
      binding.generation <= this.#binding.generation ||
      expectedNativeIdentity !== this.#expectedNativeIdentity
    ) {
      throw new AdapterContractError(
        CORE_ERROR_CODES.INVALID_REQUEST,
        "A refresh must preserve the account identity and advance its session generation"
      );
    }
    const replacement = new RedditSessionTransport({
      routeAuthority,
      binding,
      expectedNativeIdentity,
      stopCircuit: this.#stopCircuit,
      deadlineMs: this.#deadlineMs,
      now: this.#now
    });
    this.revoke();
    return replacement;
  }

  async #executeWrite(operation, input, controls) {
    validateWriteControls(controls);
    const cacheKey = `${controls.callerId}\u0000${controls.idempotencyKey}`;
    const digest = createHash("sha256")
      .update(stableStringify({ operation, accountId: this.#binding.accountId, input }))
      .digest("hex");
    const cached = this.#idempotency.get(cacheKey);
    if (cached) {
      if (cached.digest !== digest) {
        throw new RedditTransportError(
          CORE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "The caller-scoped idempotency key was already used for another Reddit action"
        );
      }
      return cached.promise;
    }

    const actionId = controls.actionId ?? this.#nextActionId("write");
    const promise = (async () => {
      let existingNative = null;
      if (EXISTING_ITEM_WRITES.has(operation)) {
        existingNative = await this.#existingItemForWrite(operation, input, actionId);
      }
      this.#writeAttempts += 1;
      return this.#perform(operation, input, { actionId, existingNative, isWrite: true });
    })();
    this.#idempotency.set(cacheKey, { digest, promise });
    return promise;
  }

  async #existingItemForWrite(operation, input, actionId) {
    const nativeId = input?.nativeId;
    if (operation !== "item.deleteOwn") return Object.freeze({ nativeId });
    if (typeof nativeId !== "string" || !nativeId.startsWith("t3_")) {
      throw new RedditTransportError(
        CORE_ERROR_CODES.CAPABILITY_DISABLED,
        "Caller-owned comment deletion needs a separately admitted ownership lookup",
        { actionRequired: true }
      );
    }
    const lookup = await this.#perform("post.get", { nativeId }, { actionId: `${actionId}:ownership` });
    const author = lookup.data?.author;
    if (typeof author !== "string" || normalizeUsername(author) !== normalizeUsername(this.#identity.username)) {
      throw new RedditTransportError(
        CORE_ERROR_CODES.NOT_CALLER_OWNED,
        "The authenticated Reddit account does not own the target post",
        { actionRequired: true }
      );
    }
    return lookup.native;
  }

  async #perform(operation, input, { actionId, existingNative = null, isWrite = false }) {
    const dispatch = this.#dispatchBinding(actionId);
    this.#assertCircuit(dispatch);
    const protocol = buildRedditProtocolRequest(operation, input);
    const descriptor = {
      method: protocol.method,
      path: requestPath(protocol),
      body: protocol.body === null ? null : encodeForm(protocol.body),
      deadlineEpochMs: this.#now() + this.#deadlineMs
    };
    let response;
    try {
      this.#requests += 1;
      response = await this.#authority.request(this.#lease, descriptor);
    } catch (error) {
      const normalized = isWrite
        ? new RedditTransportError(
          CORE_ERROR_CODES.WORKER_UNAVAILABLE,
          "The Reddit write result could not be verified after submission started",
          { submissionMayHaveStarted: true }
        )
        : new RedditTransportError(
          CORE_ERROR_CODES.WORKER_UNAVAILABLE,
          "The trusted Reddit egress request failed before a usable response",
          { retryable: true }
        );
      if (error?.code === "REDIRECT_DENIED" || error?.code === "DNS_REBINDING" || error?.code === "DESTINATION_DENIED") {
        normalized.code = CORE_ERROR_CODES.PROTOCOL_DRIFT;
        normalized.retryable = false;
        normalized.actionRequired = true;
      }
      this.#observeStop(actionId, normalized);
      throw normalized;
    }

    try {
      return projectResponse(operation, response, existingNative, isWrite);
    } catch (error) {
      const normalized = normalizeResponseError(error, isWrite);
      this.#observeStop(actionId, normalized);
      throw normalized;
    }
  }

  #assertActive(actionId) {
    if (this.#revoked) {
      throw new RedditTransportError(CORE_ERROR_CODES.SESSION_REVOKED, "The Reddit session generation is revoked", {
        actionRequired: true
      });
    }
    this.#assertCircuit(this.#dispatchBinding(actionId));
  }

  #assertCircuit(binding) {
    try {
      this.#stopCircuit.assertCanDispatch(binding);
    } catch {
      throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Reddit dispatch is stopped for this session generation", {
        actionRequired: true
      });
    }
  }

  #observeStop(actionId, error) {
    this.#stopCircuit.observe(this.#dispatchBinding(actionId), {
      status: "FAILED",
      error: { code: error.code }
    });
  }

  #dispatchBinding(actionId) {
    return {
      platform: "reddit",
      tenantId: this.#binding.tenantId,
      accountId: this.#binding.accountId,
      routeId: this.#binding.routeId,
      generation: this.#binding.generation,
      actionId
    };
  }

  #nextActionId(label) {
    this.#sequence += 1;
    return `reddit-${label}-${this.#sequence}`;
  }
}

function projectResponse(operation, response, existingNative, isWrite) {
  const rateLimit = rateLimitFromHeaders(response.headers);
  if (response.status === 401) {
    throw new RedditTransportError(CORE_ERROR_CODES.SESSION_REVOKED, "Reddit rejected the authenticated session", { actionRequired: true });
  }
  if (response.status === 429) {
    throw new RedditTransportError(CORE_ERROR_CODES.RATE_LIMITED, "Reddit rate limited the bound session", {
      retryable: !isWrite,
      actionRequired: true,
      rateLimit
    });
  }
  const contentEncoding = headerValue(response.headers, "content-encoding") ?? "identity";
  const body = decodeBoundedPlatformBody(response.body, contentEncoding);
  if (response.status < 200 || response.status > 299) {
    const classified = classifyTextFailure(response.status, body, isWrite, rateLimit);
    throw classified;
  }
  return decodeHostilePlatformJson(body, (raw) => {
    const nativeFailure = classifyNativeFailure(raw, isWrite, rateLimit);
    if (nativeFailure) throw nativeFailure;
    if (EXISTING_ITEM_WRITES.has(operation)) {
      return existingWriteResult(operation, raw, existingNative);
    }
    const normalized = normalizeRedditOperationResponse(operation, raw, { existingNative });
    return Object.freeze({ ...normalized, rateLimit });
  });
}

function existingWriteResult(operation, raw, existingNative) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit write response is not an object");
  }
  if (raw.json !== undefined && (!raw.json || !Array.isArray(raw.json.errors) || raw.json.errors.length !== 0)) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit write response did not confirm success");
  }
  if (!existingNative || typeof existingNative.nativeId !== "string") {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The existing Reddit target is missing");
  }
  const data = {
    "vote.set": { applied: true },
    "save.set": { saved: true },
    "save.unset": { saved: false },
    "item.deleteOwn": { deleted: true }
  }[operation];
  return Object.freeze({ native: Object.freeze({ ...existingNative }), data: Object.freeze(data) });
}

function classifyNativeFailure(raw, isWrite, rateLimit) {
  const errors = raw?.json?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const code = String(errors[0]?.[0] ?? "").toUpperCase();
  if (code.includes("RATELIMIT")) {
    return new RedditTransportError(CORE_ERROR_CODES.RATE_LIMITED, "Reddit returned a native rate-limit error", {
      retryable: false, actionRequired: true, rateLimit
    });
  }
  if (code.includes("CAPTCHA")) {
    return new RedditTransportError(CORE_ERROR_CODES.CAPTCHA_REQUIRED, "Reddit requires CAPTCHA completion", {
      actionRequired: true
    });
  }
  if (code.includes("MODHASH") || code.includes("USER_REQUIRED")) {
    return new RedditTransportError(CORE_ERROR_CODES.SESSION_REVOKED, "Reddit rejected the session CSRF binding", {
      actionRequired: true
    });
  }
  return new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Reddit returned an unrecognized native error", {
    actionRequired: true
  });
}

function classifyTextFailure(status, body, isWrite, rateLimit) {
  const text = Buffer.from(body).toString("utf8").slice(0, 64 * 1024).toLowerCase();
  const options = { actionRequired: true };
  if (text.includes("captcha")) return new RedditTransportError(CORE_ERROR_CODES.CAPTCHA_REQUIRED, "Reddit requires CAPTCHA completion", options);
  if (text.includes("checkpoint")) return new RedditTransportError(CORE_ERROR_CODES.CHECKPOINT_REQUIRED, "Reddit requires an account checkpoint", options);
  if (text.includes("challenge") || text.includes("verify your identity")) {
    return new RedditTransportError(CORE_ERROR_CODES.CHALLENGE_REQUIRED, "Reddit requires an account challenge", options);
  }
  if (status === 403) return new RedditTransportError(CORE_ERROR_CODES.SESSION_REVOKED, "Reddit rejected the authenticated session", options);
  if (status >= 500) {
    return new RedditTransportError(
      isWrite ? CORE_ERROR_CODES.WORKER_UNAVAILABLE : CORE_ERROR_CODES.WORKER_UNAVAILABLE,
      isWrite ? "The Reddit write result is unverified" : "Reddit is temporarily unavailable",
      { retryable: !isWrite, submissionMayHaveStarted: isWrite }
    );
  }
  return new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Reddit returned an unrecognized HTTP response", {
    ...options, rateLimit
  });
}

function normalizeResponseError(error, isWrite) {
  if (error instanceof RedditTransportError) return error;
  if (error instanceof AdapterContractError) {
    return new RedditTransportError(error.code, "The Reddit response did not match the admitted protocol", {
      actionRequired: true,
      submissionMayHaveStarted: isWrite
    });
  }
  return new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit response could not be normalized", {
    actionRequired: true,
    submissionMayHaveStarted: isWrite
  });
}

function requestPath(protocol) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(protocol.query)) query.set(name, String(value));
  const serialized = query.toString();
  return serialized ? `${protocol.path}?${serialized}` : protocol.path;
}

function encodeForm(body) {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) form.set(name, String(value));
  return Buffer.from(form.toString(), "utf8");
}

function rateLimitFromHeaders(headers) {
  const remaining = nonNegativeNumber(headerValue(headers, "x-ratelimit-remaining"));
  const used = nonNegativeNumber(headerValue(headers, "x-ratelimit-used"));
  const resetSeconds = nonNegativeNumber(headerValue(headers, "x-ratelimit-reset"));
  const limit = remaining === null || used === null ? null : Math.floor(remaining + used);
  return Object.freeze({
    ...(limit === null ? {} : { limit }),
    ...(remaining === null ? {} : { remaining: Math.floor(remaining) }),
    ...(resetSeconds === null ? {} : { resetAt: new Date(Date.now() + resetSeconds * 1000).toISOString() })
  });
}

function headerValue(headers, target) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function nonNegativeNumber(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function identityMatches(expected, observed) {
  const normalized = expected.replace(/^reddit:/u, "");
  return normalized === observed.nativeId;
}

function normalizeUsername(value) {
  return String(value).replace(/^u\//iu, "").toLowerCase();
}

function validateBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "A production route binding is required");
  }
  const keys = Object.keys(binding);
  if (keys.length !== 4 || keys.some((key) => !["tenantId", "accountId", "routeId", "generation"].includes(key))) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The route binding contains unrecognized authority");
  }
  for (const field of ["tenantId", "accountId", "routeId"]) {
    if (typeof binding[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(binding[field])) {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, `The route binding has an invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The route binding generation is invalid");
  }
}

function validateWriteControls(controls) {
  if (
    !controls || typeof controls !== "object" ||
    typeof controls.callerId !== "string" || controls.callerId.length < 1 ||
    typeof controls.idempotencyKey !== "string" || controls.idempotencyKey.length < 1 || controls.idempotencyKey.length > 128
  ) {
    throw new RedditTransportError(CORE_ERROR_CODES.IDEMPOTENCY_REQUIRED, "Caller-scoped idempotency is required for Reddit writes");
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
