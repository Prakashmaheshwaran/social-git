import { CORE_ERROR_CODES, isWriteOperation } from "./contract.mjs";

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_LIST_ITEMS = 100;
const NATIVE_KINDS_BY_OPERATION = Object.freeze({
  "session.import": ["t2"],
  "fixture.diagnostics": null,
  "profile.get": ["t2"],
  "subreddit.get": ["t5"],
  "listing.list": null,
  "post.get": ["t3"],
  "comments.list": ["t3"],
  "search.query": null,
  "user.get": ["t2"],
  "user.content": null,
  "account.saved": null,
  "account.upvoted": null,
  "message.inbox": null,
  "message.thread": ["t4"],
  "post.createText": ["t3"],
  "post.createLink": ["t3"],
  "post.createMedia": ["t3"],
  "comment.create": ["t1"],
  "reply.create": ["t1"],
  "item.editOwn": ["t1", "t3"],
  "vote.set": ["t1", "t3"],
  "save.set": ["t1", "t3"],
  "save.unset": ["t1", "t3"],
  "subreddit.subscribe": ["t5"],
  "subreddit.unsubscribe": ["t5"],
  "item.deleteOwn": ["t1", "t3"],
  "message.send": ["t4"],
  "message.reply": ["t4"],
  "action.recover": ["t1", "t3", "t4"]
});

export function validateRedditWorkerOutcome(operation, result, context = {}) {
  if (result?.status === "FAILED") {
    exact(result, ["status", "error"], ["rateLimit"]);
    exact(result.error, ["code", "message", "retryable", "actionRequired"]);
    if (!Object.values(CORE_ERROR_CODES).includes(result.error.code)) fail("failure code");
    requireText(result.error.message, "failure message", 1, 1_024);
    requireBoolean(result.error.retryable, "failure retryable");
    requireBoolean(result.error.actionRequired, "failure actionRequired");
    if (result.rateLimit !== undefined) validateRateLimit(result.rateLimit);
    return result;
  }

  if (result?.status === "UNKNOWN") {
    exact(result, ["status", "recoveryCheckedAt"]);
    if (operation !== "action.recover") fail("unexpected UNKNOWN result");
    requireTimestamp(result.recoveryCheckedAt, "recoveryCheckedAt");
    return result;
  }

  exact(result, ["status", "native", "data", "rateLimit"]);
  if (result.status !== "SUCCEEDED") fail("result status");
  const native = validateOperationNative(operation, result.native, context);
  validateRateLimit(result.rateLimit);
  validateOperationData(operation, result.data, native, context);
  if (isWriteOperation(operation)) {
    validateRedditSubmissionEvent(operation, context.submission, context);
    requireSameNative(native, context.submission.native, "terminal result and submission marker");
  }
  return result;
}

export function validateRedditSubmissionEvent(operation, event, context = {}) {
  exact(event, ["type", "native", "submittedAt"]);
  if (!isWriteOperation(operation) || event.type !== "SUBMISSION_STARTED") {
    fail("submission event operation or type");
  }
  requireTimestamp(event.submittedAt, "submittedAt");
  validateOperationNative(operation, event.native, context);
  return event;
}

function validateOperationNative(operation, native, context) {
  if (!Object.hasOwn(NATIVE_KINDS_BY_OPERATION, operation)) fail("missing operation native schema");
  const expectedKinds = NATIVE_KINDS_BY_OPERATION[operation];
  if (expectedKinds === null) {
    if (native !== null) fail("operation must not return a native reference");
    return null;
  }
  const validated = validateNative(native, expectedKinds);
  const targetNativeId = targetNativeIdFor(operation, context);
  if (targetNativeId !== null && validated.nativeId !== targetNativeId) {
    fail("native reference does not match the request target");
  }
  if (["post.createText", "post.createLink", "post.createMedia"].includes(operation)) {
    requireSubredditTarget(validated, context.input?.subreddit, "created post target");
  }
  if (operation === "comment.create") {
    requirePostTarget(validated, context.input?.postNativeId, "created comment target");
  }
  if (["subreddit.subscribe", "subreddit.unsubscribe"].includes(operation)) {
    requireSubredditTarget(validated, context.input?.subreddit, "subscription target");
  }
  return validated;
}

