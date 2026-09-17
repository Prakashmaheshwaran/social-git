import { createHash } from "node:crypto";
import {
  AdapterContractError,
  CORE_ERROR_CODES,
  MAX_SESSION_TTL_MS,
  isRecord
} from "./contract.mjs";

export function validateWorkerSession(session, context, nowMs = Date.now()) {
  if (
    !isRecord(session) ||
    session.kind !== "core_decrypted_worker_session" ||
    session.version !== 1 ||
    !isRecord(session.sessionMaterial)
  ) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.INVALID_REQUEST,
      "A versioned core-decrypted worker session is required"
    );
  }
  allowOnly(session, [
    "kind", "version", "accountId", "expectedNativeIdentity", "generation",
    "issuedAt", "expiresAt", "sessionMaterial"
  ], "worker session");
  rejectRouteAuthority(session.sessionMaterial, "worker session");

  if (
    session.accountId !== context.accountId ||
    session.expectedNativeIdentity !== context.expectedNativeIdentity
  ) {
    throw new AdapterContractError(CORE_ERROR_CODES.WRONG_IDENTITY, "Worker session binding does not match the account");
  }

  if (!Number.isSafeInteger(session.generation) || session.generation < 1) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "Worker session generation is invalid");
  }

  const issuedAtMs = Date.parse(session.issuedAt);
  const expiresAtMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "Worker session lifetime is invalid");
  }
  if (issuedAtMs > nowMs + 5_000 || expiresAtMs <= nowMs) {
    throw new AdapterContractError(CORE_ERROR_CODES.SESSION_REVOKED, "Worker session is expired or not active");
  }
  if (expiresAtMs - issuedAtMs > MAX_SESSION_TTL_MS) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.INVALID_REQUEST,
      `Worker session lifetime must not exceed ${MAX_SESSION_TTL_MS} ms`
    );
  }

  return session;
}

export function validateWriteControls(capability, context, nowMs = Date.now()) {
  const { authorization, idempotency } = context;
  if (
    !isRecord(idempotency) ||
    typeof idempotency.callerId !== "string" ||
    idempotency.callerId.length === 0 ||
    typeof idempotency.key !== "string" ||
    idempotency.key.length === 0 ||
    idempotency.key.length > 128
  ) {
    throw new AdapterContractError(CORE_ERROR_CODES.IDEMPOTENCY_REQUIRED, "Caller-scoped idempotency is required");
  }
  allowOnly(idempotency, ["callerId", "key"], "write idempotency");

  if (!isRecord(authorization)) {
    throw new AdapterContractError(CORE_ERROR_CODES.AUTHORIZATION_DENIED, "Exact write authorization is required");
  }
  allowOnly(authorization, ["accountId", "callerId", "operation", "scope", "expiresAt"], "write authorization");

  const authorizationExpiresAt = Date.parse(authorization.expiresAt);
  if (
    authorization.accountId !== context.accountId ||
    authorization.callerId !== idempotency.callerId ||
    authorization.operation !== capability.operation ||
    authorization.scope !== capability.authorizationScope ||
    !Number.isFinite(authorizationExpiresAt) ||
    authorizationExpiresAt <= nowMs
  ) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.AUTHORIZATION_DENIED,
      "Write authorization does not exactly match the caller, account, operation, and scope"
    );
  }

  return idempotency;
}

export function idempotencyDigest(operation, accountId, input) {
  const canonical = stableStringify({ operation, accountId, input });
  return createHash("sha256").update(canonical).digest("hex");
}

