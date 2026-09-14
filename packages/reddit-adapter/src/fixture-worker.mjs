import { createHash } from "node:crypto";
import {
  CORE_ERROR_CODES,
  IPC_PROTOCOL_VERSION,
  MAX_IPC_MESSAGE_BYTES,
  assertBoundedIPCMessage,
  isWriteOperation
} from "./contract.mjs";

const scenario = parseScenario(process.env.SOCIAL_GIT_FIXTURE_SCENARIO);
const ownedNativeIds = new Set(scenario.ownedNativeIds ?? ["t3_owned", "t1_owned"]);
const nativeIdentity = scenario.nativeIdentity ?? "fixture_user";

process.on("message", async (message) => {
  if (!message || message.version !== IPC_PROTOCOL_VERSION || message.kind !== "request") {
    return;
  }

  try {
    assertBoundedIPCMessage(message, MAX_IPC_MESSAGE_BYTES);
    const response = await handleRequest(message);
    send({ version: IPC_PROTOCOL_VERSION, kind: "response", requestId: message.requestId, result: response });
  } catch (error) {
    send({
      version: IPC_PROTOCOL_VERSION,
      kind: "response",
      requestId: message.requestId,
      result: failure("PROTOCOL_DRIFT", "Fixture worker could not map the native response", false, true)
    });
  } finally {
    if (message.session && typeof message.session === "object") {
      message.session.sessionMaterial = undefined;
    }
  }
});

send({ version: IPC_PROTOCOL_VERSION, kind: "ready" });

async function handleRequest(message) {
  if (message.operation === "fixture.diagnostics") {
    return {
      status: "SUCCEEDED",
      data: {
        databaseEnvironmentVisible: Object.keys(process.env).some((name) => /DATABASE|SQLITE|POSTGRES/i.test(name)),
        fixtureWorker: process.env.SOCIAL_GIT_FIXTURE_WORKER === "1",
        workerProcessId: process.pid
      }
    };
  }

  if (message.operation === "action.recover") {
    return recoverAction(message.input?.action);
  }

  const expectedIdentity = message.expectedNativeIdentity;
  if (nativeIdentity !== expectedIdentity) {
    return failure(CORE_ERROR_CODES.WRONG_IDENTITY, "The native account does not match the expected identity", false, true);
  }

  const scenarioFailure = failureForScenario(scenario.outcome);
  if (scenarioFailure) {
    return scenarioFailure;
  }

  if (message.operation === "session.import") {
    return {
      status: "SUCCEEDED",
      operation: message.operation,
      accountId: message.accountId,
      native: { nativeId: "t2_fixtureuser", canonicalUrl: "https://www.reddit.com/user/fixture_user/" },
      data: { nativeIdentity, validated: true },
      rateLimit: standardRateLimit()
    };
  }

  if (isWriteOperation(message.operation)) {
    if (
      scenario.outcome === "crash_before_submit" ||
      (scenario.outcome === "crash_before_submit_once" && message.requestId === "reddit-fixture-1")
    ) {
      setImmediate(() => process.exit(85));
      return new Promise(() => {});
    }

    if (message.operation === "item.deleteOwn" && !ownedNativeIds.has(message.input?.nativeId)) {
      return failure(
        CORE_ERROR_CODES.NOT_CALLER_OWNED,
        "The authenticated account does not own the requested item",
        false,
        false
      );
    }

    const native = nativeForWrite(message.operation, message.input, message.idempotency);
    send({
      version: IPC_PROTOCOL_VERSION,
      kind: "submission_started",
      requestId: message.requestId,
      native,
      submittedAt: "2026-01-01T00:00:01.000Z"
    });

    if (scenario.outcome === "crash_after_submit") {
      setImmediate(() => process.exit(86));
      return new Promise(() => {});
    }

    return successForWrite(message, native);
  }

  return successForRead(message);
}

function failureForScenario(outcome) {
  switch (outcome) {
    case "auth_failure":
      return failure(CORE_ERROR_CODES.AUTHENTICATION_FAILED, "The Reddit session is not authenticated", false, true);
    case "captcha":
      return failure(CORE_ERROR_CODES.CAPTCHA_REQUIRED, "Reddit requires CAPTCHA completion", false, true);
    case "challenge":
      return failure(CORE_ERROR_CODES.CHALLENGE_REQUIRED, "Reddit requires an account challenge", false, true);
    case "checkpoint":
      return failure(CORE_ERROR_CODES.CHECKPOINT_REQUIRED, "Reddit requires account action", false, true);
    case "rate_limit":
      return failure(CORE_ERROR_CODES.RATE_LIMITED, "Reddit rate limit reached", true, false, {
        limit: 60,
        remaining: 0,
        resetAt: "2026-01-01T00:01:00.000Z",
        retryAfterMs: 60_000
      });
    case "revoked":
      return failure(CORE_ERROR_CODES.SESSION_REVOKED, "The Reddit session was revoked", false, true);
    case "protocol_drift":
      return failure(CORE_ERROR_CODES.PROTOCOL_DRIFT, "The native response no longer matches the adapter", false, true);
    default:
      return null;
  }
}

