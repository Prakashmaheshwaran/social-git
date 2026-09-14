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
  if (!Object.hasOwn({ t1: true, t3: true, t5: true }, expectedKind)) {
    protocolDrift("listing item kind is not supported");
  }
  const data = responseData(raw, "listing");
  if (!Array.isArray(data.children)) {
    protocolDrift("listing children are missing");
  }

  const items = data.children.map((child) => {
    if (!isRecord(child) || child.kind !== expectedKind || !isRecord(child.data)) {
      protocolDrift(`listing child does not match ${expectedKind}`);
    }
    if (expectedKind === "t1") {
      return normalizeCommentData(child.data);
    }
    if (expectedKind === "t5") {
      return normalizeSubredditData(child.data);
    }
    return normalizePostData(child.data);
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

  const comments = commentListing.children
    .filter((child) => child?.kind === "t1")
    .map((child) => {
      if (!isRecord(child.data)) {
        protocolDrift("comment data is missing");
      }
      return normalizeCommentData(child.data);
    });

  return deepFreeze({
    post: normalizePostData(postChild.data),
    comments,
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
    case "listing.list":
    case "search.query":
      return deepFreeze({ native: null, data: normalizeRedditListing(raw) });
    case "post.get": {
      const thread = normalizeRedditPostThread(raw);
      return deepFreeze({ native: pickNative(thread.post), data: thread.post });
    }
    case "comments.list": {
      const thread = normalizeRedditPostThread(raw);
      return deepFreeze({
        native: pickNative(thread.post),
        data: { items: thread.comments, page: thread.page }
      });
    }
    default:
      return normalizeRedditWriteResponse(operation, raw, options);
  }
}

function normalizePostData(data) {
  const permalink = requireString(data.permalink, "post permalink");
  return deepFreeze({
    ...nativeReference(data, "t3", permalink),
    ...selectFields(data, POST_FIELDS)
  });
}

function normalizeCommentData(data) {
  const permalink = requireString(data.permalink, "comment permalink");
  return deepFreeze({
    ...nativeReference(data, "t1", permalink),
    ...selectFields(data, COMMENT_FIELDS)
  });
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
