import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { buildXProtocolRequest, createXPublicAssetConnector, createXSessionConnector, X_WEB_CLIENT_TOKEN } from "../../x-adapter/src/index.mjs";
import { createPinnedXHttpsConnector, createXRouteAuthority } from "../src/index.mjs";

const binding = { tenantId: "tenant-a", accountId: "account-a", routeId: "route-a", generation: 2 };

test("X composite egress binds tenant/account/generation and fixed direct hosts", async () => {
  const calls = [];
  const connector = async (request) => {
    calls.push(request);
    return { status: 200, headers: {}, body: Buffer.from("{}"), remoteAddress: request.selectedAddress };
  };
  const authority = createXRouteAuthority({
    route: binding,
    connectors: { web: connector, api: connector, upload: connector, asset: connector },
    resolver: async (hostname) => hostname === "x.com" ? ["93.184.216.34"] : hostname === "api.x.com" ? ["93.184.216.35"] : hostname === "upload.x.com" ? ["93.184.216.36"] : ["93.184.216.37"],
    now: () => 1000,
  });
  const lease = authority.issueLease(binding);
  for (const [target, path, host] of [
    ["web", "/i/api/graphql/id/Query", "x.com"],
    ["api", "/1.1/account/settings.json", "api.x.com"],
    ["upload", "/i/media/upload.json", "upload.x.com"],
    ["asset", "/responsive-web/client-web/ondemand.s.abc123a.js", "abs.twimg.com"],
  ]) {
    const result = await authority.request(lease, { target, method: "GET", path, body: null, contentType: null, deadlineEpochMs: 2000 });
    assert.equal(new URL(result.finalUrl).hostname, host);
    assert.equal(result.redirectCount, 0);
  }
  assert.equal(calls.length, 4);
  assert.throws(() => authority.issueLease({ ...binding, accountId: "other" }), (error) => error.code === "ROUTE_DENIED");
  assert.throws(() => authority.request(lease, { target: "other", method: "GET", path: "/", body: null, contentType: null, deadlineEpochMs: 2000 }), (error) => error.code === "DESTINATION_DENIED");
});

test("X egress denies redirects, private addresses, and absolute destinations", async () => {
  const redirectAuthority = createXRouteAuthority({
    route: binding,
    connectors: { web: redirect, api: redirect, upload: redirect, asset: redirect },
    resolver: async () => ["93.184.216.34"],
    now: () => 1000,
  });
  const lease = redirectAuthority.issueLease(binding);
  await assert.rejects(() => redirectAuthority.request(lease, { target: "web", method: "GET", path: "/start", body: null, contentType: null, deadlineEpochMs: 2000 }), (error) => error.code === "REDIRECT_DENIED");
  await assert.rejects(() => redirectAuthority.request(lease, { target: "web", method: "GET", path: "https://evil.invalid/", body: null, contentType: null, deadlineEpochMs: 2000 }), (error) => error.code === "DESTINATION_DENIED");

  const privateAuthority = createXRouteAuthority({
    route: binding,
    connectors: { web: redirect, api: redirect, upload: redirect, asset: redirect },
    resolver: async () => ["127.0.0.1"],
    now: () => 1000,
  });
  await assert.rejects(() => privateAuthority.request(privateAuthority.issueLease(binding), { target: "web", method: "GET", path: "/", body: null, contentType: null, deadlineEpochMs: 2000 }), (error) => error.code === "DESTINATION_DENIED");
});

