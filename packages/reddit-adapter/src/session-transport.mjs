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
import { normalizeRedditListing, normalizeRedditOperationResponse } from "./protocol-normalizers.mjs";

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

  async leaseMedia(input, controls = {}) {
    this.#assertActive(controls.actionId ?? "media-lease");
    await this.verifyIdentity();
    validateMediaMetadata(input);
    const actionId = controls.actionId ?? this.#nextActionId("media-lease");
    return this.#mediaRequest({
      actionId,
      path: "/api/media/asset.json",
      body: encodeForm({ filepath: input.filename, mimetype: input.mimeType }),
      submissionMayHaveStarted: false,
      project: projectMediaLease
    });
  }

  async submitMedia(input, controls = {}) {
    this.#assertActive(controls.actionId ?? "media-submit");
    await this.verifyIdentity();
    validateSubreddit(input?.subreddit);
    if (typeof input?.title !== "string" || input.title.length < 1 || input.title.length > 300) {
      throw new RedditTransportError(CORE_ERROR_CODES.INVALID_REQUEST, "The Reddit media title is invalid");
    }
    validateMediaUrl(input.mediaUrl);
    const actionId = controls.actionId ?? this.#nextActionId("media-submit");
    this.#writeAttempts += 1;
    return this.#mediaRequest({
      actionId,
      path: "/api/submit",
      body: encodeForm({
        api_type: "json",
        sr: input.subreddit,
        kind: "image",
        title: input.title,
        url: input.mediaUrl,
        nsfw: false,
        spoiler: false,
        resubmit: false,
        sendreplies: true
      }),
      submissionMayHaveStarted: true,
      project: projectMediaSubmission
    });
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
    if (typeof nativeId !== "string" || !/^t[13]_[a-z0-9]+$/u.test(nativeId)) {
      throw new RedditTransportError(
        CORE_ERROR_CODES.NOT_CALLER_OWNED,
        "The Reddit target cannot be verified as caller-owned",
        { actionRequired: true }
      );
    }
    const lookup = nativeId.startsWith("t1_")
      ? await this.#lookupCommentForOwnership(nativeId, `${actionId}:ownership`)
      : await this.#perform("post.get", { nativeId }, { actionId: `${actionId}:ownership` });
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

  async #lookupCommentForOwnership(nativeId, actionId) {
    this.#assertCircuit(this.#dispatchBinding(actionId));
    let response;
    try {
      this.#requests += 1;
      response = await this.#authority.request(this.#lease, {
        method: "GET",
        path: `/api/info.json?id=${encodeURIComponent(nativeId)}&raw_json=1`,
        body: null,
        deadlineEpochMs: this.#now() + this.#deadlineMs
      });
    } catch (error) {
      const protocolFailure = error?.code === "REDIRECT_DENIED" || error?.code === "DNS_REBINDING" || error?.code === "DESTINATION_DENIED";
      const normalized = new RedditTransportError(
        protocolFailure ? CORE_ERROR_CODES.PROTOCOL_DRIFT : CORE_ERROR_CODES.WORKER_UNAVAILABLE,
        "The caller-owned comment lookup failed before submission",
        { retryable: !protocolFailure, actionRequired: protocolFailure }
      );
      this.#observeStop(actionId, normalized);
      throw normalized;
    }

    try {
      return projectOwnershipLookup(response, nativeId);
    } catch (error) {
      const normalized = error instanceof RedditTransportError
        ? error
        : new RedditTransportError(
          CORE_ERROR_CODES.NOT_CALLER_OWNED,
          "The Reddit comment owner could not be verified",
          { actionRequired: true }
        );
      this.#observeStop(actionId, normalized);
      throw normalized;
    }
  }

  async #mediaRequest({ actionId, path, body, submissionMayHaveStarted, project }) {
    const dispatch = this.#dispatchBinding(actionId);
    this.#assertCircuit(dispatch);
    let response;
    try {
      this.#requests += 1;
      response = await this.#authority.request(this.#lease, {
        method: "POST",
        path,
        body,
        deadlineEpochMs: this.#now() + this.#deadlineMs
      });
    } catch (error) {
      const protocolFailure = error?.code === "REDIRECT_DENIED" || error?.code === "DNS_REBINDING" || error?.code === "DESTINATION_DENIED";
      const normalized = new RedditTransportError(
        protocolFailure ? CORE_ERROR_CODES.PROTOCOL_DRIFT : CORE_ERROR_CODES.WORKER_UNAVAILABLE,
        submissionMayHaveStarted ? "The Reddit media submission result is unverified" : "The Reddit media preflight failed",
        {
          retryable: !submissionMayHaveStarted && !protocolFailure,
          actionRequired: protocolFailure,
          submissionMayHaveStarted
        }
      );
      this.#observeStop(actionId, normalized);
      throw normalized;
    }
    try {
      return project(response);
    } catch (error) {
      const normalized = normalizeResponseError(error, submissionMayHaveStarted);
      this.#observeStop(actionId, normalized);
      throw normalized;
    }
  }

  async #perform(operation, input, { actionId, existingNative = null, isWrite = false }) {
    const dispatch = this.#dispatchBinding(actionId);
    this.#assertCircuit(dispatch);
    const protocol = buildRedditProtocolRequest(operation, input, {
      ...(operation === "account.saved" || operation === "account.upvoted" ? {
        authenticatedUsername: this.#identity?.username,
        limit: input?.limit,
        after: input?.after
      } : {})
    });
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
      return projectResponse(operation, response, existingNative, isWrite, input);
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

