import assert from "node:assert/strict";
import test from "node:test";
import {
  AdapterContractError,
  CORE_ERROR_CODES,
  MAX_IPC_MESSAGE_BYTES,
  REDDIT_CAPABILITIES,
  RedditFixtureAdapter,
  assertBoundedIPCMessage,
  assertIPCEnvelope,
  capabilityFor
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
    assert.ok(Object.isFrozen(capability));
  }
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

test("maps authentication, identity, checkpoint, rate limit, revocation, and protocol drift failures", async (t) => {
  const cases = [
    ["auth_failure", CORE_ERROR_CODES.AUTHENTICATION_FAILED],
    ["checkpoint", CORE_ERROR_CODES.CHECKPOINT_REQUIRED],
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
