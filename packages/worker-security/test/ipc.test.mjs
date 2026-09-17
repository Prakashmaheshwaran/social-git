import assert from "node:assert/strict";
import test from "node:test";
import {
  IpcFence,
  BoundedFrameDecoder,
  SECURITY_ERROR_CODES,
  decodeCoreRequest,
  decodeWorkerResponse,
  encodeCoreRequest,
  encodeLengthPrefixedFrame,
  encodeWorkerEvent,
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

test("IPC accepts one bound submission event before one terminal response", () => {
  const request = makeRequest();
  const event = {
    ...makeResponse(),
    kind: "event",
    event: {
      type: "SUBMISSION_STARTED",
      native: { nativeId: "t3_fixture", canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/" },
      submittedAt: "2026-01-01T00:00:00.000Z"
    }
  };
  delete event.outcome;
  const response = { ...makeResponse(), sequence: 2 };
  assert.ok(encodeWorkerEvent(event).byteLength > 0);
  const fence = new IpcFence();
  fence.register("peer-1", request);
  assert.equal(fence.accept("peer-1", event).type, "SUBMISSION_STARTED");
  assert.deepEqual(fence.accept("peer-1", response), response.outcome);
  assert.throws(() => fence.accept("peer-1", response), hasCode(SECURITY_ERROR_CODES.IPC_FENCE));
});

test("IPC admits only target-bound Reddit t4 message references for candidate fixtures", () => {
  const event = {
    ...makeResponse(),
    kind: "event",
    event: {
      type: "SUBMISSION_STARTED",
      native: { nativeId: "t4_fixture", canonicalUrl: "https://www.reddit.com/message/messages/fixture" },
      submittedAt: "2026-01-01T00:00:00.000Z"
    }
  };
  delete event.outcome;
  assert.ok(encodeWorkerEvent(event).byteLength > 0);
  assert.throws(() => encodeWorkerEvent({
    ...event,
    event: { ...event.event, native: { ...event.event.native, canonicalUrl: "https://www.reddit.com/message/messages/other" } }
  }), hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA));
});

test("IPC rejects forged Reddit submission references before fencing or storage", () => {
  const valid = {
    ...makeResponse(),
    kind: "event",
    event: {
      type: "SUBMISSION_STARTED",
      native: { nativeId: "t3_fixture", canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/" },
      submittedAt: "2026-01-01T00:00:00.000Z"
    }
  };
  delete valid.outcome;

  assert.throws(
    () => encodeWorkerEvent({
      ...valid,
      event: { ...valid.event, native: { ...valid.event.native, nativeId: "not_a_reddit_fullname" } }
    }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
  );
  assert.throws(
    () => encodeWorkerEvent({
      ...valid,
      event: { ...valid.event, native: { ...valid.event.native, canonicalUrl: "https://www.reddit.com.evil/r/test/" } }
    }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
  );
  assert.throws(
    () => encodeWorkerEvent({
      ...valid,
      event: { ...valid.event, native: { ...valid.event.native, canonicalUrl: "https://www.reddit.com/r/test/comments/other/post/" } }
    }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
  );
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

test("byte framing rejects an oversized declaration before allocating or parsing JSON", () => {
  let called = false;
  const decoder = new BoundedFrameDecoder({ maxBytes: 64 * 1024, onFrame: () => { called = true; } });
  const header = Buffer.alloc(4);
  header.writeUInt32BE(64 * 1024 + 1);
  assert.throws(() => decoder.push(header), hasCode(SECURITY_ERROR_CODES.IPC_BOUNDS));
  assert.equal(called, false);
  assert.throws(
    () => encodeLengthPrefixedFrame(Buffer.alloc(64 * 1024 + 1), 64 * 1024),
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
    () => encodeWorkerResponse({ ...makeResponse(), outcome: "SUCCEEDED" }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
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
    payload: { operation: "profile.get", input: {} }
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