function projectOwnershipLookup(response, nativeId) {
  const rateLimit = rateLimitFromHeaders(response.headers);
  if (response.status === 401) {
    throw new RedditTransportError(CORE_ERROR_CODES.SESSION_REVOKED, "Reddit rejected the ownership lookup session", {
      actionRequired: true
    });
  }
  if (response.status === 429) {
    throw new RedditTransportError(CORE_ERROR_CODES.RATE_LIMITED, "Reddit rate limited the ownership lookup", {
      retryable: true,
      actionRequired: true,
      rateLimit
    });
  }
  const contentEncoding = headerValue(response.headers, "content-encoding") ?? "identity";
  const body = decodeBoundedPlatformBody(response.body, contentEncoding);
  if (response.status < 200 || response.status > 299) {
    throw classifyTextFailure(response.status, body, false, rateLimit);
  }
  return decodeHostilePlatformJson(body, (raw) => {
    const listing = normalizeRedditListing(raw, "t1");
    if (listing.items.length !== 1 || listing.items[0].nativeId !== nativeId) {
      throw new RedditTransportError(
        CORE_ERROR_CODES.NOT_CALLER_OWNED,
        "The Reddit comment owner could not be verified",
        { actionRequired: true }
      );
    }
    const item = listing.items[0];
    return Object.freeze({
      native: Object.freeze({ nativeId: item.nativeId, canonicalUrl: item.canonicalUrl }),
      data: item,
      rateLimit
    });
  });
}

function projectMediaLease(response) {
  const rateLimit = rateLimitFromHeaders(response.headers);
  if (response.status === 401) {
    throw new RedditTransportError(CORE_ERROR_CODES.SESSION_REVOKED, "Reddit rejected the media lease session", { actionRequired: true });
  }
  if (response.status === 429) {
    throw new RedditTransportError(CORE_ERROR_CODES.RATE_LIMITED, "Reddit rate limited the media lease", {
      retryable: true,
      actionRequired: true,
      rateLimit
    });
  }
  const body = decodeBoundedPlatformBody(response.body, headerValue(response.headers, "content-encoding") ?? "identity");
  if (response.status < 200 || response.status > 299) throw classifyTextFailure(response.status, body, false, rateLimit);
  return decodeHostilePlatformJson(body, (raw) => {
    if (!plainRecord(raw) || !plainRecord(raw.args) || !Array.isArray(raw.args.fields)) {
      throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media lease envelope is missing");
    }
    const uploadUrl = validateUploadAction(raw.args.action);
    if (raw.args.fields.length < 1 || raw.args.fields.length > 32) {
      throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media lease fields are invalid");
    }
    let totalBytes = 0;
    const names = new Set();
    const fields = raw.args.fields.map((field) => {
      if (!plainRecord(field) || Object.keys(field).some((key) => !["name", "value"].includes(key))
        || typeof field.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(field.name)
        || typeof field.value !== "string" || field.value.length > 16 * 1024 || names.has(field.name)) {
        throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media lease field changed shape");
      }
      names.add(field.name);
      totalBytes += Buffer.byteLength(field.name) + Buffer.byteLength(field.value);
      return Object.freeze({ name: field.name, value: field.value });
    });
    if (totalBytes > 64 * 1024) throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media lease exceeds its byte bound");
    const key = fields.find((field) => field.name === "key")?.value;
    if (!key) throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media lease has no object key");
    const mediaUrl = new URL(key.replace(/^\/+/, ""), `${new URL(uploadUrl).origin}/`).href;
    return Object.freeze({ uploadUrl, fields: Object.freeze(fields), mediaUrl, rateLimit });
  });
}

