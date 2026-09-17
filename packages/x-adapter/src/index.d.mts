export interface XCapability { readonly operation: string; readonly summary: string; readonly mode: "read" | "write"; readonly authorizationScope: string; readonly fixtureEnabled: true; readonly productionEnabled: false; readonly status: "fixture_only"; readonly disabledReason: string; readonly disabledReasons: readonly string[]; readonly transportCandidate: string; readonly admissionSchema: string }
export interface XRateLimit { limit?: number; remaining?: number; resetAt?: string }
export declare const X_CAPABILITIES: readonly XCapability[];
export declare const X_PROTOCOL_VERSION: 1;
export declare const X_MAX_RESPONSE_BYTES: number;
export declare const X_MAX_PAGE_ITEMS: number;
export declare const X_MAX_CURSOR_BYTES: number;
export declare class XContractError extends Error { readonly code: string; readonly rateLimit?: XRateLimit; readonly retryable: boolean; readonly actionRequired: boolean; readonly submissionMayHaveStarted: boolean; readonly observedNativeIdentity?: string; constructor(code: string, message: string, options?: { rateLimit?: XRateLimit; retryable?: boolean; actionRequired?: boolean; submissionMayHaveStarted?: boolean; observedNativeIdentity?: string }); }
export declare function capabilityFor(operation: string): XCapability | null;
export declare function assertFixtureOperation(operation: string): XCapability;
export declare function assertFixtureWriteOperation(operation: string): XCapability;
export declare function xFixture(operation: string, data: unknown, headers?: Record<string, string>): Readonly<{ status: 200; headers: Record<string, string>; body: { version: 1; operation: string; data: unknown } }>;
export declare const X_FIXTURE_ENTITIES: Readonly<Record<"account" | "profile" | "post" | "notification" | "conversation" | "list", Readonly<Record<string, unknown>>>>;
export declare function normalizeXFixtureResponse(operation: string, response: unknown, previousCursor?: string | null): Readonly<Record<string, any>>;
export declare function normalizeXFixtureWriteResponse(operation: string, response: unknown): Readonly<{ nativeId: string; canonicalUrl?: string; rateLimit: XRateLimit }>;
export declare function unwrapXNormalized(result: Readonly<Record<string, any>>): Readonly<Record<string, any>>;
export declare const X_TRANSPORT_ADMISSION: Readonly<{ schema: string; sourceRevision: string; sourceRole: string; runtimeDependency: false; candidateBoundaryImplemented: true; productionEnabled: false; gates: Readonly<Record<string, boolean>>; disabledReasons: readonly string[] }>;
export declare function evaluateXTransportAdmission(requested?: boolean): Readonly<Record<string, unknown>>;
export declare const X_PROTOCOL_SOURCE: Readonly<Record<string, any>>;
export declare const X_PUBLIC_PROTOCOL_EVIDENCE: Readonly<Record<string, any>>;
export declare const X_PROTOCOL_ROUTES: Readonly<Record<string, any>>;
export declare const X_RECORDED_SYNTHETIC_CORPUS: Readonly<Record<string, any>>;
export declare function buildXProtocolRequest(operation: string, input?: Record<string, unknown>, phase?: string): Readonly<{ operation: string; target: string; method: "GET" | "POST"; path: string; body: Uint8Array | null; contentType: string | null; submission: string }>;
export declare function normalizeXProtocolResponse(operation: string, response: unknown, previousCursor?: string | null, mediaPhase?: string | null): Readonly<Record<string, any>>;
export declare const X_WEB_CLIENT_TOKEN: string;
export declare function createXSessionConnector(options: { authToken: string; csrfToken: string; userAgent?: string; profile?: "api" | "home"; transactionIdFor?: (method: string, path: string) => string; wireConnector: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>> }): (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
export declare function createXPublicAssetConnector(options: { userAgent?: string; wireConnector: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>> }): (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
export interface XTransactionState { readonly schema: "social-git.x-client-transaction/v1"; readonly keyBase64: string; readonly animationKey: string; readonly rowIndex: number; readonly keyByteIndices: readonly number[] }
export declare const X_MAX_HOME_HTML_BYTES: number;
export declare function discoverXTransactionAsset(homeHtml: string): Readonly<{ target: "asset"; path: string }>;
export declare function buildXTransactionState(homeHtml: string, ondemandAssetText: string): XTransactionState;
export declare function generateXClientTransactionId(state: XTransactionState, input: { method: string; path: string; nowSeconds: number; randomByte: number }): string;
export declare class XSessionTransport { constructor(options: { routeAuthority: any; binding: { tenantId: string; accountId: string; routeId: string; generation: number }; expectedNativeIdentity: string; deadlineMs?: number; now?: () => number }); binding(): Readonly<Record<string, unknown>>; diagnostics(): Readonly<Record<string, unknown>>; verifyIdentity(): Promise<Readonly<Record<string, any>>>; execute(operation: string, input: Record<string, unknown>, controls?: { previousCursor?: string | null }): Promise<Readonly<Record<string, any>>>; executeMediaPhase(phase: string, input: Record<string, unknown>): Promise<Readonly<Record<string, any>>>; revoke(): void }
