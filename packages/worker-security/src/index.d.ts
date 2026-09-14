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

export declare function createPinnedHttpsConnector(options?: {
  headers?: Record<string, string>;
}): (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;

export declare const SECURITY_ERROR_CODES: Readonly<Record<string, string>>;
