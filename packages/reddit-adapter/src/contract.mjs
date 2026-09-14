export const IPC_PROTOCOL_VERSION = 1;
export const MAX_IPC_MESSAGE_BYTES = 64 * 1024;
export const MAX_SESSION_TTL_MS = 60_000;

export const PROTOCOL_MAPPING_STATUS = Object.freeze({
  MAPPED: "MAPPED",
  UNSUPPORTED: "UNSUPPORTED"
});

const capabilities = [
  ["profile.get", "read", "reddit.read.profile", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["subreddit.get", "read", "reddit.read.subreddit", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["listing.list", "read", "reddit.read.listing", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["post.get", "read", "reddit.read.post", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["comments.list", "read", "reddit.read.comments", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["search.query", "read", "reddit.read.search", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["post.createText", "write", "reddit.write.post.text", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["post.createLink", "write", "reddit.write.post.link", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["post.createMedia", "write", "reddit.write.post.media", PROTOCOL_MAPPING_STATUS.UNSUPPORTED],
  ["comment.create", "write", "reddit.write.comment", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["reply.create", "write", "reddit.write.reply", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["vote.set", "write", "reddit.write.vote", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["save.set", "write", "reddit.write.save", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["save.unset", "write", "reddit.write.unsave", PROTOCOL_MAPPING_STATUS.MAPPED],
  ["item.deleteOwn", "write", "reddit.write.delete_own", PROTOCOL_MAPPING_STATUS.MAPPED]
].map(([operation, mode, authorizationScope, protocolMapping]) =>
  Object.freeze({
    operation,
    mode,
    authorizationScope,
    fixtureEnabled: true,
    protocolMapping,
    productionEnabled: protocolMapping === PROTOCOL_MAPPING_STATUS.MAPPED,
    disabledReason:
      protocolMapping === PROTOCOL_MAPPING_STATUS.UNSUPPORTED
        ? "MEDIA_FLOW_NOT_ADMITTED"
        : null
  })
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
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  CAPABILITY_DISABLED: "CAPABILITY_DISABLED",
  CHALLENGE_REQUIRED: "CHALLENGE_REQUIRED",
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
