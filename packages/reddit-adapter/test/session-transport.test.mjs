import assert from "node:assert/strict";
import test from "node:test";
import { PlatformStopCircuit, createRedditRouteAuthority } from "../../worker-security/src/index.mjs";
import {
  CORE_ERROR_CODES,
  RedditSessionTransport,
  RedditTransportError,
  createRedditSessionConnector
} from "../src/index.mjs";

const BINDING = Object.freeze({ tenantId: "tenant-1", accountId: "account-1", routeId: "route-1", generation: 7 });

test("uses the admitted corpus through one sealed Core session and route binding", async () => {
  const fixture = transportFixture();
  const transport = fixture.transport;

  assert.deepEqual(transport.binding(), BINDING);
  assert.equal(Object.isFrozen(transport.binding()), true);
  const listing = await transport.execute("listing.list", { subreddit: "test", limit: 5 });
  assert.equal(listing.data.items[0].nativeId, "t3_abc");
  assert.equal(listing.data.items[0].canonicalUrl, "https://www.reddit.com/r/test/comments/abc/title/");
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0].path, "/api/me.json");
  assert.equal(fixture.calls[1].path, "/r/test/hot.json?limit=5&raw_json=1&t=day");
  for (const call of fixture.calls) {
    assert.equal(call.headers.cookie, "reddit_session=fixture-cookie");
    assert.equal(call.headers["x-modhash"], "fixture-modhash");
    assert.equal("proxy" in call, false);
    assert.equal("proxyUrl" in call, false);
    assert.equal(call.selectedAddress, "151.101.1.140");
  }
  assert.deepEqual(transport.diagnostics(), {
    binding: BINDING,
    identityValidated: true,
    revoked: false,
    requests: 2,
    writeAttempts: 0,
    idempotencyEntries: 0
  });
});

test("implements all admitted reads and single-attempt writes without leaking Core session data", async () => {
  const fixture = transportFixture();
  const transport = fixture.transport;
  const controls = (suffix) => ({ callerId: "caller-1", idempotencyKey: `key-${suffix}`, actionId: `action-${suffix}` });

  const reads = [
    ["profile.get", {}],
    ["subreddit.get", { name: "test" }],
    ["listing.list", { subreddit: "test" }],
    ["post.get", { nativeId: "t3_abc" }],
    ["comments.list", { postNativeId: "t3_abc" }],
    ["search.query", { query: "fixture" }]
  ];
  for (const [operation, input] of reads) {
    const result = await transport.execute(operation, input);
    assert.equal(result.native === null || typeof result.native.nativeId === "string", true, operation);
  }

  const writes = [
    ["post.createText", { subreddit: "test", title: "Text", body: "Body" }],
    ["post.createLink", { subreddit: "test", title: "Link", url: "https://example.test/" }],
    ["comment.create", { postNativeId: "t3_abc", body: "Comment" }],
    ["reply.create", { commentNativeId: "t1_comment", body: "Reply" }],
    ["vote.set", { nativeId: "t3_abc", direction: 1 }],
    ["save.set", { nativeId: "t3_abc" }],
    ["save.unset", { nativeId: "t3_abc" }],
    ["item.deleteOwn", { nativeId: "t3_abc" }]
  ];
  for (const [operation, input] of writes) {
    const result = await transport.execute(operation, input, controls(operation));
    assert.match(result.native.nativeId, /^t[13]_[a-z0-9]+$/u, operation);
  }

  const writeCalls = fixture.calls.filter((call) => call.method === "POST");
  assert.equal(writeCalls.length, writes.length);
  for (const call of writeCalls) {
    const form = new URLSearchParams(call.body);
    assert.equal(form.get("uh"), "fixture-modhash");
    assert.equal(call.body.includes("fixture-cookie"), false);
    assert.equal(JSON.stringify(call.response).includes("fixture-cookie"), false);
    assert.equal(JSON.stringify(call.response).includes("fixture-modhash"), false);
  }
});

