import {
  DEFAULT_DATA_LIMITS,
  assertBoundedValue,
  assertExactKeys,
  decodeBoundedJson,
  deepFreeze,
  encodeBoundedJson
} from "./bounds.mjs";
import { SECURITY_ERROR_CODES, fail } from "./errors.mjs";

export const WORKER_IPC_VERSION = 1;
export const WORKER_IPC_LIMITS = Object.freeze({ ...DEFAULT_DATA_LIMITS });

const BINDING_FIELDS = Object.freeze([
  "requestId",
  "actionId",
  "tenantId",
  "accountId",
  "routeId",
  "generation",
  "capability"
]);
const AUTHORITY_FIELDS = new Set([
  "tenantId",
  "accountId",
  "routeId",
  "generation",
  "capability",
  "authorization",
  "proxy",
  "proxyUrl",
  "destination",
  "targetId"
]);

export function encodeCoreRequest(request, limits = WORKER_IPC_LIMITS) {
  validateCoreRequest(request, limits);
  return encodeBoundedJson(request, limits);
}

export function decodeCoreRequest(frame, limits = WORKER_IPC_LIMITS) {
  return validateCoreRequest(decodeBoundedJson(frame, limits), limits);
}

export function encodeWorkerResponse(response, limits = WORKER_IPC_LIMITS) {
  validateWorkerResponse(response, limits);
  return encodeBoundedJson(response, limits);
}

export function decodeWorkerResponse(frame, limits = WORKER_IPC_LIMITS) {
  return validateWorkerResponse(decodeBoundedJson(frame, limits), limits);
}

export function encodeWorkerEvent(event, limits = WORKER_IPC_LIMITS) {
  validateWorkerEvent(event, limits);
  return encodeBoundedJson(event, limits);
}

export function decodeWorkerMessage(frame, limits = WORKER_IPC_LIMITS) {
  const value = decodeBoundedJson(frame, limits);
  if (value?.kind === "event") return validateWorkerEvent(value, limits);
  return validateWorkerResponse(value, limits);
}

export function validateCoreRequest(request, limits = WORKER_IPC_LIMITS) {
  assertBoundedValue(request, limits);
  assertExactKeys(request, ["protocolVersion", "kind", ...BINDING_FIELDS, "deadlineEpochMs", "payload"]);
  if (request.protocolVersion !== WORKER_IPC_VERSION || request.kind !== "request") {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "Unsupported request protocol or kind");
  }
  validateBinding(request);
  if (!Number.isSafeInteger(request.deadlineEpochMs) || request.deadlineEpochMs < 1) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "Invalid request deadline");
  }
  validateRequestPayload(request.payload);
  return request;
}

export function validateWorkerResponse(response, limits = WORKER_IPC_LIMITS) {
  assertBoundedValue(response, limits);
  assertExactKeys(response, ["protocolVersion", "kind", ...BINDING_FIELDS, "sequence", "outcome"]);
  if (response.protocolVersion !== WORKER_IPC_VERSION || response.kind !== "response") {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "Unsupported response protocol or kind");
  }
  validateBinding(response);
  if (!Number.isSafeInteger(response.sequence) || response.sequence < 1 || response.sequence > 2) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "A terminal worker response has an invalid sequence");
  }
  validateBaseOutcome(response.outcome);
  assertNoWorkerAuthority(response.outcome);
  return response;
}

export function validateWorkerEvent(event, limits = WORKER_IPC_LIMITS) {
  assertBoundedValue(event, limits);
  assertExactKeys(event, ["protocolVersion", "kind", ...BINDING_FIELDS, "sequence", "event"]);
  if (event.protocolVersion !== WORKER_IPC_VERSION || event.kind !== "event" || event.sequence !== 1) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "Unsupported worker event or sequence");
  }
  validateBinding(event);
  assertExactKeys(event.event, ["type", "native", "submittedAt"]);
  if (event.event.type !== "SUBMISSION_STARTED" || !isExactTimestamp(event.event.submittedAt)) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "Invalid worker submission event");
  }
  validateNative(event.event.native);
  assertNoWorkerAuthority(event.event);
  return event;
}

export class IpcFence {
  #pending = new Map();
  #terminal = new Set();

