export interface RedditRouteBinding {
  tenantId: string;
  accountId: string;
  routeId: string;
  generation: number;
}

export interface RouteRecord {
  id: string;
  tenantId: string;
  accountId: string;
  generation: number;
  connectorId: string;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Uint8Array;
  finalUrl: string;
  redirectCount: number;
}

export interface RedditRouteAuthority {
  issueLease(binding: RedditRouteBinding): object;
  request(lease: object, descriptor: {
    method: "GET" | "POST";
    path: string;
    body: Uint8Array | null;
    deadlineEpochMs: number;
  }): Promise<EgressResponse>;
}

export declare class PlatformStopCircuit {
  constructor(options?: { now?: () => number; verifyRecoveryAuthorization?: (authorization: object) => boolean });
  observe(binding: Record<string, unknown>, result: Record<string, unknown>): object | null;
  assertCanDispatch(binding: Record<string, unknown>): true;
  inspect(platform: string): Readonly<Record<string, unknown>>;
}

export declare function createRedditRouteAuthority(options: {
  routes: RouteRecord[];
  connectors: Record<string, (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>>;
  resolver: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
  maxRedirects?: number;
  maxResponseBytes?: number;
  now?: () => number;
}): RedditRouteAuthority;

export declare const REDDIT_MEDIA_UPLOAD_TARGET_POLICY: Readonly<{
  id: "reddit-media-upload";
  origin: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com";
  admittedHosts: readonly ["reddit-uploaded-media.s3-accelerate.amazonaws.com"];
}>;

export declare function createRedditMediaUploadAuthority(options: {
  route: RedditRouteBinding;
  connector: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
  resolver: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
  maxResponseBytes?: number;
  now?: () => number;
}): RedditRouteAuthority;

export declare function createPinnedHttpsConnector(options?: {
  headers?: Record<string, string>;
}): (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;

export declare function assertPublicAddress(address: string): string;

export declare const X_TARGET_POLICIES: Readonly<Record<"web" | "api" | "upload" | "asset", Readonly<{ id: string; origin: string; admittedHosts: readonly string[] }>>>;
export declare function createXRouteAuthority(options: {
  route: { tenantId: string; accountId: string; routeId: string; generation: number };
  connectors: Record<"web" | "api" | "upload" | "asset", (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>>;
  resolver: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
  maxResponseBytes?: number;
  now?: () => number;
}): { issueLease(binding: { tenantId: string; accountId: string; routeId: string; generation: number }): object; request(lease: object, descriptor: { target: "web" | "api" | "upload" | "asset"; method: "GET" | "POST"; path: string; body: Uint8Array | null; deadlineEpochMs: number }): Promise<EgressResponse> };

export declare const SECURITY_ERROR_CODES: Readonly<Record<string, string>>;

export declare const REDDIT_MEDIA_PROCESS_POLICY: Readonly<{
  origin: "wss://wss.redditmedia.com";
  admittedHost: "wss.redditmedia.com";
  maxMessageBytes: number;
  maxHandshakeBytes: number;
}>;

export declare function createPinnedWebSocketConnector(): (request: Readonly<Record<string, any>>) => Promise<{
  data: Uint8Array;
  remoteAddress: string;
}>;

export declare function receiveRedditMediaProcessMessage(options: {
  url: string;
  resolver: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
  deadlineEpochMs: number;
  connector?: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
  maxMessageBytes?: number;
  now?: () => number;
}): Promise<Uint8Array>;
