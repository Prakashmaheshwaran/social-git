import { WEBHOOK_EVENT_REGISTRY } from "./webhooks.ts";
import { X_TRANSPORT_ADMISSION } from "@social-git/x-adapter";
import { OPENAPI_ERROR_EXAMPLES, OPENAPI_REPRESENTATIVE_EXAMPLES } from "./openapi-examples.ts";

export type HttpMethod = "GET" | "POST";

export interface OperationDefinition {
  operationId: string;
  mcpName: string;
  method: HttpMethod;
  path: string;
  summary: string;
  scope: string;
  successStatus?: number;
  parameters?: Array<{
    name: string;
    in: "path" | "query" | "header";
    required?: boolean;
    schema: Record<string, unknown>;
    description?: string;
  }>;
  requestBody?: Record<string, unknown>;
  responseBody: Record<string, unknown>;
  mcpInputSchema: Record<string, unknown>;
}

type ContractAvailability = {
  platform: "core" | "reddit" | "x";
  availability: "production" | "fixture_only";
  disabledReasons?: readonly string[];
};

export const API_KEY_SCOPES = Object.freeze([
  "accounts:write", "accounts:read", "connections:write", "connections:read",
  "social:read", "social:write", "actions:read", "audit:read",
  "webhooks:read", "webhooks:write", "usage:read",
]);

const id = { type: "string", minLength: 1, maxLength: 128 };
const xNativeId = { ...id, pattern: "^[0-9]+$" };
const cursor = { type: "string", maxLength: 512 };
const limit = { type: "integer", minimum: 1, maximum: 100, default: 25 };
const timeframe = { type: "string", enum: ["hour", "day", "week", "month", "year", "all"] };
const listingSort = { type: "string", enum: ["hot", "new", "top", "rising", "best", "controversial"] };
const searchSort = { type: "string", enum: ["relevance", "hot", "top", "new", "comments"] };
const commentSort = { type: "string", enum: ["best", "top", "new", "controversial", "old", "qa"] };
const accountIdParameter = { name: "accountId", in: "path" as const, required: true, schema: id };
const pageParameters = [
  { name: "cursor", in: "query" as const, schema: cursor },
  { name: "limit", in: "query" as const, schema: limit },
];

const accountCreate = {
  type: "object",
  additionalProperties: false,
  required: ["platform", "expectedNativeUserId"],
  properties: {
    platform: { type: "string", enum: ["reddit", "x"] },
    expectedNativeUserId: id,
    label: { type: "string", maxLength: 120 },
  },
};

const connectionImport = {
  type: "object",
  additionalProperties: false,
  required: ["vaultHandle", "generation"],
  properties: {
    vaultHandle: { type: "string", minLength: 1, maxLength: 256, description: "Opaque one-time reference to externally staged session material. Raw credentials are not accepted." },
    generation: { type: "integer", minimum: 1 },
  },
};

const mediaCreate = {
  type: "object",
  additionalProperties: false,
  required: ["filename", "mimeType", "dataBase64"],
  properties: {
    filename: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    mimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/gif", "image/webp"] },
    dataBase64: { type: "string", minLength: 4, maxLength: 11184812, description: "Canonical base64 image bytes, bounded to 8 MiB after decoding." },
  },
};

