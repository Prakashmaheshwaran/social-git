/*
 * Field selection is adapted from reddit-lyr's normalizer.py.
 * Copyright (c) 2026 Ishan Parihar. MIT licensed.
 * Source revision: 87ec32aff905923ecd156e7951c168adfdf6fac1.
 * See ../THIRD_PARTY_NOTICES.md for the full notice and provenance.
 */

import {
  AdapterContractError,
  CORE_ERROR_CODES,
  PROTOCOL_MAPPING_STATUS,
  assertSupportedOperation,
  isRecord
} from "./contract.mjs";

const POST_FIELDS = Object.freeze([
  "title",
  "author",
  "subreddit",
  "score",
  "num_comments",
  "upvote_ratio",
  "url",
  "selftext",
  "created_utc",
  "link_flair_text",
  "is_self",
  "domain",
  "thumbnail",
  "over_18",
  "spoiler",
  "locked",
  "stickied",
  "distinguished"
]);

const COMMENT_FIELDS = Object.freeze([
  "author",
  "body",
  "score",
  "created_utc",
  "depth",
  "parent_id",
  "distinguished",
  "stickied",
  "controversiality"
]);

const SUBREDDIT_FIELDS = Object.freeze([
  "title",
  "public_description",
  "subscribers",
  "active_user_count",
  "created_utc",
  "over18",
  "wiki_enabled"
]);

const USER_FIELDS = Object.freeze([
  "link_karma",
  "comment_karma",
  "total_karma",
  "created_utc",
  "has_verified_email",
  "is_gold",
  "is_mod"
]);

export function normalizeRedditProfile(raw) {
  const data = responseData(raw, "profile");
  const username = requireString(data.name, "profile username");
  const native = nativeReference(data, "t2", `/user/${encodeURIComponent(username)}/`);
  return deepFreeze({
    ...native,
    username,
    ...selectFields(data, USER_FIELDS)
  });
}

export function normalizeRedditSubreddit(raw) {
  const data = responseData(raw, "subreddit");
  const displayName = requireString(data.display_name, "subreddit display name");
  const native = nativeReference(data, "t5", `/r/${encodeURIComponent(displayName)}/`);
  return deepFreeze({
    ...native,
    name: displayName,
    ...selectFields(data, SUBREDDIT_FIELDS)
  });
}

export function normalizeRedditListing(raw, expectedKind = "t3") {
  if (!Object.hasOwn({ t1: true, t3: true, t5: true, mixed: true }, expectedKind)) {
    protocolDrift("listing item kind is not supported");
  }
  const data = responseData(raw, "listing");
  if (!Array.isArray(data.children)) {
    protocolDrift("listing children are missing");
  }

  const items = data.children.map((child) => {
    if (!isRecord(child) || !isRecord(child.data) || (expectedKind === "mixed"
      ? !["t1", "t3"].includes(child.kind)
      : child.kind !== expectedKind)) {
      protocolDrift(`listing child does not match ${expectedKind}`);
    }
    if (child.kind === "t1") {
      const comment = normalizeCommentData(child.data);
      return expectedKind === "mixed" ? deepFreeze({ itemType: "comment", ...comment }) : comment;
    }
    if (child.kind === "t5") {
      return normalizeSubredditData(child.data);
    }
    const post = normalizePostData(child.data);
    return expectedKind === "mixed" ? deepFreeze({ itemType: "post", ...post }) : post;
  });

  return deepFreeze({
    items,
    page: {
      after: optionalPageToken(data.after),
      before: optionalPageToken(data.before)
    }
  });
}