function failure(code, message, retryable, actionRequired, rateLimit) {
  return {
    status: "FAILED",
    error: { code, message, retryable, actionRequired },
    ...(rateLimit ? { rateLimit } : {})
  };
}

function successForRead(message) {
  const input = message.input ?? {};
  const base = {
    status: "SUCCEEDED",
    operation: message.operation,
    accountId: message.accountId,
    rateLimit: standardRateLimit()
  };

  switch (message.operation) {
    case "profile.get":
      return {
        ...base,
        native: { nativeId: "t2_fixtureuser", canonicalUrl: "https://www.reddit.com/user/fixture_user/" },
        data: { username: nativeIdentity, karma: { post: 42, comment: 84 } }
      };
    case "subreddit.get":
      return {
        ...base,
        native: { nativeId: "t5_2qh1i", canonicalUrl: `https://www.reddit.com/r/${input.name}/` },
        data: { name: input.name, subscribers: 1234 }
      };
    case "listing.list":
      return {
        ...base,
        native: null,
        data: {
          items: [fixturePost("t3_fixture", "Fixture post")],
          page: { after: "t3_fixture", before: null }
        }
      };
    case "post.get":
      return { ...base, native: postNative(input.nativeId ?? "t3_fixture"), data: fixturePost(input.nativeId ?? "t3_fixture", "Fixture post") };
    case "comments.list":
      return {
        ...base,
        native: postNative(input.postNativeId ?? "t3_fixture"),
        data: {
          items: [
            {
              nativeId: "t1_fixture",
              canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/fixture/",
              body: "Fixture comment",
              author: nativeIdentity
            }
          ],
          page: { after: null, before: null }
        }
      };
    case "search.query":
      return {
        ...base,
        native: null,
        data: { query: input.query ?? "fixture", items: [fixturePost("t3_fixture", "Fixture search result")], page: { after: null, before: null } }
      };
    default:
      return failure(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Fixture read mapping is missing", false, true);
  }
}

function successForWrite(message, native) {
  const dataByOperation = {
    "post.createText": { created: true, kind: "text_post" },
    "post.createLink": { created: true, kind: "link_post" },
    "post.createMedia": { created: true, kind: "media_post", media: { state: "uploaded" } },
    "comment.create": { created: true, kind: "comment" },
    "reply.create": { created: true, kind: "reply" },
    "vote.set": { applied: true, direction: message.input?.direction ?? 0 },
    "save.set": { saved: true },
    "save.unset": { saved: false },
    "item.deleteOwn": { deleted: true }
  };

  return {
    status: "SUCCEEDED",
    operation: message.operation,
    accountId: message.accountId,
    native,
    data: dataByOperation[message.operation],
    rateLimit: standardRateLimit()
  };
}

function nativeForWrite(operation, input = {}, idempotency = {}) {
  if (["vote.set", "save.set", "save.unset", "item.deleteOwn"].includes(operation)) {
    return nativeForExisting(input.nativeId ?? "t3_owned");
  }

  const suffix = createHash("sha256")
    .update(`${idempotency.callerId ?? "caller"}:${idempotency.key ?? "key"}:${operation}`)
    .digest("hex")
    .slice(0, 10);
  const isComment = operation === "comment.create" || operation === "reply.create";
  const nativeId = `${isComment ? "t1" : "t3"}_${suffix}`;
  return isComment
    ? { nativeId, canonicalUrl: `https://www.reddit.com/r/test/comments/fixture/post/${suffix}/` }
    : { nativeId, canonicalUrl: `https://www.reddit.com/r/test/comments/${suffix}/fixture_post/` };
}

function nativeForExisting(nativeId) {
  if (String(nativeId).startsWith("t1_")) {
    return { nativeId, canonicalUrl: `https://www.reddit.com/r/test/comments/fixture/post/${String(nativeId).slice(3)}/` };
  }
  return postNative(nativeId);
}

function postNative(nativeId) {
  const shortId = String(nativeId).replace(/^t3_/, "");
  return { nativeId, canonicalUrl: `https://www.reddit.com/r/test/comments/${shortId}/fixture_post/` };
}

function fixturePost(nativeId, title) {
  const native = postNative(nativeId);
  return { nativeId: native.nativeId, canonicalUrl: native.canonicalUrl, title, author: nativeIdentity };
}

function standardRateLimit() {
  return { limit: 60, remaining: 59, resetAt: "2026-01-01T00:01:00.000Z" };
}

function recoverAction(action) {
  if (!action || action.state !== "UNKNOWN") {
    return failure(CORE_ERROR_CODES.PROTOCOL_DRIFT, "Recovery requires an UNKNOWN action reference", false, true);
  }
  if (scenario.recoveryOutcome !== "SUCCEEDED") {
    return { status: "UNKNOWN", action: { ...action, recoveryCheckedAt: "2026-01-01T00:00:02.000Z" } };
  }
  return {
    status: "SUCCEEDED",
    operation: action.operation,
    accountId: action.accountId,
    native: action.native,
    data: { recovered: true },
    rateLimit: standardRateLimit()
  };
}

function send(message) {
  assertBoundedIPCMessage(message, MAX_IPC_MESSAGE_BYTES);
  if (process.connected) {
    process.send(message);
  }
}

function parseScenario(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
