import type { AccountRecord, ActionRecord, MediaFlowPhase, MediaFlowRecord, ResolvedMediaAsset } from "./persistence.ts";
import type { RateLimitInfo } from "./errors.ts";
import type { WriteKind } from "./contract.ts";

export interface NativeEntity {
  nativeId: string;
  canonicalUrl?: string;
  [key: string]: unknown;
}

export type RedditReadRequest =
  | { kind: "profile" }
  | { kind: "subreddit"; subreddit: string }
  | { kind: "feed"; subreddit?: string; sort?: RedditListingSort; timeframe?: RedditTimeframe; cursor?: string; limit: number }
  | { kind: "post"; postId: string }
  | { kind: "comments"; postId: string; sort?: RedditCommentSort; cursor?: string; limit: number }
  | { kind: "search"; query: string; subreddit?: string; sort?: RedditSearchSort; timeframe?: RedditTimeframe; cursor?: string; limit: number }
  | { kind: "user_profile"; username: string }
  | { kind: "user_content"; username: string; content: "submitted" | "comments"; sort?: "hot" | "new" | "top" | "controversial"; timeframe?: RedditTimeframe; cursor?: string; limit: number }
  | { kind: "saved"; cursor?: string; limit: number }
  | { kind: "upvoted"; cursor?: string; limit: number }
  | { kind: "message_inbox"; folder: RedditMessageFolder; cursor?: string; limit: number }
  | { kind: "message_thread"; messageId: string };

export type RedditTimeframe = "hour" | "day" | "week" | "month" | "year" | "all";
export type RedditListingSort = "hot" | "new" | "top" | "rising" | "best" | "controversial";
export type RedditSearchSort = "relevance" | "hot" | "top" | "new" | "comments";
export type RedditCommentSort = "best" | "top" | "new" | "controversial" | "old" | "qa";
export type RedditMessageFolder = "inbox" | "unread" | "messages" | "sent" | "mentions";

export type XReadRequest =
  | { kind: "x_account_health" }
  | { kind: "x_profile"; username: string }
  | { kind: "x_post"; postId: string }
  | { kind: "x_thread"; postId: string; cursor?: string; limit: number }
  | { kind: "x_home_timeline"; cursor?: string; limit: number }
  | { kind: "x_user_timeline"; username: string; cursor?: string; limit: number }
  | { kind: "x_search"; query: string; cursor?: string; limit: number }
  | { kind: "x_notifications"; cursor?: string; limit: number }
  | { kind: "x_conversations"; cursor?: string; limit: number }
  | { kind: "x_bookmarks"; cursor?: string; limit: number }
  | { kind: "x_followers"; userNativeId: string; cursor?: string; limit: number }
  | { kind: "x_following"; userNativeId: string; cursor?: string; limit: number }
  | { kind: "x_list"; listId: string }
  | { kind: "x_list_memberships"; cursor?: string; limit: number }
  | { kind: "x_list_members"; listId: string; cursor?: string; limit: number }
  | { kind: "x_list_timeline"; listId: string; cursor?: string; limit: number };

export type ReadRequest = RedditReadRequest | XReadRequest;

export type RedditWriteRequest =
  | { kind: "text_post"; subreddit: string; title: string; text: string }
  | { kind: "link_post"; subreddit: string; title: string; url: string }
  | { kind: "media_post"; subreddit: string; title: string; mediaRef: string }
  | { kind: "comment"; postId: string; text: string }
  | { kind: "reply"; commentId: string; text: string }
  | { kind: "edit"; targetId: string; text: string }
  | { kind: "vote"; targetId: string; direction: -1 | 0 | 1 }
  | { kind: "save"; targetId: string }
  | { kind: "unsave"; targetId: string }
  | { kind: "subscribe"; subreddit: string }
  | { kind: "unsubscribe"; subreddit: string }
  | { kind: "delete"; targetId: string }
  | { kind: "message_send"; recipient: string; subject: string; text: string }
  | { kind: "message_reply"; parentMessageId: string; text: string };

