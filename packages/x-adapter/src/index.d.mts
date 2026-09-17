export interface XCapability { readonly operation: string; readonly summary: string; readonly mode: "read" | "write"; readonly authorizationScope: string; readonly fixtureEnabled: true; readonly productionEnabled: false; readonly status: "fixture_only"; readonly disabledReason: string }
export interface XRateLimit { limit?: number; remaining?: number; resetAt?: string }
export declare const X_CAPABILITIES: readonly XCapability[];
export declare const X_PROTOCOL_VERSION: 1;
export declare const X_MAX_RESPONSE_BYTES: number;
export declare const X_MAX_PAGE_ITEMS: number;
export declare const X_MAX_CURSOR_BYTES: number;
export declare class XContractError extends Error { readonly code: string; readonly rateLimit?: XRateLimit; }
export declare function capabilityFor(operation: string): XCapability | null;
export declare function assertFixtureOperation(operation: string): XCapability;
export declare function assertFixtureWriteOperation(operation: string): XCapability;
export declare function xFixture(operation: string, data: unknown, headers?: Record<string, string>): Readonly<{ status: 200; headers: Record<string, string>; body: { version: 1; operation: string; data: unknown } }>;
export declare const X_FIXTURE_ENTITIES: Readonly<Record<"account" | "profile" | "post" | "notification" | "conversation", Readonly<Record<string, unknown>>>>;
export declare function normalizeXFixtureResponse(operation: string, response: unknown, previousCursor?: string | null): Readonly<Record<string, unknown>>;
export declare function normalizeXFixtureWriteResponse(operation: string, response: unknown): Readonly<{ nativeId: string; canonicalUrl?: string; rateLimit: XRateLimit }>;
export declare function unwrapXNormalized(result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
