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
    {}, (value) => { value.data.created = false; }],
  ["post.createLink", success(postNative, { created: true, kind: "link_post" }),
    {}, (value) => { value.data.kind = "text_post"; }],
  ["post.createMedia", success(postNative, { created: true, kind: "media_post", media: { state: "uploaded" } }),
    {}, (value) => { value.data.media.state = "pending"; }],
  ["comment.create", success(commentNative, { created: true, kind: "comment" }),
    {}, (value) => { value.data.kind = "reply"; }],
  ["reply.create", success(commentNative, { created: true, kind: "reply" }),
    {}, (value) => { value.data.created = 1; }],
  ["vote.set", success(postNative, { applied: true, direction: 1 }),
    { input: { nativeId: "t3_fixture", direction: 1 } }, (value) => { value.data.direction = 2; }],
  ["save.set", success(postNative, { saved: true }),
    { input: { nativeId: "t3_fixture" } }, (value) => { value.data.saved = false; }],
  ["save.unset", success(postNative, { saved: false }),
    { input: { nativeId: "t3_fixture" } }, (value) => { value.data.saved = true; }],
  ["item.deleteOwn", success(postNative, { deleted: true }),
    { input: { nativeId: "t3_fixture" } }, (value) => { value.data.deleted = null; }],
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
    ["post.createText", postNative, {}, commentNative],
    ["post.createLink", postNative, {}, commentNative],
    ["post.createMedia", postNative, {}, commentNative],
    ["comment.create", commentNative, {}, postNative],
    ["reply.create", commentNative, {}, postNative],
    ["vote.set", postNative, { input: { nativeId: "t3_fixture" } }, {
      nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
    }],
    ["save.set", postNative, { input: { nativeId: "t3_fixture" } }, {
      nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
    }],
    ["save.unset", postNative, { input: { nativeId: "t3_fixture" } }, {
      nativeId: "t3_other", canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/"
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

function success(native, data) {
  return { status: "SUCCEEDED", native, data, rateLimit };
}

function submission(native) {
  return { type: "SUBMISSION_STARTED", native, submittedAt: "2026-01-01T00:00:01.000Z" };
}

function clone(value) {
  return structuredClone(value);
}
