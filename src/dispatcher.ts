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
    case "connections.refresh": return service.refreshConnection(caller, required(input, "accountId"), input);
    case "connections.get": return service.getConnection(caller, required(input, "accountId"));
    case "capabilities.list": return service.listCapabilities(caller, required(input, "accountId"));
    case "platforms.capabilities": return service.listPlatformCapabilities(caller, required(input, "platform", 32));
    case "media.create": {
      const { accountId, ...media } = input;
      return service.createMedia(caller, required({ accountId }, "accountId"), media);
    }
    case "accounts.revoke": return service.revokeAccount(caller, required(input, "accountId"), input);
    case "reads.profile": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "profile" });
    case "reads.subreddit": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "subreddit", subreddit: required(input, "subreddit") });
    case "reads.feed": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "feed", ...(optional(input, "subreddit") ? { subreddit: optional(input, "subreddit") } : {}), sort: optionalEnum(input, "sort", ["hot", "new", "top", "rising", "best", "controversial"]), timeframe: optionalEnum(input, "timeframe", TIMEFRAMES), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "reads.post": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "post", postId: required(input, "postId") });
    case "reads.comments": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "comments", postId: required(input, "postId"), sort: optionalEnum(input, "sort", ["best", "top", "new", "controversial", "old", "qa"]), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "reads.search": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "search", query: required(input, "query", 512), subreddit: optional(input, "subreddit"), sort: optionalEnum(input, "sort", ["relevance", "hot", "top", "new", "comments"]), timeframe: optionalEnum(input, "timeframe", TIMEFRAMES), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "reads.userProfile": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "user_profile", username: required(input, "username", 20) });
    case "reads.userContent": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "user_content", username: required(input, "username", 20), content: requiredEnum(input, "content", ["submitted", "comments"]), sort: optionalEnum(input, "sort", ["hot", "new", "top", "controversial"]), timeframe: optionalEnum(input, "timeframe", TIMEFRAMES), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "reads.saved": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "saved", cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "reads.upvoted": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "upvoted", cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.account.health": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_account_health" });
    case "x.profiles.get": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_profile", username: required(input, "username") });
    case "x.posts.get": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_post", postId: required(input, "postId") });
    case "x.threads.get": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_thread", postId: required(input, "postId"), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.timelines.home": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_home_timeline", cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.timelines.user": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_user_timeline", username: required(input, "username"), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.search": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_search", query: required(input, "query", 512), cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.notifications.list": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_notifications", cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.conversations.list": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_conversations", cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.bookmarks.list": return service.read(caller, required(input, "accountId"), operation.operationId, { kind: "x_bookmarks", cursor: optional(input, "cursor"), limit: pageLimit(input.limit) });
    case "x.actions.create": return service.enqueueAction(caller, required(input, "accountId"), required(input, "idempotencyKey"), input.action, operation.operationId);
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
const TIMEFRAMES = ["hour", "day", "week", "month", "year", "all"] as const;
function optionalEnum<T extends string>(input: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
  if (input[key] === undefined) return undefined;
  return requiredEnum(input, key, values);
}
function requiredEnum<T extends string>(input: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = required(input, key, 32);
  if (!values.includes(value as T)) throw new ServiceError("VALIDATION_FAILED", `${key} is not supported.`, { details: { field: key } });
  return value as T;
}

function pageLimit(value: unknown): number {
  if (value === undefined) return 25;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 1 || Number(parsed) > 100) {
    throw new ServiceError("VALIDATION_FAILED", "limit must be an integer from 1 through 100.", { details: { field: "limit" } });
  }
  return Number(parsed);
}