export function normalizeRedditPostThread(raw) {
  if (!Array.isArray(raw) || raw.length < 2) {
    protocolDrift("post thread must contain post and comment listings");
  }

  const postListing = normalizeListingEnvelope(raw[0], "post thread");
  const commentListing = normalizeListingEnvelope(raw[1], "comment thread");
  if (postListing.children.length !== 1) {
    protocolDrift("post thread must contain exactly one post");
  }

  const postChild = postListing.children[0];
  if (!isRecord(postChild) || postChild.kind !== "t3" || !isRecord(postChild.data)) {
    protocolDrift("post thread does not contain a native post");
  }

  const normalizedChildren = normalizeCommentChildren(commentListing.children, 0, { remaining: 500 });

  return deepFreeze({
    post: normalizePostData(postChild.data),
    comments: normalizedChildren.comments,
    more: normalizedChildren.more,
    page: {
      after: optionalPageToken(commentListing.after),
      before: optionalPageToken(commentListing.before)
    }
  });
}

export function normalizeRedditWriteResponse(operation, raw, { existingNative = null } = {}) {
  const capability = assertSupportedOperation(operation);
  if (capability.mode !== "write" || capability.protocolMapping !== PROTOCOL_MAPPING_STATUS.MAPPED) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.CAPABILITY_DISABLED,
      `Reddit operation ${operation} has no admitted write normalizer`
    );
  }
  if (operation === "post.createMedia") {
    throw new AdapterContractError(
      CORE_ERROR_CODES.INVALID_REQUEST,
      "Reddit media is normalized only by the phased process result"
    );
  }

  assertSuccessfulWriteEnvelope(raw);

  if (operation === "post.createText" || operation === "post.createLink") {
    if (!isRecord(raw.json)) {
      protocolDrift("created post response envelope is missing");
    }
    const data = raw.json.data;
    if (!isRecord(data)) {
      protocolDrift("created post data is missing");
    }
    const native = nativeReference(data, "t3", data.url ?? data.permalink);
    return deepFreeze({ native, data: { created: true, kind: operation === "post.createText" ? "text_post" : "link_post" } });
  }

  if (operation === "comment.create" || operation === "reply.create") {
    if (!isRecord(raw.json)) {
      protocolDrift("created comment response envelope is missing");
    }
    const things = raw.json.data?.things;
    if (!Array.isArray(things) || things.length !== 1 || !isRecord(things[0]?.data)) {
      protocolDrift("created comment data is missing or ambiguous");
    }
    const native = nativeReference(things[0].data, "t1", things[0].data.permalink);
    return deepFreeze({ native, data: { created: true, kind: operation === "comment.create" ? "comment" : "reply" } });
  }

  const native = validateExistingNative(existingNative);
  const dataByOperation = {
    "vote.set": { applied: true },
    "save.set": { saved: true },
    "save.unset": { saved: false },
    "item.deleteOwn": { deleted: true }
  };
  return deepFreeze({ native, data: dataByOperation[operation] });
}

export function normalizeRedditOperationResponse(operation, raw, options = {}) {
  switch (operation) {
    case "profile.get": {
      const data = normalizeRedditProfile(raw);
      return resultWithNative(data);
    }
    case "subreddit.get": {
      const data = normalizeRedditSubreddit(raw);
      return resultWithNative(data);
    }
    case "listing.list": {
      const listing = normalizeRedditListing(raw);
      assertListingSubreddit(listing, options.input?.subreddit);
      return deepFreeze({ native: null, data: listing });
    }
    case "search.query": {
      const listing = normalizeRedditListing(raw);
      assertListingSubreddit(listing, options.input?.subreddit);
      return deepFreeze({ native: null, data: { query: options.input?.query, ...listing } });
    }
    case "user.get": {
      const data = normalizeRedditProfile(raw);
      if (options.input?.username !== undefined && normalizeName(data.username) !== normalizeName(options.input.username)) {
        protocolDrift("user profile does not match the requested username");
      }
      return resultWithNative(data);
    }
    case "user.content": {
      const kind = options.input?.content === "comments" ? "t1" : "t3";
      const listing = normalizeRedditListing(raw, kind);
      for (const item of listing.items) {
        if (item.author !== "[deleted]" && normalizeName(item.author) !== normalizeName(options.input?.username)) {
          protocolDrift("user content author does not match the requested username");
        }
      }
      return deepFreeze({ native: null, data: listing });
    }
    case "account.saved":
    case "account.upvoted":
      return deepFreeze({ native: null, data: normalizeRedditListing(raw, "mixed") });
    case "post.get": {
      const thread = normalizeRedditPostThread(raw);
      assertThreadTarget(thread, options.input?.nativeId);
      return deepFreeze({ native: pickNative(thread.post), data: thread.post });
    }
    case "comments.list": {
      const thread = normalizeRedditPostThread(raw);
      assertThreadTarget(thread, options.input?.postNativeId);
      return deepFreeze({
        native: pickNative(thread.post),
        data: { items: thread.comments, more: thread.more, page: thread.page }
      });
    }
    default:
      return normalizeRedditWriteResponse(operation, raw, options);
  }
}

