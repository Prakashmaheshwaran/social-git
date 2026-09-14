import assert from "node:assert/strict";
import test from "node:test";
import {
  AdapterContractError,
  CORE_ERROR_CODES,
  MAX_IPC_MESSAGE_BYTES,
  PROTOCOL_MAPPING_STATUS,
  REDDIT_CAPABILITIES,
  REDDIT_PROTOCOL_ROUTES,
  REDDIT_PROTOCOL_SOURCE,
  RedditFixtureAdapter,
  assertBoundedIPCMessage,
  assertIPCEnvelope,
  buildRedditProtocolRequest,
  capabilityFor,
  normalizeRedditListing,
  normalizeRedditOperationResponse,
  normalizeRedditPostThread,
  normalizeRedditProfile,
  normalizeRedditSubreddit,
  normalizeRedditWriteResponse
} from "../src/index.mjs";

const expectedOperations = [
  "profile.get",
  "subreddit.get",
  "listing.list",
  "post.get",
  "comments.list",
  "search.query",
  "post.createText",
  "post.createLink",
  "post.createMedia",
  "comment.create",
  "reply.create",
  "vote.set",
  "save.set",
  "save.unset",
  "item.deleteOwn"
];

test("declares the complete Reddit MVP capability surface", () => {
  assert.deepEqual(REDDIT_CAPABILITIES.map(({ operation }) => operation), expectedOperations);
  assert.equal(REDDIT_CAPABILITIES.filter(({ mode }) => mode === "read").length, 6);
  assert.equal(REDDIT_CAPABILITIES.filter(({ mode }) => mode === "write").length, 9);
  for (const capability of REDDIT_CAPABILITIES) {
    assert.match(capability.authorizationScope, /^reddit\.(read|write)\./);
    assert.equal(capability.fixtureEnabled, true);
    assert.equal(capability.productionEnabled, false);
    assert.ok(Object.isFrozen(capability));
  }
  assert.equal(
    REDDIT_CAPABILITIES.filter(({ protocolMapping }) => protocolMapping === PROTOCOL_MAPPING_STATUS.MAPPED).length,
    14
  );
  assert.deepEqual(capabilityFor("post.createMedia"), {
    operation: "post.createMedia",
    mode: "write",
    authorizationScope: "reddit.write.post.media",
    fixtureEnabled: true,
    protocolMapping: "UNSUPPORTED",
    productionEnabled: false,
    disabledReason: "MEDIA_FLOW_NOT_ADMITTED"
  });
});

test("pins the admitted source corpus and exposes only immutable transport-neutral mappings", () => {
  assert.deepEqual(REDDIT_PROTOCOL_SOURCE, {
    project: "reddit-lyr",
    manifestVersion: "0.1.1",
    revision: "87ec32aff905923ecd156e7951c168adfdf6fac1",
    license: "MIT",
    repository: "https://github.com/ishan-parihar/reddit-lyr",
    files: [
      {
        path: "reddit_mcp_server/scraping/api_client.py",
        gitBlob: "1a18f05cb12c80094826365557f06dda7953a499",
        sha256: "f1c4a33c06e5357b790801d81b849d98e108ca081cecd4ac03563b7ab727185f"
      },
      {
        path: "reddit_mcp_server/normalizer.py",
        gitBlob: "c6be236df1b349d9d38a42f3f90e1b7815a0bfae",
        sha256: "f552d8853827a1538b9d354c96351b302125200680f2af33b8a0653169151f54"
      }
    ]
  });
  assert.equal(Object.keys(REDDIT_PROTOCOL_ROUTES).length, 14);
  assert.equal(REDDIT_PROTOCOL_ROUTES["post.createText"].submission, "SINGLE_ATTEMPT");
  assert.equal(REDDIT_PROTOCOL_ROUTES["profile.get"].submission, "READ_ONLY");
  assert.equal(Object.isFrozen(REDDIT_PROTOCOL_SOURCE.files), true);
  assert.equal(Object.isFrozen(REDDIT_PROTOCOL_ROUTES["post.createText"]), true);
  assert.equal("post.createMedia" in REDDIT_PROTOCOL_ROUTES, false);
});

