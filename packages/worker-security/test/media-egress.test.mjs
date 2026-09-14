import assert from "node:assert/strict";
import test from "node:test";
import {
  REDDIT_MEDIA_PROCESS_POLICY,
  REDDIT_MEDIA_UPLOAD_TARGET_POLICY,
  createRedditMediaUploadAuthority,
  receiveRedditMediaProcessMessage
} from "../src/index.mjs";

const BINDING = Object.freeze({ tenantId: "tenant-1", accountId: "account-1", routeId: "route-1", generation: 1 });
const PUBLIC = "93.184.216.34";

test("media upload authority admits only the pinned Reddit S3 destination without redirects", async () => {
  const calls = [];
  const authority = createRedditMediaUploadAuthority({
    route: BINDING,
    resolver: async (hostname) => {
      assert.equal(hostname, "reddit-uploaded-media.s3-accelerate.amazonaws.com");
      return [PUBLIC];
    },
    connector: async (request) => {
      calls.push(request);
      return { status: 204, headers: {}, body: Buffer.alloc(0), remoteAddress: request.selectedAddress };
    },
    now: () => 1_000
  });
  const response = await authority.request(authority.issueLease(BINDING), {
    method: "POST",
    path: "/",
    body: Buffer.from("bounded multipart"),
    deadlineEpochMs: 2_000
  });
  assert.equal(response.status, 204);
  assert.equal(calls[0].url, `${REDDIT_MEDIA_UPLOAD_TARGET_POLICY.origin}/`);
  assert.equal("headers" in calls[0], false);

  await assert.rejects(
    authority.request(authority.issueLease(BINDING), {
      method: "POST",
      path: "//attacker.example/upload",
      body: Buffer.alloc(0),
      deadlineEpochMs: 2_000
    }),
    (error) => error.code === "DESTINATION_DENIED"
  );
});

test("media process receiver DNS-pins the exact WSS host and bounds the result", async () => {
  const message = Buffer.from('{"type":"success","payload":{"redirect":"/r/test/comments/abc/title/"}}');
  const received = await receiveRedditMediaProcessMessage({
    url: `${REDDIT_MEDIA_PROCESS_POLICY.origin}/ticket?m=opaque`,
    resolver: async (hostname) => {
      assert.equal(hostname, "wss.redditmedia.com");
      return [PUBLIC];
    },
    connector: async (request) => {
      assert.equal(request.selectedAddress, PUBLIC);
      assert.equal(request.serverName, "wss.redditmedia.com");
      return { data: message, remoteAddress: PUBLIC };
    },
    deadlineEpochMs: 2_000,
    now: () => 1_000
  });
  assert.deepEqual(received, message);
});

test("media process receiver rejects alternate hosts, private DNS, peer changes, and oversized messages", async () => {
  const base = {
    url: "wss://wss.redditmedia.com/ticket",
    deadlineEpochMs: 2_000,
    now: () => 1_000
  };
  await assert.rejects(
    receiveRedditMediaProcessMessage({ ...base, url: "wss://attacker.example/ticket", resolver: async () => [PUBLIC], connector: async () => ({}) }),
    (error) => error.code === "DESTINATION_DENIED"
  );
  await assert.rejects(
    receiveRedditMediaProcessMessage({ ...base, resolver: async () => ["127.0.0.1"], connector: async () => ({}) }),
    (error) => error.code === "DESTINATION_DENIED"
  );
  await assert.rejects(
    receiveRedditMediaProcessMessage({ ...base, resolver: async () => [PUBLIC], connector: async () => ({ data: "{}", remoteAddress: "1.1.1.1" }) }),
    (error) => error.code === "DNS_REBINDING"
  );
  await assert.rejects(
    receiveRedditMediaProcessMessage({ ...base, resolver: async () => [PUBLIC], connector: async () => ({ data: "x".repeat(65), remoteAddress: PUBLIC }), maxMessageBytes: 64 }),
    (error) => error.code === "RESPONSE_BOUNDS"
  );
});
