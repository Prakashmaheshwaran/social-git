import { XContractError, X_MAX_CURSOR_BYTES, X_MAX_PAGE_ITEMS, X_MAX_RESPONSE_BYTES, X_PROTOCOL_VERSION, assertFixtureWriteOperation } from "./contract.mjs";

const ENTITY_FIELDS = Object.freeze({
  account: ["nativeId", "canonicalUrl", "username", "displayName", "description", "followersCount", "followingCount", "createdAt", "verified"],
  profile: ["nativeId", "canonicalUrl", "username", "displayName", "description", "followersCount", "followingCount", "createdAt", "verified"],
  post: ["nativeId", "canonicalUrl", "authorNativeId", "text", "createdAt", "replyCount", "repostCount", "likeCount", "quoteCount", "conversationId", "inReplyToNativeId"],
  notification: ["nativeId", "canonicalUrl", "notificationType", "actorNativeId", "postNativeId", "text", "createdAt"],
  conversation: ["nativeId", "canonicalUrl", "participantNativeIds", "lastMessageText", "updatedAt"],
  list: ["nativeId", "canonicalUrl", "name", "description", "memberCount", "subscriberCount", "visibility", "createdAt"],
});

function drift(message = "The X fixture response does not match the admitted protocol corpus.") {
  throw new XContractError("PROTOCOL_DRIFT", message);
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) drift();
  return value;
}

function exactKeys(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) drift();
}

function text(value, max = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) drift();
  return value;
}

function optionalText(value, max = 512) {
  return value === null || value === undefined ? undefined : text(value, max);
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) drift();
  return value;
}

function canonicalUrl(value) {
  const raw = text(value, 2048);
  let url;
  try { url = new URL(raw); } catch { drift(); }
  if (url.protocol !== "https:" || !new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]).has(url.hostname.toLowerCase())) drift();
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

function instant(value) {
  const raw = text(value, 64);
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) drift();
  return date.toISOString();
}

function entity(value, expectedType) {
  const source = record(value);
  exactKeys(source, ["type", ...ENTITY_FIELDS[expectedType]]);
  if (source.type !== expectedType) drift();
  const output = { nativeId: text(source.nativeId, 128) };
  if (!/^\d+$/u.test(output.nativeId)) drift();
  for (const field of ENTITY_FIELDS[expectedType]) {
    if (field === "nativeId" || source[field] === undefined || source[field] === null) continue;
    if (field === "canonicalUrl") output[field] = canonicalUrl(source[field]);
    else if (["createdAt", "updatedAt"].includes(field)) output[field] = instant(source[field]);
    else if (field.endsWith("Count")) output[field] = count(source[field]);
    else if (field === "verified") {
      if (typeof source[field] !== "boolean") drift();
      output[field] = source[field];
    } else if (field === "visibility") {
      if (!new Set(["public", "private"]).has(source[field])) drift();
      output[field] = source[field];
    } else if (field === "participantNativeIds") {
      if (!Array.isArray(source[field]) || source[field].length > 100) drift();
      output[field] = source[field].map((item) => text(item, 128));
    } else output[field] = text(source[field], field === "text" || field === "description" || field === "lastMessageText" ? 16_384 : 512);
  }
  return Object.freeze(output);
}

function rateLimit(headers = {}) {
  const remainingRaw = headers["x-rate-limit-remaining"];
  const limitRaw = headers["x-rate-limit-limit"];
  const resetRaw = headers["x-rate-limit-reset"];
  const output = {};
  if (remainingRaw !== undefined) {
    if (!/^\d+$/u.test(remainingRaw)) drift();
    output.remaining = Number(remainingRaw);
  }
  if (limitRaw !== undefined) {
    if (!/^\d+$/u.test(limitRaw)) drift();
    output.limit = Number(limitRaw);
  }
  if (resetRaw !== undefined) {
    if (!/^\d+$/u.test(resetRaw)) drift();
    const reset = new Date(Number(resetRaw) * 1000);
    if (Number.isNaN(reset.valueOf())) drift();
    output.resetAt = reset.toISOString();
  }
  return Object.freeze(output);
}

function terminal(response) {
  const headers = response.headers ?? {};
  const rate = rateLimit(headers);
  if (response.status === 429 || rate.remaining === 0) throw new XContractError("RATE_LIMITED", "The X account is rate limited.", { rateLimit: rate });
  if (response.status === 401) throw new XContractError("SESSION_REVOKED", "The X session is revoked.");
  if (response.status === 403) throw new XContractError("ACCESS_DENIED", "The X operation requires human review or access was denied.");
  if (response.status !== 200) drift();
  return rate;
}

export function normalizeXFixtureResponse(operation, response, previousCursor = null) {
  let encoded;
  try { encoded = JSON.stringify(response?.body); } catch { drift(); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > X_MAX_RESPONSE_BYTES) drift();
  const rate = terminal(record(response));
  const body = record(response.body);
  exactKeys(body, ["version", "operation", "data"]);
  if (body.version !== X_PROTOCOL_VERSION || body.operation !== operation) drift();
  const data = record(body.data);
  if (["account.identity", "profile.get", "post.get", "lists.lookup"].includes(operation)) {
    exactKeys(data, ["entity"]);
    const expected = operation === "post.get" ? "post" : operation === "profile.get" ? "profile" : operation === "lists.lookup" ? "list" : "account";
    return Object.freeze({ entity: entity(data.entity, expected), rateLimit: rate });
  }
  exactKeys(data, ["items", "nextCursor"]);
  if (!Array.isArray(data.items) || data.items.length > X_MAX_PAGE_ITEMS) drift();
  const kind = operation === "notifications.list" ? "notification"
    : operation === "conversations.list" ? "conversation"
      : ["followers.list", "following.list", "lists.members"].includes(operation) ? "profile"
        : operation === "lists.memberships" ? "list" : "post";
  const items = data.items.map((item) => entity(item, kind));
  const cursor = data.nextCursor === null ? null : text(data.nextCursor, X_MAX_CURSOR_BYTES);
  if (cursor !== null && cursor === previousCursor) drift();
  return Object.freeze({ items: Object.freeze(items), nextCursor: cursor, rateLimit: rate });
}

export function unwrapXNormalized(result) {
  return "entity" in result ? { ...result.entity, rateLimit: result.rateLimit } : result;
}

export function normalizeXFixtureWriteResponse(operation, response) {
  assertFixtureWriteOperation(operation);
  let encoded;
  try { encoded = JSON.stringify(response?.body); } catch { drift(); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > X_MAX_RESPONSE_BYTES) drift();
  const rate = terminal(record(response));
  const body = record(response.body);
  exactKeys(body, ["version", "operation", "data"]);
  if (body.version !== X_PROTOCOL_VERSION || body.operation !== operation) drift();
  const data = record(body.data);
  exactKeys(data, ["result"]);
  const source = record(data.result);
  exactKeys(source, ["nativeId", "canonicalUrl"]);
  const nativeId = text(source.nativeId, 128);
  if (!/^\d+$/u.test(nativeId)) drift();
  return Object.freeze({
    nativeId,
    ...(source.canonicalUrl === undefined ? {} : { canonicalUrl: canonicalUrl(source.canonicalUrl) }),
    rateLimit: rate,
  });
}
