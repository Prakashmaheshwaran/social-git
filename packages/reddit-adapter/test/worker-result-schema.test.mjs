import assert from "node:assert/strict";
import test from "node:test";
import {
  validateRedditSubmissionEvent,
  validateRedditWorkerOutcome
} from "../src/worker-result-schema.mjs";

const rateLimit = { limit: 60, remaining: 59, resetAt: "2026-01-01T00:01:00.000Z" };
const profileNative = { nativeId: "t2_fixtureuser", canonicalUrl: "https://www.reddit.com/user/fixture_user/" };
const subredditNative = { nativeId: "t5_2qh1i", canonicalUrl: "https://www.reddit.com/r/test/" };
const postNative = { nativeId: "t3_fixture", canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/" };
const commentNative = {
  nativeId: "t1_fixture",
  canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/fixture/"
};
const post = { ...postNative, title: "Fixture post", author: "fixture_user" };
const comment = { ...commentNative, body: "Fixture comment", author: "fixture_user" };

const cases = [
  ["session.import", success(profileNative, { nativeIdentity: "fixture_user", validated: true }),
    { expectedNativeIdentity: "fixture_user" }, (value) => { value.data.nativeIdentity = 42; }],
  ["fixture.diagnostics", success(null, {
    databaseEnvironmentVisible: false,
    fixtureWorker: true,
    workerProcessId: 123,
    runtime: {
      permissionModel: true,
      networkGranted: false,
      filesystemWriteGranted: false,
      childProcessGranted: false,
      workerThreadGranted: false,
      nativeAddonGranted: false,
      forbiddenEnvironmentVisible: false,
      osSandbox: "node_permission_model"
    }
  }), {}, (value) => { value.data.runtime.networkGranted = true; }],
  ["profile.get", success(profileNative, { username: "fixture_user", karma: { post: 42, comment: 84 } }),
    {}, (value) => { value.data.karma = { post: null, comment: "84" }; }],
  ["subreddit.get", success(subredditNative, { name: "test", subscribers: 1_234 }),
    { input: { name: "test" } }, (value) => { value.data.subscribers = null; }],
  ["listing.list", success(null, { items: [post], page: { after: "t3_fixture", before: null } }),
    {}, (value) => { value.data.items = "not-an-array"; }],
  ["post.get", success(postNative, post), { input: { nativeId: "t3_fixture" } },
    (value) => { value.data.title = null; }],
  ["comments.list", success(postNative, { items: [comment], page: { after: null, before: null } }),
    { input: { postNativeId: "t3_fixture" } }, (value) => { value.data.items[0].author = null; }],
  ["search.query", success(null, { query: "fixture", items: [post], page: { after: null, before: null } }),
    { input: { query: "fixture" } }, (value) => { value.data.query = null; }],
  ["post.createText", success(postNative, { created: true, kind: "text_post" }),
    writeContext({ subreddit: "test" }, postNative), (value) => { value.data.created = false; }],
  ["post.createLink", success(postNative, { created: true, kind: "link_post" }),
    writeContext({ subreddit: "test" }, postNative), (value) => { value.data.kind = "text_post"; }],
  ["post.createMedia", success(postNative, { created: true, kind: "media_post", media: { state: "uploaded" } }),
    writeContext({ subreddit: "test" }, postNative), (value) => { value.data.media.state = "pending"; }],
  ["comment.create", success(commentNative, { created: true, kind: "comment" }),
    writeContext({ postNativeId: "t3_fixture" }, commentNative), (value) => { value.data.kind = "reply"; }],
  ["reply.create", success(commentNative, { created: true, kind: "reply" }),
    writeContext({ commentNativeId: "t1_parent" }, commentNative), (value) => { value.data.created = 1; }],
  ["item.editOwn", success(commentNative, { edited: true }),
    writeContext({ nativeId: "t1_fixture", body: "Edited" }, commentNative), (value) => { value.data.edited = false; }],
  ["vote.set", success(postNative, { applied: true, direction: 1 }),
    writeContext({ nativeId: "t3_fixture", direction: 1 }, postNative), (value) => { value.data.direction = 2; }],
  ["save.set", success(postNative, { saved: true }),
    writeContext({ nativeId: "t3_fixture" }, postNative), (value) => { value.data.saved = false; }],
  ["save.unset", success(postNative, { saved: false }),
    writeContext({ nativeId: "t3_fixture" }, postNative), (value) => { value.data.saved = true; }],
  ["subreddit.subscribe", success(subredditNative, { subscribed: true }),
    writeContext({ subreddit: "test" }, subredditNative), (value) => { value.data.subscribed = false; }],
  ["subreddit.unsubscribe", success(subredditNative, { subscribed: false }),
    writeContext({ subreddit: "test" }, subredditNative), (value) => { value.data.subscribed = true; }],
  ["item.deleteOwn", success(postNative, { deleted: true }),
    writeContext({ nativeId: "t3_fixture" }, postNative), (value) => { value.data.deleted = null; }],
  ["action.recover", success(postNative, { recovered: true }),
    { recoveryAction: { native: postNative } }, (value) => { value.data.recovered = false; }]
];

test("every operation-specific success schema accepts its exact typed result", () => {
  for (const [operation, result, context] of cases) {
    assert.doesNotThrow(() => validateRedditWorkerOutcome(operation, clone(result), context), operation);
  }
});

test("every operation-specific success schema rejects exact fields with invalid values", () => {
  for (const [operation, result, context, mutate] of cases) {
    const hostile = clone(result);
    mutate(hostile);
    assert.throws(
      () => validateRedditWorkerOutcome(operation, hostile, context),
      /Invalid Reddit worker result/u,
      operation
    );
  }
});

test("result schemas reject nullability, bounds, forged targets, URLs, failures, and recovery timestamps", () => {
  assert.throws(() => validateRedditWorkerOutcome("profile.get", success(null, {
    username: "fixture_user", karma: { post: 1, comment: 2 }
  })), /Invalid Reddit worker result/u);
  assert.throws(() => validateRedditWorkerOutcome("post.get", success(
    { ...postNative, canonicalUrl: "https://www.reddit.com.evil/r/test/comments/fixture/post/" }, post
  ), { input: { nativeId: "t3_fixture" } }), /Invalid Reddit worker result/u);
  assert.throws(() => validateRedditWorkerOutcome("post.get", success(
    { nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/" },
    { nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/", title: "Other", author: "fixture_user" }
  ), { input: { nativeId: "t3_fixture" } }), /Invalid Reddit worker result/u);
  assert.throws(() => validateRedditWorkerOutcome("listing.list", success(null, {
    items: Array.from({ length: 101 }, () => post), page: { after: null, before: null }
  })), /Invalid Reddit worker result/u);
  assert.throws(() => validateRedditWorkerOutcome("profile.get", {
    status: "FAILED",
    error: { code: "WORKER_CHOSE_THIS", message: "No", retryable: false, actionRequired: true }
  }), /Invalid Reddit worker result/u);
  assert.throws(() => validateRedditWorkerOutcome("action.recover", {
    status: "UNKNOWN", recoveryCheckedAt: "January 1, 2026"
  }), /Invalid Reddit worker result/u);
});

test("every write operation validates its submission reference before storage", () => {
  const submissionCases = [
    ["post.createText", postNative, { input: { subreddit: "test" } }, commentNative],
    ["post.createLink", postNative, { input: { subreddit: "test" } }, commentNative],
    ["post.createMedia", postNative, { input: { subreddit: "test" } }, commentNative],
    ["comment.create", commentNative, { input: { postNativeId: "t3_fixture" } }, postNative],
    ["reply.create", commentNative, { input: { commentNativeId: "t1_parent" } }, postNative],
    ["item.editOwn", commentNative, { input: { nativeId: "t1_fixture" } }, {
      nativeId: "t1_other", canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/other/"
    }],
    ["vote.set", postNative, { input: { nativeId: "t3_fixture" } }, {
      nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
    }],
    ["save.set", postNative, { input: { nativeId: "t3_fixture" } }, {
      nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
    }],
    ["save.unset", postNative, { input: { nativeId: "t3_fixture" } }, {
      nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
    }],
    ["subreddit.subscribe", subredditNative, { input: { subreddit: "test" } }, {
      nativeId: "t5_other", canonicalUrl: "https://www.reddit.com/r/other/"
    }],
    ["subreddit.unsubscribe", subredditNative, { input: { subreddit: "test" } }, {
      nativeId: "t5_other", canonicalUrl: "https://www.reddit.com/r/other/"
    }],
    ["item.deleteOwn", postNative, { input: { nativeId: "t3_fixture" } }, {
      nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
    }]
  ];

  for (const [operation, native, context, invalidNative] of submissionCases) {
    assert.doesNotThrow(
      () => validateRedditSubmissionEvent(operation, submission(native), context),
      operation
    );
    assert.throws(
      () => validateRedditSubmissionEvent(operation, submission(invalidNative), context),
      /Invalid Reddit worker result/u,
      operation
    );
  }
});

test("URL-carried targets and submission-to-terminal identities are request bound", () => {
  const otherSubredditPost = {
    nativeId: "t3_fixture",
    canonicalUrl: "https://www.reddit.com/r/other/comments/fixture/post/"
  };
  const otherPostComment = {
    nativeId: "t1_fixture",
    canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/fixture/"
  };
  const otherTerminal = {
    nativeId: "t3_other",
    canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
  };

  assert.throws(() => validateRedditWorkerOutcome("listing.list", success(null, {
    items: [{ ...otherSubredditPost, title: "Other", author: "fixture_user" }],
    page: { after: null, before: null }
  }), { input: { subreddit: "test" } }), /listing subreddit target/u);
  assert.throws(() => validateRedditWorkerOutcome("search.query", success(null, {
    query: "fixture",
    items: [{ ...otherSubredditPost, title: "Other", author: "fixture_user" }],
    page: { after: null, before: null }
  }), { input: { query: "fixture", subreddit: "test" } }), /search subreddit target/u);
  assert.throws(() => validateRedditSubmissionEvent(
    "post.createText",
    submission(otherSubredditPost),
    { input: { subreddit: "test" } }
  ), /created post target/u);
  assert.throws(() => validateRedditSubmissionEvent(
    "comment.create",
    submission(otherPostComment),
    { input: { postNativeId: "t3_fixture" } }
  ), /created comment target/u);
  assert.throws(() => validateRedditWorkerOutcome(
    "post.createText",
    success(otherTerminal, { created: true, kind: "text_post" }),
    writeContext({ subreddit: "test" }, postNative)
  ), /terminal result and submission marker/u);
  assert.throws(() => validateRedditWorkerOutcome(
    "post.createText",
    success(postNative, { created: true, kind: "text_post" }),
    { input: { subreddit: "test" } }
  ), /Invalid Reddit worker result/u);
});

function success(native, data) {
  return { status: "SUCCEEDED", native, data, rateLimit };
}

function submission(native) {
  return { type: "SUBMISSION_STARTED", native, submittedAt: "2026-01-01T00:00:01.000Z" };
}

function writeContext(input, native) {
  return { input, submission: submission(native) };
}

function clone(value) {
  return structuredClone(value);
}
