export interface OpenApiRepresentativeExamples {
  request?: Record<string, unknown>;
  responses?: Record<string, Record<string, unknown>>;
}

const timestamp = "2026-09-17T12:00:00.000Z";

const queuedAction = {
  id: "action_01JQEXAMPLE00000000000001",
  callerId: "api-key:automation",
  accountId: "account_reddit_primary",
  idempotencyKey: "publish-release-note-2026-09-17",
  kind: "text_post",
  state: "queued",
  submissionMayHaveStarted: false,
  result: null,
  error: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const action = (state: string, extras: Record<string, unknown> = {}) => ({
  ...queuedAction,
  state,
  updatedAt: "2026-09-17T12:00:03.000Z",
  ...extras,
});

/**
 * Curated values used by both the generated OpenAPI document and the local
 * explorer. They contain placeholders only: never credentials or live IDs.
 */
export const OPENAPI_REPRESENTATIVE_EXAMPLES: Readonly<Record<string, OpenApiRepresentativeExamples>> = Object.freeze({
  "reads.feed": {
    responses: {
      page: {
        items: [
          { nativeId: "t3_example", canonicalUrl: "https://www.reddit.com/r/selfhosted/comments/example/", title: "A bounded feed item" },
        ],
        nextCursor: "t3_next_opaque_cursor",
        more: [],
        rateLimit: { limit: 100, remaining: 87, resetAt: "2026-09-17T12:10:00.000Z" },
      },
    },
  },
  "actions.create": {
    request: {
      textPost: { kind: "text_post", subreddit: "selfhosted", title: "Release notes", text: "A caller-approved update." },
      save: { kind: "save", targetId: "t3_example" },
    },
    responses: { queued: { action: queuedAction, replayed: false } },
  },
  "actions.get": {
    responses: {
      queued: { action: queuedAction },
      running: { action: action("running") },
      succeeded: { action: action("succeeded", { submissionMayHaveStarted: true, result: { nativeId: "t3_created", canonicalUrl: "https://www.reddit.com/r/selfhosted/comments/created/" } }) },
      failed: { action: action("failed", { error: { code: "RATE_LIMITED", message: "Reddit rejected the action before submission.", retryable: true } }) },
      actionRequired: { action: action("action_required", { error: { code: "CHALLENGE_REQUIRED", message: "Reddit requires account action.", retryable: false } }) },
      unknown: { action: action("UNKNOWN", { submissionMayHaveStarted: true, error: { code: "AMBIGUOUS_RESULT", message: "The native result could not be verified.", retryable: false } }) },
      cancelled: { action: action("cancelled", { error: { code: "CANCELLED_BY_CALLER", message: "The queued action was cancelled before dispatch.", retryable: false } }) },
    },
  },
  "webhooks.subscriptions.create": {
    request: {
      actionEvents: { url: "https://hooks.example.net/social-git", eventTypes: ["action.succeeded", "action.failed", "action.UNKNOWN"] },
    },
    responses: {
      created: {
        subscription: {
          id: "webhook_subscription_example",
          tenantId: "tenant_example",
          url: "https://hooks.example.net/social-git",
          eventTypes: ["action.succeeded", "action.failed", "action.UNKNOWN"],
          signingKeyId: "v1",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        replayed: false,
      },
    },
  },
  "webhooks.deliveries.list": {
    responses: {
      retryScheduled: {
        items: [{
          eventId: "event_example",
          subscriptionId: "webhook_subscription_example",
          eventType: "action.succeeded",
          occurredAt: timestamp,
          state: "pending",
          attemptCount: 1,
          nextAttemptAt: "2026-09-17T12:01:00.000Z",
          deliveredAt: null,
          attempts: [{
            id: "webhook_attempt_example",
            attemptNumber: 1,
            attemptedAt: timestamp,
            outcome: "retry_scheduled",
            responseStatus: 503,
            errorCode: "DELIVERY_HTTP_ERROR",
            nextAttemptAt: "2026-09-17T12:01:00.000Z",
          }],
        }],
        nextCursor: "delivery_cursor_opaque",
      },
    },
  },
});

export const OPENAPI_ERROR_EXAMPLES = Object.freeze({
  unauthenticated: { error: { code: "UNAUTHENTICATED", message: "Authentication is required.", requestId: "req_example_auth", retryable: false } },
  wrongIdentity: { error: { code: "WRONG_IDENTITY", message: "The connected native identity does not match this account.", requestId: "req_example_identity", retryable: false } },
  challenge: { error: { code: "CHALLENGE_REQUIRED", message: "The platform requires account action.", requestId: "req_example_challenge", retryable: false } },
  rateLimited: { error: { code: "RATE_LIMITED", message: "The platform rate limit is active.", requestId: "req_example_rate", retryable: true, rateLimit: { limit: 100, remaining: 0, resetAt: "2026-09-17T12:10:00.000Z", retryAfterSeconds: 60 } } },
  protocolDrift: { error: { code: "PROTOCOL_DRIFT", message: "The platform response no longer matches the admitted contract.", requestId: "req_example_drift", retryable: false } },
});
