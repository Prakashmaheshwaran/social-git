import type { AccountRecord, ActionRecord } from "./persistence.ts";
import { AdapterExecutionError, type AdapterWriteOutcome, type PlatformAdapter, type ReadRequest, type ReconcileOutcome, type WriteRequest } from "./adapter.ts";

const ALL_CAPABILITIES = [
  "profile:read", "subreddit:read", "feed:read", "post:read", "comments:read", "search:read",
  "text_post:write", "link_post:write", "media_post:write", "comment:write", "reply:write",
  "vote:write", "save:write", "unsave:write", "delete_own:write",
];

export type MockMode = "success" | "failed" | "action_required" | "rate_limited" | "unknown" | "throw_before_submit" | "throw_after_submit";

export class MockRedditAdapter implements PlatformAdapter {
  readonly platform = "reddit";
  identity: string;
  mode: MockMode = "success";
  submitCount = 0;
  revoked = false;
  readonly seenWriteKinds: string[] = [];
  private reconciliations = new Map<string, ReconcileOutcome>();

  constructor(identity = "native-user-1") {
    this.identity = identity;
  }

  async capabilities(_account: AccountRecord) { return [...ALL_CAPABILITIES]; }

  async verifyIdentity(_input: { account: AccountRecord; vaultHandle: string }) {
    if (this.revoked) throw new AdapterExecutionError("SESSION_REVOKED", "mock session revoked");
    return { nativeUserId: this.identity };
  }

  async read(input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }) {
    const { request } = input;
    switch (request.kind) {
      case "profile":
        return { nativeId: this.identity, canonicalUrl: `https://www.reddit.com/user/${this.identity}/`, username: this.identity };
      case "subreddit":
        return { nativeId: `t5_${request.subreddit}`, canonicalUrl: `https://www.reddit.com/r/${request.subreddit}/`, name: request.subreddit };
      case "post":
        return { nativeId: request.postId, canonicalUrl: `https://www.reddit.com/comments/${request.postId}/`, title: "Mock post" };
      case "feed":
        return page("post", request.limit, request.cursor, (nativeId) => ({ nativeId, canonicalUrl: `https://www.reddit.com/comments/${nativeId}/`, subreddit: request.subreddit ?? "all" }));
      case "comments":
        return page("comment", request.limit, request.cursor, (nativeId) => ({ nativeId, canonicalUrl: `https://www.reddit.com/comments/${request.postId}/_/${nativeId}/`, postId: request.postId }));
      case "search":
        return page("search", request.limit, request.cursor, (nativeId) => ({ nativeId, canonicalUrl: `https://www.reddit.com/comments/${nativeId}/`, query: request.query }));
    }
  }

  async submit(input: { account: AccountRecord; vaultHandle: string; action: ActionRecord; request: WriteRequest }): Promise<AdapterWriteOutcome> {
    this.submitCount += 1;
    this.seenWriteKinds.push(input.request.kind);
    if (this.mode === "throw_before_submit") throw new AdapterExecutionError("PROTOCOL_DRIFT", "mock internal protocol details");
    if (this.mode === "throw_after_submit") throw new AdapterExecutionError("CONNECTION_LOST", "mock transport details", { submissionMayHaveStarted: true, retryable: true });
    if (this.mode === "failed") return { status: "failed", code: "PLATFORM_REJECTED", message: "The platform rejected the write." };
    if (this.mode === "action_required") return { status: "action_required", code: "CHALLENGE_REQUIRED", message: "Human action is required on the platform." };
    if (this.mode === "rate_limited") return { status: "failed", code: "RATE_LIMITED", message: "The platform rate limit was reached.", retryable: true, rateLimit: { remaining: 0, retryAfterSeconds: 60 } };
    if (this.mode === "unknown") return { status: "unknown", message: "The platform result could not be verified." };
    const target = targetFor(input.request, input.action.id);
    return { status: "confirmed", result: { nativeId: target.nativeId, canonicalUrl: target.canonicalUrl, kind: input.request.kind } };
  }

  setReconciliation(actionId: string, outcome: ReconcileOutcome) { this.reconciliations.set(actionId, outcome); }

  async reconcile(input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }) {
    return this.reconciliations.get(input.action.id) ?? { status: "pending" as const };
  }

  async revoke(_input: { account: AccountRecord; vaultHandle: string }) { this.revoked = true; }
}

function page(prefix: string, limit: number, cursor: string | undefined, map: (nativeId: string) => Record<string, unknown>) {
  const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) : 0;
  const count = Math.min(limit, 3);
  const items = Array.from({ length: count }, (_, index) => map(`${prefix}-${offset + index + 1}`));
  return { items, nextCursor: count === limit ? Buffer.from(String(offset + count)).toString("base64url") : null };
}

function targetFor(request: WriteRequest, actionId: string) {
  const newId = `mock-${request.kind}-${actionId}`;
  switch (request.kind) {
    case "text_post":
    case "link_post":
    case "media_post": return { nativeId: newId, canonicalUrl: `https://www.reddit.com/r/${request.subreddit}/comments/${newId}/` };
    case "comment": return { nativeId: newId, canonicalUrl: `https://www.reddit.com/comments/${request.postId}/_/${newId}/` };
    case "reply": return { nativeId: newId, canonicalUrl: `https://www.reddit.com/comments/_/_/${newId}/` };
    default: return { nativeId: request.targetId, canonicalUrl: `https://www.reddit.com/${request.targetId}/` };
  }
}
