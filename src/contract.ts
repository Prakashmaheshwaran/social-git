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

export const API_KEY_SCOPES = Object.freeze([
  "accounts:write", "accounts:read", "connections:write", "connections:read",
  "social:read", "social:write", "actions:read", "audit:read", "events:ingest",
]);

const id = { type: "string", minLength: 1, maxLength: 128 };
const cursor = { type: "string", maxLength: 512 };
const limit = { type: "integer", minimum: 1, maximum: 100, default: 25 };
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
  "vote",
  "save",
  "unsave",
  "delete",
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
      title: "Delete caller-owned item",
      type: "object", additionalProperties: false, required: ["kind", "targetId"],
      properties: { kind: { const: "delete" }, targetId: id },
    },
  ],
};

const adapterEvent = {
  type: "object",
  additionalProperties: false,
  required: ["version", "eventId", "source", "accountId", "type", "occurredAt", "payload"],
  properties: {
    version: { const: 1 }, eventId: id, source: id, accountId: id,
    type: { type: "string", enum: ["action.result"] },
    occurredAt: { type: "string", format: "date-time" },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["actionId", "attempt", "state"],
      properties: {
        actionId: id,
        attempt: { type: "integer", minimum: 1 },
        state: { type: "string", enum: ["succeeded", "failed", "action_required", "UNKNOWN"] },
        result: {},
        error: {},
      },
    },
  },
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

const account = {
  type: "object",
  additionalProperties: false,
  required: ["id", "platform", "expectedNativeUserId", "actualNativeUserId", "status", "createdAt", "updatedAt"],
  properties: {
    id, platform: { type: "string" }, expectedNativeUserId: id, actualNativeUserId: { oneOf: [id, { type: "null" }] },
    label: { oneOf: [{ type: "string" }, { type: "null" }] }, status: { type: "string", enum: ["disconnected", "active", "suspended", "revoked"] },
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
    state: { type: "string", enum: ["queued", "running", "succeeded", "failed", "action_required", "UNKNOWN"] },
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

const pageOf = (itemSchema: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required: ["items", "nextCursor"],
  properties: { items: { type: "array", items: itemSchema }, nextCursor: { oneOf: [cursor, { type: "null" }] }, rateLimit },
});

const wrapped = (key: string, schema: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
  type: "object", additionalProperties: false, required: [key, ...Object.keys(extras)], properties: { [key]: schema, ...extras },
});

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
  { operationId: "capabilities.list", mcpName: "social_capabilities_list", method: "GET", path: "/v1/accounts/{accountId}/capabilities", summary: "List capabilities and production admission state for an account", scope: "social:read", parameters: [accountIdParameter], responseBody: objectInput({ platform: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, details: { type: "array", items: { type: "object", additionalProperties: true } } }, ["platform", "capabilities"]), mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "platforms.capabilities", mcpName: "social_platform_capabilities", method: "GET", path: "/v1/platforms/{platform}/capabilities", summary: "Discover pre-connection platform capabilities and production admission state", scope: "social:read", parameters: [{ name: "platform", in: "path", required: true, schema: { type: "string", enum: ["x"] } }], responseBody: objectInput({ platform: { type: "string" }, details: { type: "array", items: { type: "object", additionalProperties: true } } }, ["platform", "details"]), mcpInputSchema: objectInput({ platform: { type: "string", enum: ["x"] } }, ["platform"]) },
  { operationId: "media.create", mcpName: "social_media_create", method: "POST", path: "/v1/accounts/{accountId}/media", summary: "Store bounded image media in Core and return an account-scoped media reference", scope: "social:write", successStatus: 201, parameters: [accountIdParameter], requestBody: mediaCreate, responseBody: wrapped("media", mediaAsset), mcpInputSchema: objectInput({ accountId: id, ...mediaCreate.properties }, ["accountId", ...mediaCreate.required]) },
  { operationId: "accounts.revoke", mcpName: "social_accounts_revoke", method: "POST", path: "/v1/accounts/{accountId}/revoke", summary: "Revoke an account connection", scope: "connections:write", parameters: [accountIdParameter], requestBody: objectInput({ reason: { type: "string", maxLength: 200 } }), responseBody: wrapped("connection", connection), mcpInputSchema: objectInput({ accountId: id, reason: { type: "string", maxLength: 200 } }, ["accountId"]) },
  { operationId: "reads.profile", mcpName: "reddit_profile_get", method: "GET", path: "/v1/accounts/{accountId}/profile", summary: "Read the connected native account profile", scope: "social:read", parameters: [accountIdParameter], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "reads.subreddit", mcpName: "reddit_subreddit_get", method: "GET", path: "/v1/accounts/{accountId}/subreddits/{subreddit}", summary: "Read subreddit metadata", scope: "social:read", parameters: [accountIdParameter, { name: "subreddit", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, subreddit: id }, ["accountId", "subreddit"]) },
  { operationId: "reads.feed", mcpName: "reddit_feed_list", method: "GET", path: "/v1/accounts/{accountId}/feed", summary: "Read a feed listing", scope: "social:read", parameters: [accountIdParameter, { name: "subreddit", in: "query", schema: id }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, subreddit: id, cursor, limit }, ["accountId"]) },
  { operationId: "reads.post", mcpName: "reddit_post_get", method: "GET", path: "/v1/accounts/{accountId}/posts/{postId}", summary: "Read a post", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, postId: id }, ["accountId", "postId"]) },
  { operationId: "reads.comments", mcpName: "reddit_comments_list", method: "GET", path: "/v1/accounts/{accountId}/posts/{postId}/comments", summary: "Read comments for a post", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, postId: id, cursor, limit }, ["accountId", "postId"]) },
  { operationId: "reads.search", mcpName: "reddit_search", method: "GET", path: "/v1/accounts/{accountId}/search", summary: "Search Reddit", scope: "social:read", parameters: [accountIdParameter, { name: "query", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 512 } }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, query: { type: "string", minLength: 1, maxLength: 512 }, cursor, limit }, ["accountId", "query"]) },
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
  { operationId: "actions.create", mcpName: "reddit_action_create", method: "POST", path: "/v1/accounts/{accountId}/actions", summary: "Queue an explicitly authorized Reddit write", scope: "social:write", successStatus: 202, parameters: [accountIdParameter, { name: "Idempotency-Key", in: "header", required: true, schema: id }], requestBody: writeRequest, responseBody: wrapped("action", action, { replayed: { type: "boolean" } }), mcpInputSchema: objectInput({ accountId: id, idempotencyKey: id, action: writeRequest }, ["accountId", "idempotencyKey", "action"]) },
  { operationId: "actions.get", mcpName: "social_action_get", method: "GET", path: "/v1/actions/{actionId}", summary: "Get caller-scoped action status", scope: "actions:read", parameters: [{ name: "actionId", in: "path", required: true, schema: id }], responseBody: wrapped("action", action), mcpInputSchema: objectInput({ actionId: id }, ["actionId"]) },
  { operationId: "actions.reconcile", mcpName: "social_action_reconcile", method: "POST", path: "/v1/actions/{actionId}/reconcile", summary: "Reconcile an UNKNOWN action without resubmitting it", scope: "social:write", parameters: [{ name: "actionId", in: "path", required: true, schema: id }], requestBody: objectInput({}), responseBody: wrapped("action", action, { reconciled: { type: "boolean" } }), mcpInputSchema: objectInput({ actionId: id }, ["actionId"]) },
  { operationId: "audit.list", mcpName: "social_audit_list", method: "GET", path: "/v1/audit-events", summary: "List bounded, redacted audit events", scope: "audit:read", parameters: [{ name: "accountId", in: "query", schema: id }, ...pageParameters], responseBody: pageOf(auditEvent), mcpInputSchema: objectInput({ accountId: id, cursor, limit }) },
  { operationId: "events.ingest", mcpName: "social_adapter_event_ingest", method: "POST", path: "/v1/adapter-events", summary: "Ingest a versioned, replay-safe adapter event", scope: "events:ingest", requestBody: adapterEvent, responseBody: wrapped("action", action, { replayed: { type: "boolean" } }), mcpInputSchema: adapterEvent },
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

