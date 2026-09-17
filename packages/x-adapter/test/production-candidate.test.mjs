import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  X_CAPABILITIES,
  X_PROTOCOL_ROUTES,
  X_PROTOCOL_SOURCE,
  X_PUBLIC_PROTOCOL_EVIDENCE,
  X_RECORDED_SYNTHETIC_CORPUS,
  X_TRANSPORT_ADMISSION,
  XContractError,
  XSessionTransport,
  buildXProtocolRequest,
  createXSessionConnector,
  buildXTransactionState,
  discoverXTransactionAsset,
  generateXClientTransactionId,
  normalizeXProtocolResponse,
} from "../src/index.mjs";

test("pinned source is a noticed corpus, never a runtime dependency", () => {
  assert.equal(X_PROTOCOL_SOURCE.revision, "6a73ab97f4de09f79139f6308c9fb80029a9f5f7");
  assert.equal(X_PROTOCOL_SOURCE.license, "MIT");
  assert.equal(X_PROTOCOL_SOURCE.runtimeDependency, false);
  assert.equal(X_PROTOCOL_SOURCE.files.length, 10);
  assert.deepEqual(X_PROTOCOL_SOURCE.files.find((file) => file.path === "LICENSE"), {
    path: "LICENSE",
    gitBlob: "02c0ce95a5556628b8508cdbf1d05d39aef689a3",
    sha256: "71fec6fa5605fe7958564251e54ac0a8f7658e2915e2aa",
  });
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.dependencies, undefined);
  const lock = readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8").toLowerCase();
  assert.equal(lock.includes('"twikit"'), false);
  const notice = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  assert.match(notice, /MIT License/u);
  assert.match(notice, new RegExp(X_PROTOCOL_SOURCE.revision, "u"));
});

test("transaction header parser and generator are pure, bounded, and deterministic", () => {
  const key = Buffer.from(Array.from({ length: 64 }, (_, index) => index)).toString("base64");
  const row = "1 2 3 4 5 6 7 8 9 10 11";
  const path = `M00000000${Array(16).fill(row).join("C")}`;
  const frames = Array.from({ length: 4 }, (_, index) => `<svg id="loading-x-anim-${index}"><g><path d="M0 0"></path><path d="${path}"></path></g></svg>`).join("");
  const html = `<html><head><meta name="twitter-site-verification" content="${key}"><script>,123:"ondemand.s",123:"abcdef"</script></head><body>${frames}</body></html>`;
  const asset = "(a[2], 16)(b[12], 16)(c[14], 16)(d[7], 16)";
  assert.deepEqual(discoverXTransactionAsset(html), { target: "asset", path: "/responsive-web/client-web/ondemand.s.abcdefa.js" });
  const state = buildXTransactionState(html, asset);
  const first = generateXClientTransactionId(state, { method: "GET", path: "/i/api/graphql/id/Query", nowSeconds: 1_700_000_000, randomByte: 7 });
  const second = generateXClientTransactionId(state, { method: "GET", path: "/i/api/graphql/id/Query", nowSeconds: 1_700_000_000, randomByte: 7 });
  assert.equal(first, second);
  assert.equal(first, "BwcGBQQDAgEADw4NDAsKCQgXFhUUExIREB8eHRwbGhkYJyYlJCMiISAvLi0sKyopKDc2NTQzMjEwPz49PDs6OTiXigMG+GXs6pw3zeDe9H97Me6akwQ");
  const currentSizeHtml = `${html}<!--${"x".repeat(300_000)}-->`;
  assert.ok(buildXTransactionState(currentSizeHtml, asset));
  assert.throws(() => buildXTransactionState(`${html}<script>${"x".repeat(600_000)}</script>`, asset), hasCode("PROTOCOL_DRIFT"));
  assert.throws(() => buildXTransactionState(html, "eval(document.cookie)"), hasCode("PROTOCOL_DRIFT"));
});

