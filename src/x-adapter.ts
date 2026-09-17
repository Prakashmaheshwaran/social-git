import {
  X_CAPABILITIES,
  X_FIXTURE_ENTITIES,
  XContractError,
  assertFixtureOperation,
  normalizeXFixtureResponse,
  unwrapXNormalized,
  xFixture,
} from "../packages/x-adapter/src/index.mjs";
import { AdapterExecutionError, type AdapterWriteOutcome, type PlatformAdapter, type ReadRequest, type ReconcileOutcome, type WriteRequest } from "./adapter.ts";
import type { AccountRecord, ActionRecord } from "./persistence.ts";

type Scenario = "ok" | "rate_limited" | "revoked" | "access_denied" | "protocol_drift";

/** Synthetic-only X adapter used to prove Core/API contracts without live network access. */
export class XFixturePlatformAdapter implements PlatformAdapter {
  readonly platform = "x";
  private readonly staged = new Map<string, { identity: string; scenario: Scenario }>();

  stageSession(input: { vaultHandle: string; nativeIdentity: string; scenario?: Scenario }) {
    this.staged.set(input.vaultHandle, { identity: input.nativeIdentity, scenario: input.scenario ?? "ok" });
  }

  setScenario(vaultHandle: string, scenario: Scenario) {
    if (!new Set<Scenario>(["ok", "rate_limited", "revoked", "access_denied", "protocol_drift"]).has(scenario)) throw new TypeError("The fixture X scenario is invalid.");
    const staged = this.staged.get(vaultHandle);
    if (!staged) throw new TypeError("The fixture vault handle is not staged.");
    staged.scenario = scenario;
  }

  reset() { this.staged.clear(); }
  close() { this.reset(); }

  async capabilities(_account: AccountRecord) {
    return X_CAPABILITIES.filter((capability) => capability.fixtureEnabled).map((capability) => capability.operation);
  }

  async capabilityDetails(_account: AccountRecord) {
    return X_CAPABILITIES.map((capability) => ({ ...capability }));
  }

  capabilityCatalog() { return X_CAPABILITIES.map((capability) => ({ ...capability })); }

  async verifyIdentity(input: { account: AccountRecord; vaultHandle: string }) {
    const staged = this.requiredSession(input.vaultHandle);
    this.assertScenario(staged.scenario);
    return { nativeUserId: staged.identity };
  }

  async read(input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }) {
    const staged = this.requiredSession(input.vaultHandle);
    this.assertScenario(staged.scenario);
    const mapped = mapXRead(input.request);
    assertFixtureOperation(mapped.operation);
    const response = scenarioResponse(staged.scenario, mapped.operation, mapped.data);
    try {
      return unwrapXNormalized(normalizeXFixtureResponse(mapped.operation, response, mapped.previousCursor));
    } catch (error) {
      throw bridgeError(error);
    }
  }

  async submit(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord; request: WriteRequest }): Promise<AdapterWriteOutcome> {
    return { status: "action_required", code: "CAPABILITY_UNAVAILABLE", message: "X writes have not passed production admission." };
  }

  async reconcile(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome> {
    return { status: "pending" };
  }

  async revoke(input: { account: AccountRecord; vaultHandle: string }) {
    this.staged.delete(input.vaultHandle);
  }

  private requiredSession(vaultHandle: string) {
    const staged = this.staged.get(vaultHandle);
    if (!staged) throw new AdapterExecutionError("SESSION_REVOKED", "The fixture X session is not staged.");
    return staged;
  }

  private assertScenario(scenario: Scenario) {
    if (scenario === "revoked") throw new AdapterExecutionError("SESSION_REVOKED", "The fixture X session is revoked.");
    if (scenario === "access_denied") throw new AdapterExecutionError("CHALLENGE_REQUIRED", "Human action is required for the fixture X account.");
    if (scenario === "rate_limited") throw new AdapterExecutionError("RATE_LIMITED", "The fixture X account is rate limited.", { retryable: true, rateLimit: { limit: 50, remaining: 0, resetAt: "2033-05-18T03:33:20.000Z" } });
    if (scenario === "protocol_drift") throw new AdapterExecutionError("PROTOCOL_DRIFT", "The fixture X protocol drifted.");
  }
}