export function generateOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of OPERATIONS) {
    const method = operation.method.toLowerCase();
    const pathItem = paths[operation.path] ?? (paths[operation.path] = {});
    pathItem[method] = {
      operationId: operation.operationId,
      summary: operation.summary,
      security: [{ bearerAuth: [] }],
      "x-required-scope": operation.scope,
      "x-mcp-tool": operation.mcpName,
      ...(operation.parameters ? { parameters: operation.parameters } : {}),
      ...(operation.requestBody ? { requestBody: { required: true, content: { "application/json": { schema: operation.requestBody } } } } : {}),
      responses: {
        [String(operation.successStatus ?? 200)]: { description: "Successful response", content: { "application/json": { schema: operation.responseBody } } },
        default: { description: "Structured error", content: { "application/json": { schema: publicErrorSchema } } },
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
        "200": { description: "Runtime is ready" },
        "503": { description: "Runtime is not ready" },
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
    role: { type: "string", const: "owner" },
  }, ["authenticated", "tenantId", "role"]);
  const apiKeySummary = objectInput({
    id,
    tenantId: id,
    name: { type: "string", minLength: 1, maxLength: 120 },
    prefix: { type: "string", pattern: "^sgk_[A-Za-z0-9_-]{12}_$", description: "Non-secret display prefix; never sufficient to authenticate." },
    scopes: { type: "array", minItems: 1, maxItems: API_KEY_SCOPES.length, uniqueItems: true, items: { type: "string", enum: API_KEY_SCOPES } },
    createdAt: { type: "string", format: "date-time" },
    lastUsedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    revokedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    rotatedFromId: { oneOf: [id, { type: "null" }] },
  }, ["id", "tenantId", "name", "prefix", "scopes", "createdAt", "lastUsedAt", "revokedAt", "rotatedFromId"]);
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
  return {
    openapi: "3.1.0",
    info: { title: "Social Git API", version: "1.0.0", description: "Stable, session-authenticated social interaction gateway contract." },
    servers: [{ url: "/" }],
    paths,
    components: { securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "A tenant API key, or an optional legacy file-provisioned bearer token during migration." },
      browserSession: { type: "apiKey", in: "cookie", name: "social_git_session" },
    } },
  };
}
