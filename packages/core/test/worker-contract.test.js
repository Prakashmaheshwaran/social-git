import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WORKER_MESSAGE_BYTES,
  createSafeLogger,
  decodeWorkerMessage,
  encodeWorkerMessage,
  redact,
  summarizeWorkerMessage
} from "../src/index.js";
import * as workerBoundary from "../src/worker-contract.js";

function command(overrides = {}) {
  return {
    version: 1,
    type: "social-git.worker.command",
    requestId: "request-1",
    tenantId: "tenant-a",
    accountId: "account-a",
    platform: "reddit",
    generation: 1,
    leaseId: "lease-1",
    fence: 1,
    expiresAt: 1_900_000_000_000,
    intent: "read",
    operation: "post.get",
    expectedNativeIdentity: "native-id",
    sessionBase64: Buffer.from("session").toString("base64url"),
    networkRoute: {
      id: "route-a",
      materialBase64: Buffer.from("route").toString("base64url")
    },
    payload: { postId: "synthetic" },
    ...overrides
  };
}

test("worker codec round trips bounded versioned messages", () => {
  const encoded = encodeWorkerMessage(command());
  assert.ok(encoded.byteLength < MAX_WORKER_MESSAGE_BYTES);
  assert.deepEqual(decodeWorkerMessage(encoded), command());
  assert.deepEqual(summarizeWorkerMessage(command()), {
    version: 1,
    type: "social-git.worker.command",
    requestId: "request-1",
    tenantId: "tenant-a",
    accountId: "account-a",
    platform: "reddit",
    generation: 1,
    leaseId: "lease-1",
    fence: 1,
    intent: "read",
    operation: "post.get"
  });
});

test("worker codec rejects oversized, malformed, and secret-bearing result shapes", () => {
  assert.throws(
    () => encodeWorkerMessage(command({ payload: { value: "x".repeat(MAX_WORKER_MESSAGE_BYTES) } })),
    (error) => error.code === "MESSAGE_TOO_LARGE"
  );
  assert.throws(
    () => decodeWorkerMessage(Buffer.alloc(MAX_WORKER_MESSAGE_BYTES + 1)),
    (error) => error.code === "MESSAGE_TOO_LARGE"
  );
  assert.throws(
    () => decodeWorkerMessage(Uint8Array.from([0xff, 0xfe])),
    (error) => error.code === "MALFORMED_MESSAGE"
  );
  assert.throws(
    () => encodeWorkerMessage({
      version: 1,
      type: "social-git.worker.result",
      requestId: "request-1",
      tenantId: "tenant-a",
      accountId: "account-a",
      platform: "reddit",
      generation: 1,
      leaseId: "lease-1",
      fence: 1,
      status: "SUCCEEDED",
      observedNativeIdentity: "native-id",
      sessionBase64: Buffer.from("must-not-return").toString("base64url")
    }),
    (error) => error.code === "MALFORMED_MESSAGE"
  );
});

test("safe logging redacts bytes, keyed secrets, headers, and generic errors", () => {
  const entries = [];
  const logger = createSafeLogger((level, message, fields) => entries.push({ level, message, fields }));
  logger.info("Authorization: Bearer bearer-value", {
    sessionBase64: "encoded-session",
    nested: {
      cookie: "cookie-value",
      csrfToken: "csrf-value",
      safe: "visible"
    },
    bytes: Buffer.from("opaque")
  });
  logger.error("cookie=session-value", { error: new Error("raw database detail") });

  const output = JSON.stringify(entries);
  for (const secret of [
    "bearer-value",
    "encoded-session",
    "cookie-value",
    "csrf-value",
    "session-value",
    "opaque",
    "raw database detail"
  ]) {
    assert.equal(output.includes(secret), false);
  }
  assert.equal(output.includes("visible"), true);
  assert.deepEqual(redact({ accessToken: "token", safe: 1 }), {
    accessToken: "[REDACTED]",
    safe: 1
  });
});

test("the worker module does not expose database, backup, or key custody APIs", () => {
  for (const forbidden of [
    "SessionRuntime",
    "SessionEnvelopeCrypto",
    "restoreEncryptedBackup",
    "createEncryptedBackupFile"
  ]) {
    assert.equal(Object.hasOwn(workerBoundary, forbidden), false);
  }
});
