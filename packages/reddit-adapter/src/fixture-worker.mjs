import { createHash } from "node:crypto";
import {
  BoundedFrameDecoder,
  WORKER_IPC_VERSION,
  assertEffectiveWorkerPermissions,
  decodeCoreRequest,
  encodeBoundedJson,
  encodeWorkerEvent,
  encodeWorkerResponse,
  writeLengthPrefixedFrame
} from "../../worker-security/src/index.mjs";
import {
  CORE_ERROR_CODES,
  MAX_IPC_MESSAGE_BYTES,
  REDDIT_CAPABILITIES,
  isWriteOperation
} from "./contract.mjs";
import { validateOperationInput, validateWorkerSession } from "./validation.mjs";

const runtime = assertEffectiveWorkerPermissions();
const scenario = parseScenario(process.env.SOCIAL_GIT_FIXTURE_SCENARIO);
const ownedNativeIds = new Set(scenario.ownedNativeIds ?? ["t3_owned", "t1_owned"]);
const nativeIdentity = scenario.nativeIdentity ?? "fixture_user";
const submittedRequests = new Set();
const capabilityByOperation = new Map(REDDIT_CAPABILITIES.map((item) => [item.operation, item.authorizationScope]));
let processing = Promise.resolve();

const decoder = new BoundedFrameDecoder({
  maxBytes: MAX_IPC_MESSAGE_BYTES,
  onFrame(frame) {
    processing = processing.then(() => handleFrame(frame)).catch(() => process.exit(84));
  }
});
process.stdin.on("data", (chunk) => decoder.push(chunk));
process.stdin.on("end", () => decoder.end());

await sendRaw({ protocolVersion: WORKER_IPC_VERSION, kind: "ready", pid: process.pid, runtime });

async function handleFrame(frame) {
  const request = decodeCoreRequest(frame);
  validateRequest(request);
  try {
    const outcome = await handleRequest(request);
    const response = boundMessage(request, {
      kind: "response",
      sequence: submittedRequests.has(request.requestId) ? 2 : 1,
      outcome
    });
    await writeLengthPrefixedFrame(process.stdout, encodeWorkerResponse(response), MAX_IPC_MESSAGE_BYTES);
  } catch (error) {
    const response = boundMessage(request, {
      kind: "response",
      sequence: submittedRequests.has(request.requestId) ? 2 : 1,
      outcome: failure("PROTOCOL_DRIFT", "Fixture worker could not map the native response", false, true)
    });
    await writeLengthPrefixedFrame(process.stdout, encodeWorkerResponse(response), MAX_IPC_MESSAGE_BYTES);
  } finally {
    if (request.payload.session && typeof request.payload.session === "object") {
      request.payload.session.sessionMaterial = undefined;
    }
  }
}

function validateRequest(request) {
  const operation = request.payload.operation;
  const expectedCapability = capabilityForOperation(operation);
  if (request.capability !== expectedCapability) throw new Error("capability mismatch");
  if (operation === "fixture.diagnostics") return;
  if (operation === "action.recover") {
    validateRecoveryAction(request.payload.input?.action);
  } else if (operation !== "session.import") {
    validateOperationInput(operation, request.payload.input);
  }
  const expectedNativeIdentity = request.payload.expectedNativeIdentity;
  validateWorkerSession(request.payload.session, {
    accountId: request.accountId,
    expectedNativeIdentity
  });
  if (request.payload.session.generation !== request.generation) throw new Error("generation mismatch");
  if (isWriteOperation(operation)) {
    exact(request.payload.idempotency, ["callerId", "key"]);
  } else if (request.payload.idempotency !== undefined) {
    throw new Error("read request has idempotency authority");
  }
}

function validateRecoveryAction(action) {
  exact(action, [
    "state", "operation", "accountId", "callerId", "idempotencyKey",
    "submittedAt", "native", "retryPermitted"
  ], ["recoveryCheckedAt"]);
  if (action.state !== "UNKNOWN" || action.retryPermitted !== false) throw new Error("bad recovery");
}