/** Strict candidate parser for Reddit's native private-message (t4) shapes. */
export function normalizeRedditMessagingCandidateResponse(operation, raw, { input } = {}) {
  if (operation === "message.inbox") {
    const listing = normalizeListingEnvelope(raw, "message inbox");
    if (listing.children.length > 100) protocolDrift("message inbox exceeds its item bound");
    const budget = { remaining: 100 };
    const items = listing.children.map((child) => normalizeMessageChild(child, 0, budget, false));
    return deepFreeze({ native: null, data: { items, page: { after: optionalMessagePageToken(listing.after), before: optionalMessagePageToken(listing.before) } } });
  }
  if (operation === "message.thread") {
    const listing = normalizeListingEnvelope(raw, "message thread");
    if (listing.children.length !== 1) protocolDrift("message thread must contain exactly one root t4");
    const root = normalizeMessageChild(listing.children[0], 0, { remaining: 100 }, true);
    const expected = input?.messageNativeId;
    const selected = findMessage(root, expected);
    if (!selected) protocolDrift("message thread does not contain the requested t4");
    return deepFreeze({ native: pickNative(selected), data: selected });
  }
  if (operation === "message.send") {
    assertSuccessfulWriteEnvelope(raw);
    return deepFreeze({ native: null, data: { acceptedWithoutNativeProof: true } });
  }
  if (operation === "message.reply") {
    assertSuccessfulWriteEnvelope(raw);
    const things = raw?.json?.data?.things;
    if (!Array.isArray(things) || things.length !== 1) protocolDrift("message reply result is missing or ambiguous");
    const message = normalizeMessageChild(things[0], 0, { remaining: 1 }, false);
    if (message.parentNativeId !== input?.parentMessageNativeId) protocolDrift("message reply parent does not match the requested t4");
    return deepFreeze({ native: pickNative(message), data: { ...message, created: true, kind: "private_message_reply" } });
  }
  protocolDrift("unknown messaging candidate operation");
}

function normalizeMessageChild(child, depth, budget, includeReplies) {
  if (depth > 10 || budget.remaining-- < 1 || !isRecord(child) || child.kind !== "t4" || !isRecord(child.data)) {
    protocolDrift("message child is not a bounded native t4");
  }
  const data = child.data;
  const nativeId = nativeFullname(data, "t4");
  const author = boundedMessageString(data.author, "message author", 128);
  const recipient = boundedMessageString(data.dest, "message recipient", 128);
  const subject = boundedMessageString(data.subject, "message subject", 300);
  const body = boundedMessageString(data.body, "message body", 10_000, true);
  if (!Number.isFinite(data.created_utc) || data.created_utc < 0) protocolDrift("message created timestamp is invalid");
  if (typeof data.new !== "boolean" && typeof data.was_read !== "boolean") protocolDrift("message read state is missing");
  if (typeof data.new === "boolean" && typeof data.was_read === "boolean" && data.was_read === data.new) protocolDrift("message read states conflict");
  const parentNativeId = data.parent_id == null ? null : messageNativeId(data.parent_id, "message parent");
  const normalized = {
    nativeId,
    canonicalUrl: `https://www.reddit.com/message/messages/${nativeId.slice(3)}/`,
    author,
    recipient,
    subject,
    body,
    wasRead: typeof data.was_read === "boolean" ? data.was_read : !data.new,
    parentNativeId,
    created_utc: data.created_utc
  };
  if (includeReplies && data.replies !== undefined && data.replies !== "") {
    const listing = normalizeListingEnvelope(data.replies, "message replies");
    if (listing.children.length > 100) protocolDrift("message reply tree exceeds its item bound");
    normalized.replies = listing.children.map((reply) => normalizeMessageChild(reply, depth + 1, budget, true));
  }
  return deepFreeze(normalized);
}

