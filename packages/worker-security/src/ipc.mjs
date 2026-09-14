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
  return request;
}

export function validateWorkerResponse(response, limits = WORKER_IPC_LIMITS) {
  assertBoundedValue(response, limits);
  assertExactKeys(response, ["protocolVersion", "kind", ...BINDING_FIELDS, "sequence", "outcome"]);
  if (response.protocolVersion !== WORKER_IPC_VERSION || response.kind !== "response") {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "Unsupported response protocol or kind");
  }
  validateBinding(response);
  if (response.sequence !== 1) {
    fail(SECURITY_ERROR_CODES.IPC_SCHEMA, "A terminal worker response must use sequence 1");
  }
  assertNoWorkerAuthority(response.outcome);
  return response;
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
    this.#pending.set(request.requestId, deepFreeze({
      peerId,
      deadlineEpochMs: request.deadlineEpochMs,
      binding: Object.fromEntries(BINDING_FIELDS.map((field) => [field, request[field]]))
    }));
  }

  accept(peerId, response, nowEpochMs = Date.now()) {
    requireId(peerId, "peerId");
    validateWorkerResponse(response);
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
