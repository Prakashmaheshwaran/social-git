import type { OperationDefinition } from "./contract.ts";
import { assertString, ServiceError } from "./errors.ts";
import type { Principal, SocialGitService } from "./service.ts";

export async function executeOperation(
  service: SocialGitService,
  operation: OperationDefinition,
  principal: Principal | null | undefined,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!principal?.callerId) throw new ServiceError("UNAUTHENTICATED", "Authentication is required.");
  const caller = principal;
  switch (operation.operationId) {
    case "accounts.create": return service.createAccount(caller, input);
    case "accounts.list": return service.listAccounts(caller, input as { cursor?: string; limit?: number });
    case "accounts.get": return service.getAccount(caller, required(input, "accountId"));
    case "connections.import": return service.importConnection(caller, required(input, "accountId"), input);
    case "connections.get": return service.getConnection(caller, required(input, "accountId"));
    case "capabilities.list": return service.listCapabilities(caller, required(input, "accountId"));
    case "accounts.revoke": return service.revokeAccount(caller, required(input, "accountId"), input);
    case "reads.profile": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "profile" });
    case "reads.subreddit": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "subreddit", subreddit: required(input, "subreddit") });
    case "reads.feed": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "feed", ...(optional(input, "subreddit") ? { subreddit: optional(input, "subreddit") } : {}), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "reads.post": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "post", postId: required(input, "postId") });
    case "reads.comments": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "comments", postId: required(input, "postId"), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "reads.search": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "search", query: required(input, "query", 512), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "actions.create": return service.enqueueAction(caller, required(input, "accountId"), required(input, "idempotencyKey"), input.action);
    case "actions.get": return service.getAction(caller, required(input, "actionId"));
    case "actions.reconcile": return service.reconcileAction(caller, required(input, "actionId"));
    case "audit.list": return service.listAuditEvents(caller, { accountId: optional(input, "accountId"), cursor: optional(input, "cursor"), limit: input.limit === undefined ? undefined : pageLimit(input.limit) });
    case "events.ingest": return service.ingestAdapterEvent(caller, input);
    default: throw new ServiceError("NOT_FOUND", "Operation not found.");
  }
}

function required(input: Record<string, unknown>, key: string, max = 128) { return assertString(input[key], key, max); }
function optional(input: Record<string, unknown>, key: string) { return input[key] === undefined ? undefined : assertString(input[key], key, 512); }

function pageLimit(value: unknown): number {
  if (value === undefined) return 25;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 1 || Number(parsed) > 100) {
    throw new ServiceError("VALIDATION_FAILED", "limit must be an integer from 1 through 100.", { details: { field: "limit" } });
  }
  return Number(parsed);
}