function boundedMessageString(value, label, maximum, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length < 1) || value.length > maximum || Buffer.byteLength(value, "utf8") > maximum * 4) {
    protocolDrift(`${label} is invalid`);
  }
  return value;
}

function messageNativeId(value, label) {
  if (typeof value !== "string" || !/^t4_[a-z0-9]+$/u.test(value)) protocolDrift(`${label} is invalid`);
  return value;
}

function optionalMessagePageToken(value) {
  if (value == null) return null;
  return messageNativeId(value, "message page token");
}

function findMessage(message, nativeId) {
  if (message.nativeId === nativeId) return message;
  for (const reply of message.replies ?? []) {
    const found = findMessage(reply, nativeId);
    if (found) return found;
  }
  return null;
}

function normalizePostData(data) {
  const permalink = requireString(data.permalink, "post permalink");
  return deepFreeze({
    ...nativeReference(data, "t3", permalink),
    ...selectFields(data, POST_FIELDS)
  });
}

function normalizeCommentData(data, traversal = { depth: 0, budget: { remaining: 500 } }) {
  const permalink = requireString(data.permalink, "comment permalink");
  const normalized = {
    ...nativeReference(data, "t1", permalink),
    ...selectFields(data, COMMENT_FIELDS)
  };
  if (data.replies !== undefined && data.replies !== "") {
    const listing = normalizeListingEnvelope(data.replies, "comment replies");
    const nested = normalizeCommentChildren(listing.children, traversal.depth + 1, traversal.budget);
    normalized.replies = nested.comments;
    normalized.more = nested.more;
  }
  return deepFreeze(normalized);
}

function normalizeCommentChildren(children, depth, budget) {
  if (!Array.isArray(children) || depth > 10) protocolDrift("comment tree depth or children are invalid");
  const comments = [];
  const more = [];
  for (const child of children) {
    budget.remaining -= 1;
    if (budget.remaining < 0) protocolDrift("comment tree exceeds the bounded item count");
    if (!isRecord(child) || !isRecord(child.data)) protocolDrift("comment child data is missing");
    if (child.kind === "t1") {
      comments.push(normalizeCommentData(child.data, { depth, budget }));
      continue;
    }
    if (child.kind !== "more") protocolDrift("comment tree contains an unknown child kind");
    const data = child.data;
    const childIds = data.children ?? [];
    if (!Array.isArray(childIds) || childIds.length > 100
      || childIds.some((id) => typeof id !== "string" || !/^[a-z0-9]+$/u.test(id))) {
      protocolDrift("comment more placeholder is invalid");
    }
    if (data.parent_id !== undefined && (typeof data.parent_id !== "string" || !/^t[13]_[a-z0-9]+$/u.test(data.parent_id))) {
      protocolDrift("comment more parent is invalid");
    }
    more.push(deepFreeze({
      itemType: "more",
      parentNativeId: data.parent_id ?? null,
      depth: Number.isSafeInteger(data.depth) && data.depth >= 0 ? data.depth : depth,
      count: Number.isSafeInteger(data.count) && data.count >= 0 ? data.count : childIds.length,
      childNativeIds: childIds.map((id) => `t1_${id}`),
      expandable: false,
      unsupportedReason: "COMMENT_MORE_EXPANSION_UNSUPPORTED"
    }));
  }
  return { comments, more };
}

