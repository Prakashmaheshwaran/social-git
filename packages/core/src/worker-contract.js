import { runtimeError } from "./errors.js";

export const WORKER_MESSAGE_VERSION = 1;
// Includes one Core-owned image encoded as base64. The decoded image remains
// independently bounded to 8 MiB by Core and the Reddit worker.
export const MAX_WORKER_MESSAGE_BYTES = 12 * 1024 * 1024;
export const MAX_SESSION_BYTES = 48 * 1024;
export const MAX_NETWORK_ROUTE_BYTES = 16 * 1024;

export const WORKER_RESULT_STATUSES = Object.freeze([
  "SUCCEEDED",
  "AUTH_FAILURE",
  "CHALLENGE",
  "CHECKPOINT",
  "CAPTCHA",
  "RATE_LIMITED",
  "REVOKED",
  "PROTOCOL_DRIFT",
  "UNEXPECTED_REDIRECT",
  "POLICY_DENIED",
  "NOT_EXECUTED",
  "UNKNOWN"
]);

const RESULT_STATUS_SET = new Set(WORKER_RESULT_STATUSES);
const INTENTS = new Set(["identity_validation", "refresh", "read", "write"]);
const COMMAND_KEYS = new Set([
  "version",
  "type",
  "requestId",
  "tenantId",
  "accountId",
  "platform",
  "generation",
  "leaseId",
  "fence",
  "expiresAt",
  "intent",
  "operation",
  "expectedNativeIdentity",
  "sessionBase64",
  "networkRoute",
  "payload"
]);
const RESULT_KEYS = new Set([
  "version",
  "type",
  "requestId",
  "tenantId",
  "accountId",
  "platform",
  "generation",
  "leaseId",
  "fence",
  "status",
  "observedNativeIdentity",
  "nativeId",
  "canonicalUrl"
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validText(value, maximum, allowEmpty = false) {
  return typeof value === "string"
    && value.length <= maximum
    && (allowEmpty || value.length > 0);
}

function validInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalBase64(value, maxDecodedBytes) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  const valid = decoded.byteLength > 0
    && decoded.byteLength <= maxDecodedBytes
    && decoded.toString("base64url") === value;
  decoded.fill(0);
  return valid;
}

function assertCommon(message) {
  if (!isPlainObject(message)
    || message.version !== WORKER_MESSAGE_VERSION
    || !validText(message.requestId, 128)
    || !validText(message.tenantId, 128)
    || !validText(message.accountId, 128)
    || !validText(message.platform, 64)
    || !validInteger(message.generation)
    || !validText(message.leaseId, 128)
    || !validInteger(message.fence)) {
    throw runtimeError("MALFORMED_MESSAGE");
  }
}

function assertJsonSafe(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("not serializable");
  } catch (error) {
    throw runtimeError("MALFORMED_MESSAGE", error);
  }
}

export function validateWorkerCommand(message) {
  assertCommon(message);
  if (message.type !== "social-git.worker.command"
    || !hasOnlyKeys(message, COMMAND_KEYS)
    || !validInteger(message.expiresAt)
    || !INTENTS.has(message.intent)
    || !validText(message.operation, 128)
    || !validText(message.expectedNativeIdentity, 256)
    || !canonicalBase64(message.sessionBase64, MAX_SESSION_BYTES)
    || !isPlainObject(message.networkRoute)
    || Object.keys(message.networkRoute).length !== 2
    || !validText(message.networkRoute.id, 128)
    || !canonicalBase64(message.networkRoute.materialBase64, MAX_NETWORK_ROUTE_BYTES)) {
    throw runtimeError("MALFORMED_MESSAGE");
  }
  assertJsonSafe(message.payload);
  return message;
}

export function validateWorkerResult(message) {
  assertCommon(message);
  if (message.type !== "social-git.worker.result"
    || !hasOnlyKeys(message, RESULT_KEYS)
    || !RESULT_STATUS_SET.has(message.status)
    || (message.observedNativeIdentity !== undefined
      && !validText(message.observedNativeIdentity, 256))
    || (message.nativeId !== undefined && !validText(message.nativeId, 512))
    || (message.canonicalUrl !== undefined && !validText(message.canonicalUrl, 4096))) {
    throw runtimeError("MALFORMED_MESSAGE");
  }
  if (message.status === "SUCCEEDED" && message.observedNativeIdentity === undefined) {
    throw runtimeError("MALFORMED_MESSAGE");
  }
  return message;
}

export function validateWorkerMessage(message) {
  if (!isPlainObject(message)) throw runtimeError("MALFORMED_MESSAGE");
  if (message.type === "social-git.worker.command") return validateWorkerCommand(message);
  if (message.type === "social-git.worker.result") return validateWorkerResult(message);
  throw runtimeError("MALFORMED_MESSAGE");
}

export function encodeWorkerMessage(message, maximumBytes = MAX_WORKER_MESSAGE_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || maximumBytes > MAX_WORKER_MESSAGE_BYTES) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  validateWorkerMessage(message);
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(message), "utf8");
  } catch (error) {
    throw runtimeError("MALFORMED_MESSAGE", error);
  }
  if (encoded.byteLength > maximumBytes) {
    encoded.fill(0);
    throw runtimeError("MESSAGE_TOO_LARGE");
  }
  return encoded;
}

export function decodeWorkerMessage(serialized, maximumBytes = MAX_WORKER_MESSAGE_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || maximumBytes > MAX_WORKER_MESSAGE_BYTES) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  const bytes = typeof serialized === "string"
    ? Buffer.from(serialized, "utf8")
    : serialized instanceof Uint8Array
      ? Buffer.from(serialized.buffer, serialized.byteOffset, serialized.byteLength)
      : null;
  if (bytes === null || bytes.byteLength === 0) throw runtimeError("MALFORMED_MESSAGE");
  if (bytes.byteLength > maximumBytes) throw runtimeError("MESSAGE_TOO_LARGE");

  let text;
  let message;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    message = JSON.parse(text);
  } catch (error) {
    throw runtimeError("MALFORMED_MESSAGE", error);
  }
  return validateWorkerMessage(message);
}

export function summarizeWorkerMessage(message) {
  const valid = validateWorkerMessage(message);
  const summary = {
    version: valid.version,
    type: valid.type,
    requestId: valid.requestId,
    tenantId: valid.tenantId,
    accountId: valid.accountId,
    platform: valid.platform,
    generation: valid.generation,
    leaseId: valid.leaseId,
    fence: valid.fence
  };
  if (valid.type === "social-git.worker.command") {
    summary.intent = valid.intent;
    summary.operation = valid.operation;
  } else {
    summary.status = valid.status;
  }
  return summary;
}