function projectMediaSubmission(response) {
  const rateLimit = rateLimitFromHeaders(response.headers);
  if (response.status === 401) {
    throw new RedditTransportError(CORE_ERROR_CODES.SESSION_REVOKED, "Reddit rejected the media submission session", {
      actionRequired: true,
      submissionMayHaveStarted: true
    });
  }
  if (response.status === 429) {
    throw new RedditTransportError(CORE_ERROR_CODES.RATE_LIMITED, "Reddit rate limited the media submission", {
      actionRequired: true,
      submissionMayHaveStarted: true,
      rateLimit
    });
  }
  const body = decodeBoundedPlatformBody(response.body, headerValue(response.headers, "content-encoding") ?? "identity");
  if (response.status < 200 || response.status > 299) throw classifyTextFailure(response.status, body, true, rateLimit);
  return decodeHostilePlatformJson(body, (raw) => {
    const nativeFailure = classifyNativeFailure(raw, true, rateLimit);
    if (nativeFailure) {
      nativeFailure.submissionMayHaveStarted = true;
      throw nativeFailure;
    }
    const websocketUrl = raw?.json?.data?.websocket_url;
    validateWebsocketUrl(websocketUrl);
    return Object.freeze({ websocketUrl, rateLimit });
  });
}

function projectResponse(operation, response, existingNative, isWrite, input) {
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
    const normalized = normalizeRedditOperationResponse(operation, raw, { existingNative, input });
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

function validateMediaMetadata(input) {
  if (!plainRecord(input)
    || typeof input.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.filename)
    || !new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(input.mimeType)
    || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 8 * 1024 * 1024
    || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new RedditTransportError(CORE_ERROR_CODES.INVALID_REQUEST, "The Core media metadata is invalid");
  }
}

function validateSubreddit(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{2,21}$/u.test(value)) {
    throw new RedditTransportError(CORE_ERROR_CODES.INVALID_REQUEST, "The subreddit is invalid");
  }
}

function validateUploadAction(value) {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("//")) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media upload action is invalid");
  }
  const url = new URL(`https:${value}`);
  if (url.origin !== "https://reddit-uploaded-media.s3-accelerate.amazonaws.com" || url.username || url.password || url.hash || url.search) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media upload destination is not admitted");
  }
  return url.href;
}

function validateMediaUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new RedditTransportError(CORE_ERROR_CODES.INVALID_REQUEST, "The uploaded Reddit media URL is invalid");
  const url = new URL(value);
  if (url.origin !== "https://reddit-uploaded-media.s3-accelerate.amazonaws.com" || url.username || url.password || url.hash) {
    throw new RedditTransportError(CORE_ERROR_CODES.INVALID_REQUEST, "The uploaded Reddit media URL is not admitted");
  }
}

function validateWebsocketUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media process URL is missing");
  }
  const url = new URL(value);
  if (url.protocol !== "wss:" || url.hostname !== "wss.redditmedia.com" || url.port || url.username || url.password || url.hash) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The Reddit media process destination is not admitted");
  }
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
