import assert from "node:assert/strict";
import test from "node:test";
import { X_CAPABILITIES, X_FIXTURE_ENTITIES, XContractError, normalizeXFixtureResponse, normalizeXFixtureWriteResponse, unwrapXNormalized, xFixture } from "../src/index.mjs";
import { readFileSync } from "node:fs";

test("capability matrix is complete, fixture-only, and production-disabled", () => {
  assert.deepEqual(X_CAPABILITIES.filter(({ mode }) => mode === "read").map(({ operation }) => operation), [
    "account.identity", "profile.get", "post.get", "thread.get", "timeline.home", "timeline.user",
    "search.query", "notifications.list", "conversations.list", "bookmarks.list",
  ]);
  assert.deepEqual(X_CAPABILITIES.filter(({ mode }) => mode === "write").map(({ operation }) => operation), [
    "post.create", "post.reply", "post.delete", "post.like.set", "post.repost.set",
    "profile.follow.set", "bookmark.set", "post.media.create", "message.send",
  ]);
  assert.ok(X_CAPABILITIES.every((capability) => capability.fixtureEnabled && !capability.productionEnabled && capability.status === "fixture_only"));
});

test("write outcomes normalize to strict secret-free native evidence", () => {
  const post = normalizeXFixtureWriteResponse("post.create", xFixture("post.create", {
    result: { nativeId: "600", canonicalUrl: "https://x.com/fixture_owner/status/600" },
  }));
  assert.deepEqual(post, {
    nativeId: "600", canonicalUrl: "https://x.com/fixture_owner/status/600", rateLimit: { limit: 50, remaining: 49, resetAt: "2033-05-18T03:33:20.000Z" },
  });
  const message = normalizeXFixtureWriteResponse("message.send", xFixture("message.send", { result: { nativeId: "700" } }));
  assert.equal(message.nativeId, "700");
  assert.throws(() => normalizeXFixtureWriteResponse("profile.get", xFixture("profile.get", { result: { nativeId: "700" } })), hasCode("UNKNOWN_OPERATION"));
  for (const response of [
    xFixture("post.create", { result: { nativeId: "not-numeric" } }),
    xFixture("post.create", { result: { nativeId: "600", canonicalUrl: "https://evil.invalid/600" } }),
    xFixture("post.create", { result: { nativeId: "600", raw: { cookie: "secret" } } }),
  ]) assert.throws(() => normalizeXFixtureWriteResponse("post.create", response), hasCode("PROTOCOL_DRIFT"));
});

test("package has no runtime network, browser, impersonation, challenge, or account-pool dependency", () => {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8").toLowerCase();
  const source = ["contract.mjs", "fixture-corpus.mjs", "protocol-normalizers.mjs", "index.mjs"]
    .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n").toLowerCase();
  for (const forbidden of ["playwright", "puppeteer", "selenium", "chromium", "curl-cffi", "tls-client", "cloudscraper", "captcha", "mfa", "proxy rotation", "account pool", "node:http", "node:https", "node:net", "node:tls", "fetch("]) {
    assert.equal(`${manifest}\n${source}`.includes(forbidden), false, forbidden);
  }
});

test("identity, profile, post and all paged kinds normalize to bounded DTOs", () => {
  for (const [operation, kind] of [["account.identity", "account"], ["profile.get", "profile"], ["post.get", "post"]]) {
    const normalized = unwrapXNormalized(normalizeXFixtureResponse(operation, xFixture(operation, { entity: X_FIXTURE_ENTITIES[kind] })));
    assert.equal(normalized.nativeId, X_FIXTURE_ENTITIES[kind].nativeId);
    assert.equal("ignored" in normalized, false);
    assert.equal(normalized.rateLimit.remaining, 49);
  }
  const pageKinds = new Map([
    ["thread.get", "post"], ["timeline.home", "post"], ["timeline.user", "post"], ["search.query", "post"],
    ["notifications.list", "notification"], ["conversations.list", "conversation"], ["bookmarks.list", "post"],
  ]);
  for (const [operation, kind] of pageKinds) {
    const page = normalizeXFixtureResponse(operation, xFixture(operation, { items: [X_FIXTURE_ENTITIES[kind]], nextCursor: "opaque-next" }));
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, "opaque-next");
    assert.equal(page.rateLimit.limit, 50);
  }
});

test("opaque pagination rejects repeat, ambiguity, and oversized pages", () => {
  const response = xFixture("timeline.home", { items: [X_FIXTURE_ENTITIES.post], nextCursor: "same" });
  assert.throws(() => normalizeXFixtureResponse("timeline.home", response, "same"), hasCode("PROTOCOL_DRIFT"));
  assert.throws(() => normalizeXFixtureResponse("timeline.home", xFixture("timeline.home", { items: Array(101).fill(X_FIXTURE_ENTITIES.post), nextCursor: null })), hasCode("PROTOCOL_DRIFT"));
  assert.throws(() => normalizeXFixtureResponse("timeline.home", xFixture("timeline.home", { items: [], nextCursor: "x".repeat(513) })), hasCode("PROTOCOL_DRIFT"));
});

test("terminal auth, access and rate states never become empty success", () => {
  assert.throws(() => normalizeXFixtureResponse("timeline.home", { status: 401, body: {} }), hasCode("SESSION_REVOKED"));
  assert.throws(() => normalizeXFixtureResponse("timeline.home", { status: 403, body: {} }), hasCode("ACCESS_DENIED"));
  assert.throws(() => normalizeXFixtureResponse("timeline.home", { status: 429, headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "2000000000" }, body: {} }), hasCode("RATE_LIMITED"));
});

test("protocol drift rejects partial errors, unknown variants, unsafe URLs and extras", () => {
  const cases = [
    { status: 200, body: {} },
    xFixture("timeline.home", { items: [], nextCursor: null, errors: [] }),
    xFixture("timeline.home", { items: [{ ...X_FIXTURE_ENTITIES.post, type: "promoted_post" }], nextCursor: null }),
    xFixture("timeline.home", { items: [{ ...X_FIXTURE_ENTITIES.post, canonicalUrl: "https://evil.invalid/post/300" }], nextCursor: null }),
    xFixture("timeline.home", { items: [{ ...X_FIXTURE_ENTITIES.post, raw: { cookie: "secret" } }], nextCursor: null }),
  ];
  for (const value of cases) assert.throws(() => normalizeXFixtureResponse("timeline.home", value), hasCode("PROTOCOL_DRIFT"));
});

function hasCode(code) {
  return (error) => error instanceof XContractError && error.code === code;
}
