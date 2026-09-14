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
export type RedditAdmittedProtocolOperation = RedditOperation;

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
  "comments.list": { postNativeId: string; limit?: number };
  "search.query": { query: string; subreddit?: string; limit?: number };
  "post.createText": PostOptions & { subreddit: string; title: string; body: string };
  "post.createLink": { subreddit: string; title: string; url: string; nsfw?: boolean };
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
  fixtureEnabled: true;
  protocolMapping: "MAPPED" | "UNSUPPORTED";
  productionEnabled: boolean;
  disabledReason: null;
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
    data: {
      databaseEnvironmentVisible: false;
      fixtureWorker: true;
      workerProcessId: number;
      runtime: {
        permissionModel: true;
        networkGranted: false;
        filesystemWriteGranted: false;
        childProcessGranted: false;
        workerThreadGranted: false;
        nativeAddonGranted: false;
        forbiddenEnvironmentVisible: false;
        osSandbox: "darwin_sandbox_exec" | "node_permission_model";
      };
    };
  }>;
  diagnostics(): Readonly<{
    submissionAttempts: number;
    recoveryChecks: number;
    pendingRequests: number;
    workerRunning: boolean;
    workerRuntime: null | Readonly<{
      pid: number;
      command: string;
      osSandbox: "darwin_sandbox_exec" | "node_permission_model";
      inheritedEnvironment: false;
      byteTransport: true;
    }>;
  }>;
  close(): Promise<void>;
}

export interface RedditRouteBinding {
  tenantId: string;
  accountId: string;
  routeId: string;
  generation: number;
}

export interface RedditRouteAuthority {
  issueLease(binding: RedditRouteBinding): object;
  request(lease: object, descriptor: {
    method: "GET" | "POST";
    path: string;
    body: Uint8Array | null;
    deadlineEpochMs: number;
  }): Promise<{ status: number; headers: Record<string, string | string[]>; body: Uint8Array; finalUrl: string; redirectCount: number }>;
}

export interface RedditProductionResult {
  native: { nativeId: string; canonicalUrl?: string } | null;
  data: Record<string, unknown>;
  rateLimit?: Readonly<Record<string, number | string>>;
}

export declare class RedditTransportError extends Error {
  constructor(code: string, message: string, options?: {
    retryable?: boolean;
    actionRequired?: boolean;
    submissionMayHaveStarted?: boolean;
    rateLimit?: Readonly<Record<string, number | string>>;
  });
  code: string;
  retryable: boolean;
  actionRequired: boolean;
  submissionMayHaveStarted: boolean;
  rateLimit?: Readonly<Record<string, number | string>>;
}

export declare class RedditSessionTransport {
  constructor(options: {
    routeAuthority: RedditRouteAuthority;
    binding: RedditRouteBinding;
    expectedNativeIdentity: string;
    stopCircuit?: object;
    deadlineMs?: number;
    now?: () => number;
  });
  binding(): Readonly<RedditRouteBinding>;
  diagnostics(): Readonly<{
    binding: Readonly<RedditRouteBinding>;
    identityValidated: boolean;
    revoked: boolean;
    requests: number;
    writeAttempts: number;
    idempotencyEntries: number;
  }>;
  verifyIdentity(): Promise<RedditProductionResult>;
  execute(operation: RedditOperation, input: Record<string, unknown>, controls?: {
    actionId?: string;
    callerId?: string;
    idempotencyKey?: string;
  }): Promise<RedditProductionResult>;
  leaseMedia(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }, controls?: { actionId?: string }): Promise<Readonly<{
    uploadUrl: string;
    fields: readonly Readonly<{ name: string; value: string }>[];
    mediaUrl: string;
    rateLimit?: Readonly<Record<string, number | string>>;
  }>>;
  submitMedia(input: { subreddit: string; title: string; mediaUrl: string }, controls?: {
    actionId?: string;
  }): Promise<Readonly<{ websocketUrl: string; rateLimit?: Readonly<Record<string, number | string>> }>>;
  refresh(options: {
    routeAuthority: RedditRouteAuthority;
    binding: RedditRouteBinding;
    expectedNativeIdentity: string;
  }): RedditSessionTransport;
  revoke(): void;
}

