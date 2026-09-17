import { X_MAX_CURSOR_BYTES, X_MAX_PAGE_ITEMS, X_MAX_RESPONSE_BYTES, XContractError } from "./contract.mjs";

export function normalizeXProtocolResponse(operation, response, previousCursor = null, mediaPhase = null) {
  const source = object(response);
  const rateLimit = rate(source.headers ?? {});
  terminal(source.status, rateLimit, source.body);
  boundedBody(source.body);
  const body = object(source.body);
  if (Object.hasOwn(body, "errors")) upstreamErrors(body.errors);
  if (operation === "post.media.create" && mediaPhase !== null) return Object.freeze({ ...media(mediaPhase, body), rateLimit });
  if (operation === "account.identity") return Object.freeze({ entity: identity(body), rateLimit });
  if (operation === "profile.get") return Object.freeze({ entity: profile(path(body, "data", "user", "result")), rateLimit });
  if (operation === "post.get") return Object.freeze({ entity: tweet(path(body, "data", "tweetResult", "result")), rateLimit });
  if (operation === "notifications.list") return Object.freeze({ ...notifications(body), rateLimit });
  if (operation === "conversations.list") return Object.freeze({ ...conversations(body), rateLimit });
  if (["thread.get", "timeline.home", "timeline.user", "search.query", "bookmarks.list"].includes(operation)) return Object.freeze({ ...timeline(body, previousCursor), rateLimit });
  return Object.freeze({ ...mutation(operation, body), rateLimit });
}