test("composed pinned X HTTPS path preserves sealed profiles and never sends account authority to assets", async () => {
  const calls = [];
  const requestImpl = (target, options) => {
    const request = new EventEmitter();
    const chunks = [];
    request.write = (chunk) => { chunks.push(Buffer.from(chunk)); };
    request.end = () => {
      options.lookup(target.hostname, {}, (_error, selectedAddress) => {
        calls.push({ url: target.toString(), headers: { ...options.headers }, body: Buffer.concat(chunks) });
        const response = Readable.from([Buffer.from("{}")]);
        response.statusCode = 200;
        response.headers = {};
        response.socket = { remoteAddress: selectedAddress };
        queueMicrotask(() => request.emit("response", response));
      });
    };
    return request;
  };
  const wire = createPinnedXHttpsConnector({ publicBearerToken: X_WEB_CLIENT_TOKEN, requestImpl });
  const api = createXSessionConnector({
    authToken: "synthetic-auth",
    csrfToken: "synthetic-csrf",
    transactionIdFor: () => "ABCDEFGHIJKLMNOP",
    wireConnector: wire,
  });
  const home = createXSessionConnector({ authToken: "synthetic-auth", csrfToken: "synthetic-csrf", profile: "home", wireConnector: wire });
  const asset = createXPublicAssetConnector({ wireConnector: wire });
  const options = { route: binding, resolver: async () => ["93.184.216.34"], now: () => 1000 };
  const homeAuthority = createXRouteAuthority({ ...options, connectors: { web: home, api, upload: api, asset } });
  await homeAuthority.request(homeAuthority.issueLease(binding), { target: "web", method: "GET", path: "/home", body: null, contentType: null, deadlineEpochMs: 2000 });
  const authority = createXRouteAuthority({ ...options, connectors: { web: api, api, upload: api, asset } });
  const lease = authority.issueLease(binding);
  await authority.request(lease, { target: "asset", method: "GET", path: "/responsive-web/client-web/ondemand.s.abc123a.js", body: null, contentType: null, deadlineEpochMs: 2000 });
  for (const protocol of [
    buildXProtocolRequest("post.create", { text: "fixture" }),
    buildXProtocolRequest("profile.follow.set", { userNativeId: "200", enabled: true }),
    buildXProtocolRequest("post.media.create", { mediaId: "500", data: Buffer.from("media") }, "append"),
  ]) {
    const { target, method, path, body, contentType } = protocol;
    await authority.request(lease, { target, method, path, body, contentType, deadlineEpochMs: 2000 });
  }

  assert.equal(calls.length, 5);
  assert.equal(calls[0].headers.accept, "text/html");
  assert.equal(calls[0].headers["accept-language"], "en-US,en;q=0.9");
  assert.equal(calls[0].headers["cache-control"], "no-cache");
  assert.equal(calls[0].headers.cookie, "auth_token=synthetic-auth; ct0=synthetic-csrf");
  assert.equal(calls[0].headers.referer, "https://x.com/");
  assert.equal(calls[1].headers.accept, "application/javascript");
  for (const name of ["authorization", "cookie", "referer", "x-csrf-token", "x-client-transaction-id", "x-twitter-active-user", "x-twitter-auth-type"]) {
    assert.equal(calls[1].headers[name], undefined, name);
  }
  for (const call of calls.slice(2)) {
    assert.equal(call.headers.authorization, `Bearer ${X_WEB_CLIENT_TOKEN}`);
    assert.equal(call.headers.cookie, "auth_token=synthetic-auth; ct0=synthetic-csrf");
    assert.equal(call.headers["x-csrf-token"], "synthetic-csrf");
    assert.equal(call.headers["x-client-transaction-id"], "ABCDEFGHIJKLMNOP");
    assert.equal(call.headers["x-twitter-active-user"], "yes");
    assert.equal(call.headers["x-twitter-auth-type"], "OAuth2Session");
    assert.equal(call.headers.referer, "https://x.com/");
  }
  assert.equal(calls[2].headers["content-type"], "application/json");
  assert.equal(JSON.parse(calls[2].body.toString("utf8")).queryId, "GYdIGqVWfZNho79bQ2XDoA");
  assert.equal(calls[3].headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(calls[3].body.toString("utf8"), "user_id=200&skip_status=1");
  assert.match(calls[4].headers["content-type"], /^multipart\/form-data; boundary=socialgit-x-[a-f0-9]{32}$/u);
  assert.match(calls[4].body.toString("utf8"), /Content-Disposition: form-data; name="media"; filename="blob"/u);
});

async function redirect(request) {
  return { status: 302, headers: { location: "/next" }, body: Buffer.alloc(0), remoteAddress: request.selectedAddress };
}