export function validateOperationInput(operation, input) {
  if (!isRecord(input)) {
    invalidInput(operation, "input must be an object");
  }

  switch (operation) {
    case "account.saved":
    case "account.upvoted":
      allowOnly(input, ["limit", "after"], operation);
      optionalString(input, "after", operation);
      optionalLimit(input, operation);
      return input;
    case "profile.get":
      allowOnly(input, [], operation);
      return input;
    case "user.get":
      allowOnly(input, ["username"], operation);
      requireString(input, "username", operation);
      requireUsername(input.username, operation);
      return input;
    case "user.content":
      allowOnly(input, ["username", "content", "sort", "timeframe", "limit", "after"], operation);
      requireString(input, "username", operation);
      requireUsername(input.username, operation);
      if (!["submitted", "comments"].includes(input.content)) invalidInput(operation, "content must be submitted or comments");
      optionalListingControls(input, operation, ["hot", "new", "top", "controversial"]);
      return input;
    case "subreddit.get":
      allowOnly(input, ["name"], operation);
      requireString(input, "name", operation);
      requireSubredditName(input.name, operation);
      return input;
    case "listing.list":
      allowOnly(input, ["subreddit", "kind", "timeframe", "limit", "after"], operation);
      optionalString(input, "subreddit", operation);
      if (input.subreddit !== undefined) {
        requireSubredditName(input.subreddit, operation);
      }
      optionalListingControls(input, operation, ["hot", "new", "top", "rising", "best", "controversial"], "kind");
      if (input.timeframe !== undefined && !["top", "controversial"].includes(input.kind)) {
        invalidInput(operation, "timeframe is supported only for top or controversial listings");
      }
      return input;
    case "post.get":
      allowOnly(input, ["nativeId"], operation);
      requireNativeId(input, "nativeId", operation, ["t3"]);
      return input;
    case "comments.list":
      allowOnly(input, ["postNativeId", "sort", "limit", "after"], operation);
      requireNativeId(input, "postNativeId", operation, ["t3"]);
      optionalString(input, "after", operation);
      optionalLimit(input, operation);
      if (input.sort !== undefined && !["best", "top", "new", "controversial", "old", "qa"].includes(input.sort)) {
        invalidInput(operation, "sort is not an admitted comment sort");
      }
      return input;
    case "search.query":
      allowOnly(input, ["query", "subreddit", "sort", "timeframe", "limit", "after"], operation);
      requireString(input, "query", operation);
      optionalString(input, "subreddit", operation);
      if (input.subreddit !== undefined) {
        requireSubredditName(input.subreddit, operation);
      }
      optionalString(input, "after", operation);
      optionalListingControls(input, operation, ["relevance", "hot", "top", "new", "comments"], "sort");
      return input;
    case "post.createText":
      allowOnly(input, ["subreddit", "title", "body", "nsfw", "spoiler"], operation);
      requireString(input, "subreddit", operation);
      requireSubredditName(input.subreddit, operation);
      requireString(input, "title", operation);
      requireString(input, "body", operation, true);
      optionalBoolean(input, "nsfw", operation);
      optionalBoolean(input, "spoiler", operation);
      return input;
    case "post.createLink":
      allowOnly(input, ["subreddit", "title", "url", "nsfw"], operation);
      requireString(input, "subreddit", operation);
      requireSubredditName(input.subreddit, operation);
      requireString(input, "title", operation);
      requireString(input, "url", operation);
      assertHttpUrl(input.url, operation);
      optionalBoolean(input, "nsfw", operation);
      return input;
    case "post.createMedia":
      allowOnly(input, ["subreddit", "title", "mediaRef", "caption", "nsfw", "spoiler"], operation);
      requireString(input, "subreddit", operation);
      requireSubredditName(input.subreddit, operation);
      requireString(input, "title", operation);
      requireString(input, "mediaRef", operation);
      optionalString(input, "caption", operation);
      optionalBoolean(input, "nsfw", operation);
      optionalBoolean(input, "spoiler", operation);
      return input;
    case "comment.create":
      allowOnly(input, ["postNativeId", "body"], operation);
      requireNativeId(input, "postNativeId", operation, ["t3"]);
      requireString(input, "body", operation);
      return input;
    case "reply.create":
      allowOnly(input, ["commentNativeId", "body"], operation);
      requireNativeId(input, "commentNativeId", operation, ["t1"]);
      requireString(input, "body", operation);
      return input;
    case "vote.set":
      allowOnly(input, ["nativeId", "direction"], operation);
      requireNativeId(input, "nativeId", operation, ["t1", "t3"]);
      if (![-1, 0, 1].includes(input.direction)) {
        invalidInput(operation, "direction must be -1, 0, or 1");
      }
      return input;
    case "save.set":
    case "save.unset":
    case "item.deleteOwn":
      allowOnly(input, ["nativeId"], operation);
      requireNativeId(input, "nativeId", operation, ["t1", "t3"]);
      return input;
    default:
      invalidInput(operation, "operation input schema is missing");
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireNativeId(input, field, operation, prefixes) {
  requireString(input, field, operation);
  if (!/^t[0-9]+_[a-z0-9]+$/.test(input[field])) {
    invalidInput(operation, `${field} must be a native Reddit fullname`);
  }
  if (prefixes && !prefixes.some((prefix) => input[field].startsWith(`${prefix}_`))) {
    invalidInput(operation, `${field} has the wrong native Reddit item kind`);
  }
}

function requireSubredditName(value, operation) {
  if (!/^[A-Za-z0-9_]{2,21}$/.test(value)) {
    invalidInput(operation, "subreddit name must contain 2 through 21 letters, numbers, or underscores");
  }
}

function requireUsername(value, operation) {
  if (!/^[A-Za-z0-9_-]{3,20}$/u.test(value)) {
    invalidInput(operation, "username must contain 3 through 20 admitted Reddit username characters");
  }
}

function optionalListingControls(input, operation, sorts, sortField = "sort") {
  optionalString(input, "after", operation);
  optionalLimit(input, operation);
  if (input[sortField] !== undefined && !sorts.includes(input[sortField])) {
    invalidInput(operation, `${sortField} is not an admitted listing sort`);
  }
  if (input.timeframe !== undefined && !["hour", "day", "week", "month", "year", "all"].includes(input.timeframe)) {
    invalidInput(operation, "timeframe is not an admitted listing timeframe");
  }
}

function requireString(input, field, operation, allowEmpty = false) {
  if (typeof input[field] !== "string" || (!allowEmpty && input[field].trim().length === 0)) {
    invalidInput(operation, `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
}

function optionalString(input, field, operation) {
  if (input[field] !== undefined && (typeof input[field] !== "string" || input[field].trim().length === 0)) {
    invalidInput(operation, `${field} must be a non-empty string when supplied`);
  }
}

function optionalBoolean(input, field, operation) {
  if (input[field] !== undefined && typeof input[field] !== "boolean") {
    invalidInput(operation, `${field} must be a boolean when supplied`);
  }
}

function allowOnly(input, allowedFields, operation) {
  const unexpected = Object.keys(input).filter((field) => !allowedFields.includes(field));
  if (unexpected.length > 0) {
    invalidInput(operation, `unexpected field: ${unexpected[0]}`);
  }
}

function rejectRouteAuthority(value, operation) {
  const forbidden = new Set(["proxy", "proxyUrl", "destination", "targetId", "routeId", "connectorId"]);
  const stack = [value];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (seen.has(item)) invalidInput(operation, "session material cannot contain cycles");
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) invalidInput(operation, `session material cannot select ${key}`);
      stack.push(child);
    }
  }
}

function optionalLimit(input, operation) {
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
  ) {
    invalidInput(operation, "limit must be an integer from 1 through 100");
  }
}

function assertHttpUrl(value, operation) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      invalidInput(operation, "url must use HTTP or HTTPS");
    }
  } catch (error) {
    if (error instanceof AdapterContractError) {
      throw error;
    }
    invalidInput(operation, "url must be an absolute HTTP or HTTPS URL");
  }
}

function invalidInput(operation, detail) {
  throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, `Invalid ${operation} input: ${detail}`);
}
