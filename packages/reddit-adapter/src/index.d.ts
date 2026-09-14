export type RedditReadOperation =
  | "profile.get"
  | "subreddit.get"
  | "listing.list"
  | "post.get"
  | "comments.list"
  | "search.query";

export type RedditWriteOperation =
  | "post.createText"
  | "post.createLink"
  | "post.createMedia"
  | "comment.create"
  | "reply.create"
  | "vote.set"
  | "save.set"
  | "save.unset"
  | "item.deleteOwn";

export type RedditOperation = RedditReadOperation | RedditWriteOperation;

export interface RedditOperationInputMap {
  "profile.get": Record<string, never>;
  "subreddit.get": { name: string };
  "listing.list": {
    subreddit?: string;
    kind?: "hot" | "new" | "top" | "rising" | "best";
    limit?: number;
    after?: string;
  };
  "post.get": { nativeId: string };
  "comments.list": { postNativeId: string; limit?: number; after?: string };
  "search.query": { query: string; subreddit?: string; limit?: number; after?: string };
  "post.createText": PostOptions & { subreddit: string; title: string; body: string };
  "post.createLink": PostOptions & { subreddit: string; title: string; url: string };
  "post.createMedia": PostOptions & { subreddit: string; title: string; mediaRef: string; caption?: string };
  "comment.create": { postNativeId: string; body: string };
  "reply.create": { commentNativeId: string; body: string };
  "vote.set": { nativeId: string; direction: -1 | 0 | 1 };
  "save.set": { nativeId: string };
  "save.unset": { nativeId: string };
  "item.deleteOwn": { nativeId: string };
}

export interface PostOptions {
  nsfw?: boolean;
  spoiler?: boolean;
}

export interface RedditCapability {
  operation: RedditOperation;
  mode: "read" | "write";
  authorizationScope: string;
}

export interface CoreDecryptedWorkerSession {
  kind: "core_decrypted_worker_session";
  version: 1;
  accountId: string;
  expectedNativeIdentity: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
  sessionMaterial: Record<string, unknown>;
}

export interface ExactWriteAuthorization {
  accountId: string;
  callerId: string;
  operation: RedditWriteOperation;
  scope: string;
  expiresAt: string;
}

export interface AdapterRequestContext {
  accountId: string;
  expectedNativeIdentity: string;
  session: CoreDecryptedWorkerSession;
  authorization?: ExactWriteAuthorization;
  idempotency?: { callerId: string; key: string };
}

export interface NativeReference {
  nativeId: string;
  canonicalUrl: string;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterMs?: number;
}

export interface AdapterSuccess<T = unknown> {
  status: "SUCCEEDED";
  operation: string;
  accountId: string;
  native: NativeReference | null;
  data: T;
  rateLimit: RateLimit;
}

export interface AdapterFailure {
  status: "FAILED";
  operation?: string;
  accountId?: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    actionRequired: boolean;
  };
  rateLimit?: RateLimit;
}

export interface AdapterUnknown {
  status: "UNKNOWN";
  operation: RedditWriteOperation;
  accountId: string;
  action: {
    state: "UNKNOWN";
    operation: RedditWriteOperation;
    accountId: string;
    callerId: string;
    idempotencyKey: string;
    submittedAt: string;
    native: NativeReference;
    retryPermitted: false;
  };
}

export type AdapterResult<T = unknown> = AdapterSuccess<T> | AdapterFailure | AdapterUnknown;

export declare class AdapterContractError extends Error {
  code: string;
}

export declare class RedditFixtureAdapter {
  constructor(options?: {
    scenario?: Record<string, unknown>;
    maxMessageBytes?: number;
    now?: () => number;
  });
  capabilities(): readonly RedditCapability[];
  importSession(context: AdapterRequestContext): Promise<AdapterResult>;
  execute<TOperation extends RedditOperation>(
    operation: TOperation,
    input: RedditOperationInputMap[TOperation],
    context: AdapterRequestContext
  ): Promise<AdapterResult>;
  recoverUnknown(result: AdapterUnknown, context: AdapterRequestContext): Promise<AdapterResult>;
  inspectFixtureIsolation(): Promise<{
    status: "SUCCEEDED";
    operation: "fixture.diagnostics";
    accountId?: undefined;
    native: null;
    data: { databaseEnvironmentVisible: boolean; fixtureWorker: boolean; workerProcessId: number };
  }>;
  diagnostics(): Readonly<{
    submissionAttempts: number;
    recoveryChecks: number;
    pendingRequests: number;
    workerRunning: boolean;
  }>;
  close(): Promise<void>;
}

export declare const IPC_PROTOCOL_VERSION: 1;
export declare const MAX_IPC_MESSAGE_BYTES: number;
export declare const MAX_SESSION_TTL_MS: number;
export declare const REDDIT_CAPABILITIES: readonly RedditCapability[];
export declare const CORE_ERROR_CODES: Readonly<Record<string, string>>;
export declare function assertBoundedIPCMessage(message: unknown, maxBytes?: number): number;
export declare function assertIPCEnvelope(message: unknown, expectedKind: string, maxBytes?: number): void;
export declare function capabilityFor(operation: string): RedditCapability | null;
export declare function isWriteOperation(operation: string): boolean;