  register(peerId, request) {
    requireId(peerId, "peerId");
    validateCoreRequest(request);
    if (this.#pending.has(request.requestId) || this.#terminal.has(request.requestId)) {
      fail(SECURITY_ERROR_CODES.IPC_FENCE, "The request ID was already registered");
    }
    this.#pending.set(request.requestId, {
      peerId,
      deadlineEpochMs: request.deadlineEpochMs,
      nextSequence: 1,
      binding: deepFreeze(Object.fromEntries(BINDING_FIELDS.map((field) => [field, request[field]])))
    });
  }

  accept(peerId, response, nowEpochMs = Date.now()) {
    requireId(peerId, "peerId");
    if (response?.kind === "event") validateWorkerEvent(response);
    else validateWorkerResponse(response);
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      fail(SECURITY_ERROR_CODES.IPC_FENCE, "The worker response is duplicate, late, or unknown");
    }
    if (nowEpochMs > pending.deadlineEpochMs) {
      this.#terminate(response.requestId);
      fail(SECURITY_ERROR_CODES.IPC_FENCE, "The worker response arrived after its deadline");
    }
    if (peerId !== pending.peerId) {
      fail(SECURITY_ERROR_CODES.IPC_FENCE, "The worker response came from the wrong peer");
    }
    for (const field of BINDING_FIELDS) {
      if (response[field] !== pending.binding[field]) {
        fail(SECURITY_ERROR_CODES.IPC_FENCE, `The worker response changed ${field}`);
      }
    }
    if (response.sequence !== pending.nextSequence) {
      fail(SECURITY_ERROR_CODES.IPC_FENCE, "The worker message sequence is duplicate or out of order");
    }
    if (response.kind === "event") {
      pending.nextSequence += 1;
      return deepFreeze(structuredClone(response.event));
    }
    this.#terminate(response.requestId);
    return deepFreeze(structuredClone(response.outcome));
  }

  expire(nowEpochMs = Date.now()) {
    const expired = [];
    for (const [requestId, pending] of this.#pending) {
      if (nowEpochMs > pending.deadlineEpochMs) {
        this.#terminate(requestId);
        expired.push(requestId);
      }
    }
    return Object.freeze(expired);
  }

  get pendingCount() {
    return this.#pending.size;
  }

  #terminate(requestId) {
    this.#pending.delete(requestId);
    this.#terminal.add(requestId);
  }
}

function validateBinding(value) {
  for (const field of BINDING_FIELDS) {
    if (field === "generation") {
      if (!Number.isSafeInteger(value[field]) || value[field] < 1) {
        fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "Invalid generation binding");
      }
    } else {
      requireId(value[field], field);
    }
  }
}

function requireId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, `Invalid ${field}`);
  }
}

function validateRequestPayload(payload) {
  assertExactKeys(payload, ["operation", "input"], ["expectedNativeIdentity", "session", "idempotency"]);
  requireId(payload.operation, "operation");
  if (payload.input === null || typeof payload.input !== "object" || Array.isArray(payload.input)) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The request input must be an object");
  }
  if (payload.expectedNativeIdentity !== undefined) requireId(payload.expectedNativeIdentity, "expectedNativeIdentity");
  if (payload.session !== undefined && (payload.session === null || typeof payload.session !== "object" || Array.isArray(payload.session))) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The worker session must be an object");
  }
  if (payload.idempotency !== undefined && (payload.idempotency === null || typeof payload.idempotency !== "object" || Array.isArray(payload.idempotency))) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The idempotency input must be an object");
  }
}

function validateBaseOutcome(outcome) {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The worker outcome must be an object");
  }
  if (!["SUCCEEDED", "FAILED", "UNKNOWN"].includes(outcome.status)) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The worker outcome status is invalid");
  }
}

function validateNative(native) {
  assertExactKeys(native, ["nativeId", "canonicalUrl"]);
  const match = /^(t[13])_([a-z0-9]+)$/u.exec(native.nativeId);
  let url;
  try {
    url = new URL(native.canonicalUrl);
  } catch {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The worker native URL is invalid");
  }
  if (
    !match || url.protocol !== "https:" || url.hostname !== "www.reddit.com" ||
    url.username || url.password || url.port || url.search || url.hash ||
    !url.pathname.startsWith("/") || url.pathname.startsWith("//")
  ) fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The worker native reference is invalid");
  const segments = url.pathname.split("/").filter(Boolean);
  const isPost = match[1] === "t3";
  if (!(
    segments.length >= (isPost ? 4 : 6) && segments[0] === "r" &&
    /^[A-Za-z0-9_]{2,21}$/u.test(segments[1]) && segments[2] === "comments" &&
    (isPost ? segments[3] : segments.at(-1)) === match[2]
  )) fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "The worker native URL does not match its Reddit fullname");
}

function isExactTimestamp(value) {
  if (typeof value !== "string") return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

function assertNoWorkerAuthority(value) {
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") {
      continue;
    }
    for (const [key, child] of Object.entries(item)) {
      if (AUTHORITY_FIELDS.has(key)) {
        fail(SECURITY_ERROR_CODES.IPC_SCHEMA, `Worker output contains authority field: ${key}`);
      }
      stack.push(child);
    }
  }
}
