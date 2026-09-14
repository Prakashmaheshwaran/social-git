import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  PlatformStopCircuit,
  SECURITY_ERROR_CODES,
  STOP_ERROR_CODES,
  assertExactKeys,
  assertRedditCanonicalUrl,
  decodeBoundedPlatformBody,
  decodeHostilePlatformJson
} from "../src/index.mjs";

test("every mandatory stop opens a platform circuit that route and account rotation cannot bypass", () => {
  for (const code of STOP_ERROR_CODES) {
    const circuit = new PlatformStopCircuit({ now: () => 1234 });
    const event = circuit.observe(binding(), { status: "FAILED", error: { code } });
    assert.equal(event.code, code);
    assert.throws(() => circuit.assertCanDispatch(binding()), hasCode(SECURITY_ERROR_CODES.CIRCUIT_OPEN));
    assert.throws(
      () => circuit.assertCanDispatch({
        ...binding(),
        accountId: "account-rotated",
        routeId: "route-rotated",
        actionId: "action-queued"
      }),
      hasCode(SECURITY_ERROR_CODES.CIRCUIT_OPEN)
    );
  }
});

test("circuits do not reopen on time and require explicit authorization plus a newer generation", () => {
  const circuit = new PlatformStopCircuit({
    now: () => 1234,
    verifyRecoveryAuthorization: (record) => record.id === "recovery-1"
  });
  circuit.observe(binding(), { status: "FAILED", error: { code: "RATE_LIMITED" } });
  assert.throws(
    () => circuit.recover({
      platform: "reddit",
      previousGeneration: 7,
      newGeneration: 7,
      authorization: authorization(7, 7),
      reason: "window ended"
    }),
    hasCode(SECURITY_ERROR_CODES.CIRCUIT_OPEN)
  );
  assert.deepEqual(circuit.recover({
    platform: "reddit",
    previousGeneration: 7,
    newGeneration: 8,
    authorization: authorization(7, 8),
    reason: "manual recovery after verification"
  }), {
    platform: "reddit",
    previousGeneration: 7,
    newGeneration: 8,
    authorizationId: "recovery-1",
    reason: "manual recovery after verification"
  });
  assert.equal(circuit.assertCanDispatch({ ...binding(), generation: 8 }), true);
  assert.throws(
    () => circuit.assertCanDispatch(binding()),
    hasCode(SECURITY_ERROR_CODES.CIRCUIT_OPEN)
  );
});

function authorization(previousGeneration, newGeneration) {
  return {
    id: "recovery-1",
    kind: "platform_stop_recovery",
    platform: "reddit",
    previousGeneration,
    newGeneration,
    approvedBy: "reviewer-1",
    approvedAtEpochMs: 1234
  };
}

test("hostile platform JSON is bounded, strictly projected, inert, and immutable", () => {
  const frame = Buffer.from(JSON.stringify({
    data: {
      id: "fixture",
      name: "t3_fixture",
      permalink: "/r/test/comments/fixture/post/",
      selftext_html: "<script>steal()</script>",
      unexpected: "library-object-field"
    }
  }));
  const projected = decodeHostilePlatformJson(frame, (raw) => {
    assertExactKeys(raw, ["data"]);
    assertExactKeys(raw.data, ["id", "name", "permalink"], ["selftext_html", "unexpected"]);
    return {
      nativeId: raw.data.name,
      canonicalUrl: assertRedditCanonicalUrl(`https://www.reddit.com${raw.data.permalink}`)
    };
  });
  assert.deepEqual(projected, {
    nativeId: "t3_fixture",
    canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/"
  });
  assert.equal(JSON.stringify(projected).includes("script"), false);
  assert.equal(JSON.stringify(projected).includes("library-object-field"), false);
  assert.throws(() => { projected.nativeId = "changed"; }, TypeError);
});

test("hostile platform JSON rejects oversize, deep data, malformed Unicode, active output, and bad URLs", () => {
  assert.throws(
    () => decodeHostilePlatformJson(Buffer.alloc(2 * 1024 * 1024 + 1), () => ({})),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  let nested = "leaf";
  for (let index = 0; index < 14; index += 1) nested = { child: nested };
  assert.throws(
    () => decodeHostilePlatformJson(Buffer.from(JSON.stringify(nested)), (value) => value),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  assert.throws(
    () => decodeHostilePlatformJson(Buffer.from('{"value":"\\ud800"}'), (value) => value),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  assert.throws(
    () => decodeHostilePlatformJson(Buffer.from("{}"), () => ({ body_html: "<b>unsafe</b>" })),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  assert.throws(
    () => decodeHostilePlatformJson(Buffer.from("{}"), () => ({ proxyUrl: "https://proxy.test" })),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  for (const url of ["http://www.reddit.com/r/test", "https://evil.test/r/test", "javascript:alert(1)"]) {
    assert.throws(() => assertRedditCanonicalUrl(url), hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS));
  }
});

test("platform decompression rejects bombs and unknown encodings before JSON parsing", () => {
  const compactBomb = gzipSync(Buffer.alloc(128 * 1024, 0x41));
  assert.throws(
    () => decodeBoundedPlatformBody(compactBomb, "gzip", {
      maxCompressedBytes: 1024,
      maxDecompressedBytes: 4096
    }),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  assert.throws(
    () => decodeBoundedPlatformBody(Buffer.from("{}"), "compress"),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  assert.deepEqual(decodeBoundedPlatformBody(gzipSync(Buffer.from("{}")), "gzip"), Buffer.from("{}"));
});

function binding() {
  return {
    platform: "reddit",
    tenantId: "tenant-1",
    accountId: "account-1",
    routeId: "route-1",
    generation: 7,
    actionId: "action-1"
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
