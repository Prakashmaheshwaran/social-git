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
    platform: { type: "string", enum: ["reddit"] },
    expectedNativeUserId: id,
    label: { type: "string", maxLength: 120 },
  },
};

const connectionImport = {
  type: "object",
  additionalProperties: false,
  required: ["vaultHandle", "generation"],
  properties: {
    vaultHandle: { type: "string", minLength: 1, maxLength: 256, description: "Opaque reference to encrypted session material. Raw credentials are not accepted." },
    generation: { type: "integer", minimum: 1 },
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
    payload: { type: "object" },
  },
};

const nativeEntity = {
  type: "object",
  required: ["nativeId"],
  properties: { nativeId: id, canonicalUrl: { type: "string", format: "uri" } },
  additionalProperties: true,
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
  properties: { items: { type: "array", items: itemSchema }, nextCursor: { oneOf: [cursor, { type: "null" }] } },
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
  { operationId: "connections.get", mcpName: "social_connections_get", method: "GET", path: "/v1/accounts/{accountId}/connection", summary: "Get redacted connection health", scope: "connections:read", parameters: [accountIdParameter], responseBody: wrapped("connection", connection), mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "capabilities.list", mcpName: "social_capabilities_list", method: "GET", path: "/v1/accounts/{accountId}/capabilities", summary: "List capabilities declared for an account", scope: "social:read", parameters: [accountIdParameter], responseBody: objectInput({ platform: { type: "string" }, capabilities: { type: "array", items: { type: "string" } } }, ["platform", "capabilities"]), mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "accounts.revoke", mcpName: "social_accounts_revoke", method: "POST", path: "/v1/accounts/{accountId}/revoke", summary: "Revoke an account connection", scope: "connections:write", parameters: [accountIdParameter], requestBody: objectInput({ reason: { type: "string", maxLength: 200 } }), responseBody: wrapped("connection", connection), mcpInputSchema: objectInput({ accountId: id, reason: { type: "string", maxLength: 200 } }, ["accountId"]) },
  { operationId: "reads.profile", mcpName: "reddit_profile_get", method: "GET", path: "/v1/accounts/{accountId}/profile", summary: "Read the connected native account profile", scope: "social:read", parameters: [accountIdParameter], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id }, ["accountId"]) },
  { operationId: "reads.subreddit", mcpName: "reddit_subreddit_get", method: "GET", path: "/v1/accounts/{accountId}/subreddits/{subreddit}", summary: "Read subreddit metadata", scope: "social:read", parameters: [accountIdParameter, { name: "subreddit", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, subreddit: id }, ["accountId", "subreddit"]) },
  { operationId: "reads.feed", mcpName: "reddit_feed_list", method: "GET", path: "/v1/accounts/{accountId}/feed", summary: "Read a feed listing", scope: "social:read", parameters: [accountIdParameter, { name: "subreddit", in: "query", schema: id }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, subreddit: id, cursor, limit }, ["accountId"]) },
  { operationId: "reads.post", mcpName: "reddit_post_get", method: "GET", path: "/v1/accounts/{accountId}/posts/{postId}", summary: "Read a post", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }], responseBody: nativeEntity, mcpInputSchema: objectInput({ accountId: id, postId: id }, ["accountId", "postId"]) },
  { operationId: "reads.comments", mcpName: "reddit_comments_list", method: "GET", path: "/v1/accounts/{accountId}/posts/{postId}/comments", summary: "Read comments for a post", scope: "social:read", parameters: [accountIdParameter, { name: "postId", in: "path", required: true, schema: id }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, postId: id, cursor, limit }, ["accountId", "postId"]) },
  { operationId: "reads.search", mcpName: "reddit_search", method: "GET", path: "/v1/accounts/{accountId}/search", summary: "Search Reddit", scope: "social:read", parameters: [accountIdParameter, { name: "query", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 512 } }, ...pageParameters], responseBody: pageOf(nativeEntity), mcpInputSchema: objectInput({ accountId: id, query: { type: "string", minLength: 1, maxLength: 512 }, cursor, limit }, ["accountId", "query"]) },
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
  return {
    openapi: "3.1.0",
    info: { title: "Social Git API", version: "1.0.0", description: "Stable, session-authenticated social interaction gateway contract." },
    servers: [{ url: "/" }],
    paths,
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
}