test("public immutable asset evidence refreshes query IDs without opening admission", () => {
  assert.equal(X_PUBLIC_PROTOCOL_EVIDENCE.sourceRole, "public_inert_asset_observation");
  assert.equal(X_PUBLIC_PROTOCOL_EVIDENCE.productionAdmission, "partial_evidence_only");
  assert.equal(X_PUBLIC_PROTOCOL_EVIDENCE.assets.length, 4);
  assert.ok(X_PUBLIC_PROTOCOL_EVIDENCE.assets.every((asset) => asset.url.startsWith("https://abs.twimg.com/responsive-web/client-web/") && /^[0-9a-f]{64}$/u.test(asset.sha256)));
  assert.deepEqual(X_PUBLIC_PROTOCOL_EVIDENCE.unresolved, [
    "GRAPHQL_FEATURE_VALUES_UNPROVEN",
    "V11_ENDPOINT_CURRENTNESS_UNPROVEN",
    "AUTHENTICATED_ACCEPTANCE_UNPROVEN",
    "RESPONSE_SHAPE_CURRENTNESS_UNPROVEN",
  ]);
  assert.equal(X_PROTOCOL_ROUTES["profile.get"].queryId, X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.UserByScreenName);
  assert.equal(X_PROTOCOL_ROUTES["timeline.home"].queryId, X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.HomeTimeline);
  assert.equal(X_PROTOCOL_ROUTES["bookmarks.list"].queryId, X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.Bookmarks);
  assert.equal(X_PROTOCOL_ROUTES["post.create"].queryId, X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.CreateTweet);
  assert.equal(X_TRANSPORT_ADMISSION.gates.exactEndpointCurrentness, false);
  assert.equal(X_TRANSPORT_ADMISSION.gates.clientTransactionHeaderProven, false);
});

test("exact capability matrix remains production-disabled with machine reasons", () => {
  assert.equal(Object.keys(X_PROTOCOL_ROUTES).length, 19);
  assert.equal(X_CAPABILITIES.length, 19);
  assert.equal(X_TRANSPORT_ADMISSION.productionEnabled, false);
  assert.deepEqual(X_TRANSPORT_ADMISSION.disabledReasons, [
    "ENDPOINT_CURRENTNESS_UNPROVEN",
    "CLIENT_TRANSACTION_HEADER_UNPROVEN",
    "AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING",
    "AUTHORIZED_LIVE_READ_PROOF_MISSING",
    "AUTHORIZED_LIVE_WRITE_PROOF_MISSING",
  ]);
  assert.ok(X_CAPABILITIES.every((item) => item.productionEnabled === false && item.disabledReasons.length === 5));
});

test("protocol builders pin one bounded request and never paginate or retry", () => {
  const page = buildXProtocolRequest("search.query", { query: "fixture", limit: 25, cursor: "opaque" });
  assert.equal(page.method, "GET");
  assert.match(page.path, /^\/i\/api\/graphql\/auLkqtmHqYEpRvflfvLhyQ\/SearchTimeline\?/u);
  assert.equal(page.body, null);
  const write = buildXProtocolRequest("post.create", { text: "bounded" });
  assert.equal(write.method, "POST");
  assert.equal(write.submission, "SINGLE_ATTEMPT");
  assert.equal(JSON.parse(write.body).queryId, "GYdIGqVWfZNho79bQ2XDoA");
  assert.equal(buildXProtocolRequest("timeline.home", { limit: 1 }).submission, "READ_ONLY");
  assert.equal(buildXProtocolRequest("post.media.create", { sizeBytes: 1, mimeType: "image/png" }, "init").submission, "SINGLE_ATTEMPT");
  assert.throws(() => buildXProtocolRequest("timeline.home", { limit: 101 }), hasCode("INVALID_REQUEST"));
  assert.throws(() => buildXProtocolRequest("post.create", { text: "x".repeat(281) }), hasCode("INVALID_REQUEST"));
});

