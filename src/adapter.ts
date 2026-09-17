import type { AccountRecord, ActionRecord, MediaFlowPhase, MediaFlowRecord, ResolvedMediaAsset } from "./persistence.ts";
import type { RateLimitInfo } from "./errors.ts";

export interface NativeEntity {
  nativeId: string;
  canonicalUrl?: string;
  [key: string]: unknown;
}

export type RedditReadRequest =
  | { kind: "profile" }
  | { kind: "subreddit"; subreddit: string }
  | { kind: "feed"; subreddit?: string; cursor?: string; limit: number }
  | { kind: "post"; postId: string }
  | { kind: "comments"; postId: string; cursor?: string; limit: number }
  | { kind: "search"; query: string; cursor?: string; limit: number };

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
  | { kind: "x_bookmarks"; cursor?: string; limit: number };

export type ReadRequest = RedditReadRequest | XReadRequest;

export type WriteRequest =
  | { kind: "text_post"; subreddit: string; title: string; text: string }
  | { kind: "link_post"; subreddit: string; title: string; url: string }
  | { kind: "media_post"; subreddit: string; title: string; mediaRef: string }
  | { kind: "comment"; postId: string; text: string }
  | { kind: "reply"; commentId: string; text: string }
  | { kind: "vote"; targetId: string; direction: -1 | 0 | 1 }
  | { kind: "save"; targetId: string }
  | { kind: "unsave"; targetId: string }
  | { kind: "delete"; targetId: string };

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
  prepareConnection?(input: { account: AccountRecord; vaultHandle: string; generation: number }): Promise<void>;
  capabilities(account: AccountRecord): Promise<string[]>;
  capabilityDetails?(account: AccountRecord): Promise<readonly Record<string, unknown>[]>;
  capabilityCatalog?(): Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
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