const mediaAsset = {
  type: "object",
  additionalProperties: false,
  required: ["mediaRef", "callerId", "accountId", "filename", "mimeType", "sizeBytes", "sha256", "createdAt"],
  properties: {
    mediaRef: id, callerId: id, accountId: id, filename: { type: "string" }, mimeType: { type: "string" },
    sizeBytes: { type: "integer", minimum: 1, maximum: 8388608 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const WRITE_KINDS = [
  "text_post",
  "link_post",
  "media_post",
  "comment",
  "reply",
  "edit",
  "vote",
  "save",
  "unsave",
  "subscribe",
  "unsubscribe",
  "delete",
  "message_send",
  "message_reply",
  "x_post_create",
  "x_reply_create",
  "x_post_delete",
  "x_like_set",
  "x_repost_set",
  "x_follow_set",
  "x_bookmark_set",
  "x_media_post",
  "x_direct_message",
] as const;

const redditMessageWriteVariants = [
  {
    title: "Send Reddit private message candidate",
    type: "object", additionalProperties: false, required: ["kind", "recipient", "subject", "text"],
    properties: {
      kind: { const: "message_send" }, recipient: { type: "string", minLength: 3, maxLength: 20, pattern: "^[A-Za-z0-9_-]+$" },
      subject: { type: "string", minLength: 1, maxLength: 100 }, text: { type: "string", minLength: 1, maxLength: 10_000 },
    },
    "x-social-git-availability": "fixture_only",
    "x-social-git-disabled-reasons": ["NO_VERIFIABLE_NATIVE_RESULT", "AUTHORIZED_LIVE_WRITE_PROOF_MISSING"],
  },
  {
    title: "Reply to Reddit private message candidate",
    type: "object", additionalProperties: false, required: ["kind", "parentMessageId", "text"],
    properties: {
      kind: { const: "message_reply" }, parentMessageId: { ...id, pattern: "^t4_[a-z0-9]+$" },
      text: { type: "string", minLength: 1, maxLength: 10_000 },
    },
    "x-social-git-availability": "fixture_only",
    "x-social-git-disabled-reasons": ["DIRECT_SESSION_REPLY_MAPPING_UNPROVEN", "AUTHORIZED_LIVE_WRITE_PROOF_MISSING"],
  },
] as const;

const writeRequest = {
  oneOf: [
    {
      title: "Text post",
      type: "object", additionalProperties: false, required: ["kind", "subreddit", "title", "text"],
      properties: { kind: { const: "text_post" }, subreddit: id, title: { type: "string", minLength: 1, maxLength: 300 }, text: { type: "string", maxLength: 40000 } },
    },
    {
      title: "Link post",
      type: "object", additionalProperties: false, required: ["kind", "subreddit", "title", "url"],
      properties: { kind: { const: "link_post" }, subreddit: id, title: { type: "string", minLength: 1, maxLength: 300 }, url: { type: "string", format: "uri", maxLength: 2048 } },
    },
    {
      title: "Media post",
      type: "object", additionalProperties: false, required: ["kind", "subreddit", "title", "mediaRef"],
      properties: { kind: { const: "media_post" }, subreddit: id, title: { type: "string", minLength: 1, maxLength: 300 }, mediaRef: { type: "string", minLength: 1, maxLength: 512, description: "Reference to separately stored media; binary data is not accepted here." } },
    },
    {
      title: "Comment",
      type: "object", additionalProperties: false, required: ["kind", "postId", "text"],
      properties: { kind: { const: "comment" }, postId: id, text: { type: "string", minLength: 1, maxLength: 10000 } },
    },
    {
      title: "Reply",
      type: "object", additionalProperties: false, required: ["kind", "commentId", "text"],
      properties: { kind: { const: "reply" }, commentId: id, text: { type: "string", minLength: 1, maxLength: 10000 } },
    },
    {
      title: "Edit caller-owned post or comment",
      type: "object", additionalProperties: false, required: ["kind", "targetId", "text"],
      properties: { kind: { const: "edit" }, targetId: id, text: { type: "string", minLength: 1, maxLength: 40000 } },
    },
    {
      title: "Vote",
      type: "object", additionalProperties: false, required: ["kind", "targetId", "direction"],
      properties: { kind: { const: "vote" }, targetId: id, direction: { type: "integer", enum: [-1, 0, 1] } },
    },
    {
      title: "Save",
      type: "object", additionalProperties: false, required: ["kind", "targetId"],
      properties: { kind: { const: "save" }, targetId: id },
    },
    {
      title: "Unsave",
      type: "object", additionalProperties: false, required: ["kind", "targetId"],
      properties: { kind: { const: "unsave" }, targetId: id },
    },
    {
      title: "Subscribe to subreddit",
      type: "object", additionalProperties: false, required: ["kind", "subreddit"],
      properties: { kind: { const: "subscribe" }, subreddit: id },
    },
    {
      title: "Unsubscribe from subreddit",
      type: "object", additionalProperties: false, required: ["kind", "subreddit"],
      properties: { kind: { const: "unsubscribe" }, subreddit: id },
    },
    {
      title: "Delete caller-owned item",
      type: "object", additionalProperties: false, required: ["kind", "targetId"],
      properties: { kind: { const: "delete" }, targetId: id },
    },
  ],
};

const redditMessageWriteRequest = { oneOf: redditMessageWriteVariants };

const xWriteRequest = {
  oneOf: [
    {
      title: "Create X post",
      type: "object", additionalProperties: false, required: ["kind", "text"],
      properties: { kind: { const: "x_post_create" }, text: { type: "string", minLength: 1, maxLength: 10_000 } },
    },
    {
      title: "Reply to X post",
      type: "object", additionalProperties: false, required: ["kind", "postId", "text"],
      properties: { kind: { const: "x_reply_create" }, postId: id, text: { type: "string", minLength: 1, maxLength: 10_000 } },
    },
    {
      title: "Delete caller-owned X post",
      type: "object", additionalProperties: false, required: ["kind", "postId"],
      properties: { kind: { const: "x_post_delete" }, postId: id },
    },
    ...["like", "repost", "bookmark"].map((name) => ({
      title: `Set X ${name}`,
      type: "object", additionalProperties: false, required: ["kind", "postId", "enabled"],
      properties: { kind: { const: `x_${name}_set` }, postId: id, enabled: { type: "boolean" } },
    })),
    {
      title: "Set X follow",
      type: "object", additionalProperties: false, required: ["kind", "userNativeId", "enabled"],
      properties: { kind: { const: "x_follow_set" }, userNativeId: id, enabled: { type: "boolean" } },
    },
    {
      title: "Create X media post",
      type: "object", additionalProperties: false, required: ["kind", "text", "mediaRef"],
      properties: {
        kind: { const: "x_media_post" },
        text: { type: "string", maxLength: 10_000 },
        mediaRef: { type: "string", minLength: 1, maxLength: 512, description: "Reference to Core-managed media; binary data is not accepted here." },
      },
    },
    {
      title: "Send X direct message",
      type: "object", additionalProperties: false, required: ["kind", "recipientNativeId", "text"],
      properties: { kind: { const: "x_direct_message" }, recipientNativeId: id, text: { type: "string", minLength: 1, maxLength: 10_000 } },
    },
  ],
};

const nativeEntity = {
  type: "object",
  required: ["nativeId"],
  properties: { nativeId: id, canonicalUrl: { type: "string", format: "uri" } },
  additionalProperties: true,
};

const rateLimit = {
  type: "object", additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 0 }, remaining: { type: "integer", minimum: 0 },
    resetAt: { type: "string", format: "date-time" }, retryAfterSeconds: { type: "integer", minimum: 0 },
  },
};

const redditMessageRequired = [
  "nativeId", "canonicalUrl", "authorNativeId", "recipientNativeId", "subject",
  "body", "wasRead", "parentNativeId", "createdAt",
] as const;

const redditMessageProperties = {
  nativeId: { type: "string", pattern: "^t4_[a-z0-9]+$", minLength: 4, maxLength: 128 },
  canonicalUrl: { type: "string", format: "uri", maxLength: 2048 },
  authorNativeId: { type: "string", minLength: 1, maxLength: 128 },
  recipientNativeId: { type: "string", minLength: 1, maxLength: 128 },
  subject: { type: "string", minLength: 1, maxLength: 100 },
  body: { type: "string", minLength: 1, maxLength: 10_000 },
  wasRead: { type: "boolean" },
  parentNativeId: { oneOf: [{ type: "string", pattern: "^t4_[a-z0-9]+$", minLength: 4, maxLength: 128 }, { type: "null" }] },
  createdAt: { type: "string", format: "date-time" },
};

const redditMessage = {
  type: "object",
  additionalProperties: false,
  required: redditMessageRequired,
  properties: redditMessageProperties,
};

const redditMessageThread = {
  type: "object",
  additionalProperties: false,
  required: [...redditMessageRequired, "replies"],
  properties: {
    ...redditMessageProperties,
    replies: { type: "array", maxItems: 100, items: redditMessage },
    rateLimit,
  },
};

const redditMessagePage = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", maxItems: 100, items: redditMessage },
    nextCursor: { oneOf: [cursor, { type: "null" }] },
    rateLimit,
  },
};

