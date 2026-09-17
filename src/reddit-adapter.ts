import {
  REDDIT_CAPABILITIES,
  RedditSessionTransport,
  RedditTransportError,
  isRedditMessagingCandidateAdmitted,
  type RedditMessagingCandidateTestAdmission,
  type RedditProductionResult,
} from "@social-git/reddit-adapter";
import {
  AdapterExecutionError,
  type ActionExecutionContext,
  type AdapterWriteOutcome,
  type PlatformAdapter,
  type ReadRequest,
  type RedditReadRequest,
  type RedditWriteRequest,
  type ReconcileOutcome,
  type WriteRequest,
} from "./adapter.ts";
import type { AccountRecord, ActionRecord } from "./persistence.ts";

const CAPABILITIES = Object.freeze([
  "profile:read", "subreddit:read", "feed:read", "post:read", "comments:read", "search:read",
  "user_profile:read", "user_content:read", "saved:read", "upvoted:read", "identity_health:read",
  "text_post:write", "link_post:write", "media_post:write", "comment:write", "reply:write", "vote:write",
  "edit_own:write", "save:write", "unsave:write", "subscribe:write", "unsubscribe:write", "delete_own:write",
]);
const MEDIA_CAPABILITY = "media_post:write";
const MESSAGE_CAPABILITIES = Object.freeze(["message_inbox:read", "message_thread:read", "message_send:write", "message_reply:write"]);
export const REDDIT_UNSUPPORTED_CAPABILITIES = Object.freeze({
  comment_more_expand: "COMMENT_MORE_EXPANSION_UNSUPPORTED",
  moderation: "PHASE_1_NOT_ADMITTED",
  message_inbox: "AUTHORIZED_LIVE_INBOX_PROOF_MISSING",
  message_thread: "DIRECT_SESSION_THREAD_MAPPING_UNPROVEN",
  message_send: "NO_VERIFIABLE_NATIVE_RESULT",
  message_reply: "DIRECT_SESSION_REPLY_MAPPING_UNPROVEN",
});

export interface RedditTransportProvider {
  bind?(input: { account: AccountRecord; vaultHandle: string }): Promise<RedditSessionTransport> | RedditSessionTransport;
  importConnection?(input: { account: AccountRecord; vaultHandle: string; generation: number }): Promise<void> | void;
  nextConnectionGeneration?(account: AccountRecord): Promise<number> | number;
  importDirectConnection?(input: {
    account: AccountRecord;
    generation: number;
    session: Uint8Array;
    networkRoute: { id: string; material: Uint8Array };
  }): Promise<void> | void;
  execute?(input: {
    account: AccountRecord;
    vaultHandle: string;
    intent: "identity_validation" | "read" | "write";
    operation: string;
    payload: Record<string, unknown>;
  }): Promise<RedditProductionResult>;
  revoke?(input: { account: AccountRecord; vaultHandle: string }): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** PlatformAdapter bridge for the admitted browser-free Reddit session transport. */
export class ProductionRedditAdapter implements PlatformAdapter {
  readonly platform = "reddit";
  private readonly provider: RedditTransportProvider;
  private readonly messagingAdmission?: RedditMessagingCandidateTestAdmission;

  constructor(provider: RedditTransportProvider, options: { messagingAdmission?: RedditMessagingCandidateTestAdmission } = {}) {
    if (!provider || (typeof provider.bind !== "function" && typeof provider.execute !== "function")) {
      throw new TypeError("A Core Reddit transport provider is required");
    }
    this.provider = provider;
    this.messagingAdmission = options.messagingAdmission;
  }

  async prepareConnection(input: { account: AccountRecord; vaultHandle: string; generation: number }) {
    await this.provider.importConnection?.(input);
  }

  async nextConnectionGeneration(account: AccountRecord) {
    if (!this.provider.nextConnectionGeneration) throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "Direct Reddit session import is unavailable.");
    return this.provider.nextConnectionGeneration(account);
  }