test("leases and submits image media through separate bounded preflight and submission phases", async () => {
  const fixture = transportFixture();
  const lease = await fixture.transport.leaseMedia({
    filename: "fixture.png",
    mimeType: "image/png",
    sizeBytes: 8,
    sha256: "a".repeat(64)
  }, { actionId: "media-lease" });
  assert.equal(lease.uploadUrl, "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/");
  assert.equal(lease.mediaUrl, "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/fixture/object.png");
  assert.equal(lease.fields.find(({ name }) => name === "policy")?.value, "opaque-policy");

  const submitted = await fixture.transport.submitMedia({
    subreddit: "test",
    title: "Media",
    mediaUrl: lease.mediaUrl
  }, { actionId: "media-submit" });
  assert.equal(submitted.websocketUrl, "wss://wss.redditmedia.com/opaque-ticket");
  const mediaCalls = fixture.calls.filter((call) => call.method === "POST");
  assert.deepEqual(mediaCalls.map(({ path }) => path), ["/api/media/asset.json", "/api/submit"]);
  assert.equal(new URLSearchParams(mediaCalls[1].body).get("kind"), "image");
});

test("media preflight failures remain retryable but submit disconnects are unverified", async () => {
  const preflight = transportFixture({ responseMode: "media_lease_rate" });
  await assert.rejects(
    preflight.transport.leaseMedia({ filename: "fixture.png", mimeType: "image/png", sizeBytes: 8, sha256: "a".repeat(64) }),
    (error) => error.code === CORE_ERROR_CODES.RATE_LIMITED && error.submissionMayHaveStarted === false
  );

  const submit = transportFixture({ responseMode: "crash_media_submit" });
  const lease = await submit.transport.leaseMedia({ filename: "fixture.png", mimeType: "image/png", sizeBytes: 8, sha256: "a".repeat(64) });
  await assert.rejects(
    submit.transport.submitMedia({ subreddit: "test", title: "Media", mediaUrl: lease.mediaUrl }),
    (error) => error.code === CORE_ERROR_CODES.WORKER_UNAVAILABLE && error.submissionMayHaveStarted === true
  );
});

test("deletes a caller-owned comment only after an exact admitted ownership read", async () => {
  const fixture = transportFixture();
  const result = await fixture.transport.execute("item.deleteOwn", { nativeId: "t1_comment" }, {
    callerId: "caller-1", idempotencyKey: "delete-comment", actionId: "delete-comment-action"
  });

  assert.deepEqual(result.native, {
    nativeId: "t1_comment",
    canonicalUrl: "https://www.reddit.com/r/test/comments/abc/title/comment/"
  });
  assert.deepEqual(
    fixture.calls.slice(1).map(({ method, path }) => ({ method, path })),
    [
      { method: "GET", path: "/api/info.json?id=t1_comment&raw_json=1" },
      { method: "POST", path: "/api/del" }
    ]
  );
});

test("denies foreign and unverifiable comment ownership before submission", async () => {
  for (const responseMode of ["foreign_comment", "missing_comment", "malformed_comment"]) {
    const fixture = transportFixture({ responseMode });
    await assert.rejects(
      fixture.transport.execute("item.deleteOwn", { nativeId: "t1_comment" }, {
        callerId: "caller-1", idempotencyKey: `delete-${responseMode}`, actionId: `delete-${responseMode}`
      }),
      hasCode(CORE_ERROR_CODES.NOT_CALLER_OWNED),
      responseMode
    );
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 0, responseMode);
  }
});

test("ownership reads preserve revocation, rate, challenge, and drift stop states", async () => {
  for (const [responseMode, code] of [
    ["comment_auth_failure", CORE_ERROR_CODES.SESSION_REVOKED],
    ["comment_rate_limit", CORE_ERROR_CODES.RATE_LIMITED],
    ["comment_challenge", CORE_ERROR_CODES.CHALLENGE_REQUIRED],
    ["comment_protocol_drift", CORE_ERROR_CODES.PROTOCOL_DRIFT]
  ]) {
    const fixture = transportFixture({ responseMode, stopCircuit: new PlatformStopCircuit() });
    await assert.rejects(
      fixture.transport.execute("item.deleteOwn", { nativeId: "t1_comment" }, {
        callerId: "caller-1", idempotencyKey: `delete-${responseMode}`, actionId: `delete-${responseMode}`
      }),
      hasCode(code),
      responseMode
    );
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 0, responseMode);
    await assert.rejects(fixture.transport.execute("listing.list", {}), hasCode(CORE_ERROR_CODES.PROTOCOL_DRIFT));
  }
});