/** Production placeholder: advertises the matrix but refuses session use and all execution. */
export class DisabledXPlatformAdapter implements PlatformAdapter {
  readonly platform = "x";
  async capabilities(_account: AccountRecord) { return []; }
  async capabilityDetails(_account: AccountRecord) { return X_CAPABILITIES.map((capability) => ({ ...capability })); }
  capabilityCatalog() { return X_CAPABILITIES.map((capability) => ({ ...capability })); }
  async verifyIdentity(_input: { account: AccountRecord; vaultHandle: string }): Promise<{ nativeUserId: string }> { throw unavailable(); }
  async read(_input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }): Promise<unknown> { throw unavailable(); }
  async submit(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord; request: WriteRequest }): Promise<AdapterWriteOutcome> { return { status: "action_required", code: "CAPABILITY_UNAVAILABLE", message: "X production transport is disabled." }; }
  async reconcile(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome> { return { status: "pending" }; }
  async revoke(_input: { account: AccountRecord; vaultHandle: string }) {}
}

function unavailable() {
  return new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "No X production transport has passed admission.");
}

function bridgeError(error: unknown) {
  if (!(error instanceof XContractError)) return new AdapterExecutionError("PROTOCOL_DRIFT", "The X fixture decoder rejected the response.");
  if (error.code === "RATE_LIMITED") return new AdapterExecutionError("RATE_LIMITED", error.message, { retryable: true, rateLimit: error.rateLimit });
  if (error.code === "SESSION_REVOKED") return new AdapterExecutionError("SESSION_REVOKED", error.message);
  if (error.code === "ACCESS_DENIED") return new AdapterExecutionError("CHALLENGE_REQUIRED", error.message);
  return new AdapterExecutionError("PROTOCOL_DRIFT", error.message);
}

function mapXRead(request: ReadRequest): { operation: string; data: Record<string, unknown>; previousCursor?: string | null } {
  const page = (items: unknown[], cursor?: string) => ({ items, nextCursor: cursor ? null : "fixture-next" });
  switch (request.kind) {
    case "x_account_health": return { operation: "account.identity", data: { entity: X_FIXTURE_ENTITIES.account } };
    case "x_profile": return { operation: "profile.get", data: { entity: { ...X_FIXTURE_ENTITIES.profile, username: request.username } } };
    case "x_post": return { operation: "post.get", data: { entity: { ...X_FIXTURE_ENTITIES.post, nativeId: request.postId, canonicalUrl: `https://x.com/fixture_owner/status/${request.postId}` } } };
    case "x_thread": return { operation: "thread.get", data: page([X_FIXTURE_ENTITIES.post], request.cursor), previousCursor: request.cursor };
    case "x_home_timeline": return { operation: "timeline.home", data: page([X_FIXTURE_ENTITIES.post], request.cursor), previousCursor: request.cursor };
    case "x_user_timeline": return { operation: "timeline.user", data: page([X_FIXTURE_ENTITIES.post], request.cursor), previousCursor: request.cursor };
    case "x_search": return { operation: "search.query", data: page([X_FIXTURE_ENTITIES.post], request.cursor), previousCursor: request.cursor };
    case "x_notifications": return { operation: "notifications.list", data: page([X_FIXTURE_ENTITIES.notification], request.cursor), previousCursor: request.cursor };
    case "x_conversations": return { operation: "conversations.list", data: page([X_FIXTURE_ENTITIES.conversation], request.cursor), previousCursor: request.cursor };
    case "x_bookmarks": return { operation: "bookmarks.list", data: page([X_FIXTURE_ENTITIES.post], request.cursor), previousCursor: request.cursor };
    default: throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "The read kind is not an X operation.");
  }
}

function scenarioResponse(scenario: Scenario, operation: string, data: Record<string, unknown>) {
  if (scenario === "rate_limited") return { status: 429, body: {}, headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "2000000000" } };
  if (scenario === "revoked") return { status: 401, body: {} };
  if (scenario === "access_denied") return { status: 403, body: {} };
  if (scenario === "protocol_drift") return { status: 200, body: { unknown: true } };
  return xFixture(operation, data);
}