export type XWriteRequest =
  | { kind: "x_post_create"; text: string }
  | { kind: "x_reply_create"; postId: string; text: string }
  | { kind: "x_post_delete"; postId: string }
  | { kind: "x_like_set"; postId: string; enabled: boolean }
  | { kind: "x_repost_set"; postId: string; enabled: boolean }
  | { kind: "x_follow_set"; userNativeId: string; enabled: boolean }
  | { kind: "x_bookmark_set"; postId: string; enabled: boolean }
  | { kind: "x_media_post"; text: string; mediaRef: string }
  | { kind: "x_direct_message"; recipientNativeId: string; text: string };

export type WriteRequest = RedditWriteRequest | XWriteRequest;

export type WritePlatform = "reddit" | "x";

export interface WriteKindBinding {
  readonly platform: WritePlatform;
  /** True when the write is submitted through Core's phased media flow. */
  readonly media: boolean;
}

/**
 * The single source of truth for how a write kind reaches a platform.
 *
 * `satisfies` makes this exhaustive: adding a member to WRITE_KINDS without
 * adding its binding here is a TypeScript error, and a binding for a kind that
 * is not in WRITE_KINDS is rejected as an excess property. Routing decisions
 * must read this registry; never infer a platform from a kind's spelling.
 *
 * This lives in adapter.ts rather than contract.ts because Core persistence
 * needs it at runtime, and contract.ts already participates in a
 * contract -> webhooks -> persistence cycle. adapter.ts has only type imports,
 * so it is a safe leaf. contract.ts re-exports it beside WRITE_KINDS.
 */
export const WRITE_KIND_REGISTRY = Object.freeze({
  text_post: { platform: "reddit", media: false },
  link_post: { platform: "reddit", media: false },
  media_post: { platform: "reddit", media: true },
  comment: { platform: "reddit", media: false },
  reply: { platform: "reddit", media: false },
  edit: { platform: "reddit", media: false },
  vote: { platform: "reddit", media: false },
  save: { platform: "reddit", media: false },
  unsave: { platform: "reddit", media: false },
  subscribe: { platform: "reddit", media: false },
  unsubscribe: { platform: "reddit", media: false },
  delete: { platform: "reddit", media: false },
  message_send: { platform: "reddit", media: false },
  message_reply: { platform: "reddit", media: false },
  x_post_create: { platform: "x", media: false },
  x_reply_create: { platform: "x", media: false },
  x_post_delete: { platform: "x", media: false },
  x_like_set: { platform: "x", media: false },
  x_repost_set: { platform: "x", media: false },
  x_follow_set: { platform: "x", media: false },
  x_bookmark_set: { platform: "x", media: false },
  x_media_post: { platform: "x", media: true },
  x_direct_message: { platform: "x", media: false },
} satisfies Readonly<Record<WriteKind, WriteKindBinding>>);

/**
 * Look up a write kind's binding. Returns undefined for anything that is not a
 * registered write kind so every caller fails closed instead of guessing.
 */
export function writeKindBinding(kind: string): WriteKindBinding | undefined {
  return Object.hasOwn(WRITE_KIND_REGISTRY, kind)
    ? WRITE_KIND_REGISTRY[kind as WriteKind]
    : undefined;
}

/** The platform that owns a registered write kind, or undefined when unknown. */
export function platformForWriteKind(kind: string): WritePlatform | undefined {
  return writeKindBinding(kind)?.platform;
}

/** True only for write kinds that use Core's phased media flow. */
export function isMediaWriteKind(kind: string): boolean {
  return writeKindBinding(kind)?.media === true;
}

export type ReadPlatform = "reddit" | "x";

/**
 * Explicit read-kind to platform map. Read guards must consult this instead of
 * inferring a platform from a kind's spelling; an unlisted kind is unknown.
 */
