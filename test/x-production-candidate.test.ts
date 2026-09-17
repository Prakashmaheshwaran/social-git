import assert from "node:assert/strict";
import test from "node:test";
import { X_RECORDED_SYNTHETIC_CORPUS } from "@social-git/x-adapter";
import { bootstrapXCandidateTransport } from "../src/runtime-x.ts";

test("candidate bootstrap parses inert assets and binds Core session material without live calls", async () => {
  const key = Buffer.from(Array.from({ length: 64 }, (_, index) => index)).toString("base64");
  const row = "1 2 3 4 5 6 7 8 9 10 11";
  const vector = `M00000000${Array(16).fill(row).join("C")}`;
  const frames = Array.from({ length: 4 }, (_, index) => `<svg id="loading-x-anim-${index}"><g><path d="M0 0"></path><path d="${vector}"></path></g></svg>`).join("");
  const home = `<html><head><meta name="twitter-site-verification" content="${key}"><script>,123:"ondemand.s",123:"abcdef"</script></head><body>${frames}</body></html>`;
  const asset = "(a[2], 16)(b[12], 16)(c[14], 16)(d[7], 16)";
  const calls: Array<Record<string, any>> = [];
  const responses = new Map<string, any>([
    ["https://x.com/home", { status: 200, headers: {}, body: Buffer.from(home) }],
    ["https://abs.twimg.com/responsive-web/client-web/ondemand.s.abcdefa.js", { status: 200, headers: {}, body: Buffer.from(asset) }],
    ["https://api.x.com/1.1/account/settings.json", X_RECORDED_SYNTHETIC_CORPUS.identity],
  ]);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "synthetic-auth", ct0: "synthetic-csrf" } }));
  const route = Buffer.from(JSON.stringify({ kind: "direct" }));
  try {
    const transport = await bootstrapXCandidateTransport({
      binding: { tenantId: "tenant-a", accountId: "account-a", routeId: "route-a", generation: 4 },
      expectedNativeIdentity: "100",
      sessionBytes: session,
      routeBytes: route,
      resolver: async () => ["93.184.216.34"],
      wireConnector: async (request) => {
        calls.push(request);
        const response = responses.get(request.url) ?? (request.url.includes("HomeTimeline") ? X_RECORDED_SYNTHETIC_CORPUS.page : undefined);
        assert.ok(response, request.url);
        return {
          status: response.status,
          headers: { ...response.headers },
          body: Buffer.isBuffer(response.body) ? response.body : Buffer.from(JSON.stringify(response.body)),
          remoteAddress: request.selectedAddress,
        };
      },
      now: () => 1_700_000_000_000,
      randomByte: () => 7,
    });
    const page = await transport.execute("timeline.home", { limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(calls.length, 4);
    assert.equal(calls[0]?.headers["x-client-transaction-id"], undefined);
    assert.equal(calls[1]?.headers["x-client-transaction-id"], undefined);
    assert.match(calls[2]?.headers["x-client-transaction-id"], /^[A-Za-z0-9+/]+$/u);
    assert.match(calls[3]?.headers["x-client-transaction-id"], /^[A-Za-z0-9+/]+$/u);
    assert.ok(calls.every((call) => call.headers.cookie === "auth_token=synthetic-auth; ct0=synthetic-csrf"));
    assert.equal(JSON.stringify(page).includes("synthetic-auth"), false);
  } finally {
    session.fill(0);
    route.fill(0);
  }
});

test("candidate bootstrap rejects extra cookies, route authority, and malformed asset before any product operation", async () => {
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: "a", ct0: "c", extra: "forbidden" } }));
  const route = Buffer.from(JSON.stringify({ kind: "proxy", url: "https://proxy.invalid" }));
  await assert.rejects(() => bootstrapXCandidateTransport({
    binding: { tenantId: "tenant-a", accountId: "account-a", routeId: "route-a", generation: 1 },
    expectedNativeIdentity: "100",
    sessionBytes: session,
    routeBytes: route,
    resolver: async () => ["93.184.216.34"],
    wireConnector: async () => { throw new Error("must not connect"); },
  }), (error: any) => error.code === "INVALID_REQUEST");
  session.fill(0);
  route.fill(0);
});