test("builds the admitted read endpoint mappings without session material", () => {
  assert.deepEqual(buildRedditProtocolRequest("profile.get", {}), {
    operation: "profile.get",
    method: "GET",
    path: "/api/me.json",
    query: {},
    body: null,
    normalizer: "profile",
    submission: "READ_ONLY",
    requiresWorkerModhash: false
  });
  assert.deepEqual(buildRedditProtocolRequest("subreddit.get", { name: "test" }), {
    operation: "subreddit.get",
    method: "GET",
    path: "/r/test/about.json",
    query: { raw_json: 1 },
    body: null,
    normalizer: "subreddit",
    submission: "READ_ONLY",
    requiresWorkerModhash: false
  });
  assert.deepEqual(buildRedditProtocolRequest("listing.list", {
    subreddit: "test",
    kind: "new",
    limit: 10,
    after: "t3_next"
  }), {
    operation: "listing.list",
    method: "GET",
    path: "/r/test/new.json",
    query: { limit: 10, raw_json: 1, t: "day", after: "t3_next" },
    body: null,
    normalizer: "listing",
    submission: "READ_ONLY",
    requiresWorkerModhash: false
  });
  assert.equal(buildRedditProtocolRequest("post.get", { nativeId: "t3_abcd" }).path, "/comments/abcd.json");
  assert.equal(buildRedditProtocolRequest("comments.list", { postNativeId: "t3_abcd" }).path, "/comments/abcd.json");
  assert.deepEqual(buildRedditProtocolRequest("search.query", { query: "fixture", subreddit: "test" }).query, {
    q: "fixture",
    sort: "relevance",
    t: "all",
    limit: 25,
    raw_json: 1,
    type: "link",
    restrict_sr: "on"
  });
});

test("builds every admitted write as one attempt and rejects media", () => {
  const writes = [
    ["post.createText", { subreddit: "test", title: "Title", body: "Body" }, "/api/submit"],
    ["post.createLink", { subreddit: "test", title: "Title", url: "https://example.test" }, "/api/submit"],
    ["comment.create", { postNativeId: "t3_abcd", body: "Comment" }, "/api/comment"],
    ["reply.create", { commentNativeId: "t1_abcd", body: "Reply" }, "/api/comment"],
    ["vote.set", { nativeId: "t3_abcd", direction: -1 }, "/api/vote"],
    ["save.set", { nativeId: "t3_abcd" }, "/api/save"],
    ["save.unset", { nativeId: "t3_abcd" }, "/api/unsave"],
    ["item.deleteOwn", { nativeId: "t3_abcd" }, "/api/del"]
  ];

  for (const [operation, input, path] of writes) {
    const request = buildRedditProtocolRequest(operation, input);
    assert.equal(request.method, "POST");
    assert.equal(request.path, path);
    assert.equal(request.submission, "SINGLE_ATTEMPT");
    assert.equal(request.requiresWorkerModhash, true);
    assert.equal("uh" in request.body, false);
    assert.equal(JSON.stringify(request).includes("session"), false);
    assert.equal(Object.isFrozen(request.body), true);
  }
  assert.deepEqual(buildRedditProtocolRequest("post.createText", {
    subreddit: "test",
    title: "Title",
    body: "Body",
    spoiler: true
  }).body, {
    api_type: "json",
    sr: "test",
    kind: "self",
    title: "Title",
    text: "Body",
    nsfw: false,
    spoiler: true
  });
  assert.throws(
    () => buildRedditProtocolRequest("post.createMedia", {
      subreddit: "test",
      title: "Media",
      mediaRef: "core-media-1"
    }),
    (error) => error.code === CORE_ERROR_CODES.CAPABILITY_DISABLED
  );
});

test("normalizes admitted Reddit read shapes into native identifiers and canonical URLs", () => {
  const profile = normalizeRedditProfile({
    data: { id: "abc", name: "fixture_user", link_karma: 12, comment_karma: 34 }
  });
  assert.deepEqual(profile, {
    nativeId: "t2_abc",
    canonicalUrl: "https://www.reddit.com/user/fixture_user/",
    username: "fixture_user",
    link_karma: 12,
    comment_karma: 34
  });

  const subreddit = normalizeRedditSubreddit({
    data: { id: "2qh1i", name: "t5_2qh1i", display_name: "test", subscribers: 1234 }
  });
  assert.deepEqual(subreddit, {
    nativeId: "t5_2qh1i",
    canonicalUrl: "https://www.reddit.com/r/test/",
    name: "test",
    subscribers: 1234
  });

  const listing = normalizeRedditListing(redditListingFixture());
  assert.equal(listing.items[0].nativeId, "t3_abcd");
  assert.equal(listing.items[0].canonicalUrl, "https://www.reddit.com/r/test/comments/abcd/fixture_post/");
  assert.deepEqual(listing.page, { after: "t3_next", before: null });
  assert.throws(() => {
    listing.items[0].title = "changed";
  }, TypeError);
});