function validateOperationData(operation, data, native, context) {
  switch (operation) {
    case "session.import":
      exact(data, ["nativeIdentity", "validated"]);
      requireUsername(data.nativeIdentity, "nativeIdentity");
      if (data.validated !== true ||
          canonicalSubject(native) !== data.nativeIdentity ||
          (context.expectedNativeIdentity !== undefined && data.nativeIdentity !== context.expectedNativeIdentity)) {
        fail("session identity validation");
      }
      return;
    case "fixture.diagnostics":
      exact(data, ["databaseEnvironmentVisible", "fixtureWorker", "workerProcessId", "runtime"]);
      if (data.databaseEnvironmentVisible !== false || data.fixtureWorker !== true) fail("diagnostic isolation state");
      requireInteger(data.workerProcessId, "workerProcessId", 1);
      validateRuntime(data.runtime);
      return;
    case "profile.get":
      exact(data, ["username", "karma"]);
      requireUsername(data.username, "username");
      exact(data.karma, ["post", "comment"]);
      requireInteger(data.karma.post, "post karma", 0);
      requireInteger(data.karma.comment, "comment karma", 0);
      if (canonicalSubject(native) !== data.username ||
          (context.expectedNativeIdentity !== undefined && data.username !== context.expectedNativeIdentity)) {
        fail("profile identity");
      }
      return;
    case "user.get":
      exact(data, ["username", "karma"]);
      requireUsername(data.username, "username");
      exact(data.karma, ["post", "comment"]);
      requireInteger(data.karma.post, "post karma", 0);
      requireInteger(data.karma.comment, "comment karma", 0);
      if (canonicalSubject(native) !== data.username ||
          (context.input?.username !== undefined && data.username !== context.input.username)) fail("user profile target");
      return;
    case "subreddit.get":
      exact(data, ["name", "subscribers"]);
      requireSubreddit(data.name, "subreddit name");
      requireInteger(data.subscribers, "subscribers", 0);
      if (canonicalSubject(native) !== data.name ||
          (context.input?.name !== undefined && data.name !== context.input.name)) fail("subreddit result target");
      return;
    case "listing.list":
      exact(data, ["items", "page"]);
      validateItems(data.items, (post) => {
        validatePost(post);
        requireSubredditTarget(post, context.input?.subreddit, "listing subreddit target");
      });
      validatePage(data.page, "t3");
      return;
    case "post.get":
      validatePost(data);
      requireSameNative(data, native, "post result");
      return;
    case "comments.list":
      exact(data, ["items", "page"]);
      validateItems(data.items, (comment) => {
        validateComment(comment);
        requirePostTarget(comment, context.input?.postNativeId, "comment listing target");
      });
      validatePage(data.page, "t1");
      return;
    case "search.query":
      exact(data, ["query", "items", "page"]);
      requireText(data.query, "search query", 1, 512);
      if (context.input?.query !== undefined && data.query !== context.input.query) fail("search result query");
      validateItems(data.items, (post) => {
        validatePost(post);
        requireSubredditTarget(post, context.input?.subreddit, "search subreddit target");
      });
      validatePage(data.page, "t3");
      return;
    case "user.content": {
      exact(data, ["items", "page"]);
      const comments = context.input?.content === "comments";
      validateItems(data.items, comments ? validateComment : validatePost);
      validatePage(data.page, comments ? "t1" : "t3");
      return;
    }
    case "account.saved":
    case "account.upvoted":
      exact(data, ["items", "page"]);
      validateItems(data.items, (item) => {
        if (item?.itemType === "post") validatePost(item);
        else if (item?.itemType === "comment") validateComment(item);
        else fail("account listing item type");
      });
      validatePage(data.page, null);
      return;
    case "message.inbox":
      exact(data, ["items", "page"]);
      validateItems(data.items, validateMessage);
      validatePage(data.page, "t4");
      return;
    case "message.thread":
      validateMessage(data, true);
      requireSameNative(data, native, "message thread result");
      return;
    case "post.createText":
      validateCreated(data, "text_post");
      return;
    case "post.createLink":
      validateCreated(data, "link_post");
      return;
    case "post.createMedia":
      exact(data, ["created", "kind", "media"]);
      if (data.created !== true || data.kind !== "media_post") fail("media post result");
      exact(data.media, ["state"]);
      if (data.media.state !== "uploaded") fail("media state");
      return;
    case "comment.create":
      validateCreated(data, "comment");
      return;
    case "reply.create":
      validateCreated(data, "reply");
      return;
    case "item.editOwn":
      exact(data, ["edited"]);
      if (data.edited !== true) fail("edit result");
      return;
    case "vote.set":
      exact(data, ["applied", "direction"]);
      if (data.applied !== true || ![-1, 0, 1].includes(data.direction) ||
          (context.input?.direction !== undefined && data.direction !== context.input.direction)) fail("vote result");
      return;
    case "save.set":
      exact(data, ["saved"]);
      if (data.saved !== true) fail("save result");
      return;
    case "save.unset":
      exact(data, ["saved"]);
      if (data.saved !== false) fail("unsave result");
      return;
    case "subreddit.subscribe":
      exact(data, ["subscribed"]);
      if (data.subscribed !== true) fail("subscribe result");
      return;
    case "subreddit.unsubscribe":
      exact(data, ["subscribed"]);
      if (data.subscribed !== false) fail("unsubscribe result");
      return;
    case "item.deleteOwn":
      exact(data, ["deleted"]);
      if (data.deleted !== true) fail("delete result");
      return;
    case "message.send":
      validateCreated(data, "private_message");
      return;
    case "message.reply":
      validateCreated(data, "private_message_reply");
      return;
    case "action.recover":
      exact(data, ["recovered"]);
      if (data.recovered !== true) fail("recovery result");
      return;
    default:
      fail("missing operation data schema");
  }
}