function exact(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("not plain");
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("wrong fields");
  }
}

async function handleRequest(request) {
  const message = {
    requestId: request.requestId,
    operation: request.payload.operation,
    input: request.payload.input,
    accountId: request.accountId,
    expectedNativeIdentity: request.payload.expectedNativeIdentity,
    session: request.payload.session,
    idempotency: request.payload.idempotency
  };
  if (message.operation === "fixture.diagnostics") {
    return success(null, {
      databaseEnvironmentVisible: Object.keys(process.env).some((name) => /DATABASE|SQLITE|POSTGRES/i.test(name)),
      fixtureWorker: process.env.SOCIAL_GIT_FIXTURE_WORKER === "1",
      workerProcessId: process.pid,
      runtime
    });
  }
  if (message.operation === "action.recover") return recoverAction(message.input.action);

  if (nativeIdentity !== message.expectedNativeIdentity) {
    return failure(CORE_ERROR_CODES.WRONG_IDENTITY, "The native account does not match the expected identity", false, true);
  }
  const scenarioFailure = failureForScenario(scenario.outcome);
  if (scenarioFailure) return scenarioFailure;

  if (message.operation === "session.import") {
    return success(
      { nativeId: "t2_fixtureuser", canonicalUrl: "https://www.reddit.com/user/fixture_user/" },
      { nativeIdentity, validated: true }
    );
  }

  if (isWriteOperation(message.operation)) {
    if (
      scenario.outcome === "crash_before_submit" ||
      (scenario.outcome === "crash_before_submit_once" && message.requestId === "reddit-fixture-1")
    ) {
      setImmediate(() => process.exit(85));
      return new Promise(() => {});
    }
    if (["item.editOwn", "item.deleteOwn"].includes(message.operation) && !ownedNativeIds.has(message.input?.nativeId)) {
      return failure(CORE_ERROR_CODES.NOT_CALLER_OWNED, "The authenticated account does not own the requested item", false, false);
    }

    const native = nativeForWrite(message.operation, message.input, message.idempotency);
    let submissionNative = native;
    if (scenario.outcome === "malformed_submission_event") {
      submissionNative = {
        nativeId: "not_a_reddit_fullname",
        canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/"
      };
    } else if (scenario.outcome === "wrong_target_submission_event") {
      submissionNative = {
        nativeId: native.nativeId,
        canonicalUrl: `https://www.reddit.com/r/other/comments/${native.nativeId.slice(3)}/fixture_post/`
      };
    }
    const submittedAt = "2026-01-01T00:00:01.000Z";
    const event = boundMessage(request, {
      kind: "event",
      sequence: 1,
      event: { type: "SUBMISSION_STARTED", native: submissionNative, submittedAt }
    });
    const encodedEvent = scenario.outcome === "malformed_submission_event"
      ? encodeBoundedJson(event)
      : encodeWorkerEvent(event);
    await writeLengthPrefixedFrame(process.stdout, encodedEvent, MAX_IPC_MESSAGE_BYTES);
    submittedRequests.add(request.requestId);

    if (scenario.outcome === "crash_after_submit") {
      setImmediate(() => process.exit(86));
      return new Promise(() => {});
    }
    if (scenario.outcome === "malformed_result_after_submit") {
      return success(native, { created: "yes", kind: "text_post" });
    }
    if (scenario.outcome === "mismatched_terminal_native") {
      const otherNative = {
        nativeId: "t3_other",
        canonicalUrl: `https://www.reddit.com/r/${message.input.subreddit}/comments/other/fixture_post/`
      };
      return successForWrite(message, otherNative);
    }
    return successForWrite(message, native);
  }
  return successForRead(message);
}

function boundMessage(request, message) {
  return {
    protocolVersion: WORKER_IPC_VERSION,
    kind: message.kind,
    requestId: request.requestId,
    actionId: request.actionId,
    tenantId: request.tenantId,
    accountId: request.accountId,
    routeId: request.routeId,
    generation: request.generation,
    capability: request.capability,
    sequence: message.sequence,
    ...(message.kind === "event" ? { event: message.event } : { outcome: message.outcome })
  };
}