const account = {
  type: "object",
  additionalProperties: false,
  required: ["id", "platform", "expectedNativeUserId", "actualNativeUserId", "status", "connectionHealth", "actionRequiredReason", "healthGeneration", "lastVerifiedAt", "createdAt", "updatedAt"],
  properties: {
    id, platform: { type: "string" }, expectedNativeUserId: id, actualNativeUserId: { oneOf: [id, { type: "null" }] },
    label: { oneOf: [{ type: "string" }, { type: "null" }] }, status: { type: "string", enum: ["disconnected", "active", "suspended", "revoked"] },
    connectionHealth: { type: "string", enum: ["disconnected", "pending_identity", "healthy", "action_required", "revoked"] },
    actionRequiredReason: { oneOf: [
      { type: "string", enum: ["SESSION_EXPIRED", "CHALLENGE_REQUIRED", "RATE_LIMITED", "SESSION_REVOKED", "WRONG_IDENTITY", "PROTOCOL_DRIFT"] },
      { type: "null" },
    ] },
    healthGeneration: { type: "integer", minimum: 0 },
    lastVerifiedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
};

const connection = {
  type: "object",
  additionalProperties: false,
  required: ["accountId", "generation", "status", "connectedAt", "revokedAt"],
  properties: {
    accountId: id, generation: { type: "integer", minimum: 1 }, status: { type: "string", enum: ["active", "revoked"] },
    connectedAt: { type: "string", format: "date-time" }, revokedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
};

const action = {
  type: "object",
  additionalProperties: false,
  required: ["id", "callerId", "accountId", "idempotencyKey", "kind", "state", "submissionMayHaveStarted", "result", "error", "createdAt", "updatedAt"],
  properties: {
    id, callerId: id, accountId: id, idempotencyKey: id, kind: { type: "string", enum: WRITE_KINDS },
    state: { type: "string", enum: ["queued", "running", "succeeded", "failed", "action_required", "UNKNOWN", "cancelled"] },
    submissionMayHaveStarted: { type: "boolean" }, result: {}, error: {},
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
};

const auditEvent = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sequence", "callerId", "accountId", "type", "outcome", "data", "occurredAt"],
  properties: {
    id, sequence: { type: "integer", minimum: 1 }, callerId: { oneOf: [id, { type: "null" }] }, accountId: { oneOf: [id, { type: "null" }] },
    type: { type: "string" }, outcome: { type: "string" }, data: {}, occurredAt: { type: "string", format: "date-time" },
  },
};

const usageAggregate = {
  type: "object", additionalProperties: false,
  required: ["tenantId", "keyId", "callerId", "accountId", "operationId", "outcome", "count", "firstRecordedAt", "lastRecordedAt"],
  properties: {
    tenantId: id, keyId: { oneOf: [id, { type: "null" }] }, callerId: { oneOf: [id, { type: "null" }] },
    accountId: { oneOf: [id, { type: "null" }] }, operationId: { oneOf: [id, { type: "null" }] },
    outcome: { type: "string", enum: ["succeeded", "failed"] }, count: { type: "integer", minimum: 1 },
    firstRecordedAt: { type: "string", format: "date-time" }, lastRecordedAt: { type: "string", format: "date-time" },
  },
};

const webhookEventType = { type: "string", enum: WEBHOOK_EVENT_REGISTRY.map(({ type }) => type) };
const webhookSubscription = {
  type: "object", additionalProperties: false,
  required: ["id", "tenantId", "url", "eventTypes", "signingKeyId", "status", "createdAt", "updatedAt"],
  properties: {
    id, tenantId: id, url: { type: "string", format: "uri", maxLength: 2048 },
    eventTypes: { type: "array", minItems: 1, uniqueItems: true, items: webhookEventType },
    signingKeyId: { type: "string", pattern: "^v[1-9][0-9]*$" },
    status: { type: "string", enum: ["active", "disabled"] },
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
};
const webhookSecretResponse = wrapped("subscription", webhookSubscription, {
  secret: { type: "string", readOnly: true, pattern: "^[A-Za-z0-9_-]{43}$", description: "Returned only by an idempotent create or rotate response. Store it securely; listings never include it." },
  replayed: { type: "boolean" },
});
const webhookAttempt = objectInput({
  id, attemptNumber: { type: "integer", minimum: 1 }, attemptedAt: { type: "string", format: "date-time" },
  outcome: { type: "string", enum: ["delivered", "retry_scheduled", "exhausted"] },
  responseStatus: { oneOf: [{ type: "integer", minimum: 100, maximum: 599 }, { type: "null" }] },
  errorCode: { oneOf: [{ type: "string" }, { type: "null" }] },
  nextAttemptAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
}, ["id", "attemptNumber", "attemptedAt", "outcome", "responseStatus", "errorCode", "nextAttemptAt"]);
const webhookDelivery = objectInput({
  eventId: id, subscriptionId: id, eventType: webhookEventType, occurredAt: { type: "string", format: "date-time" },
  state: { type: "string", enum: ["pending", "delivered", "exhausted"] }, attemptCount: { type: "integer", minimum: 0 },
  nextAttemptAt: { type: "string", format: "date-time" }, deliveredAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  attempts: { type: "array", items: webhookAttempt },
}, ["eventId", "subscriptionId", "eventType", "occurredAt", "state", "attemptCount", "nextAttemptAt", "deliveredAt", "attempts"]);

const pageOf = (itemSchema: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: itemSchema },
    nextCursor: { oneOf: [cursor, { type: "null" }] },
    more: { type: "array", items: { type: "object", additionalProperties: true } },
    rateLimit,
  },
});

function wrapped(key: string, schema: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  return { type: "object", additionalProperties: false, required: [key, ...Object.keys(extras)], properties: { [key]: schema, ...extras } };
}

