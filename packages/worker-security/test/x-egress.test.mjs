import assert from "node:assert/strict";
import test from "node:test";
import { createXRouteAuthority } from "../src/index.mjs";

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
    const result = await authority.request(lease, { target, method: "GET", path, body: null, deadlineEpochMs: 2000 });
    assert.equal(new URL(result.finalUrl).hostname, host);
    assert.equal(result.redirectCount, 0);
  }
  assert.equal(calls.length, 4);
  assert.throws(() => authority.issueLease({ ...binding, accountId: "other" }), (error) => error.code === "ROUTE_DENIED");
  assert.throws(() => authority.request(lease, { target: "other", method: "GET", path: "/", body: null, deadlineEpochMs: 2000 }), (error) => error.code === "DESTINATION_DENIED");
});

test("X egress denies redirects, private addresses, and absolute destinations", async () => {
  const redirectAuthority = createXRouteAuthority({
    route: binding,
    connectors: { web: redirect, api: redirect, upload: redirect, asset: redirect },
    resolver: async () => ["93.184.216.34"],
    now: () => 1000,
  });
  const lease = redirectAuthority.issueLease(binding);
  await assert.rejects(() => redirectAuthority.request(lease, { target: "web", method: "GET", path: "/start", body: null, deadlineEpochMs: 2000 }), (error) => error.code === "REDIRECT_DENIED");
  await assert.rejects(() => redirectAuthority.request(lease, { target: "web", method: "GET", path: "https://evil.invalid/", body: null, deadlineEpochMs: 2000 }), (error) => error.code === "DESTINATION_DENIED");

  const privateAuthority = createXRouteAuthority({
    route: binding,
    connectors: { web: redirect, api: redirect, upload: redirect, asset: redirect },
    resolver: async () => ["127.0.0.1"],
    now: () => 1000,
  });
  await assert.rejects(() => privateAuthority.request(privateAuthority.issueLease(binding), { target: "web", method: "GET", path: "/", body: null, deadlineEpochMs: 2000 }), (error) => error.code === "DESTINATION_DENIED");
});

async function redirect(request) {
  return { status: 302, headers: { location: "/next" }, body: Buffer.alloc(0), remoteAddress: request.selectedAddress };
}