  async prepareDirectConnection(input: {
    account: AccountRecord;
    generation: number;
    session: Uint8Array;
    networkRoute: { id: string; material: Uint8Array };
  }) {
    if (!this.provider.importDirectConnection) throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "Direct Reddit session import is unavailable.");
    await this.provider.importDirectConnection(input);
  }

  async capabilities(_account: AccountRecord): Promise<string[]> {
    const capabilities = this.provider.execute ? [...CAPABILITIES] : CAPABILITIES.filter((capability) => capability !== MEDIA_CAPABILITY);
    if (isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.inbox")) capabilities.push(MESSAGE_CAPABILITIES[0]!);
    if (isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.thread")) capabilities.push(MESSAGE_CAPABILITIES[1]!);
    if (isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.send")) capabilities.push(MESSAGE_CAPABILITIES[2]!);
    if (isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.reply") && isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.thread")) capabilities.push(MESSAGE_CAPABILITIES[3]!);
    return capabilities;
  }

  unsupportedCapabilities() {
    return Object.freeze({
      ...(!this.provider.execute ? { media_post: "CORE_MEDIA_PHASE_TRANSPORT_REQUIRED" } : {}),
      ...Object.fromEntries(Object.entries(REDDIT_UNSUPPORTED_CAPABILITIES).filter(([key]) => !isRedditMessagingCandidateAdmitted(this.messagingAdmission, key.replace("_", ".")))),
    });
  }

  async capabilityDetails(_account: AccountRecord) {
    return REDDIT_CAPABILITIES.map((capability) => Object.freeze({ ...capability }));
  }

  capabilityCatalog() {
    return REDDIT_CAPABILITIES.map((capability) => Object.freeze({ ...capability }));
  }

  async verifyIdentity(input: { account: AccountRecord; vaultHandle: string }) {
    try {
      const result = this.provider.execute
        ? await this.provider.execute({ ...input, intent: "identity_validation", operation: "profile.get", payload: {} })
        : await (await this.transport(input)).verifyIdentity();
      return { nativeUserId: expectedIdentityValue(input.account.expectedNativeUserId, result) };
    } catch (error) {
      throw adapterError(error);
    }
  }

  async read(input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }) {
    try {
      if (!isRedditRead(input.request)) throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "The Reddit adapter cannot execute an X read.");
      const request = input.request;
      if ((request.kind === "message_inbox" && !isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.inbox"))
        || (request.kind === "message_thread" && !isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.thread"))) {
        throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "Reddit private-message reads require authorized direct-session admission evidence.");
      }
      const mapped = mapReadRequest(request);
      const result = this.provider.execute
        ? await this.provider.execute({ ...input, intent: "read", operation: mapped.operation, payload: mapped.input })
        : await (await this.transport(input)).execute(mapped.operation, mapped.input, { actionId: `read-${input.request.kind}` });
      return projectRead(request, result);
    } catch (error) {
      throw adapterError(error);
    }
  }

  async submit(input: {
    account: AccountRecord;
    vaultHandle: string;
    action: ActionRecord;
    request: WriteRequest;
    execution?: ActionExecutionContext;
  }): Promise<AdapterWriteOutcome> {
    if (!isRedditWrite(input.request)) return { status: "failed", code: "CAPABILITY_UNAVAILABLE", message: "The Reddit adapter cannot execute an X write." };
    if ((input.request.kind === "message_send" && !isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.send"))
      || (input.request.kind === "message_reply" && (!isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.reply") || !isRedditMessagingCandidateAdmitted(this.messagingAdmission, "message.thread")))) {
      return {
        status: "failed",
        code: "CAPABILITY_DISABLED",
        message: "Reddit private-message writes have not passed production admission.",
        retryable: false,
      };
    }
    if (input.request.kind === "media_post") {
      return this.submitMedia(input as typeof input & { request: Extract<WriteRequest, { kind: "media_post" }> });
    }
    try {
      const mapped = mapWriteRequest(input.request);
      const result = this.provider.execute
        ? await this.provider.execute({ ...input, intent: "write", operation: mapped.operation, payload: mapped.input })
        : await (await this.transport(input)).execute(mapped.operation, mapped.input, {
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
    if (this.provider.bind) {
      const transport = await this.transport(input);
      transport.revoke();
    }
    await this.provider.revoke?.(input);
  }

  async close() { await this.provider.close?.(); }

  private async submitMedia(input: {
    account: AccountRecord;
    vaultHandle: string;
    action: ActionRecord;
    request: Extract<WriteRequest, { kind: "media_post" }>;
    execution?: ActionExecutionContext;
  }): Promise<AdapterWriteOutcome> {
    if (!this.provider.execute || !input.execution) {
      return {
        status: "failed",
        code: "CAPABILITY_DISABLED",
        message: "Reddit media submission requires the Core media phase transport.",
        retryable: false,
      };
    }
    let flow = input.execution.flow;
    let mediaBase64 = "";
    try {
      if (flow.phase === "reserved") {
        const result = await this.provider.execute({
          account: input.account,
          vaultHandle: input.vaultHandle,
          intent: "write",
          operation: "reddit.post.media.lease",
          payload: {
            filename: input.execution.media.filename,
            mimeType: input.execution.media.mimeType,
            sizeBytes: input.execution.media.sizeBytes,
            sha256: input.execution.media.sha256,
          },
        });
        const ticket = mediaTicket(result);
        flow = input.execution.transition("reserved", "leased", ticket);
      }
      if (flow.phase === "leased") {
        const ticket = requiredTicket(flow.workerTicket);
        mediaBase64 = Buffer.from(
          input.execution.media.data.buffer,
          input.execution.media.data.byteOffset,
          input.execution.media.data.byteLength,
        ).toString("base64");
        const result = await this.provider.execute({
          account: input.account,
          vaultHandle: input.vaultHandle,
          intent: "write",
          operation: "reddit.post.media.upload",
          payload: {
            ticket,
            dataBase64: mediaBase64,
            sizeBytes: input.execution.media.sizeBytes,
            sha256: input.execution.media.sha256,
          },
        });
        requireSameMediaTicket(result, ticket);
        flow = input.execution.transition("leased", "uploaded", ticket);
      }
      if (flow.phase === "uploaded") {
        flow = input.execution.beginSubmission(requiredTicket(flow.workerTicket));
      }
      if (flow.phase === "submitting") {
        const ticket = requiredTicket(flow.workerTicket);
        const result = await this.provider.execute({
          account: input.account,
          vaultHandle: input.vaultHandle,
          intent: "write",
          operation: "reddit.post.media.submit",
          payload: { ticket, subreddit: input.request.subreddit, title: input.request.title },
        });
        requireSameMediaTicket(result, ticket);
        flow = input.execution.transition("submitting", "submitted", ticket);
      }
      if (flow.phase === "submitted") {
        const ticket = requiredTicket(flow.workerTicket);
        const result = await this.provider.execute({
          account: input.account,
          vaultHandle: input.vaultHandle,
          intent: "write",
          operation: "reddit.post.media.process",
          payload: { ticket },
        });
        if (!result.native?.nativeId || !result.native.canonicalUrl) {
          throw new AdapterExecutionError("PROTOCOL_DRIFT", "The processed Reddit media post has no native evidence", {
            submissionMayHaveStarted: true,
          });
        }
        input.execution.transition("submitted", "processed", ticket);
        return {
          status: "confirmed",
          result: { nativeId: result.native.nativeId, canonicalUrl: result.native.canonicalUrl },
        };
      }
      throw new AdapterExecutionError("PROTOCOL_DRIFT", "The Reddit media flow is not executable", {
        submissionMayHaveStarted: ["submitting", "submitted", "processed"].includes(flow.phase),
      });
    } catch (error) {
      const normalized = adapterError(error);
      if (["submitting", "submitted", "processed"].includes(flow.phase) || normalized.submissionMayHaveStarted) {
        return { status: "unknown", message: "The Reddit media result could not be verified." };
      }
      if (["AUTHENTICATION_FAILED", "CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED", "CAPTCHA_REQUIRED", "SESSION_REVOKED", "WRONG_IDENTITY"].includes(normalized.code)) {
        return { status: "action_required", code: normalized.code, message: "Reddit requires account action." };
      }
      return {
        status: "failed",
        code: normalized.code,
        message: "Reddit rejected the media action before submission.",
        retryable: normalized.retryable,
        ...(normalized.rateLimit ? { rateLimit: normalized.rateLimit } : {}),
      };
    } finally {
      mediaBase64 = "";
    }
  }

  private async transport(input: { account: AccountRecord; vaultHandle: string }) {
    if (!this.provider.bind) throw new AdapterExecutionError("PROTOCOL_DRIFT", "The Core Reddit transport provider cannot bind a direct transport");
    const transport = await this.provider.bind(input);
    if (!(transport instanceof RedditSessionTransport) || transport.binding().accountId !== input.account.id) {
      throw new AdapterExecutionError("PROTOCOL_DRIFT", "Core returned a Reddit transport for the wrong account");
    }
    return transport;
  }
}

function mapReadRequest(request: RedditReadRequest): { operation: any; input: Record<string, unknown> } {
  switch (request.kind) {
    case "profile": return { operation: "profile.get", input: {} };
    case "subreddit": return { operation: "subreddit.get", input: { name: request.subreddit } };
    case "feed": return { operation: "listing.list", input: compact({ subreddit: request.subreddit, kind: request.sort, timeframe: request.timeframe, limit: request.limit, after: request.cursor }) };
    case "post": return { operation: "post.get", input: { nativeId: postFullname(request.postId) } };
    case "comments": return { operation: "comments.list", input: compact({ postNativeId: postFullname(request.postId), sort: request.sort, limit: request.limit, after: request.cursor }) };
    case "search": return { operation: "search.query", input: compact({ query: request.query, subreddit: request.subreddit, sort: request.sort, timeframe: request.timeframe, limit: request.limit, after: request.cursor }) };
    case "user_profile": return { operation: "user.get", input: { username: request.username } };
    case "user_content": return { operation: "user.content", input: compact({ username: request.username, content: request.content, sort: request.sort, timeframe: request.timeframe, limit: request.limit, after: request.cursor }) };
    case "saved": return { operation: "account.saved", input: compact({ limit: request.limit, after: request.cursor }) };
    case "upvoted": return { operation: "account.upvoted", input: compact({ limit: request.limit, after: request.cursor }) };
    case "message_inbox": return { operation: "message.inbox", input: compact({ folder: request.folder, limit: request.limit, after: request.cursor }) };
    case "message_thread": return { operation: "message.thread", input: { messageNativeId: messageFullname(request.messageId) } };
  }
}

function mapWriteRequest(request: Exclude<RedditWriteRequest, { kind: "media_post" }>): { operation: any; input: Record<string, unknown> } {
  switch (request.kind) {
    case "text_post": return { operation: "post.createText", input: { subreddit: request.subreddit, title: request.title, body: request.text } };
    case "link_post": return { operation: "post.createLink", input: { subreddit: request.subreddit, title: request.title, url: request.url } };
    case "comment": return { operation: "comment.create", input: { postNativeId: postFullname(request.postId), body: request.text } };
    case "reply": return { operation: "reply.create", input: { commentNativeId: commentFullname(request.commentId), body: request.text } };
    case "edit": return { operation: "item.editOwn", input: { nativeId: itemFullname(request.targetId), body: request.text } };
    case "vote": return { operation: "vote.set", input: { nativeId: itemFullname(request.targetId), direction: request.direction } };
    case "save": return { operation: "save.set", input: { nativeId: itemFullname(request.targetId) } };
    case "unsave": return { operation: "save.unset", input: { nativeId: itemFullname(request.targetId) } };
    case "subscribe": return { operation: "subreddit.subscribe", input: { subreddit: request.subreddit } };
    case "unsubscribe": return { operation: "subreddit.unsubscribe", input: { subreddit: request.subreddit } };
    case "delete": return { operation: "item.deleteOwn", input: { nativeId: itemFullname(request.targetId) } };
    case "message_send": return { operation: "message.send", input: { recipient: request.recipient, subject: request.subject, body: request.text } };
    case "message_reply": return { operation: "message.reply", input: { parentMessageNativeId: messageFullname(request.parentMessageId), body: request.text } };
  }
}

function projectRead(request: RedditReadRequest, result: RedditProductionResult) {
  const data = result.data as Record<string, any>;
  if (["feed", "search", "comments", "user_content", "saved", "upvoted", "message_inbox"].includes(request.kind)) {
    const items = Array.isArray(data.items) ? data.items.map((item) => projectEntity(request.kind, item)) : [];
    return compact({ items, nextCursor: data.page?.after ?? null, more: data.more, rateLimit: result.rateLimit });
  }
  return compact({ ...projectEntity(request.kind, data), rateLimit: result.rateLimit });
}

function projectEntity(kind: RedditReadRequest["kind"], data: Record<string, any>): Record<string, any> {
  const common = compact({
    nativeId: data.nativeId,
    canonicalUrl: data.canonicalUrl,
    title: data.title,
    subreddit: data.subreddit,
    score: data.score,
    url: data.url,
    createdAt: epochDate(data.created_utc),
  });
  if (kind === "profile" || kind === "user_profile") {
    return compact({
      ...common,
      username: data.username,
      karma: compact({ post: data.link_karma, comment: data.comment_karma, total: data.total_karma }),
    });
  }
  if (kind === "subreddit") {
    return compact({ ...common, name: data.name, description: data.public_description, subscribers: data.subscribers });
  }
  if (kind === "comments" || (kind === "user_content" && data.body !== undefined) || (["saved", "upvoted"].includes(kind) && data.itemType === "comment")) {
    return compact({
      ...common,
      itemType: data.itemType ?? "comment",
      parentNativeId: data.parent_id,
      authorNativeId: data.author,
      body: data.body,
      replies: Array.isArray(data.replies) ? data.replies.map((reply: Record<string, any>) => projectEntity("comments", reply)) : undefined,
      more: data.more
    });
  }
  if (kind === "message_inbox" || kind === "message_thread") {
    return compact({
      ...common,
      authorNativeId: data.author,
      recipientNativeId: data.recipient,
      subject: data.subject,
      body: data.body,
      wasRead: data.wasRead,
      parentNativeId: data.parentNativeId,
      replies: Array.isArray(data.replies) ? data.replies.map((reply: Record<string, any>) => projectEntity("message_thread", reply)) : undefined,
    });
  }
  return compact({ ...common, itemType: data.itemType ?? "post", authorNativeId: data.author, body: data.selftext });
}

function isRedditRead(request: ReadRequest): request is RedditReadRequest {
  return !request.kind.startsWith("x_");
}

function isRedditWrite(request: WriteRequest): request is RedditWriteRequest {
  return !request.kind.startsWith("x_");
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

function mediaTicket(result: RedditProductionResult) {
  const ticket = (result.data as Record<string, unknown>)?.ticket;
  return requiredTicket(ticket);
}

function requireSameMediaTicket(result: RedditProductionResult, expected: string) {
  const actual = mediaTicket(result);
  if (actual !== expected) throw new AdapterExecutionError("PROTOCOL_DRIFT", "The Reddit media worker ticket changed");
}

function requiredTicket(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new AdapterExecutionError("PROTOCOL_DRIFT", "The Reddit media worker ticket is invalid");
  }
  return value;
}

function postFullname(value: string) { return value.startsWith("t3_") ? value : `t3_${value}`; }
function commentFullname(value: string) { return value.startsWith("t1_") ? value : `t1_${value}`; }
function itemFullname(value: string) {
  if (!/^t[13]_[a-z0-9]+$/u.test(value)) throw new AdapterExecutionError("VALIDATION_FAILED", "A Reddit target must be a native fullname");
  return value;
}

function messageFullname(value: string) {
  return /^t4_[a-z0-9]+$/u.test(value) ? value : `t4_${value}`;
}
function epochDate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}
function compact<T extends Record<string, any>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