function validateRuntime(runtime) {
  exact(runtime, [
    "permissionModel", "networkGranted", "filesystemWriteGranted", "childProcessGranted",
    "workerThreadGranted", "nativeAddonGranted", "forbiddenEnvironmentVisible", "osSandbox"
  ]);
  if (
    runtime.permissionModel !== true || runtime.networkGranted !== false ||
    runtime.filesystemWriteGranted !== false || runtime.childProcessGranted !== false ||
    runtime.workerThreadGranted !== false || runtime.nativeAddonGranted !== false ||
    runtime.forbiddenEnvironmentVisible !== false ||
    !["darwin_sandbox_exec", "node_permission_model"].includes(runtime.osSandbox)
  ) fail("worker runtime authority");
}

function validatePost(post) {
  exact(post, ["nativeId", "canonicalUrl", "title", "author"], ["itemType"]);
  if (post.itemType !== undefined && post.itemType !== "post") fail("post item type");
  validateNative(post, ["t3"], false);
  requireText(post.title, "post title", 1, MAX_TEXT_BYTES);
  requireAuthor(post.author);
}

function validateComment(comment) {
  exact(comment, ["nativeId", "canonicalUrl", "body", "author"], ["itemType"]);
  if (comment.itemType !== undefined && comment.itemType !== "comment") fail("comment item type");
  validateNative(comment, ["t1"], false);
  requireText(comment.body, "comment body", 1, MAX_TEXT_BYTES);
  requireAuthor(comment.author);
}

function validateMessage(message, withReplies = false) {
  exact(message, [
    "nativeId", "canonicalUrl", "author", "recipient", "subject", "body",
    "wasRead", "parentNativeId", "createdUtc"
  ], withReplies ? ["replies"] : []);
  validateNative(message, ["t4"], false);
  requireAuthor(message.author);
  requireAuthor(message.recipient);
  requireText(message.subject, "message subject", 1, 100);
  requireText(message.body, "message body", 1, 10_000);
  requireBoolean(message.wasRead, "message wasRead");
  if (message.parentNativeId !== null) requireNativeId(message.parentNativeId, ["t4"], "message parentNativeId");
  if (!Number.isFinite(message.createdUtc) || message.createdUtc < 0) fail("message createdUtc");
  if (withReplies) validateItems(message.replies, validateMessage);
}

function validateItems(items, validator) {
  if (!Array.isArray(items) || items.length > MAX_LIST_ITEMS) fail("result item collection");
  for (const item of items) validator(item);
}

function validatePage(page, nativeKind) {
  exact(page, ["after", "before"]);
  for (const field of ["after", "before"]) {
    if (page[field] !== null) requireNativeId(page[field], nativeKind ? [nativeKind] : ["t1", "t3"], `page ${field}`);
  }
}

function validateCreated(data, kind) {
  exact(data, ["created", "kind"]);
  if (data.created !== true || data.kind !== kind) fail(`${kind} result`);
}