function normalizeSubredditData(data) {
  const displayName = requireString(data.display_name, "subreddit display name");
  return deepFreeze({
    ...nativeReference(data, "t5", `/r/${encodeURIComponent(displayName)}/`),
    name: displayName,
    ...selectFields(data, SUBREDDIT_FIELDS)
  });
}

function normalizeListingEnvelope(raw, label) {
  const data = responseData(raw, label);
  if (!Array.isArray(data.children)) {
    protocolDrift(`${label} children are missing`);
  }
  return data;
}

function responseData(raw, label) {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    protocolDrift(`${label} response data is missing`);
  }
  return raw.data;
}

function nativeReference(data, expectedKind, permalink) {
  const nativeId = nativeFullname(data, expectedKind);
  return {
    nativeId,
    canonicalUrl: canonicalRedditUrl(permalink)
  };
}

function nativeFullname(data, expectedKind) {
  if (typeof data.name === "string" && data.name.startsWith(`${expectedKind}_`) && /^t[0-9]+_[a-z0-9]+$/.test(data.name)) {
    return data.name;
  }
  if (typeof data.id === "string" && /^[a-z0-9]+$/.test(data.id)) {
    return `${expectedKind}_${data.id}`;
  }
  protocolDrift(`native ${expectedKind} identifier is missing`);
}

function canonicalRedditUrl(value) {
  const permalink = requireString(value, "canonical Reddit path");
  let url;
  try {
    url = new URL(permalink, "https://www.reddit.com/");
  } catch {
    protocolDrift("canonical Reddit URL is invalid");
  }

  if (url.protocol !== "https:" || !["reddit.com", "www.reddit.com"].includes(url.hostname)) {
    protocolDrift("canonical URL is not an HTTPS Reddit URL");
  }
  url.hostname = "www.reddit.com";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assertSuccessfulWriteEnvelope(raw) {
  if (!isRecord(raw)) {
    protocolDrift("write response is not an object");
  }
  if (isRecord(raw.json)) {
    if (!Array.isArray(raw.json.errors)) {
      protocolDrift("write response errors field is missing");
    }
    if (raw.json.errors.length > 0) {
      protocolDrift("write response contains native errors");
    }
  }
}

function validateExistingNative(native) {
  if (!isRecord(native) || !/^t[13]_[a-z0-9]+$/.test(native.nativeId ?? "")) {
    protocolDrift("verified existing native identifier is required");
  }
  return deepFreeze({
    nativeId: native.nativeId,
    canonicalUrl: canonicalRedditUrl(native.canonicalUrl)
  });
}

function selectFields(data, allowedFields) {
  const output = {};
  for (const field of allowedFields) {
    if (data[field] !== undefined && data[field] !== null) {
      output[field] = structuredClone(data[field]);
    }
  }
  return output;
}

function optionalPageToken(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !/^t[0-9]+_[a-z0-9]+$/.test(value)) {
    protocolDrift("listing page token is invalid");
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    protocolDrift(`${label} is missing`);
  }
  return value;
}

function pickNative(data) {
  return { nativeId: data.nativeId, canonicalUrl: data.canonicalUrl };
}

function assertListingSubreddit(listing, expected) {
  if (expected === undefined) return;
  for (const item of listing.items) {
    if (normalizeName(item.subreddit) !== normalizeName(expected)) {
      protocolDrift("listing item does not match the requested subreddit");
    }
  }
}

function assertThreadTarget(thread, expectedNativeId) {
  if (expectedNativeId !== undefined && thread.post.nativeId !== expectedNativeId) {
    protocolDrift("post thread does not match the requested post");
  }
}

function normalizeName(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function resultWithNative(data) {
  return deepFreeze({ native: pickNative(data), data });
}

function protocolDrift(detail) {
  throw new AdapterContractError(
    CORE_ERROR_CODES.PROTOCOL_DRIFT,
    `Reddit protocol response drift: ${detail}`
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