test("normalizes post threads and rejects native response drift", () => {
  const thread = normalizeRedditPostThread([
    redditListingFixture(null),
    {
      data: {
        children: [
          {
            kind: "t1",
            data: {
              id: "comment",
              name: "t1_comment",
              author: "fixture_user",
              body: "Fixture comment",
              permalink: "/r/test/comments/abcd/fixture_post/comment/"
            }
          },
          { kind: "more", data: { id: "ignored" } }
        ],
        after: null,
        before: null
      }
    }
  ]);
  assert.equal(thread.post.nativeId, "t3_abcd");
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0].nativeId, "t1_comment");

  const mapped = normalizeRedditOperationResponse("comments.list", [
    redditListingFixture(null),
    { data: { children: [], after: null, before: null } }
  ]);
  assert.equal(mapped.native.nativeId, "t3_abcd");
  assert.deepEqual(mapped.data.items, []);

  assert.throws(
    () => normalizeRedditListing({ data: { children: [{ kind: "t3", data: { id: "abcd" } }] } }),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT
  );
  assert.throws(
    () => normalizeRedditListing({
      data: {
        children: [{
          kind: "t3",
          data: { id: "abcd", name: "t3_abcd", permalink: "https://evil.test/post" }
        }]
      }
    }),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT
  );
});

test("requires verified native results for writes and maps caller-owned deletion", () => {
  const post = normalizeRedditWriteResponse("post.createText", {
    json: {
      errors: [],
      data: {
        name: "t3_created",
        url: "https://www.reddit.com/r/test/comments/created/fixture_post/"
      }
    }
  });
  assert.equal(post.native.nativeId, "t3_created");
  assert.equal(post.data.created, true);

  const comment = normalizeRedditWriteResponse("comment.create", {
    json: {
      errors: [],
      data: {
        things: [{
          kind: "t1",
          data: {
            name: "t1_created",
            permalink: "/r/test/comments/abcd/fixture_post/created/"
          }
        }]
      }
    }
  });
  assert.equal(comment.native.nativeId, "t1_created");

  const deleted = normalizeRedditWriteResponse("item.deleteOwn", {}, {
    existingNative: {
      nativeId: "t3_owned",
      canonicalUrl: "https://www.reddit.com/r/test/comments/owned/fixture_post/"
    }
  });
  assert.deepEqual(deleted.data, { deleted: true });
  assert.equal(deleted.native.nativeId, "t3_owned");

  assert.throws(
    () => normalizeRedditWriteResponse("post.createLink", { json: { errors: [], data: {} } }),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT
  );
  assert.throws(
    () => normalizeRedditWriteResponse("comment.create", {}),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT
  );
  assert.throws(
    () => normalizeRedditWriteResponse("vote.set", {}),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT
  );
  assert.throws(
    () => normalizeRedditWriteResponse("post.createMedia", {}),
    (error) => error.code === CORE_ERROR_CODES.CAPABILITY_DISABLED
  );
});

test("imports only a short-lived core worker session without returning or persisting its plaintext", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  const context = makeContext();
  context.session.sessionMaterial = { cookie: "fixture-cookie-sentinel", csrf: "fixture-csrf-sentinel" };

  const result = await adapter.importSession(context);

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.data.validated, true);
  assert.equal(result.native.nativeId, "t2_fixtureuser");
  assert.equal(JSON.stringify(result).includes("fixture-cookie-sentinel"), false);
  assert.equal(JSON.stringify(result).includes("fixture-csrf-sentinel"), false);

  const isolation = await adapter.inspectFixtureIsolation();
  assert.equal(isolation.status, "SUCCEEDED");
  assert.equal(isolation.data.databaseEnvironmentVisible, false);
  assert.equal(isolation.data.fixtureWorker, true);
  assert.notEqual(isolation.data.workerProcessId, process.pid);
});