function capabilityForOperation(operation) {
  if (capabilityByOperation.has(operation)) return capabilityByOperation.get(operation);
  if (operation === "session.import") return "reddit.session.import";
  if (operation === "action.recover") return "reddit.action.recover";
  if (operation === "fixture.diagnostics") return "reddit.fixture.diagnostics";
  throw new Error("unknown capability");
}

function failureForScenario(outcome) {
  switch (outcome) {
    case "malformed_result":
      return {
        ...success(
          { nativeId: "t2_fixtureuser", canonicalUrl: "https://www.reddit.com/user/fixture_user/" },
          { username: nativeIdentity, karma: { post: 42, comment: 84 } }
        ),
        unexpectedWorkerField: true
      };
    case "malformed_profile_values":
      return success(
        { nativeId: "t2_fixtureuser", canonicalUrl: "https://www.reddit.com/user/fixture_user/" },
        { username: 42, karma: { post: null, comment: "84" } }
      );
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

function success(native, data) {
  return { status: "SUCCEEDED", native, data, rateLimit: standardRateLimit() };
}

function successForRead(message) {
  const input = message.input ?? {};
  switch (message.operation) {
    case "profile.get":
      return success(
        { nativeId: "t2_fixtureuser", canonicalUrl: "https://www.reddit.com/user/fixture_user/" },
        { username: nativeIdentity, karma: { post: 42, comment: 84 } }
      );
    case "user.get":
      return success(
        { nativeId: "t2_fixtureuser", canonicalUrl: `https://www.reddit.com/user/${input.username}/` },
        { username: input.username, karma: { post: 42, comment: 84 } }
      );
    case "subreddit.get":
      return success(
        { nativeId: "t5_2qh1i", canonicalUrl: `https://www.reddit.com/r/${input.name}/` },
        { name: input.name, subscribers: 1234 }
      );
    case "listing.list":
      return success(null, {
        items: [fixturePost(
          "t3_fixture",
          "Fixture post",
          scenario.outcome === "wrong_scoped_result" ? "other" : (input.subreddit ?? "test")
        )],
        page: { after: "t3_fixture", before: null }
      });
    case "post.get": {
      const nativeId = input.nativeId ?? "t3_fixture";
      return success(postNative(nativeId), fixturePost(nativeId, "Fixture post"));
    }
    case "comments.list":
      return success(postNative(input.postNativeId ?? "t3_fixture"), {
        items: [{
          nativeId: "t1_fixture",
          canonicalUrl: `https://www.reddit.com/r/test/comments/${String(input.postNativeId ?? "t3_fixture").slice(3)}/post/fixture/`,
          body: "Fixture comment",
          author: nativeIdentity
        }],
        page: { after: null, before: null }
      });
    case "search.query":
      return success(null, {
        query: input.query ?? "fixture",
        items: [fixturePost(
          "t3_fixture",
          "Fixture search result",
          scenario.outcome === "wrong_scoped_result" ? "other" : (input.subreddit ?? "test")
        )],
        page: { after: null, before: null }
      });
    case "user.content":
      return success(null, {
        items: input.content === "comments"
          ? [{ nativeId: "t1_fixture", canonicalUrl: "https://www.reddit.com/r/test/comments/fixture/post/fixture/", body: "Fixture comment", author: input.username }]
          : [fixturePost("t3_fixture", "Fixture user post")],
        page: { after: input.content === "comments" ? "t1_fixture" : "t3_fixture", before: null }
      });
    case "account.saved":
    case "account.upvoted":
      return success(null, {
        items: [{ itemType: "post", ...fixturePost("t3_fixture", "Fixture account item") }],
        page: { after: "t3_fixture", before: null }
      });
    case "message.inbox":
      return success(null, {
        items: [fixtureMessage("t4_fixture", {
          author: input.folder === "sent" ? nativeIdentity : "fixture_sender",
          recipient: input.folder === "sent" ? "fixture_recipient" : nativeIdentity,
          subject: "Fixture private message",
          body: "Fixture message body",
          wasRead: input.folder !== "unread",
          parentNativeId: null
        })],
        page: { after: "t4_fixture", before: null }
      });
    case "message.thread": {
      const nativeId = input.messageNativeId ?? "t4_fixture";
      const root = fixtureMessage(nativeId, {
        author: "fixture_sender", recipient: nativeIdentity, subject: "Fixture thread",
        body: "Fixture thread root", wasRead: true, parentNativeId: null
      });
      return success(messageNative(nativeId), {
        ...root,
        replies: [fixtureMessage("t4_fixturereply", {
          author: nativeIdentity, recipient: "fixture_sender", subject: "re: Fixture thread",
          body: "Fixture thread reply", wasRead: true, parentNativeId: nativeId
        })]
      });
    }
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
    "item.editOwn": { edited: true },
    "vote.set": { applied: true, direction: message.input?.direction ?? 0 },
    "save.set": { saved: true },
    "save.unset": { saved: false },
    "subreddit.subscribe": { subscribed: true },
    "subreddit.unsubscribe": { subscribed: false },
    "item.deleteOwn": { deleted: true },
    "message.send": { created: true, kind: "private_message" },
    "message.reply": { created: true, kind: "private_message_reply" }
  };
  return success(native, dataByOperation[message.operation]);
}

function nativeForWrite(operation, input = {}, idempotency = {}) {
  if (["item.editOwn", "vote.set", "save.set", "save.unset", "item.deleteOwn"].includes(operation)) {
    return nativeForExisting(input.nativeId ?? "t3_owned");
  }
  if (["subreddit.subscribe", "subreddit.unsubscribe"].includes(operation)) {
    const subreddit = String(input.subreddit ?? "test");
    const nativeId = `t5_${createHash("sha256").update(subreddit.toLowerCase()).digest("hex").slice(0, 10)}`;
    return { nativeId, canonicalUrl: `https://www.reddit.com/r/${subreddit}/` };
  }
  const suffix = createHash("sha256")
    .update(`${idempotency.callerId ?? "caller"}:${idempotency.key ?? "key"}:${operation}`)
    .digest("hex")
    .slice(0, 10);
  if (operation === "message.send" || operation === "message.reply") {
    const nativeId = `t4_${suffix}`;
    return messageNative(nativeId);
  }
  const isComment = operation === "comment.create" || operation === "reply.create";
  const nativeId = `${isComment ? "t1" : "t3"}_${suffix}`;
  if (operation === "comment.create") {
    const postShortId = String(input.postNativeId).slice(3);
    return { nativeId, canonicalUrl: `https://www.reddit.com/r/test/comments/${postShortId}/post/${suffix}/` };
  }
  if (operation === "reply.create") {
    return { nativeId, canonicalUrl: `https://www.reddit.com/r/test/comments/fixture/post/${suffix}/` };
  }
  return {
    nativeId,
    canonicalUrl: `https://www.reddit.com/r/${input.subreddit}/comments/${suffix}/fixture_post/`
  };
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

function messageNative(nativeId) {
  const shortId = String(nativeId).replace(/^t4_/, "");
  return { nativeId: `t4_${shortId}`, canonicalUrl: `https://www.reddit.com/message/messages/${shortId}` };
}

function fixtureMessage(nativeId, fields) {
  return { ...messageNative(nativeId), ...fields, createdUtc: 1_767_225_600 };
}

function fixturePost(nativeId, title, subreddit = "test") {
  const shortId = String(nativeId).replace(/^t3_/, "");
  const native = {
    nativeId,
    canonicalUrl: `https://www.reddit.com/r/${subreddit}/comments/${shortId}/fixture_post/`
  };
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
    return { status: "UNKNOWN", recoveryCheckedAt: "2026-01-01T00:00:02.000Z" };
  }
  return success(action.native, { recovered: true });
}

async function sendRaw(message) {
  await writeLengthPrefixedFrame(process.stdout, encodeBoundedJson(message), MAX_IPC_MESSAGE_BYTES);
}

function parseScenario(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
