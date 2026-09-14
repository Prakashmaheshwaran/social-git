import {
  RedditSessionTransport,
  RedditTransportError,
  type RedditProductionResult,
} from "@social-git/reddit-adapter";
import {
  AdapterExecutionError,
  type AdapterWriteOutcome,
  type PlatformAdapter,
  type ReadRequest,
  type ReconcileOutcome,
  type WriteRequest,
} from "./adapter.ts";
import type { AccountRecord, ActionRecord } from "./persistence.ts";

const CAPABILITIES = Object.freeze([
  "profile:read", "subreddit:read", "feed:read", "post:read", "comments:read", "search:read",
  "text_post:write", "link_post:write", "comment:write", "reply:write", "vote:write",
  "save:write", "unsave:write", "delete_own:write",
]);

export interface RedditTransportProvider {
  bind(input: { account: AccountRecord; vaultHandle: string }): Promise<RedditSessionTransport> | RedditSessionTransport;
  revoke?(input: { account: AccountRecord; vaultHandle: string }): Promise<void> | void;
}

/** PlatformAdapter bridge for the admitted browser-free Reddit session transport. */
export class ProductionRedditAdapter implements PlatformAdapter {
  readonly platform = "reddit";
  private readonly provider: RedditTransportProvider;

  constructor(provider: RedditTransportProvider) {
    if (!provider || typeof provider.bind !== "function") throw new TypeError("A Core Reddit transport provider is required");
    this.provider = provider;
  }

  async capabilities(_account: AccountRecord): Promise<string[]> {
    return [...CAPABILITIES];
  }

  unsupportedCapabilities() {
    return Object.freeze({ media_post: "MEDIA_FLOW_NOT_ADMITTED" });
  }

  async verifyIdentity(input: { account: AccountRecord; vaultHandle: string }) {
    try {
      const transport = await this.transport(input);
      const result = await transport.verifyIdentity();
      return { nativeUserId: expectedIdentityValue(input.account.expectedNativeUserId, result) };
    } catch (error) {
      throw adapterError(error);
    }
  }

  async read(input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }) {
    try {
      const transport = await this.transport(input);
      const mapped = mapReadRequest(input.request);
      const result = await transport.execute(mapped.operation, mapped.input, {
        actionId: `read-${input.request.kind}`,
      });
      return projectRead(input.request, result);
    } catch (error) {
      throw adapterError(error);
    }
  }

  async submit(input: {
    account: AccountRecord;
    vaultHandle: string;
    action: ActionRecord;
    request: WriteRequest;
  }): Promise<AdapterWriteOutcome> {
    if (input.request.kind === "media_post") {
      return {
        status: "failed",
        code: "CAPABILITY_DISABLED",
        message: "Reddit media submission has no admitted production transport.",
        retryable: false,
      };
    }
    try {
      const transport = await this.transport(input);
      const mapped = mapWriteRequest(input.request);
      const result = await transport.execute(mapped.operation, mapped.input, {
        actionId: input.action.id,
        callerId: input.action.callerId,
        idempotencyKey: input.action.idempotencyKey,
      });
      if (!result.native?.nativeId) throw new AdapterExecutionError("PROTOCOL_DRIFT", "The confirmed Reddit write has no native ID");
      return {
        status: "confirmed",
        result: {
          nativeId: result.native.nativeId,
          ...(result.native.canonicalUrl ? { canonicalUrl: result.native.canonicalUrl } : {}),
        },
      };
    } catch (error) {
      const normalized = adapterError(error);
      if (normalized.submissionMayHaveStarted) {
        return { status: "unknown", message: "The Reddit write result could not be verified." };
      }
      if (["AUTHENTICATION_FAILED", "CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED", "CAPTCHA_REQUIRED", "SESSION_REVOKED", "WRONG_IDENTITY"].includes(normalized.code)) {
        return { status: "action_required", code: normalized.code, message: "Reddit requires account action." };
      }
      return {
        status: "failed",
        code: normalized.code,
        message: "Reddit rejected the action before submission.",
        retryable: normalized.retryable,
        ...(normalized.rateLimit ? { rateLimit: normalized.rateLimit } : {}),
      };
    }
  }

  async reconcile(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome> {
    // No admitted Reddit route can prove an unknown create without a native ID.
    // Recovery therefore remains read-only and pending; it never repeats a write.
    return { status: "pending" };
  }

  async revoke(input: { account: AccountRecord; vaultHandle: string }) {
    const transport = await this.transport(input);
    transport.revoke();
    await this.provider.revoke?.(input);
  }

  private async transport(input: { account: AccountRecord; vaultHandle: string }) {
    const transport = await this.provider.bind(input);
    if (!(transport instanceof RedditSessionTransport) || transport.binding().accountId !== input.account.id) {
      throw new AdapterExecutionError("PROTOCOL_DRIFT", "Core returned a Reddit transport for the wrong account");
    }
    return transport;
  }
}

