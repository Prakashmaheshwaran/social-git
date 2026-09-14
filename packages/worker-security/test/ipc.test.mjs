import assert from "node:assert/strict";
import test from "node:test";
import {
  IpcFence,
  SECURITY_ERROR_CODES,
  decodeCoreRequest,
  decodeWorkerResponse,
  encodeCoreRequest,
  encodeWorkerResponse
} from "../src/index.mjs";

test("strict IPC accepts one fully bound response", () => {
  const request = makeRequest();
  const response = makeResponse();
  assert.deepEqual(decodeCoreRequest(encodeCoreRequest(request)), request);
  assert.deepEqual(decodeWorkerResponse(encodeWorkerResponse(response)), response);

  const fence = new IpcFence();
  fence.register("peer-1", request);
  const outcome = fence.accept("peer-1", response, request.deadlineEpochMs - 1);
  assert.deepEqual(outcome, { status: "SUCCEEDED", nativeId: "t3_fixture" });
  assert.equal(fence.pendingCount, 0);
  assert.throws(() => fence.accept("peer-1", response), hasCode(SECURITY_ERROR_CODES.IPC_FENCE));
});

test("IPC rejects unknown fields, malformed encoding, depth, strings, and oversized frames", () => {
  const unknown = { ...makeRequest(), proxyUrl: "http://127.0.0.1:8080" };
  assert.throws(() => encodeCoreRequest(unknown), hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA));
  assert.throws(() => decodeCoreRequest(Buffer.from([0xff, 0xfe])), hasCode(SECURITY_ERROR_CODES.IPC_BOUNDS));

  let nested = "leaf";
  for (let index = 0; index < 14; index += 1) {
    nested = { child: nested };
  }
  assert.throws(
    () => encodeCoreRequest({ ...makeRequest(), payload: nested }),
    hasCode(SECURITY_ERROR_CODES.IPC_BOUNDS)
  );
  assert.throws(
    () => encodeCoreRequest({ ...makeRequest(), payload: { text: "\ud800" } }),
    hasCode(SECURITY_ERROR_CODES.IPC_BOUNDS)
  );
  assert.throws(
    () => decodeCoreRequest(Buffer.alloc(64 * 1024 + 1, 0x20)),
    hasCode(SECURITY_ERROR_CODES.IPC_BOUNDS)
  );
});

test("IPC fences wrong peers, changed bindings, late responses, and worker-selected authority", () => {
  const request = makeRequest();
  const fence = new IpcFence();
  fence.register("peer-1", request);

  assert.throws(
    () => fence.accept("peer-other", makeResponse(), request.deadlineEpochMs - 1),
    hasCode(SECURITY_ERROR_CODES.IPC_FENCE)
  );
  assert.throws(
    () => fence.accept("peer-1", { ...makeResponse(), accountId: "account-other" }, request.deadlineEpochMs - 1),
    hasCode(SECURITY_ERROR_CODES.IPC_FENCE)
  );
  assert.throws(
    () => encodeWorkerResponse({
      ...makeResponse(),
      outcome: { status: "SUCCEEDED", routeId: "route-worker-choice" }
    }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
  );
  assert.throws(
    () => fence.accept("peer-1", makeResponse(), request.deadlineEpochMs + 1),
    hasCode(SECURITY_ERROR_CODES.IPC_FENCE)
  );
  assert.equal(fence.pendingCount, 0);
});

test("IPC rejects duplicate registrations and explicitly expires silent requests", () => {
  const request = makeRequest();
  const fence = new IpcFence();
  fence.register("peer-1", request);
  assert.throws(() => fence.register("peer-1", request), hasCode(SECURITY_ERROR_CODES.IPC_FENCE));
  assert.deepEqual(fence.expire(request.deadlineEpochMs + 1), [request.requestId]);
  assert.throws(
    () => fence.accept("peer-1", makeResponse(), request.deadlineEpochMs + 2),
    hasCode(SECURITY_ERROR_CODES.IPC_FENCE)
  );
});

function makeRequest() {
  return {
    protocolVersion: 1,
    kind: "request",
    requestId: "request-1",
    actionId: "action-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    routeId: "route-1",
    generation: 7,
    capability: "reddit.read.profile",
    deadlineEpochMs: 2_000_000_000_000,
    payload: { operation: "profile.get" }
  };
}

function makeResponse() {
  const request = makeRequest();
  return {
    protocolVersion: 1,
    kind: "response",
    requestId: request.requestId,
    actionId: request.actionId,
    tenantId: request.tenantId,
    accountId: request.accountId,
    routeId: request.routeId,
    generation: request.generation,
    capability: request.capability,
    sequence: 1,
    outcome: { status: "SUCCEEDED", nativeId: "t3_fixture" }
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