function validateNative(native, expectedKinds, requireExactReference = true) {
  if (requireExactReference) exact(native, ["nativeId", "canonicalUrl"]);
  const { kind, shortId } = requireNativeId(native.nativeId, expectedKinds, "nativeId");
  let url;
  try {
    url = new URL(native.canonicalUrl);
  } catch {
    fail("canonical URL");
  }
  if (
    url.protocol !== "https:" || url.hostname !== "www.reddit.com" || url.username || url.password ||
    url.port || url.search || url.hash || !url.pathname.startsWith("/") || url.pathname.startsWith("//")
  ) fail("canonical Reddit URL authority");
  const segments = url.pathname.split("/").filter(Boolean);
  if (kind === "t2" && !(segments.length === 2 && segments[0] === "user" && isUsername(segments[1]))) {
    fail("profile canonical URL");
  }
  if (kind === "t5" && !(segments.length === 2 && segments[0] === "r" && isSubreddit(segments[1]))) {
    fail("subreddit canonical URL");
  }
  if (kind === "t4" && !(segments.length === 3 && segments[0] === "message" && segments[1] === "messages" && segments[2] === shortId)) {
    fail("message canonical URL");
  }
  if ((kind === "t1" || kind === "t3") && !(
    segments.length >= (kind === "t1" ? 6 : 4) && segments[0] === "r" && isSubreddit(segments[1]) &&
    segments[2] === "comments" && segments[3] === (kind === "t3" ? shortId : segments[3]) &&
    (kind !== "t1" || segments.at(-1) === shortId)
  )) fail("item canonical URL");
  return native;
}

function validateRateLimit(rateLimit) {
  exact(rateLimit, ["limit", "remaining", "resetAt"], ["retryAfterMs"]);
  requireInteger(rateLimit.limit, "rate limit", 0);
  requireInteger(rateLimit.remaining, "rate remaining", 0);
  if (rateLimit.remaining > rateLimit.limit) fail("rate remaining exceeds limit");
  requireTimestamp(rateLimit.resetAt, "rate resetAt");
  if (rateLimit.retryAfterMs !== undefined) requireInteger(rateLimit.retryAfterMs, "rate retryAfterMs", 0);
}

function targetNativeIdFor(operation, context) {
  if (["post.get", "item.editOwn", "vote.set", "save.set", "save.unset", "item.deleteOwn"].includes(operation)) {
    return context.input?.nativeId ?? null;
  }
  if (operation === "comments.list") return context.input?.postNativeId ?? null;
  if (operation === "message.thread") return context.input?.messageNativeId ?? null;
  if (operation === "action.recover") return context.recoveryAction?.native?.nativeId ?? null;
  return null;
}

function canonicalSubject(native) {
  return new URL(native.canonicalUrl).pathname.split("/").filter(Boolean)[1];
}

function requireSubredditTarget(native, expectedSubreddit, label) {
  if (expectedSubreddit === undefined) return;
  const actual = new URL(native.canonicalUrl).pathname.split("/").filter(Boolean)[1];
  if (actual.toLowerCase() !== expectedSubreddit.toLowerCase()) fail(label);
}

function requirePostTarget(native, expectedPostNativeId, label) {
  if (expectedPostNativeId === undefined) return;
  const expectedShortId = requireNativeId(expectedPostNativeId, ["t3"], label).shortId;
  const actualShortId = new URL(native.canonicalUrl).pathname.split("/").filter(Boolean)[3];
  if (actualShortId !== expectedShortId) fail(label);
}

function requireSameNative(left, right, label) {
  if (left.nativeId !== right.nativeId || left.canonicalUrl !== right.canonicalUrl) fail(label);
}

function requireNativeId(value, expectedKinds, label) {
  if (typeof value !== "string") fail(label);
  const match = /^(t[0-9]+)_([a-z0-9]+)$/u.exec(value);
  if (!match || !expectedKinds.includes(match[1])) fail(label);
  return { kind: match[1], shortId: match[2] };
}

function requireUsername(value, label) {
  if (!isUsername(value)) fail(label);
}

function requireAuthor(value) {
  if (value === "[deleted]") return;
  requireUsername(value, "author");
}

function requireSubreddit(value, label) {
  if (!isSubreddit(value)) fail(label);
}

function isUsername(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,20}$/u.test(value);
}

function isSubreddit(value) {
  return typeof value === "string" && /^[A-Za-z0-9_]{2,21}$/u.test(value);
}

function requireText(value, label, minBytes, maxBytes) {
  if (typeof value !== "string") fail(label);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minBytes || bytes > maxBytes || value.trim().length === 0 || value.includes("\0")) fail(label);
}

function requireTimestamp(value, label) {
  if (typeof value !== "string") fail(label);
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) fail(label);
}

function requireInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(label);
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(label);
}

function exact(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("plain object");
  }
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    fail("exact fields");
  }
}

function fail(label) {
  throw new Error(`Invalid Reddit worker result: ${label}`);
}