function mapReadRequest(request: ReadRequest): { operation: any; input: Record<string, unknown> } {
  switch (request.kind) {
    case "profile": return { operation: "profile.get", input: {} };
    case "subreddit": return { operation: "subreddit.get", input: { name: request.subreddit } };
    case "feed": return { operation: "listing.list", input: compact({ subreddit: request.subreddit, limit: request.limit, after: request.cursor }) };
    case "post": return { operation: "post.get", input: { nativeId: postFullname(request.postId) } };
    case "comments": return { operation: "comments.list", input: compact({ postNativeId: postFullname(request.postId), limit: request.limit }) };
    case "search": return { operation: "search.query", input: compact({ query: request.query, limit: request.limit }) };
  }
}

function mapWriteRequest(request: Exclude<WriteRequest, { kind: "media_post" }>): { operation: any; input: Record<string, unknown> } {
  switch (request.kind) {
    case "text_post": return { operation: "post.createText", input: { subreddit: request.subreddit, title: request.title, body: request.text } };
    case "link_post": return { operation: "post.createLink", input: { subreddit: request.subreddit, title: request.title, url: request.url } };
    case "comment": return { operation: "comment.create", input: { postNativeId: postFullname(request.postId), body: request.text } };
    case "reply": return { operation: "reply.create", input: { commentNativeId: commentFullname(request.commentId), body: request.text } };
    case "vote": return { operation: "vote.set", input: { nativeId: itemFullname(request.targetId), direction: request.direction } };
    case "save": return { operation: "save.set", input: { nativeId: itemFullname(request.targetId) } };
    case "unsave": return { operation: "save.unset", input: { nativeId: itemFullname(request.targetId) } };
    case "delete": return { operation: "item.deleteOwn", input: { nativeId: itemFullname(request.targetId) } };
  }
}

function projectRead(request: ReadRequest, result: RedditProductionResult) {
  const data = result.data as Record<string, any>;
  if (request.kind === "feed" || request.kind === "search" || request.kind === "comments") {
    const items = Array.isArray(data.items) ? data.items.map((item) => projectEntity(request.kind, item)) : [];
    return { items, nextCursor: data.page?.after ?? null };
  }
  return projectEntity(request.kind, data);
}

function projectEntity(kind: ReadRequest["kind"], data: Record<string, any>) {
  const common = compact({
    nativeId: data.nativeId,
    canonicalUrl: data.canonicalUrl,
    title: data.title,
    subreddit: data.subreddit,
    score: data.score,
    url: data.url,
    createdAt: epochDate(data.created_utc),
  });
  if (kind === "profile") {
    return compact({
      ...common,
      username: data.username,
      karma: compact({ post: data.link_karma, comment: data.comment_karma, total: data.total_karma }),
    });
  }
  if (kind === "subreddit") {
    return compact({ ...common, name: data.name, description: data.public_description, subscribers: data.subscribers });
  }
  if (kind === "comments") {
    return compact({ ...common, parentNativeId: data.parent_id, authorNativeId: data.author, body: data.body });
  }
  return compact({ ...common, authorNativeId: data.author, body: data.selftext });
}

function expectedIdentityValue(expected: string, result: RedditProductionResult) {
  const nativeId = result.native?.nativeId;
  if (expected.replace(/^reddit:/u, "") === nativeId) return expected;
  return String(nativeId);
}

function adapterError(error: unknown): AdapterExecutionError {
  if (error instanceof AdapterExecutionError) return error;
  if (error instanceof RedditTransportError) {
    return new AdapterExecutionError(error.code, "The Reddit transport stopped.", {
      retryable: error.retryable,
      submissionMayHaveStarted: error.submissionMayHaveStarted,
      rateLimit: error.rateLimit,
    });
  }
  return new AdapterExecutionError("PROTOCOL_DRIFT", "The Reddit transport returned an invalid result");
}

function postFullname(value: string) { return value.startsWith("t3_") ? value : `t3_${value}`; }
function commentFullname(value: string) { return value.startsWith("t1_") ? value : `t1_${value}`; }
function itemFullname(value: string) {
  if (!/^t[13]_[a-z0-9]+$/u.test(value)) throw new AdapterExecutionError("VALIDATION_FAILED", "A Reddit target must be a native fullname");
  return value;
}
function epochDate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}
function compact<T extends Record<string, any>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