test("Core-owned auth_token and ct0 are injected only into the trusted connector", async () => {
  let observed;
  const connector = createXSessionConnector({
    authToken: "synthetic-auth",
    csrfToken: "synthetic-csrf",
    transactionIdFor: () => "Abcdefghijklmnop",
    wireConnector: async (request) => { observed = request; return { status: 200, headers: {}, body: Buffer.from("{}"), remoteAddress: "93.184.216.34" }; },
  });
  await connector({ method: "GET", url: "https://x.com/i/api/test", body: null });
  assert.equal(observed.headers.cookie, "auth_token=synthetic-auth; ct0=synthetic-csrf");
  assert.equal(observed.headers["x-csrf-token"], "synthetic-csrf");
  assert.equal(observed.headers["x-client-transaction-id"], "Abcdefghijklmnop");
  assert.equal(JSON.stringify({ method: observed.method, url: observed.url, body: observed.body }).includes("synthetic-auth"), false);
  assert.throws(() => createXSessionConnector({ authToken: "bad;cookie", csrfToken: "ok", wireConnector: async () => ({}) }), hasCode("INVALID_REQUEST"));
});

test("deterministic source-shaped corpus projects strict secret-free DTOs", () => {
  const identity = normalizeXProtocolResponse("account.identity", X_RECORDED_SYNTHETIC_CORPUS.identity);
  assert.equal(identity.entity.nativeId, "100");
  const profile = normalizeXProtocolResponse("profile.get", X_RECORDED_SYNTHETIC_CORPUS.profile);
  assert.equal(profile.entity.username, "fixture_owner");
  const post = normalizeXProtocolResponse("post.get", X_RECORDED_SYNTHETIC_CORPUS.post);
  assert.equal(post.entity.nativeId, "300");
  const page = normalizeXProtocolResponse("timeline.home", X_RECORDED_SYNTHETIC_CORPUS.page);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, "opaque-next");
  const notifications = normalizeXProtocolResponse("notifications.list", X_RECORDED_SYNTHETIC_CORPUS.notificationPage);
  assert.equal(notifications.items[0].postNativeId, "300");
  const conversations = normalizeXProtocolResponse("conversations.list", X_RECORDED_SYNTHETIC_CORPUS.conversationPage);
  assert.deepEqual(conversations.items[0].participantNativeIds, ["100", "200"]);
  const write = normalizeXProtocolResponse("post.create", X_RECORDED_SYNTHETIC_CORPUS.write);
  assert.equal(write.nativeId, "600");
  assert.equal(normalizeXProtocolResponse("post.media.create", X_RECORDED_SYNTHETIC_CORPUS.mediaInit, null, "init").phase, "initialized");
  assert.equal(normalizeXProtocolResponse("post.media.create", X_RECORDED_SYNTHETIC_CORPUS.mediaAppend, null, "append").phase, "appended");
  assert.equal(normalizeXProtocolResponse("post.media.create", X_RECORDED_SYNTHETIC_CORPUS.mediaFinalize, null, "finalize").phase, "finalized");
  assert.equal(JSON.stringify({ identity, profile, post, page, notifications, conversations, write }).includes("auth_token"), false);
});

test("terminal, drift, cursor, and ambiguous-write outcomes fail closed", () => {
  assert.throws(() => normalizeXProtocolResponse("timeline.home", { status: 429, headers: { "x-rate-limit-remaining": "0" }, body: {} }), hasCode("RATE_LIMITED"));
  assert.throws(() => normalizeXProtocolResponse("timeline.home", { status: 401, headers: {}, body: {} }), hasCode("SESSION_REVOKED"));
  assert.throws(() => normalizeXProtocolResponse("timeline.home", { status: 403, headers: {}, body: { errors: [{ code: 326 }] } }), hasCode("CHALLENGE_REQUIRED"));
  assert.throws(() => normalizeXProtocolResponse("timeline.home", X_RECORDED_SYNTHETIC_CORPUS.page, "opaque-next"), hasCode("PROTOCOL_DRIFT"));
  const drift = structuredClone(X_RECORDED_SYNTHETIC_CORPUS.post);
  drift.body.data.tweetResult.result.__typename = "TweetWithVisibilityResults";
  assert.throws(() => normalizeXProtocolResponse("post.get", drift), hasCode("PROTOCOL_DRIFT"));
});

