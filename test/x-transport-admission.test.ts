import assert from "node:assert/strict";
import test from "node:test";

type Fixture = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
};

type Page = { items: { nativeId: string; text: string }[]; nextCursor: string | null };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PROTOCOL_DRIFT");
  return value as Record<string, unknown>;
}

function decodePage(response: Fixture, previousCursor: string | null = null): Page {
  if (response.status === 429 || response.headers?.["x-rate-limit-remaining"] === "0") throw new Error("RATE_LIMITED");
  if (response.status === 401) throw new Error("SESSION_REVOKED");
  if (response.status === 403) throw new Error("ACCESS_DENIED");
  if (response.status !== 200) throw new Error("PROTOCOL_DRIFT");
  const body = record(response.body);
  if (body.errors !== undefined) throw new Error("UPSTREAM_ERROR");
  const timeline = record(record(body.data).timeline);
  if (!Array.isArray(timeline.entries) || timeline.entries.length > 100) throw new Error("PROTOCOL_DRIFT");
  const items: Page["items"] = [];
  let nextCursor: string | null = null;
  for (const entry of timeline.entries) {
    const content = record(record(entry).content);
    if (content.entryType === "TimelineTimelineCursor") {
      if (content.cursorType !== "Bottom" || nextCursor !== null || typeof content.value !== "string" || content.value.length < 1 || content.value.length > 512 || content.value === previousCursor) throw new Error("PROTOCOL_DRIFT");
      nextCursor = content.value;
    } else if (content.entryType === "TimelineTimelineItem") {
      const result = record(record(record(content.itemContent).tweet_results).result);
      const legacy = record(result.legacy);
      if (result.__typename !== "Tweet" || typeof result.rest_id !== "string" || !/^\d+$/.test(result.rest_id) || typeof legacy.full_text !== "string") throw new Error("PROTOCOL_DRIFT");
      items.push({ nativeId: result.rest_id, text: legacy.full_text });
    } else {
      throw new Error("PROTOCOL_DRIFT");
    }
  }
  return { items, nextCursor };
}

function fixture(entries: unknown[]): Fixture {
  return { status: 200, body: { data: { timeline: { entries } } } };
}

const tweet = { content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: { __typename: "Tweet", rest_id: "1001", legacy: { full_text: "Synthetic fixture" }, ignored: "not exported" } } } } };
const cursor = { content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "opaque-fixture-cursor" } };

test("synthetic X-shaped page normalizes without leaking upstream objects", () => {
  assert.deepEqual(decodePage(fixture([tweet, cursor])), { items: [{ nativeId: "1001", text: "Synthetic fixture" }], nextCursor: "opaque-fixture-cursor" });
  assert.deepEqual(decodePage(fixture([])), { items: [], nextCursor: null });
});

test("pagination stops on repeated or ambiguous cursors", () => {
  assert.throws(() => decodePage(fixture([cursor]), "opaque-fixture-cursor"), /PROTOCOL_DRIFT/);
  assert.throws(() => decodePage(fixture([cursor, cursor])), /PROTOCOL_DRIFT/);
});

test("rate limit and session failures are terminal signals", () => {
  for (const [status, code] of [[429, "RATE_LIMITED"], [401, "SESSION_REVOKED"], [403, "ACCESS_DENIED"], [302, "PROTOCOL_DRIFT"], [503, "PROTOCOL_DRIFT"]] as const) {
    assert.throws(() => decodePage({ status, body: null }), new RegExp(code));
  }
  assert.throws(() => decodePage({ ...fixture([]), headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "2000000000" } }), /RATE_LIMITED/);
});

test("malformed and partial responses never become empty success", () => {
  for (const body of ["<html>checkpoint</html>", {}, { data: {} }, { errors: [{ code: 326 }], data: { timeline: { entries: [] } } }]) {
    assert.throws(() => decodePage({ status: 200, body }));
  }
  assert.throws(() => decodePage(fixture([{ content: { entryType: "Unknown" } }])), /PROTOCOL_DRIFT/);
  assert.throws(() => decodePage(fixture(Array(101).fill(tweet))), /PROTOCOL_DRIFT/);
  const missingId = structuredClone(tweet);
  missingId.content.itemContent.tweet_results.result.rest_id = "";
  assert.throws(() => decodePage(fixture([missingId])), /PROTOCOL_DRIFT/);
});

test("production capabilities remain disabled; ambiguous writes remain unknown", () => {
  const admission = Object.freeze({ liveReads: false, liveWrites: false, browser: false, credentials: false });
  const classifyWrite = (submissionMayHaveStarted: boolean) => submissionMayHaveStarted ? "UNKNOWN" : "NOT_SUBMITTED";
  assert.equal(admission.liveReads, false);
  assert.equal(admission.liveWrites, false);
  assert.equal(classifyWrite(true), "UNKNOWN");
  assert.equal(classifyWrite(false), "NOT_SUBMITTED");
});