test("wrong identity and challenge states stop later dispatch across another route", async () => {
  const stopCircuit = new PlatformStopCircuit();
  const wrong = transportFixture({ stopCircuit, username: "mallory", accountId: "account-1", routeId: "route-1" });
  await assert.rejects(wrong.transport.verifyIdentity(), hasCode(CORE_ERROR_CODES.WRONG_IDENTITY));
  assert.equal(wrong.calls.length, 1);

  const rotated = transportFixture({ stopCircuit, accountId: "account-2", routeId: "route-2" });
  await assert.rejects(rotated.transport.verifyIdentity(), hasCode(CORE_ERROR_CODES.PROTOCOL_DRIFT));
  assert.equal(rotated.calls.length, 0);

  const challenged = transportFixture({ responseMode: "challenge", stopCircuit: new PlatformStopCircuit() });
  await assert.rejects(challenged.transport.verifyIdentity(), hasCode(CORE_ERROR_CODES.CHALLENGE_REQUIRED));
  assert.equal(challenged.calls.length, 1);
  await assert.rejects(challenged.transport.execute("listing.list", {}), hasCode(CORE_ERROR_CODES.PROTOCOL_DRIFT));
  assert.equal(challenged.calls.length, 1);
});

test("authentication failure and rate limits remain distinct deterministic stop states", async () => {
  for (const [responseMode, code] of [
    ["auth_failure", CORE_ERROR_CODES.SESSION_REVOKED],
    ["rate_limit", CORE_ERROR_CODES.RATE_LIMITED]
  ]) {
    const fixture = transportFixture({ responseMode, stopCircuit: new PlatformStopCircuit() });
    await assert.rejects(fixture.transport.verifyIdentity(), hasCode(code));
    assert.equal(fixture.calls.length, 1);
    await assert.rejects(fixture.transport.verifyIdentity(), hasCode(CORE_ERROR_CODES.PROTOCOL_DRIFT));
    assert.equal(fixture.calls.length, 1);
  }
});

test("idempotency prevents replay and crash-after-submit remains UNKNOWN without retry", async () => {
  const fixture = transportFixture({ responseMode: "crash_after_submit" });
  const input = { subreddit: "test", title: "Text", body: "Body" };
  const controls = { callerId: "caller-1", idempotencyKey: "same-key", actionId: "action-1" };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      fixture.transport.execute("post.createText", input, controls),
      (error) => error instanceof RedditTransportError && error.submissionMayHaveStarted === true
    );
  }
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(fixture.transport.diagnostics().writeAttempts, 1);

  await assert.rejects(
    fixture.transport.execute("post.createText", { ...input, title: "Different" }, controls),
    hasCode(CORE_ERROR_CODES.IDEMPOTENCY_CONFLICT)
  );
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
});

test("malformed success is protocol drift for reads and UNKNOWN for submitted writes", async () => {
  const readFixture = transportFixture({ responseMode: "malformed_read" });
  await readFixture.transport.verifyIdentity();
  await assert.rejects(
    readFixture.transport.execute("listing.list", {}),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT && error.submissionMayHaveStarted === false
  );

  const writeFixture = transportFixture({ responseMode: "malformed_write" });
  await assert.rejects(
    writeFixture.transport.execute("post.createText", { subreddit: "test", title: "Text", body: "Body" }, {
      callerId: "caller-1", idempotencyKey: "malformed-write", actionId: "action-malformed"
    }),
    (error) => error.code === CORE_ERROR_CODES.PROTOCOL_DRIFT && error.submissionMayHaveStarted === true
  );
  assert.equal(writeFixture.calls.filter((call) => call.method === "POST").length, 1);
});