function identity(body) {
  exact(body, ["user_id", "screen_name", "name"]);
  return Object.freeze({ nativeId: id(body.user_id), username: username(body.screen_name), displayName: text(body.name, 256), canonicalUrl: `https://x.com/${username(body.screen_name)}` });
}
function profile(value) {
  const source = object(value); if (source.__typename !== "User") drift();
  const legacy = object(source.legacy);
  return Object.freeze({ nativeId: id(source.rest_id), canonicalUrl: `https://x.com/${username(legacy.screen_name)}`, username: username(legacy.screen_name), displayName: text(legacy.name, 256), description: text(legacy.description, 16_384, true), followersCount: count(legacy.followers_count), followingCount: count(legacy.friends_count), createdAt: instant(legacy.created_at), verified: boolean(legacy.verified) });
}
function tweet(value) {
  const source = object(value); if (source.__typename !== "Tweet") drift();
  const legacy = object(source.legacy); const user = object(path(source, "core", "user_results", "result")); const userLegacy = object(user.legacy);
  const nativeId = id(source.rest_id); const screen = username(userLegacy.screen_name);
  return Object.freeze({ nativeId, canonicalUrl: `https://x.com/${screen}/status/${nativeId}`, authorNativeId: id(legacy.user_id_str), text: text(legacy.full_text, 16_384, true), createdAt: instant(legacy.created_at), replyCount: count(legacy.reply_count), repostCount: count(legacy.retweet_count), likeCount: count(legacy.favorite_count), quoteCount: count(legacy.quote_count), conversationId: id(legacy.conversation_id_str) });
}
function timeline(body, previousCursor) {
  const instructions = path(body, "data", "timeline", "instructions"); if (!Array.isArray(instructions) || instructions.length !== 1) drift();
  const entries = object(instructions[0]).entries; if (!Array.isArray(entries) || entries.length > X_MAX_PAGE_ITEMS + 2) drift();
  const items = []; let nextCursor = null;
  for (const raw of entries) {
    const entry = object(raw); const content = object(entry.content);
    if (content.entryType === "TimelineTimelineCursor") {
      if (content.cursorType !== "Bottom" || nextCursor !== null) drift();
      nextCursor = text(content.value, X_MAX_CURSOR_BYTES);
      if (nextCursor === previousCursor) drift();
    } else if (content.entryType === "TimelineTimelineItem") {
      items.push(tweet(path(content, "itemContent", "tweet_results", "result")));
    } else drift();
  }
  if (items.length > X_MAX_PAGE_ITEMS) drift();
  return { items: Object.freeze(items), nextCursor };
}
function notifications(body) {
  const values = Object.values(object(path(body, "globalObjects", "notifications"))); if (values.length > X_MAX_PAGE_ITEMS) drift();
  const items = values.map((raw) => { const value = object(raw); return Object.freeze({ nativeId: id(value.id), notificationType: text(value.type, 64), text: text(path(value, "message", "text"), 16_384, true), createdAt: epoch(value.timestampMs), postNativeId: id(path(value, "template", "aggregateUserActionsV1", "targetObjects")[0].tweet.id) }); });
  return { items: Object.freeze(items), nextCursor: null };
}
function conversations(body) {
  const state = object(body.inbox_initial_state); const entries = state.entries; if (!Array.isArray(entries) || entries.length > X_MAX_PAGE_ITEMS) drift();
  const latest = new Map(entries.map((raw) => { const message = object(object(raw).message); return [text(message.conversation_id, 260), message]; }));
  const values = Object.values(object(state.conversations)); if (values.length > X_MAX_PAGE_ITEMS) drift();
  const items = values.map((raw) => { const value = object(raw); const conversationId = text(value.conversation_id, 260); const participants = value.participants; if (!Array.isArray(participants) || participants.length < 1 || participants.length > 100) drift(); const message = latest.get(conversationId); return Object.freeze({ nativeId: id(value.sort_event_id), participantNativeIds: Object.freeze(participants.map((item) => id(object(item).user_id))), ...(message ? { lastMessageText: text(path(message, "message_data", "text"), 16_384, true), updatedAt: epoch(message.time) } : {}) }); });
  const cursor = state.min_entry_id === undefined ? null : id(state.min_entry_id);
  return { items: Object.freeze(items), nextCursor: cursor };
}
function mutation(operation, body) {
  const result = object(path(body, "data", "result")); const nativeId = id(result.rest_id ?? object(result.legacy).id_str);
  return { nativeId, ...(["post.create", "post.reply", "post.delete", "post.like.set", "post.repost.set", "bookmark.set", "post.media.create"].includes(operation) ? { canonicalUrl: `https://x.com/i/status/${nativeId}` } : {}) };
}
function media(phase, body) {
  if (phase === "init") { exact(body, ["media_id_string", "expires_after_secs"]); return { phase: "initialized", mediaId: id(body.media_id_string), expiresAfterSeconds: positive(body.expires_after_secs, 3600) }; }
  if (phase === "append") { exact(body, []); return { phase: "appended" }; }
  if (phase === "finalize") { exact(body, ["media_id_string"]); return { phase: "finalized", mediaId: id(body.media_id_string) }; }
  if (phase === "submit") return { phase: "submitted", ...mutation("post.media.create", body) };
  drift();
}
function terminal(status, rateLimit, body) { if (status === 429 || rateLimit.remaining === 0) throw new XContractError("RATE_LIMITED", "The X account is rate limited.", { rateLimit }); if (status === 401) throw new XContractError("SESSION_REVOKED", "The X session is revoked."); if (status === 403) { if (isChallenge(body)) throw new XContractError("CHALLENGE_REQUIRED", "X requires human account action."); throw new XContractError("ACCESS_DENIED", "X denied the operation."); } if (status !== 200) drift(); }
function upstreamErrors(value) { if (!Array.isArray(value) || value.length < 1) drift(); const code = object(value[0]).code; if (code === 326) throw new XContractError("CHALLENGE_REQUIRED", "X requires human account action."); if (code === 32 || code === 89) throw new XContractError("SESSION_REVOKED", "The X session is revoked."); drift(); }
function isChallenge(value) { try { const errors = object(value).errors; return Array.isArray(errors) && errors.some((item) => object(item).code === 326); } catch { return false; } }
function rate(headers) { const source = object(headers); const output = {}; for (const [name, field] of [["x-rate-limit-limit", "limit"], ["x-rate-limit-remaining", "remaining"]]) if (source[name] !== undefined) { if (!/^\d+$/u.test(source[name])) drift(); output[field] = Number(source[name]); } if (source["x-rate-limit-reset"] !== undefined) { if (!/^\d+$/u.test(source["x-rate-limit-reset"])) drift(); output.resetAt = new Date(Number(source["x-rate-limit-reset"]) * 1000).toISOString(); } return Object.freeze(output); }
function boundedBody(body) { let encoded; try { encoded = JSON.stringify(body); } catch { drift(); } if (encoded === undefined || Buffer.byteLength(encoded) > X_MAX_RESPONSE_BYTES) drift(); }
function path(value, ...keys) { let current = value; for (const key of keys) current = object(current)[key]; if (current === undefined || current === null) drift(); return current; }
function object(value) { if (!value || typeof value !== "object" || Array.isArray(value)) drift(); return value; }
function exact(value, keys) { if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) drift(); }
function id(value) { const result = text(value, 128); if (!/^\d+(?:-\d+)?$/u.test(result)) drift(); return result; }
function username(value) { const result = text(value, 15); if (!/^[A-Za-z0-9_]{1,15}$/u.test(result)) drift(); return result; }
function text(value, maximum, allowEmpty = false) { if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length < 1) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) drift(); return value; }
function count(value) { if (!Number.isSafeInteger(value) || value < 0) drift(); return value; }
function positive(value, maximum) { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) drift(); return value; }
function boolean(value) { if (typeof value !== "boolean") drift(); return value; }
function instant(value) { const result = new Date(text(value, 128)); if (Number.isNaN(result.valueOf())) drift(); return result.toISOString(); }
function epoch(value) { const raw = text(value, 32); if (!/^\d+$/u.test(raw)) drift(); const result = new Date(Number(raw)); if (Number.isNaN(result.valueOf())) drift(); return result.toISOString(); }
function drift() { throw new XContractError("PROTOCOL_DRIFT", "The X response does not match the pinned protocol corpus."); }
