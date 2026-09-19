import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { decodeWorkerMessage, encodeWorkerMessage } from "@social-git/core";
import { RemoteXCommandDispatcher, XRuntimeError, sanitizeXWorkerFailure, X_WORKER_FAIL_CLOSED_MESSAGE } from "../src/runtime-x.ts";
import { createXWorkerHttpServer } from "../src/x-worker-http.ts";
import { X_COMMAND_MAC_CONTEXT, XCommandMacSigner } from "../src/x-ipc-auth.ts";

const ADMITTED = Object.freeze({ requested: true, enabled: true, productionEnabled: true, disabledReasons: [] });
const KEY = Buffer.alloc(32, 0xb7);

function workerCommand() {
  return encodeWorkerMessage({
    version: 1, type: "social-git.worker.command", requestId: "req-1",
    tenantId: "tenant-x", accountId: "x-account", platform: "x", generation: 1,
    leaseId: "lease-1", fence: 1, expiresAt: 1_900_000_000_000,
    intent: "read", operation: "profile.get", expectedNativeIdentity: "100",
    sessionBase64: Buffer.from('{"cookies":{"auth_token":"s","ct0":"c"}}').toString("base64url"),
    networkRoute: { id: "x-direct", materialBase64: Buffer.from('{"kind":"direct"}').toString("base64url") },
    payload: {},
  });
}

async function roundTrip(dispatcherExecute: (serialized: Uint8Array) => Promise<{ message: Uint8Array; error?: any; platformResult?: any }>) {
  const server = createXWorkerHttpServer({ admission: ADMITTED, commandKey: KEY, dispatcher: { ready: async () => true, execute: dispatcherExecute } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const remote = new RemoteXCommandDispatcher(`http://127.0.0.1:${(address as any).port}/v1/dispatch`, KEY);
  try {
    return await remote.execute(workerCommand());
  } finally {
    remote.close();
    server.close();
    await once(server, "close");
  }
}

test("X worker boundary never forwards upstream messages, even for allowlisted codes", async () => {
  const sentinel = "upstream: auth_token=secret cookie=SENTINEL_X_123";
  const result = await roundTrip(async (serialized) => {
    const command = decodeWorkerMessage(serialized);
    if (command.type !== "social-git.worker.command") throw new Error("bad command");
    const message = encodeWorkerMessage({
      version: 1, type: "social-git.worker.result", requestId: (command as any).requestId,
      tenantId: (command as any).tenantId, accountId: (command as any).accountId,
      platform: "x", generation: (command as any).generation, leaseId: (command as any).leaseId,
      fence: (command as any).fence, status: "PROTOCOL_DRIFT", observedNativeIdentity: "100",
    });
    return { message, error: new XRuntimeError("RATE_LIMITED", sentinel, { retryable: true, rateLimit: { limit: 50, remaining: 0 } }) };
  });
  assert.ok(result.error);
  assert.equal(result.error.code, "RATE_LIMITED");
  assert.equal(result.error.message, X_WORKER_FAIL_CLOSED_MESSAGE);
  assert.equal(String(result.error.message).includes("SENTINEL_X_123"), false);
  assert.equal(String(result.error.message).includes("auth_token"), false);
  assert.deepEqual(result.error.rateLimit, { limit: 50, remaining: 0 });
  result.message.fill(0);
});

test("X worker boundary maps unknown codes to PROTOCOL_DRIFT with a fixed message", async () => {
  const result = await roundTrip(async (serialized) => {
    const command = decodeWorkerMessage(serialized) as any;
    const message = encodeWorkerMessage({
      version: 1, type: "social-git.worker.result", requestId: command.requestId,
      tenantId: command.tenantId, accountId: command.accountId,
      platform: "x", generation: command.generation, leaseId: command.leaseId,
      fence: command.fence, status: "PROTOCOL_DRIFT", observedNativeIdentity: "100",
    });
    return { message, error: new XRuntimeError("EVIL_INJECTED", "evil upstream text exfiltrating session", { retryable: true }) };
  });
  assert.ok(result.error);
  assert.equal(result.error.code, "PROTOCOL_DRIFT");
  assert.equal(result.error.message, X_WORKER_FAIL_CLOSED_MESSAGE);
  result.message.fill(0);
});

test("sanitizeXWorkerFailure preserves allowlisted flags and drops non-allowlisted rateLimit keys", () => {
  const sanitized = sanitizeXWorkerFailure({ code: "SESSION_REVOKED", retryable: false, actionRequired: true, submissionMayHaveStarted: false, rateLimit: { limit: 15 } });
  assert.equal(sanitized.code, "SESSION_REVOKED");
  assert.equal(sanitized.message, X_WORKER_FAIL_CLOSED_MESSAGE);
  assert.deepEqual(sanitized.rateLimit, { limit: 15 });
  assert.throws(() => sanitizeXWorkerFailure({ code: "RATE_LIMITED", rateLimit: { evil: "exfil" } as any }));
});