test("revocation clears the binding and blocks reads without network access", async () => {
  const fixture = transportFixture();
  await fixture.transport.verifyIdentity();
  fixture.transport.revoke();
  const before = fixture.calls.length;
  await assert.rejects(fixture.transport.execute("listing.list", {}), hasCode(CORE_ERROR_CODES.SESSION_REVOKED));
  assert.equal(fixture.calls.length, before);
  assert.equal(fixture.transport.diagnostics().revoked, true);
});

test("refresh advances one account to a new sealed generation and revokes the old transport", async () => {
  const stopCircuit = new PlatformStopCircuit();
  const oldFixture = transportFixture({ stopCircuit, generation: 7 });
  const newFixture = transportFixture({ stopCircuit, generation: 8 });
  await oldFixture.transport.verifyIdentity();
  const refreshed = oldFixture.transport.refresh({
    routeAuthority: newFixture.routeAuthority,
    binding: newFixture.binding,
    expectedNativeIdentity: "t2_aliceid"
  });
  await assert.rejects(oldFixture.transport.execute("listing.list", {}), hasCode(CORE_ERROR_CODES.SESSION_REVOKED));
  assert.equal((await refreshed.verifyIdentity()).native.nativeId, "t2_aliceid");
  assert.equal(refreshed.binding().generation, 8);
  assert.throws(
    () => refreshed.refresh({
      routeAuthority: oldFixture.routeAuthority,
      binding: oldFixture.binding,
      expectedNativeIdentity: "t2_aliceid"
    }),
    hasCode(CORE_ERROR_CODES.INVALID_REQUEST)
  );
});

function transportFixture({
  stopCircuit = new PlatformStopCircuit(),
  username = "alice",
  accountId = "account-1",
  routeId = "route-1",
  generation = 7,
  responseMode = "success"
} = {}) {
  const calls = [];
  const binding = { ...BINDING, accountId, routeId, generation };
  const wireConnector = async (request) => {
    const snapshot = {
      ...request,
      path: new URL(request.url).pathname + new URL(request.url).search,
      body: request.body ? Buffer.from(request.body).toString("utf8") : ""
    };
    const submittedForm = request.body ? new URLSearchParams(Buffer.from(request.body).toString("utf8")) : null;
    if ((responseMode === "crash_after_submit" && request.method === "POST")
      || (responseMode === "crash_media_submit" && request.method === "POST" && request.url.endsWith("/api/submit") && submittedForm?.get("kind") === "image")) {
      calls.push(snapshot);
      throw new Error("fixture disconnect after request bytes");
    }
    const response = fixtureResponse(snapshot, { username, responseMode });
    snapshot.response = response;
    calls.push(snapshot);
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(JSON.stringify(response.body), "utf8"),
      remoteAddress: request.selectedAddress
    };
  };
  const connector = createRedditSessionConnector({
    cookies: { reddit_session: "fixture-cookie" },
    csrfToken: "fixture-modhash",
    userAgent: "social-git-test/1",
    wireConnector
  });
  const routeAuthority = createRedditRouteAuthority({
    routes: [{
      id: binding.routeId,
      tenantId: binding.tenantId,
      accountId: binding.accountId,
      generation: binding.generation,
      connectorId: `connector-${accountId}`
    }],
    connectors: { [`connector-${accountId}`]: connector },
    resolver: async () => ["151.101.1.140"],
    maxResponseBytes: 256 * 1024
  });
  const transport = new RedditSessionTransport({
    routeAuthority,
    binding,
    expectedNativeIdentity: "t2_aliceid",
    stopCircuit,
    deadlineMs: 5_000
  });
  return { binding, calls, routeAuthority, transport };
}

