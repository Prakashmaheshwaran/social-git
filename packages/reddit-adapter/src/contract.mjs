export const IPC_PROTOCOL_VERSION = 1;
export const MAX_IPC_MESSAGE_BYTES = 64 * 1024;
export const MAX_SESSION_TTL_MS = 60_000;

const capabilities = [
  ["profile.get", "read", "reddit.read.profile"],
  ["subreddit.get", "read", "reddit.read.subreddit"],
  ["listing.list", "read", "reddit.read.listing"],
  ["post.get", "read", "reddit.read.post"],
  ["comments.list", "read", "reddit.read.comments"],
  ["search.query", "read", "reddit.read.search"],
  ["post.createText", "write", "reddit.write.post.text"],
  ["post.createLink", "write", "reddit.write.post.link"],
  ["post.createMedia", "write", "reddit.write.post.media"],
  ["comment.create", "write", "reddit.write.comment"],
  ["reply.create", "write", "reddit.write.reply"],
  ["vote.set", "write", "reddit.write.vote"],
  ["save.set", "write", "reddit.write.save"],
  ["save.unset", "write", "reddit.write.unsave"],
  ["item.deleteOwn", "write", "reddit.write.delete_own"]
].map(([operation, mode, authorizationScope]) =>
  Object.freeze({ operation, mode, authorizationScope })
);

export const REDDIT_CAPABILITIES = Object.freeze(capabilities);
export const READ_OPERATIONS = Object.freeze(
  REDDIT_CAPABILITIES.filter(({ mode }) => mode === "read").map(({ operation }) => operation)
);
export const WRITE_OPERATIONS = Object.freeze(
  REDDIT_CAPABILITIES.filter(({ mode }) => mode === "write").map(({ operation }) => operation)
);
const writeOperationSet = new Set(WRITE_OPERATIONS);

export const CORE_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  AUTHORIZATION_DENIED: "AUTHORIZATION_DENIED",
  CHECKPOINT_REQUIRED: "CHECKPOINT_REQUIRED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  IDEMPOTENCY_REQUIRED: "IDEMPOTENCY_REQUIRED",
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_CALLER_OWNED: "NOT_CALLER_OWNED",
  PROTOCOL_DRIFT: "PROTOCOL_DRIFT",
  RATE_LIMITED: "RATE_LIMITED",
  SESSION_REVOKED: "SESSION_REVOKED",
  UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
  WORKER_UNAVAILABLE: "WORKER_UNAVAILABLE",
  WRONG_IDENTITY: "WRONG_IDENTITY"
});

export class AdapterContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdapterContractError";
    this.code = code;
  }
}

export function capabilityFor(operation) {
  return REDDIT_CAPABILITIES.find((capability) => capability.operation === operation) ?? null;
}

export function isWriteOperation(operation) {
  return writeOperationSet.has(operation);
}

export function assertSupportedOperation(operation) {
  const capability = capabilityFor(operation);
  if (!capability) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.UNKNOWN_OPERATION,
      `Unsupported Reddit adapter operation: ${String(operation)}`
    );
  }
  return capability;
}

export function assertBoundedIPCMessage(message, maxBytes = MAX_IPC_MESSAGE_BYTES) {
  let encoded;
  try {
    encoded = JSON.stringify(message);
  } catch {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "IPC message must be JSON serializable");
  }

  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > maxBytes) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.INVALID_REQUEST,
      `IPC message exceeds the ${maxBytes}-byte limit`
    );
  }
  return bytes;
}

export function assertIPCEnvelope(message, expectedKind, maxBytes = MAX_IPC_MESSAGE_BYTES) {
  assertBoundedIPCMessage(message, maxBytes);
  if (
    !isRecord(message) ||
    message.version !== IPC_PROTOCOL_VERSION ||
    message.kind !== expectedKind ||
    !["ready", "response", "submission_started"].includes(expectedKind)
  ) {
    throw new AdapterContractError(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Invalid worker IPC envelope");
  }
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