test("rejects non-core, expired, overlong, and wrongly bound session payloads", async () => {
  const cases = [
    {
      mutate: (context) => {
        context.session.kind = "encrypted_session_envelope";
      },
      code: CORE_ERROR_CODES.INVALID_REQUEST
    },
    {
      mutate: (context) => {
        context.session.expiresAt = new Date(Date.now() - 1).toISOString();
      },
      code: CORE_ERROR_CODES.SESSION_REVOKED
    },
    {
      mutate: (context) => {
        context.session.issuedAt = new Date(Date.now() - 90_000).toISOString();
      },
      code: CORE_ERROR_CODES.INVALID_REQUEST
    },
    {
      mutate: (context) => {
        context.session.accountId = "account-other";
      },
      code: CORE_ERROR_CODES.WRONG_IDENTITY
    }
  ];

  for (const fixture of cases) {
    const adapter = new RedditFixtureAdapter();
    const context = makeContext();
    fixture.mutate(context);
    await assert.rejects(
      adapter.importSession(context),
      (error) => error instanceof AdapterContractError && error.code === fixture.code
    );
    await adapter.close();
  }
});

test("maps every read to core-native identifiers, canonical URLs, pagination, and rate limits", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  const context = makeContext();
  const reads = [
    ["profile.get", {}],
    ["subreddit.get", { name: "test" }],
    ["listing.list", { subreddit: "test" }],
    ["post.get", { nativeId: "t3_fixture" }],
    ["comments.list", { postNativeId: "t3_fixture" }],
    ["search.query", { query: "fixture" }]
  ];

  for (const [operation, input] of reads) {
    const result = await adapter.execute(operation, input, context);
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.operation, operation);
    assert.equal(result.accountId, context.accountId);
    assert.deepEqual(result.rateLimit, {
      limit: 60,
      remaining: 59,
      resetAt: "2026-01-01T00:01:00.000Z"
    });
    if (result.native) {
      assert.match(result.native.canonicalUrl, /^https:\/\/www\.reddit\.com\//);
    } else {
      assert.ok(result.data.items.every((item) => item.nativeId && item.canonicalUrl));
    }
  }
});

test("executes every write shape with normalized native results", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  const writes = [
    ["post.createText", { subreddit: "test", title: "Title", body: "Body" }],
    ["post.createLink", { subreddit: "test", title: "Link", url: "https://example.test" }],
    ["post.createMedia", { subreddit: "test", title: "Media", mediaRef: "core-media-1" }],
    ["comment.create", { postNativeId: "t3_fixture", body: "Comment" }],
    ["reply.create", { commentNativeId: "t1_fixture", body: "Reply" }],
    ["vote.set", { nativeId: "t3_owned", direction: 1 }],
    ["save.set", { nativeId: "t3_owned" }],
    ["save.unset", { nativeId: "t3_owned" }],
    ["item.deleteOwn", { nativeId: "t3_owned" }]
  ];

  for (const [operation, input] of writes) {
    const result = await adapter.execute(operation, input, makeWriteContext(operation, `key-${operation}`));
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.operation, operation);
    assert.ok(result.native.nativeId);
    assert.match(result.native.canonicalUrl, /^https:\/\/www\.reddit\.com\//);
  }

  assert.equal(adapter.diagnostics().submissionAttempts, writes.length);
});

test("requires authorization that exactly matches caller, account, operation, and scope", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  const operation = "post.createText";
  const input = { subreddit: "test", title: "Title", body: "Body" };
  const missing = makeContext();
  missing.idempotency = { callerId: "caller-1", key: "missing-authorization" };

  await assert.rejects(
    adapter.execute(operation, input, missing),
    (error) => error.code === CORE_ERROR_CODES.AUTHORIZATION_DENIED
  );

  const missingIdempotency = makeWriteContext(operation, "missing-idempotency");
  delete missingIdempotency.idempotency;
  await assert.rejects(
    adapter.execute(operation, input, missingIdempotency),
    (error) => error.code === CORE_ERROR_CODES.IDEMPOTENCY_REQUIRED
  );

  for (const mutate of [
    (context) => (context.authorization.accountId = "account-other"),
    (context) => (context.authorization.callerId = "caller-other"),
    (context) => (context.authorization.operation = "post.createLink"),
    (context) => (context.authorization.scope = "reddit.write.post.link")
  ]) {
    const context = makeWriteContext(operation, "auth-key");
    mutate(context);
    await assert.rejects(
      adapter.execute(operation, input, context),
      (error) => error.code === CORE_ERROR_CODES.AUTHORIZATION_DENIED
    );
  }
  assert.equal(adapter.diagnostics().submissionAttempts, 0);
});