function fixtureResponse(call, { username, responseMode }) {
  if (responseMode === "challenge" && call.path === "/api/me.json") {
    return { status: 403, headers: {}, body: { message: "challenge required" } };
  }
  if (responseMode === "auth_failure" && call.path === "/api/me.json") {
    return { status: 401, headers: {}, body: { message: "not authenticated" } };
  }
  if (responseMode === "rate_limit" && call.path === "/api/me.json") {
    return { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" }, body: { message: "rate limited" } };
  }
  if (call.path === "/api/me.json") return response({ id: username === "alice" ? "aliceid" : "malloryid", name: username, link_karma: 10, comment_karma: 20 });
  if (call.path.startsWith("/r/test/about.json")) return response({ id: "2qh1i", display_name: "test", subscribers: 100 });
  if (responseMode === "malformed_read" && call.method === "GET") return response({ children: "not-an-array" });
  if (call.path.startsWith("/best.json") || call.path.startsWith("/r/test/hot.json") || call.path.startsWith("/search.json")) {
    return response({ children: [{ kind: "t3", data: postData() }], after: "t3_abc", before: null });
  }
  if (call.path.startsWith("/comments/abc.json")) {
    return jsonResponse([
      { data: { children: [{ kind: "t3", data: postData() }], after: null, before: null } },
      { data: { children: [{ kind: "t1", data: commentData() }], after: null, before: null } }
    ]);
  }
  if (call.path === "/api/media/asset.json") {
    if (responseMode === "media_lease_rate") {
      return { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" }, body: { message: "rate limited" } };
    }
    return jsonResponse({
      args: {
        action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com",
        fields: [
          { name: "key", value: "fixture/object.png" },
          { name: "policy", value: "opaque-policy" },
          { name: "x-amz-signature", value: "opaque-signature" }
        ]
      },
      asset: { asset_id: "asset-fixture" }
    });
  }
  if (call.path.startsWith("/api/info.json")) {
    if (responseMode === "comment_auth_failure") return { status: 401, headers: {}, body: { message: "not authenticated" } };
    if (responseMode === "comment_rate_limit") {
      return { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" }, body: { message: "rate limited" } };
    }
    if (responseMode === "comment_challenge") return { status: 403, headers: {}, body: { message: "challenge required" } };
    if (responseMode === "comment_protocol_drift") return { status: 418, headers: {}, body: { message: "upstream changed" } };
    if (responseMode === "missing_comment") return response({ children: [], after: null, before: null });
    if (responseMode === "malformed_comment") return response({ children: "not-an-array" });
    return response({
      children: [{ kind: "t1", data: commentData(responseMode === "foreign_comment" ? "mallory" : "alice") }],
      after: null,
      before: null
    });
  }
  if (call.method === "POST") {
    if (responseMode === "malformed_write") return jsonResponse({ unexpected: true });
    const form = new URLSearchParams(call.body);
    if (call.path === "/api/submit" && form.get("kind") === "image") {
      return jsonResponse({ json: { errors: [], data: { websocket_url: "wss://wss.redditmedia.com/opaque-ticket" } } });
    }
    if (call.path === "/api/submit") {
      return jsonResponse({ json: { errors: [], data: { name: "t3_created", url: "/r/test/comments/created/title/" } } });
    }
    if (call.path === "/api/comment") {
      return jsonResponse({ json: { errors: [], data: { things: [{ data: { name: "t1_created", permalink: "/r/test/comments/abc/title/created/" } }] } } });
    }
    assert.equal(form.get("id")?.startsWith("t"), true);
    return jsonResponse({ json: { errors: [] } });
  }
  throw new Error(`Unhandled fixture path: ${call.path}`);
}

function response(data) { return jsonResponse({ data }); }
function jsonResponse(body) {
  return {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "59", "x-ratelimit-used": "1", "x-ratelimit-reset": "60" },
    body
  };
}
function postData() {
  return { id: "abc", name: "t3_abc", permalink: "/r/test/comments/abc/title/", title: "Title", author: "alice", subreddit: "test", selftext: "Body", score: 5 };
}
function commentData(author = "alice") {
  return { id: "comment", name: "t1_comment", permalink: "/r/test/comments/abc/title/comment/", author, body: "Comment", parent_id: "t3_abc", score: 2 };
}
function hasCode(code) { return (error) => error?.code === code; }