export declare function createRedditSessionConnector(options: {
  cookies: Record<string, string>;
  csrfToken: string;
  userAgent?: string;
  wireConnector?: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
}): (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;

export declare const IPC_PROTOCOL_VERSION: 1;
export declare const MAX_IPC_MESSAGE_BYTES: number;
export declare const MAX_SESSION_TTL_MS: number;
export declare const PROTOCOL_MAPPING_STATUS: Readonly<{
  MAPPED: "MAPPED";
  UNSUPPORTED: "UNSUPPORTED";
}>;
export declare const REDDIT_CAPABILITIES: readonly RedditCapability[];
export declare const CORE_ERROR_CODES: Readonly<Record<string, string>>;
export declare function assertBoundedIPCMessage(message: unknown, maxBytes?: number): number;
export declare function assertIPCEnvelope(message: unknown, expectedKind: string, maxBytes?: number): void;
export declare function capabilityFor(operation: string): RedditCapability | null;
export declare function isWriteOperation(operation: string): boolean;

export interface RedditProtocolSource {
  project: "reddit-lyr";
  manifestVersion: "0.1.1";
  revision: "87ec32aff905923ecd156e7951c168adfdf6fac1";
  license: "MIT";
  repository: string;
  files: readonly {
    path: string;
    gitBlob: string;
    sha256: string;
  }[];
}

export interface RedditProtocolRequest {
  operation: RedditAdmittedProtocolOperation;
  method: "GET" | "POST";
  path: string;
  query: Readonly<Record<string, string | number>>;
  body: Readonly<Record<string, unknown>> | null;
  normalizer: string;
  submission: "READ_ONLY" | "SINGLE_ATTEMPT";
  requiresWorkerModhash: boolean;
}

export declare const REDDIT_PROTOCOL_SOURCE: Readonly<RedditProtocolSource>;
export declare const REDDIT_PROTOCOL_SUPPORTING_SOURCES: readonly Readonly<{
  project: "PRAW";
  version: "8.0.3";
  revision: "fdc29bb103ad652eea6740c77c2be099d1c1357e";
  license: "BSD-2-Clause";
  repository: string;
  use: string;
  files: readonly Readonly<{ path: string; gitBlob: string; sha256: string }>[];
}>[];
export declare const REDDIT_OWNERSHIP_LOOKUP_ROUTE: Readonly<{
  method: "GET";
  pathTemplate: string;
  normalizer: "single_item_listing";
  submission: "READ_ONLY";
  source: string;
}>;
export declare const REDDIT_MEDIA_PROTOCOL: Readonly<{
  lease: Readonly<{ method: "POST"; path: "/api/media/asset.json"; submission: "PREFLIGHT" }>;
  upload: Readonly<{ method: "POST"; origin: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com"; submission: "PREFLIGHT" }>;
  submit: Readonly<{ method: "POST"; path: "/api/submit"; submission: "SINGLE_ATTEMPT" }>;
  process: Readonly<{ method: "WSS"; origin: "wss://wss.redditmedia.com"; submission: "READ_ONLY_AFTER_SUBMIT" }>;
}>;
export declare const REDDIT_PROTOCOL_ROUTES: Readonly<Record<RedditAdmittedProtocolOperation, Readonly<{
  method: "GET" | "POST";
  pathTemplate: string;
  normalizer: string;
  submission: "READ_ONLY" | "SINGLE_ATTEMPT" | "MULTI_PHASE";
}>>>;
export declare function buildRedditProtocolRequest<TOperation extends RedditAdmittedProtocolOperation>(
  operation: TOperation,
  input: RedditOperationInputMap[TOperation]
): Readonly<RedditProtocolRequest>;

export interface NormalizedRedditNative {
  nativeId: string;
  canonicalUrl: string;
  [field: string]: unknown;
}

export declare function normalizeRedditProfile(raw: unknown): Readonly<NormalizedRedditNative>;
export declare function normalizeRedditSubreddit(raw: unknown): Readonly<NormalizedRedditNative>;
export declare function normalizeRedditListing(raw: unknown, expectedKind?: "t1" | "t3" | "t5"): Readonly<{
  items: readonly Readonly<NormalizedRedditNative>[];
  page: Readonly<{ after: string | null; before: string | null }>;
}>;
export declare function normalizeRedditPostThread(raw: unknown): Readonly<{
  post: Readonly<NormalizedRedditNative>;
  comments: readonly Readonly<NormalizedRedditNative>[];
  page: Readonly<{ after: string | null; before: string | null }>;
}>;
export declare function normalizeRedditWriteResponse(
  operation: RedditWriteOperation,
  raw: unknown,
  options?: { existingNative?: NativeReference | null }
): Readonly<{ native: NativeReference; data: Readonly<Record<string, unknown>> }>;
export declare function normalizeRedditOperationResponse(
  operation: RedditOperation,
  raw: unknown,
  options?: { existingNative?: NativeReference | null }
): Readonly<{ native: NativeReference | null; data: unknown }>;