test("enforces caller-scoped idempotency and rejects key reuse with different input", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  const operation = "comment.create";
  const input = { postNativeId: "t3_fixture", body: "Once" };
  const context = makeWriteContext(operation, "same-key");

  const [first, concurrentDuplicate] = await Promise.all([
    adapter.execute(operation, input, context),
    adapter.execute(operation, input, context)
  ]);
  const laterDuplicate = await adapter.execute(operation, input, context);

  assert.deepEqual(concurrentDuplicate, first);
  assert.deepEqual(laterDuplicate, first);
  assert.throws(() => {
    first.data.created = false;
  }, TypeError);
  assert.equal(adapter.diagnostics().submissionAttempts, 1);

  await assert.rejects(
    adapter.execute(operation, { ...input, body: "Different" }, context),
    (error) => error.code === CORE_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );

  const otherCaller = makeWriteContext(operation, "same-key", "caller-2");
  const otherResult = await adapter.execute(operation, input, otherCaller);
  assert.equal(otherResult.status, "SUCCEEDED");
  assert.equal(adapter.diagnostics().submissionAttempts, 2);
});

test("maps authentication, identity, challenge, checkpoint, CAPTCHA, rate limit, revocation, and protocol drift failures", async (t) => {
  const cases = [
    ["auth_failure", CORE_ERROR_CODES.AUTHENTICATION_FAILED],
    ["challenge", CORE_ERROR_CODES.CHALLENGE_REQUIRED],
    ["checkpoint", CORE_ERROR_CODES.CHECKPOINT_REQUIRED],
    ["captcha", CORE_ERROR_CODES.CAPTCHA_REQUIRED],
    ["rate_limit", CORE_ERROR_CODES.RATE_LIMITED],
    ["revoked", CORE_ERROR_CODES.SESSION_REVOKED],
    ["protocol_drift", CORE_ERROR_CODES.PROTOCOL_DRIFT]
  ];

  for (const [outcome, code] of cases) {
    await t.test(outcome, async () => {
      const adapter = new RedditFixtureAdapter({ scenario: { outcome } });
      const result = await adapter.execute("profile.get", {}, makeContext());
      assert.equal(result.status, "FAILED");
      assert.equal(result.error.code, code);
      assert.equal(result.operation, "profile.get");
      assert.equal(result.accountId, "account-1");
      if (outcome === "rate_limit") {
        assert.equal(result.error.retryable, true);
        assert.equal(result.rateLimit.retryAfterMs, 60_000);
      }
      await adapter.close();
    });
  }

  await t.test("wrong_identity", async () => {
    const adapter = new RedditFixtureAdapter({ scenario: { nativeIdentity: "intruder" } });
    const result = await adapter.importSession(makeContext());
    assert.equal(result.status, "FAILED");
    assert.equal(result.error.code, CORE_ERROR_CODES.WRONG_IDENTITY);
    await adapter.close();
  });
});

test("refuses deletion when the platform fixture does not prove caller ownership", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  const result = await adapter.execute(
    "item.deleteOwn",
    { nativeId: "t3_unowned" },
    makeWriteContext("item.deleteOwn", "delete-key")
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, CORE_ERROR_CODES.NOT_CALLER_OWNED);
  assert.equal(result.error.retryable, false);
  assert.equal(adapter.diagnostics().submissionAttempts, 0);
});

test("returns a retryable failure before submit and permits a caller-controlled retry", async (t) => {
  const adapter = new RedditFixtureAdapter({ scenario: { outcome: "crash_before_submit_once" } });
  t.after(() => adapter.close());
  const operation = "post.createText";
  const input = { subreddit: "test", title: "Retryable", body: "Body" };
  const context = makeWriteContext(operation, "pre-submit-key");

  const failed = await adapter.execute(operation, input, context);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.error.code, CORE_ERROR_CODES.WORKER_UNAVAILABLE);
  assert.equal(failed.error.retryable, true);
  assert.equal(adapter.diagnostics().submissionAttempts, 0);

  const retried = await adapter.execute(operation, input, context);
  assert.equal(retried.status, "SUCCEEDED");
  assert.equal(adapter.diagnostics().submissionAttempts, 1);
});