function objectInput(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

export const OPERATIONS: readonly OperationDefinition[] = [
  { operationId: "accounts.create", mcpName: "social_accounts_create", method: "POST", path: "/v1/accounts", summary: "Register an account bound to an expected native identity", scope: "accounts:write", successStatus: 201, requestBody: accountCreate, responseBody: wrapped("account", account), mcpInputSchema: accountCreate },
  { operationId: "accounts.list", mcpName: "social_accounts_list", method: "GET", path: "/v1/accounts", summary: "List registered accounts", scope: "accounts:read", parameters: pageParameters, responseBody: pageOf(account), mcpInputSchema: objectInput({ cursor, limit }) },
  { operationId: "accounts.get", mcpName: "social_accounts_get", method: "GET", path: "/v1/accounts/{accountId}", summary: "Get a registered account", scope: "accounts:read", parameters: [accountIdParameter], responseBody: wrapped("account", account), mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "connections.import", mcpName: "social_connections_import", method: "POST", path: "/v1/accounts/{accountId}/connections", summary: "Connect an account using an opaque encrypted-session reference", scope: "connections:write", parameters: [accountIdParameter], requestBody: connectionImport, responseBody: wrapped("connection", connection), mcpInputSchema: objectInput({ accountId: id, ...connectionImport.properties }, ["accountId", ...connectionImport.required]) },
  { operationId: "connections.refresh", mcpName: "social_connections_refresh", method: "POST", path: "/v1/accounts/{accountId}/connection/refresh", summary: "Replace an account session and route with the next encrypted generation", scope: "connections:write", parameters: [accountIdParameter], requestBody: connectionImport, responseBody: wrapped("connection", connection), mcpInputSchema: objectInput({ accountId: id, ...connectionImport.properties }, ["accountId", ...connectionImport.required]) },
  { operationId: "connections.get", mcpName: "social_connections_get", method: "GET", path: "/v1/accounts/{accountId}/connection", summary: "Get redacted connection health", scope: "connections:read", parameters: [accountIdParameter], responseBody: wrapped("connection", connection), mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "capabilities.list", mcpName: "social_capabilities_list", method: "GET", path: "/v1/accounts/{accountId}/capabilities", summary: "List capabilities, production admission state, and explicitly unsupported account capabilities", scope: "social:read", parameters: [accountIdParameter], responseBody: objectInput({ platform: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, unsupportedCapabilities: { type: "object", additionalProperties: { type: "string" } }, details: { type: "array", items: { type: "object", additionalProperties: true } } }, ["platform", "capabilities", "unsupportedCapabilities"]), mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "platforms.capabilities", mcpName: "social_platform_capabilities", method: "GET", path: "/v1/platforms/{platform}/capabilities", summary: "Discover pre-connection platform capabilities and production admission state", scope: "social:read", parameters: [{ name: "platform", in: "path", required: true, schema: { type: "string", enum: ["x"] } }], responseBody: objectInput({ platform: { type: "string" }, details: { type: "array", items: { type: "object", additionalProperties: true } } }, ["platform", "details"]), mcpInputSchema: objectInput({ platform: { type: "string", enum: ["x"] } }, ["platform"]) },
  { operationId: "media.create", mcpName: "social_media_create", method: "POST", path: "/v1/accounts/{accountId}/media", summary: "Store bounded image media in Core and return an account-scoped media reference", scope: "social:write", successStatus: 201, parameters: [accountIdParameter], requestBody: mediaCreate, responseBody: wrapped("media", mediaAsset), mcpInputSchema: objectInput({ accountId: id, ...mediaCreate.properties }, ["accountId", ...mediaCreate.required]) },
  { operationId: "accounts.revoke", mcpName: "social_accounts_revoke", method: "POST", path: "/v1/accounts/{accountId}/revoke", summary: "Revoke an account connection", scope: "connections:write", parameters: [accountIdParameter], requestBody: objectInput({ reason: { type: "string", maxLength: 200 } }), responseBody: wrapped("connection", connection), mcpInputSchema: objectInput({ accountId: id, reason: { type: "string", maxLength: 200 } }, ["accountId"]) },
  { operationId: "reads.profile", mcpName: "reddit_profile_get", method: "GET", path: "/v1/accounts/{accountId}/profile", summary: "Read the connected native account profile", scope: "social:read", parameters: [accountIdParameter], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "reads.subreddit", mcpName: "reddit_subreddit_get", method: "GET", path: "/v1/accounts/{accountId}/subreddits/{subreddit}", summary: "Read subreddit metadata", scope: "social:read", parameters: [accountIdParameter, { name: "subreddit", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, subreddit: id }, ["accountId", "subreddit"]) },
  { operationId: "reads.feed", mcpName: "reddit_feed_list", method: "GET", path: "/v1/accounts/{accountId}/feed", summary: "Read a feed listing with opaque native pagination", scope: "social:read", parameters: [accountIdParameter, { name: "subreddit", in: "query", schema: id }, { name: "sort", in: "query", schema: listingSort }, { name: "timeframe", in: "query", schema: timeframe }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, subreddit: id, sort: listingSort, timeframe, cursor, limit }, ["accountId"]) },
  { operationId: "reads.post", mcpName: "reddit_post_get", method: "GET", path: "/v1/accounts/{accountId}/posts/{postId}", summary: "Read a post", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, postId: id }, ["accountId", "postId"]) },
  { operationId: "reads.comments", mcpName: "reddit_comments_list", method: "GET", path: "/v1/accounts/{accountId}/posts/{postId}/comments", summary: "Read a bounded nested comment tree; more placeholders are returned but not expanded", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }, { name: "sort", in: "query", schema: commentSort }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, postId: id, sort: commentSort, cursor, limit }, ["accountId", "postId"]) },
  { operationId: "reads.search", mcpName: "reddit_search", method: "GET", path: "/v1/accounts/{accountId}/search", summary: "Search Reddit with subreddit, sort, timeframe and opaque pagination", scope: "social:read", parameters: [accountIdParameter, { name: "query", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 512 } }, { name: "subreddit", in: "query", schema: id }, { name: "sort", in: "query", schema: searchSort }, { name: "timeframe", in: "query", schema: timeframe }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, query: { type: "string", minLength: 1, maxLength: 512 }, subreddit: id, sort: searchSort, timeframe, cursor, limit }, ["accountId", "query"]) },
  { operationId: "reads.userProfile", mcpName: "reddit_user_profile_get", method: "GET", path: "/v1/accounts/{accountId}/users/{username}", summary: "Read a Reddit user profile", scope: "social:read", parameters: [accountIdParameter, { name: "username", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, username: id }, ["accountId", "username"]) },
  { operationId: "reads.userContent", mcpName: "reddit_user_content_list", method: "GET", path: "/v1/accounts/{accountId}/users/{username}/{content}", summary: "Read a user's submitted posts or comments", scope: "social:read", parameters: [accountIdParameter, { name: "username", in: "path", required: true, schema: id }, { name: "content", in: "path", required: true, schema: { type: "string", enum: ["submitted", "comments"] } }, { name: "sort", in: "query", schema: { type: "string", enum: ["hot", "new", "top", "controversial"] } }, { name: "timeframe", in: "query", schema: timeframe }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, username: id, content: { type: "string", enum: ["submitted", "comments"] }, sort: { type: "string", enum: ["hot", "new", "top", "controversial"] }, timeframe, cursor, limit }, ["accountId", "username", "content"]) },
  { operationId: "reads.saved", mcpName: "reddit_account_saved_list", method: "GET", path: "/v1/accounts/{accountId}/saved", summary: "Read saved items for the validated connected identity", scope: "social:read", parameters: [accountIdParameter, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, cursor, limit }, ["accountId"]) },
  { operationId: "reads.upvoted", mcpName: "reddit_account_upvoted_list", method: "GET", path: "/v1/accounts/{accountId}/upvoted", summary: "Read upvoted items for the validated connected identity", scope: "social:read", parameters: [accountIdParameter, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, cursor, limit }, ["accountId"]) },
  { operationId: "reddit.messages.list", mcpName: "reddit_message_inbox_list", method: "GET", path: "/v1/accounts/{accountId}/reddit/messages", summary: "Fixture-only bounded Reddit private-message inbox candidate", scope: "social:read", parameters: [accountIdParameter, { name: "folder", in: "query", schema: { type: "string", enum: ["inbox", "unread", "messages", "sent", "mentions"], default: "inbox" } }, ...pageParameters], responseBody: redditMessagePage, mcpInputSchema: objectInput({ accountId: id, folder: { type: "string", enum: ["inbox", "unread", "messages", "sent", "mentions"] }, cursor, limit }, ["accountId"]) },
  { operationId: "reddit.messages.thread", mcpName: "reddit_message_thread_get", method: "GET", path: "/v1/accounts/{accountId}/reddit/messages/{messageId}", summary: "Fixture-only bounded Reddit private-message thread candidate", scope: "social:read", parameters: [accountIdParameter, { name: "messageId", in: "path", required: true, schema: { ...id, pattern: "^t4_[a-z0-9]+$" } }], responseBody: redditMessageThread, mcpInputSchema: objectInput({ accountId: id, messageId: { ...id, pattern: "^t4_[a-z0-9]+$" } }, ["accountId", "messageId"]) },
  { operationId: "reddit.messages.actions.create", mcpName: "reddit_message_action_create", method: "POST", path: "/v1/accounts/{accountId}/reddit/messages/actions", summary: "Queue a fixture-only Reddit private-message send or reply candidate", scope: "social:write", successStatus: 202, parameters: [accountIdParameter, { name: "Idempotency-Key", in: "header", required: true, schema: id }], requestBody: redditMessageWriteRequest, responseBody: wrapped("action", action, { replayed: { type: "boolean" } }), mcpInputSchema: objectInput({ accountId: id, idempotencyKey: id, action: redditMessageWriteRequest }, ["accountId", "idempotencyKey", "action"]) },
  { operationId: "x.account.health", mcpName: "x_account_health", method: "GET", path: "/v1/accounts/{accountId}/x/health", summary: "Verify X account identity and return normalized account health", scope: "social:read", parameters: [accountIdParameter], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "x.profiles.get", mcpName: "x_profile_get", method: "GET", path: "/v1/accounts/{accountId}/x/profiles/{username}", summary: "Read a normalized X profile", scope: "social:read", parameters: [accountIdParameter, { name: "username", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, username: id }, ["accountId", "username"]) },
  { operationId: "x.posts.get", mcpName: "x_post_get", method: "GET", path: "/v1/accounts/{accountId}/x/posts/{postId}", summary: "Read a normalized X post", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, postId: id }, ["accountId", "postId"]) },
  { operationId: "x.threads.get", mcpName: "x_thread_get", method: "GET", path: "/v1/accounts/{accountId}/x/posts/{postId}/thread", summary: "Read one bounded normalized X thread page", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, postId: id, cursor, limit }, ["accountId", "postId"]) },
  { operationId: "x.timelines.home", mcpName: "x_home_timeline_list", method: "GET", path: "/v1/accounts/{accountId}/x/timelines/home", summary: "Read one bounded normalized X home timeline page", scope: "social:read", parameters: [accountIdParameter, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, cursor, limit }, ["accountId"]) },
  { operationId: "x.timelines.user", mcpName: "x_user_timeline_list", method: "GET", path: "/v1/accounts/{accountId}/x/timelines/users/{username}", summary: "Read one bounded normalized X user timeline page", scope: "social:read", parameters: [accountIdParameter, { name: "username", in: "path", required: true, schema: id }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, username: id, cursor, limit }, ["accountId", "username"]) },
  { operationId: "x.search", mcpName: "x_search", method: "GET", path: "/v1/accounts/{accountId}/x/search", summary: "Search X and return one bounded normalized page", scope: "social:read", parameters: [accountIdParameter, { name: "query", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 512 } }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, query: { type: "string", minLength: 1, maxLength: 512 }, cursor, limit }, ["accountId", "query"]) },
  { operationId: "x.notifications.list", mcpName: "x_notifications_list", method: "GET", path: "/v1/accounts/{accountId}/x/notifications", summary: "Read one bounded normalized X notification page", scope: "social:read", parameters: [accountIdParameter, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, cursor, limit }, ["accountId"]) },
  { operationId: "x.conversations.list", mcpName: "x_conversations_list", method: "GET", path: "/v1/accounts/{accountId}/x/conversations", summary: "Read one bounded normalized X conversation-summary page", scope: "social:read", parameters: [accountIdParameter, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, cursor, limit }, ["accountId"]) },
  { operationId: "x.bookmarks.list", mcpName: "x_bookmarks_list", method: "GET", path: "/v1/accounts/{accountId}/x/bookmarks", summary: "Read one bounded normalized X bookmark page", scope: "social:read", parameters: [accountIdParameter, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, cursor, limit }, ["accountId"]) },
  { operationId: "x.followers.list", mcpName: "x_followers_list", method: "GET", path: "/v1/accounts/{accountId}/x/users/{userNativeId}/followers", summary: "Read one bounded normalized X follower page", scope: "social:read", parameters: [accountIdParameter, { name: "userNativeId", in: "path", required: true, schema: xNativeId }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, userNativeId: xNativeId, cursor, limit }, ["accountId", "userNativeId"]) },
  { operationId: "x.following.list", mcpName: "x_following_list", method: "GET", path: "/v1/accounts/{accountId}/x/users/{userNativeId}/following", summary: "Read one bounded normalized X following page", scope: "social:read", parameters: [accountIdParameter, { name: "userNativeId", in: "path", required: true, schema: xNativeId }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, userNativeId: xNativeId, cursor, limit }, ["accountId", "userNativeId"]) },
  { operationId: "x.lists.lookup", mcpName: "x_list_lookup", method: "GET", path: "/v1/accounts/{accountId}/x/lists/{listId}", summary: "Read normalized X List metadata", scope: "social:read", parameters: [accountIdParameter, { name: "listId", in: "path", required: true, schema: xNativeId }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, listId: xNativeId }, ["accountId", "listId"]) },
  { operationId: "x.lists.memberships", mcpName: "x_list_memberships_list", method: "GET", path: "/v1/accounts/{accountId}/x/lists", summary: "Read one bounded page of Lists available to the connected X account", scope: "social:read", parameters: [accountIdParameter, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, cursor, limit }, ["accountId"]) },
  { operationId: "x.lists.members", mcpName: "x_list_members_list", method: "GET", path: "/v1/accounts/{accountId}/x/lists/{listId}/members", summary: "Read one bounded normalized X List member page", scope: "social:read", parameters: [accountIdParameter, { name: "listId", in: "path", required: true, schema: xNativeId }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, listId: xNativeId, cursor, limit }, ["accountId", "listId"]) },
  { operationId: "x.lists.timeline", mcpName: "x_list_timeline_list", method: "GET", path: "/v1/accounts/{accountId}/x/lists/{listId}/timeline", summary: "Read one bounded normalized X List timeline page", scope: "social:read", parameters: [accountIdParameter, { name: "listId", in: "path", required: true, schema: xNativeId }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, listId: xNativeId, cursor, limit }, ["accountId", "listId"]) },
  { operationId: "x.actions.create", mcpName: "x_action_create", method: "POST", path: "/v1/accounts/{accountId}/x/actions", summary: "Queue an explicitly authorized X write", scope: "social:write", successStatus: 202, parameters: [accountIdParameter, { name: "Idempotency-Key", in: "header", required: true, schema: id }], requestBody: xWriteRequest, responseBody: wrapped("action", action, { replayed: { type: "boolean" } }), mcpInputSchema: objectInput({ accountId: id, idempotencyKey: id, action: xWriteRequest }, ["accountId", "idempotencyKey", "action"]) },
  { operationId: "actions.create", mcpName: "reddit_action_create", method: "POST", path: "/v1/accounts/{accountId}/actions", summary: "Queue an explicitly authorized Reddit write", scope: "social:write", successStatus: 202, parameters: [accountIdParameter, { name: "Idempotency-Key", in: "header", required: true, schema: id }], requestBody: writeRequest, responseBody: wrapped("action", action, { replayed: { type: "boolean" } }), mcpInputSchema: objectInput({ accountId: id, idempotencyKey: id, action: writeRequest }, ["accountId", "idempotencyKey", "action"]) },
  { operationId: "actions.list", mcpName: "social_actions_list", method: "GET", path: "/v1/actions", summary: "List the tenant action queue with caller-safe filtering and cursor pagination", scope: "actions:read", parameters: [{ name: "callerId", in: "query", schema: id }, { name: "accountId", in: "query", schema: id }, { name: "state", in: "query", schema: { type: "string", enum: ["queued", "running", "succeeded", "failed", "action_required", "UNKNOWN", "cancelled"] } }, { name: "kind", in: "query", schema: { type: "string", enum: WRITE_KINDS } }, ...pageParameters], responseBody: pageOf(action), mcpInputSchema: objectInput({ callerId: id, accountId: id, state: { type: "string", enum: ["queued", "running", "succeeded", "failed", "action_required", "UNKNOWN", "cancelled"] }, kind: { type: "string", enum: WRITE_KINDS }, cursor, limit }) },
  { operationId: "actions.get", mcpName: "social_action_get", method: "GET", path: "/v1/actions/{actionId}", summary: "Get caller-scoped action status", scope: "actions:read", parameters: [{ name: "actionId", in: "path", required: true, schema: id }], responseBody: wrapped("action", action), mcpInputSchema: objectInput({ actionId: id }, ["actionId"]) },
  { operationId: "actions.cancel", mcpName: "social_action_cancel", method: "POST", path: "/v1/actions/{actionId}/cancel", summary: "Terminally cancel an unclaimed queued action without dispatch", scope: "social:write", parameters: [{ name: "actionId", in: "path", required: true, schema: id }, { name: "Idempotency-Key", in: "header", required: true, schema: id }], requestBody: objectInput({}), responseBody: wrapped("action", action, { replayed: { type: "boolean" } }), mcpInputSchema: objectInput({ actionId: id, idempotencyKey: id }, ["actionId", "idempotencyKey"]) },
  { operationId: "actions.reconcile", mcpName: "social_action_reconcile", method: "POST", path: "/v1/actions/{actionId}/reconcile", summary: "Reconcile an UNKNOWN action without resubmitting it", scope: "social:write", parameters: [{ name: "actionId", in: "path", required: true, schema: id }], requestBody: objectInput({}), responseBody: wrapped("action", action, { reconciled: { type: "boolean" } }), mcpInputSchema: objectInput({ actionId: id }, ["actionId"]) },
  { operationId: "usage.list", mcpName: "social_usage_list", method: "GET", path: "/v1/usage", summary: "List bounded redacted usage aggregates with retention", scope: "usage:read", parameters: [{ name: "accountId", in: "query", schema: id }, { name: "operationId", in: "query", schema: id }, { name: "since", in: "query", schema: { type: "string", format: "date-time" } }, { name: "until", in: "query", schema: { type: "string", format: "date-time" } }, { name: "groupBy", in: "query", schema: { type: "string", pattern: "^(tenant|key|account|operation)(,(tenant|key|account|operation))*$" } }, { name: "limit", in: "query", schema: limit }], responseBody: objectInput({ items: { type: "array", maxItems: 100, items: usageAggregate }, retentionDays: { type: "integer", minimum: 1, maximum: 365 } }, ["items", "retentionDays"]), mcpInputSchema: objectInput({ accountId: id, operationId: id, since: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" }, groupBy: { type: "string", pattern: "^(tenant|key|account|operation)(,(tenant|key|account|operation))*$" }, limit }) },
  { operationId: "webhooks.subscriptions.create", mcpName: "social_webhook_subscription_create", method: "POST", path: "/v1/webhooks/subscriptions", summary: "Create a tenant webhook subscription and return its signing secret", scope: "webhooks:write", successStatus: 201, parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: id }], requestBody: objectInput({ url: { type: "string", format: "uri", maxLength: 2048 }, eventTypes: { type: "array", minItems: 1, uniqueItems: true, items: webhookEventType } }, ["url", "eventTypes"]), responseBody: webhookSecretResponse, mcpInputSchema: objectInput({ idempotencyKey: id, url: { type: "string", format: "uri", maxLength: 2048 }, eventTypes: { type: "array", minItems: 1, uniqueItems: true, items: webhookEventType } }, ["idempotencyKey", "url", "eventTypes"]) },
  { operationId: "webhooks.subscriptions.list", mcpName: "social_webhook_subscriptions_list", method: "GET", path: "/v1/webhooks/subscriptions", summary: "List tenant webhook subscriptions without secret material", scope: "webhooks:read", parameters: pageParameters, responseBody: pageOf(webhookSubscription), mcpInputSchema: objectInput({ cursor, limit }) },
  { operationId: "webhooks.subscriptions.rotate", mcpName: "social_webhook_subscription_rotate", method: "POST", path: "/v1/webhooks/subscriptions/{subscriptionId}/rotate-secret", summary: "Rotate a webhook signing secret and return the replacement", scope: "webhooks:write", parameters: [{ name: "subscriptionId", in: "path", required: true, schema: id }, { name: "Idempotency-Key", in: "header", required: true, schema: id }], requestBody: objectInput({}), responseBody: webhookSecretResponse, mcpInputSchema: objectInput({ subscriptionId: id, idempotencyKey: id }, ["subscriptionId", "idempotencyKey"]) },
  { operationId: "webhooks.subscriptions.disable", mcpName: "social_webhook_subscription_disable", method: "POST", path: "/v1/webhooks/subscriptions/{subscriptionId}/disable", summary: "Disable a webhook subscription and exhaust its pending deliveries", scope: "webhooks:write", parameters: [{ name: "subscriptionId", in: "path", required: true, schema: id }], requestBody: objectInput({}), responseBody: wrapped("subscription", webhookSubscription), mcpInputSchema: objectInput({ subscriptionId: id }, ["subscriptionId"]) },
  { operationId: "webhooks.deliveries.list", mcpName: "social_webhook_deliveries_list", method: "GET", path: "/v1/webhooks/deliveries", summary: "List durable webhook delivery and attempt state", scope: "webhooks:read", parameters: [{ name: "subscriptionId", in: "query", schema: id }, ...pageParameters], responseBody: pageOf(webhookDelivery), mcpInputSchema: objectInput({ subscriptionId: id, cursor, limit }) },
  { operationId: "audit.list", mcpName: "social_audit_list", method: "GET", path: "/v1/audit-events", summary: "List bounded, redacted audit events", scope: "audit:read", parameters: [{ name: "accountId", in: "query", schema: id }, ...pageParameters], responseBody: pageOf(auditEvent), mcpInputSchema: objectInput({ accountId: id, cursor, limit }) },
] as const;

const publicErrorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId", "retryable"],
      properties: {
        code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" }, retryable: { type: "boolean" },
        details: {},
        rateLimit: { type: "object", properties: { limit: { type: "integer" }, remaining: { type: "integer" }, resetAt: { type: "string", format: "date-time" }, retryAfterSeconds: { type: "integer" } } },
      },
    },
  },
};

const readinessResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "contractVersion", "checks"],
  properties: {
    status: { type: "string", enum: ["ready", "not_ready"] },
    contractVersion: { type: "integer", const: 1 },
    checks: {
      type: "object",
      description: "Versioned, non-secret component diagnostics. Backlog values are capped at 10000 and carry a truncated flag.",
      required: ["databases", "workers", "maintenance", "backlog", "product"],
      properties: {
        actionWorker: { type: "boolean" }, webhookWorker: { type: "boolean" }, redditWorker: { type: "boolean" },
        xWorkerReachable: { type: "boolean" }, productWritesReady: { type: "boolean" },
        certificationGrantActive: { type: "boolean" }, writeExecutionMode: { type: "string", enum: ["product", "product_with_certification"] },
        databases: { type: "object", additionalProperties: true },
        workers: { type: "object", additionalProperties: true },
        maintenance: { type: "object", additionalProperties: true },
        backlog: { type: "object", additionalProperties: true },
        product: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
};

export function generateOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of OPERATIONS) {
    const method = operation.method.toLowerCase();
    const pathItem = paths[operation.path] ?? (paths[operation.path] = {});
    const examples = OPENAPI_REPRESENTATIVE_EXAMPLES[operation.operationId];
    const availability = contractAvailability(operation.operationId);
    pathItem[method] = {
      operationId: operation.operationId,
      summary: operation.summary,
      security: [{ bearerAuth: [] }],
      "x-required-scope": operation.scope,
      "x-mcp-tool": operation.mcpName,
      "x-social-git-platform": availability.platform,
      "x-social-git-availability": availability.availability,
      ...(availability.disabledReasons ? { "x-social-git-disabled-reasons": availability.disabledReasons } : {}),
      ...(operation.parameters ? { parameters: operation.parameters } : {}),
      ...(operation.requestBody ? { requestBody: { required: true, content: { "application/json": {
        schema: operation.requestBody,
        ...(examples?.request ? { examples: openApiExamples(examples.request) } : {}),
      } } } } : {}),
      responses: {
        [String(operation.successStatus ?? 200)]: { description: "Successful response", headers: {
          "X-Request-ID": { schema: { type: "string" }, description: "Stable request correlation identifier." },
          ...(operation.parameters?.some((parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key") ? { "Idempotency-Replayed": { schema: { type: "boolean" }, description: "True when the response was replayed from the idempotency ledger." } } : {}),
          ...(operation.parameters?.some((parameter) => parameter.name === "cursor") ? { "X-Next-Cursor": { schema: cursor, description: "Present when another bounded page is available." } } : {}),
        }, content: { "application/json": {
          schema: operation.responseBody,
          ...(examples?.responses ? { examples: openApiExamples(examples.responses) } : {}),
        } } },
        default: { description: "Structured error", headers: { "X-Request-ID": { schema: { type: "string" } } }, content: { "application/json": {
          schema: publicErrorSchema,
          ...(operation.operationId === "reads.profile" ? { examples: openApiExamples(OPENAPI_ERROR_EXAMPLES) } : {}),
        } } },
      },
    };
  }
  paths["/healthz"] = {
    get: {
      operationId: "health.get",
      summary: "Process liveness",
      security: [],
      responses: { "200": { description: "Process is alive" } },
    },
  };
  paths["/readyz"] = {
    get: {
      operationId: "readiness.get",
      summary: "Runtime dependency readiness",
      security: [],
      responses: {
        "200": { description: "Runtime is ready", content: { "application/json": { schema: readinessResponseSchema } } },
        "503": { description: "A required dependency is not ready", content: { "application/json": { schema: readinessResponseSchema } } },
      },
    },
  };
  const setupInput = objectInput({
    email: { type: "string", format: "email", maxLength: 254 },
    displayName: { type: "string", minLength: 1, maxLength: 120 },
    password: { type: "string", minLength: 12, maxLength: 256, writeOnly: true },
  }, ["email", "displayName", "password"]);
  const loginInput = objectInput({
    email: { type: "string", format: "email", maxLength: 254 },
    password: { type: "string", minLength: 1, maxLength: 256, writeOnly: true },
  }, ["email", "password"]);
  const sessionResponse = objectInput({
    authenticated: { type: "boolean", const: true },
    csrfToken: { type: "string", writeOnly: true },
    expiresAt: { type: "string", format: "date-time" },
    tenantId: id,
    workspaceId: id,
    role: { type: "string", enum: ["owner", "admin", "member"] },
  }, ["authenticated", "tenantId", "workspaceId", "role"]);
  const apiKeySummary = objectInput({
    id,
    tenantId: id,
    workspaceId: id,
    name: { type: "string", minLength: 1, maxLength: 120 },
    prefix: { type: "string", pattern: "^sgk_[A-Za-z0-9_-]{12}_$", description: "Non-secret display prefix; never sufficient to authenticate." },
    scopes: { type: "array", minItems: 1, maxItems: API_KEY_SCOPES.length, uniqueItems: true, items: { type: "string", enum: API_KEY_SCOPES } },
    createdAt: { type: "string", format: "date-time" },
    lastUsedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    revokedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    rotatedFromId: { oneOf: [id, { type: "null" }] },
  }, ["id", "tenantId", "workspaceId", "name", "prefix", "scopes", "createdAt", "lastUsedAt", "revokedAt", "rotatedFromId"]);
  const apiKeyCreateInput = objectInput({
    name: { type: "string", minLength: 1, maxLength: 120 },
    scopes: { type: "array", minItems: 1, maxItems: API_KEY_SCOPES.length, uniqueItems: true, items: { type: "string", enum: API_KEY_SCOPES } },
  }, ["name", "scopes"]);
  const apiKeyCreation = objectInput({
    apiKey: apiKeySummary,
    secret: { type: "string", writeOnly: true, pattern: "^sgk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$", description: "Shown exactly once. Store it now; only its SHA-256 digest is persisted." },
  }, ["apiKey", "secret"]);
  const csrfParameter = { name: "X-CSRF-Token", in: "header", required: true, schema: { type: "string" } };
  paths["/v1/setup/status"] = {
    get: {
      operationId: "setup.status",
      summary: "Check whether first-run owner setup is required",
      security: [],
      responses: { "200": { description: "Setup status", content: { "application/json": { schema: objectInput({ required: { type: "boolean" } }, ["required"]) } } } },
    },
  };
  paths["/v1/setup/owner"] = {
    post: {
      operationId: "setup.owner.create",
      summary: "Create the one initial owner and authenticated browser session",
      security: [],
      requestBody: { required: true, content: { "application/json": { schema: setupInput } } },
      responses: {
        "201": { description: "Owner created", headers: { "Set-Cookie": { schema: { type: "string" } } }, content: { "application/json": { schema: sessionResponse } } },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
      },
    },
  };
  paths["/v1/auth/login"] = {
    post: {
      operationId: "auth.login",
      summary: "Create an owner browser session",
      security: [],
      requestBody: { required: true, content: { "application/json": { schema: loginInput } } },
      responses: {
        "200": { description: "Authenticated", headers: { "Set-Cookie": { schema: { type: "string" } } }, content: { "application/json": { schema: sessionResponse } } },
        "429": {
          description: "Login attempts are temporarily limited before password derivation",
          headers: {
            "Retry-After": { schema: { type: "integer", minimum: 1 } },
            "X-RateLimit-Limit": { schema: { type: "integer", minimum: 1 } },
            "X-RateLimit-Remaining": { schema: { type: "integer", minimum: 0 } },
            "X-RateLimit-Reset": { schema: { type: "string", format: "date-time" } },
          },
          content: { "application/json": { schema: publicErrorSchema } },
        },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
      },
    },
  };
  paths["/v1/auth/session"] = {
    get: {
      operationId: "auth.session.get",
      summary: "Inspect the current owner browser session",
      security: [{ browserSession: [] }],
      responses: { "200": { description: "Authenticated session", content: { "application/json": { schema: sessionResponse } } } },
    },
  };
  paths["/v1/auth/logout"] = {
    post: {
      operationId: "auth.logout",
      summary: "Revoke the current owner browser session",
      security: [{ browserSession: [] }],
      parameters: [csrfParameter],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({}) } } },
      responses: { "200": { description: "Session revoked" } },
    },
  };
  paths["/v1/control-plane/api-keys"] = {
    get: {
      operationId: "apiKeys.list",
      summary: "List active tenant-scoped API keys without secret material",
      security: [{ browserSession: [] }],
      responses: {
        "200": { description: "Active API keys", content: { "application/json": { schema: pageOf(apiKeySummary) } } },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
      },
    },
    post: {
      operationId: "apiKeys.create",
      summary: "Create a scoped tenant API key; the plaintext secret is returned once",
      security: [{ browserSession: [] }],
      parameters: [csrfParameter],
      requestBody: { required: true, content: { "application/json": { schema: apiKeyCreateInput } } },
      responses: {
        "201": { description: "API key created", content: { "application/json": { schema: apiKeyCreation } } },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
      },
    },
  };
  paths["/v1/control-plane/api-keys/{apiKeyId}/revoke"] = {
    post: {
      operationId: "apiKeys.revoke",
      summary: "Revoke a tenant API key immediately",
      security: [{ browserSession: [] }],
      parameters: [{ name: "apiKeyId", in: "path", required: true, schema: id }, csrfParameter],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({}) } } },
      responses: {
        "200": { description: "API key revoked", content: { "application/json": { schema: objectInput({ apiKey: apiKeySummary, revoked: { type: "boolean", const: true } }, ["apiKey", "revoked"]) } } },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
      },
    },
  };
  paths["/v1/control-plane/api-keys/{apiKeyId}/rotate"] = {
    post: {
      operationId: "apiKeys.rotate",
      summary: "Atomically revoke an API key and return its replacement secret once",
      security: [{ browserSession: [] }],
      parameters: [{ name: "apiKeyId", in: "path", required: true, schema: id }, csrfParameter],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({
        name: { type: "string", minLength: 1, maxLength: 120 },
        scopes: { type: "array", minItems: 1, maxItems: API_KEY_SCOPES.length, uniqueItems: true, items: { type: "string", enum: API_KEY_SCOPES } },
      }) } } },
      responses: {
        "201": { description: "API key rotated", content: { "application/json": { schema: objectInput({
          apiKey: apiKeySummary,
          secret: { type: "string", writeOnly: true, pattern: "^sgk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$" },
          revokedApiKeyId: id,
        }, ["apiKey", "secret", "revokedApiKeyId"]) } } },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
      },
    },
  };
  const workspaceRole = { type: "string", enum: ["owner", "admin", "member"] };
  const workspaceSummary = objectInput({
    id, tenantId: id, name: { type: "string", minLength: 1, maxLength: 120 }, role: workspaceRole,
    status: { type: "string", const: "active" }, createdAt: { type: "string", format: "date-time" },
  }, ["id", "tenantId", "name", "role", "status", "createdAt"]);
  const memberSummary = objectInput({
    userId: id, workspaceId: id, email: { type: "string", format: "email" },
    displayName: { type: "string", minLength: 1, maxLength: 120 }, role: workspaceRole,
    status: { type: "string", enum: ["active", "inactive"] },
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  }, ["userId", "workspaceId", "email", "displayName", "role", "status", "createdAt", "updatedAt"]);
  paths["/v1/control-plane/workspaces"] = {
    get: {
      operationId: "workspaces.list", summary: "Return the installation's single primary data workspace and caller role",
      security: [{ browserSession: [] }],
      responses: { "200": { description: "Workspace memberships", content: { "application/json": { schema: pageOf(workspaceSummary) } } }, default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } } },
    },
  };
  paths["/v1/control-plane/members"] = {
    get: {
      operationId: "members.list", summary: "List members of the selected workspace (owner only)", security: [{ browserSession: [] }],
      responses: { "200": { description: "Workspace members", content: { "application/json": { schema: pageOf(memberSummary) } } }, default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } } },
    },
    post: {
      operationId: "members.provision", summary: "Provision a local user directly into the selected workspace (owner only)", security: [{ browserSession: [] }], parameters: [csrfParameter],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({
        email: { type: "string", format: "email", maxLength: 254 }, displayName: { type: "string", minLength: 1, maxLength: 120 },
        password: { type: "string", minLength: 12, maxLength: 256, writeOnly: true }, role: workspaceRole,
      }, ["email", "displayName", "password", "role"]) } } },
      responses: { "201": { description: "Member provisioned", content: { "application/json": { schema: objectInput({ member: memberSummary }, ["member"]) } } }, default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } } },
    },
  };
  paths["/v1/control-plane/members/{userId}"] = {
    post: {
      operationId: "members.update", summary: "Change a workspace role or membership status with a last-owner guard", security: [{ browserSession: [] }], parameters: [{ name: "userId", in: "path", required: true, schema: id }, csrfParameter],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({ role: workspaceRole, status: { type: "string", enum: ["active", "inactive"] } }) } } },
      responses: { "200": { description: "Membership updated", content: { "application/json": { schema: objectInput({ member: memberSummary }, ["member"]) } } }, "409": { description: "Last active owner cannot be removed", content: { "application/json": { schema: publicErrorSchema } } }, default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } } },
    },
  };
  paths["/v1/control-plane/invitations"] = {
    post: {
      operationId: "invitations.create", summary: "Create a bounded one-time local invitation without outbound mail", security: [{ browserSession: [] }], parameters: [csrfParameter],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({ email: { type: "string", format: "email", maxLength: 254 }, role: workspaceRole, expiresInHours: { type: "integer", minimum: 1, maximum: 168 } }, ["email", "role"]) } } },
      responses: { "201": { description: "Invitation created; token is shown once", content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["invitation", "token"], properties: { invitation: { type: "object" }, token: { type: "string", writeOnly: true, pattern: "^[A-Za-z0-9_-]{43}$" } } } } } }, default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } } },
    },
  };
  paths["/v1/invitations/accept"] = {
    post: {
      operationId: "invitations.accept", summary: "Consume a one-time invitation and create a local user session", security: [],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({ token: { type: "string", minLength: 43, maxLength: 43, writeOnly: true }, displayName: { type: "string", minLength: 1, maxLength: 120 }, password: { type: "string", minLength: 12, maxLength: 256, writeOnly: true } }, ["token", "displayName", "password"]) } } },
      responses: { "201": { description: "Invitation accepted", headers: { "Set-Cookie": { schema: { type: "string" } } }, content: { "application/json": { schema: sessionResponse } } }, default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } } },
    },
  };
  paths["/v1/control-plane/accounts/{accountId}/reddit-session"] = {
    post: {
      operationId: "redditSession.import",
      summary: "Import one explicitly exported Reddit owner session directly into encrypted Core custody",
      description: "Browser-only same-origin upload. Bearer and API-key authentication are rejected. The bounded JSON body is never staged on disk or returned.",
      security: [{ browserSession: [] }],
      parameters: [
        { name: "accountId", in: "path", required: true, schema: id },
        csrfParameter,
        { name: "Sec-Fetch-Site", in: "header", required: true, schema: { type: "string", const: "same-origin" } },
      ],
      requestBody: { required: true, content: { "application/json": { schema: objectInput({
        version: { type: "integer", const: 1 },
        platform: { type: "string", const: "reddit" },
        expectedNativeUserId: id,
        redditSessionCookie: { type: "string", minLength: 1, maxLength: 8192, writeOnly: true },
        csrfToken: { type: "string", minLength: 1, maxLength: 4096, writeOnly: true },
      }, ["version", "platform", "expectedNativeUserId", "redditSessionCookie", "csrfToken"]) } } },
      responses: {
        "201": {
          description: "Session encrypted, native identity verified, and a newer generation activated",
          headers: { "X-Request-ID": { schema: { type: "string" } } },
          content: { "application/json": { schema: wrapped("connection", connection) } },
        },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Social Git API", version: "1.2.0", description: "Versioned installation-scoped REST, OpenAPI, MCP, and signed webhook contract for session-authenticated social interaction. Each installation has one primary data workspace with multiple local users." },
    servers: [{ url: "/" }],
    paths,
    components: { securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "A tenant API key, or an optional legacy file-provisioned bearer token during migration." },
      browserSession: { type: "apiKey", in: "cookie", name: "social_git_session" },
    } },
  };
}

function openApiExamples(examples: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, { value }]));
}

function contractAvailability(operationId: string): ContractAvailability {
  if (operationId.startsWith("reddit.messages.")) {
    const disabledReasons = operationId === "reddit.messages.list"
      ? ["AUTHORIZED_LIVE_INBOX_PROOF_MISSING"]
      : operationId === "reddit.messages.thread"
        ? ["DIRECT_SESSION_THREAD_MAPPING_UNPROVEN"]
        : ["NO_VERIFIABLE_NATIVE_RESULT", "DIRECT_SESSION_REPLY_MAPPING_UNPROVEN", "AUTHORIZED_LIVE_WRITE_PROOF_MISSING"];
    return { platform: "reddit", availability: "fixture_only", disabledReasons };
  }
  if (operationId.startsWith("x.")) {
    return {
      platform: "x",
      availability: "fixture_only",
      disabledReasons: X_TRANSPORT_ADMISSION.disabledReasons,
    };
  }
  if (operationId.startsWith("reads.") || operationId === "actions.create") {
    return { platform: "reddit", availability: "production" };
  }
  return { platform: "core", availability: "production" };
}