test("transport binds tenant/account/route/generation, validates identity once, and never resubmits", async () => {
  const calls = [];
  const responses = [X_RECORDED_SYNTHETIC_CORPUS.identity, X_RECORDED_SYNTHETIC_CORPUS.page];
  const authority = {
    issueLease(binding) { return Object.freeze({ ...binding }); },
    async request(lease, descriptor) { calls.push({ lease, descriptor }); const response = responses.shift(); return { ...response, body: Buffer.from(JSON.stringify(response.body)) }; },
  };
  const binding = { tenantId: "tenant-a", accountId: "account-a", routeId: "route-a", generation: 3 };
  const transport = new XSessionTransport({ routeAuthority: authority, binding, expectedNativeIdentity: "100", now: () => 1000 });
  const page = await transport.execute("timeline.home", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.lease.accountId === "account-a" && call.lease.generation === 3));
  assert.equal(transport.diagnostics().identityValidated, true);

  const failing = new XSessionTransport({
    routeAuthority: { issueLease: (value) => value, request: async (_lease, descriptor) => {
      if (descriptor.path.includes("account/settings")) return { ...X_RECORDED_SYNTHETIC_CORPUS.identity, body: Buffer.from(JSON.stringify(X_RECORDED_SYNTHETIC_CORPUS.identity.body)) };
      throw new Error("synthetic disconnect");
    } }, binding, expectedNativeIdentity: "100",
  });
  await assert.rejects(() => failing.execute("post.create", { text: "uncertain" }), (error) => error.code === "UNKNOWN" && error.submissionMayHaveStarted === true);
  assert.equal(failing.diagnostics().requests, 2);

  const malformed = new XSessionTransport({
    routeAuthority: { issueLease: (value) => value, request: async (_lease, descriptor) => descriptor.path.includes("account/settings")
      ? { ...X_RECORDED_SYNTHETIC_CORPUS.identity, body: Buffer.from(JSON.stringify(X_RECORDED_SYNTHETIC_CORPUS.identity.body)) }
      : { status: 200, headers: {}, body: Buffer.from("{}") } },
    binding, expectedNativeIdentity: "100",
  });
  await assert.rejects(() => malformed.execute("post.create", { text: "unverified response" }), (error) => error.code === "UNKNOWN" && error.submissionMayHaveStarted === true);

  const mediaDisconnect = new XSessionTransport({
    routeAuthority: { issueLease: (value) => value, request: async (_lease, descriptor) => {
      if (descriptor.path.includes("account/settings")) return { ...X_RECORDED_SYNTHETIC_CORPUS.identity, body: Buffer.from(JSON.stringify(X_RECORDED_SYNTHETIC_CORPUS.identity.body)) };
      throw new Error("synthetic media disconnect");
    } }, binding, expectedNativeIdentity: "100",
  });
  await assert.rejects(
    () => mediaDisconnect.executeMediaPhase("init", { sizeBytes: 1, mimeType: "image/png" }),
    (error) => error.code === "UNKNOWN" && error.submissionMayHaveStarted === true && error.retryable === false,
  );

  const wrongIdentity = new XSessionTransport({
    routeAuthority: { issueLease: (value) => value, request: async () => ({ ...X_RECORDED_SYNTHETIC_CORPUS.identity, body: Buffer.from(JSON.stringify(X_RECORDED_SYNTHETIC_CORPUS.identity.body)) }) },
    binding,
    expectedNativeIdentity: "999",
  });
  await assert.rejects(() => wrongIdentity.execute("account.identity", {}), hasCode("WRONG_IDENTITY"));
  assert.equal(wrongIdentity.diagnostics().revoked, true);
});

function hasCode(code) { return (error) => error instanceof XContractError && error.code === code; }