test("returns UNKNOWN after crash-after-submit, never retries, and recovers only by an explicit read", async (t) => {
  const adapter = new RedditFixtureAdapter({
    scenario: { outcome: "crash_after_submit", recoveryOutcome: "SUCCEEDED" }
  });
  t.after(() => adapter.close());
  const operation = "post.createText";
  const input = { subreddit: "test", title: "Uncertain", body: "Body" };
  const context = makeWriteContext(operation, "unknown-key");

  const unknown = await adapter.execute(operation, input, context);
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.action.state, "UNKNOWN");
  assert.equal(unknown.action.retryPermitted, false);
  assert.equal(adapter.diagnostics().submissionAttempts, 1);

  const duplicate = await adapter.execute(operation, input, context);
  assert.deepEqual(duplicate, unknown);
  assert.equal(adapter.diagnostics().submissionAttempts, 1);

  const recovered = await adapter.recoverUnknown(unknown, context);
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.data.recovered, true);
  assert.equal(adapter.diagnostics().submissionAttempts, 1);
  assert.equal(adapter.diagnostics().recoveryChecks, 1);

  const afterRecovery = await adapter.execute(operation, input, context);
  assert.deepEqual(afterRecovery, recovered);
  assert.equal(adapter.diagnostics().submissionAttempts, 1);
});

test("rejects oversized IPC before sending session material", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  const context = makeContext();
  context.session.sessionMaterial = { cookie: "x".repeat(MAX_IPC_MESSAGE_BYTES) };

  await assert.rejects(
    adapter.execute("profile.get", {}, context),
    (error) => error instanceof AdapterContractError && error.code === CORE_ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => assertBoundedIPCMessage({ data: "x".repeat(MAX_IPC_MESSAGE_BYTES) }),
    (error) => error.code === CORE_ERROR_CODES.INVALID_REQUEST
  );
  assert.equal(adapter.diagnostics().workerRunning, false);
});

test("rejects malformed operation input and drifted IPC versions", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());

  await assert.rejects(
    adapter.execute("post.get", { nativeId: "short-id" }, makeContext()),
    (error) => error.code === CORE_ERROR_CODES.INVALID_REQUEST
  );
  await assert.rejects(
    adapter.execute("profile.get", { rawLibraryObject: true }, makeContext()),
    (error) => error.code === CORE_ERROR_CODES.INVALID_REQUEST
  );
  await assert.rejects(
    adapter.execute(
      "vote.set",
      { nativeId: "t3_owned", direction: 2 },
      makeWriteContext("vote.set", "invalid-vote")
    ),
    (error) => error.code === CORE_ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => assertIPCEnvelope({ version: 2, kind: "response" }, "response"),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT
  );
  assert.equal(adapter.diagnostics().workerRunning, false);
});

test("rejects unsupported operations before worker submission", async (t) => {
  const adapter = new RedditFixtureAdapter();
  t.after(() => adapter.close());
  await assert.rejects(
    adapter.execute("moderator.ban", {}, makeContext()),
    (error) => error.code === CORE_ERROR_CODES.UNKNOWN_OPERATION
  );
  assert.equal(adapter.diagnostics().submissionAttempts, 0);
});

function redditListingFixture(after = "t3_next") {
  return {
    data: {
      children: [
        {
          kind: "t3",
          data: {
            id: "abcd",
            name: "t3_abcd",
            title: "Fixture post",
            author: "fixture_user",
            subreddit: "test",
            permalink: "/r/test/comments/abcd/fixture_post/"
          }
        }
      ],
      after,
      before: null
    }
  };
}

function makeContext() {
  const now = Date.now();
  return {
    accountId: "account-1",
    expectedNativeIdentity: "fixture_user",
    session: {
      kind: "core_decrypted_worker_session",
      version: 1,
      accountId: "account-1",
      expectedNativeIdentity: "fixture_user",
      generation: 1,
      issuedAt: new Date(now - 100).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
      sessionMaterial: { fixtureSession: true }
    }
  };
}

function makeWriteContext(operation, key, callerId = "caller-1") {
  const context = makeContext();
  const capability = capabilityFor(operation);
  context.idempotency = { callerId, key };
  context.authorization = {
    accountId: context.accountId,
    callerId,
    operation,
    scope: capability.authorizationScope,
    expiresAt: new Date(Date.now() + 30_000).toISOString()
  };
  return context;
}