export const READ_KIND_PLATFORM = Object.freeze({
  profile: "reddit", subreddit: "reddit", feed: "reddit", post: "reddit", comments: "reddit",
  search: "reddit", user_profile: "reddit", user_content: "reddit", saved: "reddit",
  upvoted: "reddit", message_inbox: "reddit", message_thread: "reddit",
  x_account_health: "x", x_profile: "x", x_post: "x", x_thread: "x", x_home_timeline: "x",
  x_user_timeline: "x", x_search: "x", x_notifications: "x", x_conversations: "x",
  x_bookmarks: "x", x_followers: "x", x_following: "x", x_list: "x",
  x_list_memberships: "x", x_list_members: "x", x_list_timeline: "x",
} satisfies Readonly<Record<ReadRequest["kind"], ReadPlatform>>);

/** The platform that owns a registered read kind, or undefined when unknown. */
export function platformForReadKind(kind: string): ReadPlatform | undefined {
  return Object.hasOwn(READ_KIND_PLATFORM, kind) ? READ_KIND_PLATFORM[kind as ReadRequest["kind"]] : undefined;
}

export type AdapterWriteOutcome =
  | { status: "confirmed"; result: NativeEntity }
  | { status: "failed"; code: string; message: string; retryable?: boolean; rateLimit?: RateLimitInfo }
  | { status: "action_required"; code: string; message: string }
  | { status: "unknown"; message: string };

export type ReconcileOutcome = AdapterWriteOutcome | { status: "pending" };

export interface ActionExecutionContext {
  media: ResolvedMediaAsset;
  flow: MediaFlowRecord;
  transition(from: MediaFlowPhase, to: MediaFlowPhase, workerTicket: string | null): MediaFlowRecord;
  beginSubmission(workerTicket: string): MediaFlowRecord;
}

export interface PlatformAdapter {
  readonly platform: string;
  /**
   * Direct owner-session imports must remain custody-only unless the reviewed
   * platform transport explicitly opts into native identity verification.
   * Absence is fail-closed and is equivalent to false.
   */
  readonly directSessionIdentityVerificationAdmitted?: boolean;
  prepareConnection?(input: { account: AccountRecord; vaultHandle: string; generation: number }): Promise<void>;
  nextConnectionGeneration?(account: AccountRecord): Promise<number> | number;
  prepareDirectConnection?(input: {
    account: AccountRecord;
    generation: number;
    session: Uint8Array;
    networkRoute: { id: string; material: Uint8Array };
  }): Promise<void> | void;
  capabilities(account: AccountRecord): Promise<string[]>;
  capabilityDetails?(account: AccountRecord): Promise<readonly Record<string, unknown>[]>;
  capabilityCatalog?(): Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
  unsupportedCapabilities?(account: AccountRecord): Promise<Record<string, string>> | Record<string, string>;
  verifyIdentity(input: { account: AccountRecord; vaultHandle: string }): Promise<{ nativeUserId: string }>;
  read(input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }): Promise<unknown>;
  submit(input: {
    account: AccountRecord;
    vaultHandle: string;
    action: ActionRecord;
    request: WriteRequest;
    execution?: ActionExecutionContext;
  }): Promise<AdapterWriteOutcome>;
  reconcile(input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome>;
  revoke(input: { account: AccountRecord; vaultHandle: string }): Promise<void>;
  close?(): Promise<void> | void;
}

export class AdapterExecutionError extends Error {
  readonly code: string;
  readonly submissionMayHaveStarted: boolean;
  readonly retryable: boolean;
  readonly rateLimit?: RateLimitInfo;

  constructor(code: string, message: string, options: { submissionMayHaveStarted?: boolean; retryable?: boolean; rateLimit?: RateLimitInfo } = {}) {
    super(message);
    this.name = "AdapterExecutionError";
    this.code = code;
    this.submissionMayHaveStarted = options.submissionMayHaveStarted ?? false;
    this.retryable = options.retryable ?? false;
    this.rateLimit = options.rateLimit;
  }
}
