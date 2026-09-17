import { createHash } from "node:crypto";
import {
  X_CAPABILITIES,
  X_FIXTURE_ENTITIES,
  XContractError,
  assertFixtureOperation,
  assertFixtureWriteOperation,
  normalizeXFixtureResponse,
  normalizeXFixtureWriteResponse,
  unwrapXNormalized,
  xFixture,
} from "../packages/x-adapter/src/index.mjs";
import { AdapterExecutionError, type ActionExecutionContext, type AdapterWriteOutcome, type PlatformAdapter, type ReadRequest, type ReconcileOutcome, type WriteRequest, type XWriteRequest } from "./adapter.ts";
import type { AccountRecord, ActionRecord } from "./persistence.ts";

type Scenario = "ok" | "rate_limited" | "revoked" | "access_denied" | "protocol_drift";
type WriteScenario = "confirmed" | "failed" | "challenge" | "rate_limited" | "unknown" | "throw_after_submit";

/** Synthetic-only X adapter used to prove Core/API contracts without live network access. */
export class XFixturePlatformAdapter implements PlatformAdapter {
  readonly platform = "x";
  private readonly staged = new Map<string, { identity: string; scenario: Scenario }>();
  private readonly boundAccounts = new Map<string, string>();
  private readonly nextWrite = new Map<string, WriteScenario>();
  private readonly ownedPosts = new Map<string, Set<string>>();
  submitCount = 0;

  stageSession(input: { vaultHandle: string; nativeIdentity: string; scenario?: Scenario }) {
    this.staged.set(input.vaultHandle, { identity: input.nativeIdentity, scenario: input.scenario ?? "ok" });
  }

  setScenario(vaultHandle: string, scenario: Scenario) {
    if (!new Set<Scenario>(["ok", "rate_limited", "revoked", "access_denied", "protocol_drift"]).has(scenario)) throw new TypeError("The fixture X scenario is invalid.");
    const staged = this.staged.get(vaultHandle);
    if (!staged) throw new TypeError("The fixture vault handle is not staged.");
    staged.scenario = scenario;
  }

  setNextWriteOutcome(vaultHandle: string, scenario: WriteScenario) {
    if (!new Set<WriteScenario>(["confirmed", "failed", "challenge", "rate_limited", "unknown", "throw_after_submit"]).has(scenario)) throw new TypeError("The fixture X write outcome is invalid.");
    this.requiredSession(vaultHandle);
    this.nextWrite.set(vaultHandle, scenario);
  }

  reset() { this.staged.clear(); this.boundAccounts.clear(); this.nextWrite.clear(); this.ownedPosts.clear(); this.submitCount = 0; }
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
    const boundAccountId = this.boundAccounts.get(input.vaultHandle);
    if (boundAccountId && boundAccountId !== input.account.id) throw new AdapterExecutionError("WRONG_IDENTITY", "The fixture X session belongs to a different account binding.");
    this.boundAccounts.set(input.vaultHandle, input.account.id);
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

  async submit(input: { account: AccountRecord; vaultHandle: string; action: ActionRecord; request: WriteRequest; execution?: ActionExecutionContext }): Promise<AdapterWriteOutcome> {
    const staged = this.requiredSession(input.vaultHandle);
    this.assertScenario(staged.scenario);
    if (!isXWrite(input.request)) return { status: "failed", code: "CAPABILITY_UNAVAILABLE", message: "The X adapter cannot execute a Reddit write." };
    const mapped = mapXWrite(input.request, input.action.id);
    assertFixtureWriteOperation(mapped.operation);
    if (input.request.kind === "x_post_delete" && !this.ownedPosts.get(input.account.id)?.has(input.request.postId)) {
      return { status: "failed", code: "NOT_CALLER_OWNED", message: "The authenticated X account does not own the post." };
    }
    this.submitCount += 1;
    const scenario = this.nextWrite.get(input.vaultHandle) ?? "confirmed";
    this.nextWrite.delete(input.vaultHandle);
    if (scenario === "failed") return { status: "failed", code: "PLATFORM_REJECTED", message: "The fixture X write was rejected." };
    if (scenario === "challenge") return { status: "action_required", code: "CHALLENGE_REQUIRED", message: "Human action is required for the fixture X account." };
    if (scenario === "rate_limited") return { status: "failed", code: "RATE_LIMITED", message: "The fixture X account is rate limited.", retryable: true, rateLimit: { limit: 50, remaining: 0, retryAfterSeconds: 60 } };
    if (input.request.kind === "x_media_post") beginMediaSubmission(input.execution, input.action.id, scenario === "confirmed");
    if (scenario === "unknown") return { status: "unknown", message: "The fixture X write result could not be verified." };
    if (scenario === "throw_after_submit") throw new AdapterExecutionError("CONNECTION_LOST", "The fixture X transport disconnected after submit.", { submissionMayHaveStarted: true, retryable: true });
    const result = normalizeXFixtureWriteResponse(mapped.operation, xFixture(mapped.operation, { result: mapped.result }));
    if (["x_post_create", "x_reply_create", "x_media_post"].includes(input.request.kind)) {
      const owned = this.ownedPosts.get(input.account.id) ?? new Set<string>();
      owned.add(String(result.nativeId));
      this.ownedPosts.set(input.account.id, owned);
    }
    if (input.request.kind === "x_post_delete") this.ownedPosts.get(input.account.id)?.delete(input.request.postId);
    return { status: "confirmed", result };
  }

  async reconcile(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome> {
    return { status: "pending" };
  }

  async revoke(input: { account: AccountRecord; vaultHandle: string }) {
    this.staged.delete(input.vaultHandle);
    this.boundAccounts.delete(input.vaultHandle);
    this.nextWrite.delete(input.vaultHandle);
    this.ownedPosts.delete(input.account.id);
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
  readonly directSessionIdentityVerificationAdmitted = false;
  private readonly custody?: XSessionCustody;

  constructor(custody?: XSessionCustody) {
    this.custody = custody;
  }

  nextConnectionGeneration(account: AccountRecord) {
    const custody = this.requireCustody();
    try {
      const state = custody.getAccountState(account.id);
      return Math.max(state.generation, state.revokedThroughGeneration) + 1;
    } catch (error) {
      if ((error as { code?: string })?.code === "NOT_FOUND") return 1;
      throw error;
    }
  }

  prepareDirectConnection(input: {
    account: AccountRecord;
    generation: number;
    session: Uint8Array;
    networkRoute: { id: string; material: Uint8Array };
  }) {
    this.requireCustody().importExternalSession({
      accountId: input.account.id,
      platform: input.account.platform,
      expectedNativeIdentity: input.account.expectedNativeUserId,
      generation: input.generation,
      session: input.session,
      networkRoute: input.networkRoute,
    });
  }
  async capabilities(_account: AccountRecord) { return []; }
  async capabilityDetails(_account: AccountRecord) { return X_CAPABILITIES.map((capability) => ({ ...capability })); }
  capabilityCatalog() { return X_CAPABILITIES.map((capability) => ({ ...capability })); }
  async verifyIdentity(_input: { account: AccountRecord; vaultHandle: string }): Promise<{ nativeUserId: string }> { throw unavailable(); }
  async read(_input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }): Promise<unknown> { throw unavailable(); }
  async submit(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord; request: WriteRequest }): Promise<AdapterWriteOutcome> { return { status: "action_required", code: "CAPABILITY_UNAVAILABLE", message: "X production transport is disabled." }; }
  async reconcile(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome> { return { status: "pending" }; }
  async revoke(input: { account: AccountRecord; vaultHandle: string }) {
    if (!this.custody) return;
    try {
      const state = this.custody.getAccountState(input.account.id);
      if (state.health !== "revoked") this.custody.revokeAccount({ accountId: input.account.id, generation: state.generation });
    } catch (error) {
      if (!new Set(["NOT_FOUND", "REVOKED"]).has(String((error as { code?: string })?.code))) throw error;
    }
  }

  private requireCustody() {
    if (!this.custody) throw unavailable();
    return this.custody;
  }
}

interface XSessionCustody {
  getAccountState(accountId: string): { generation: number; revokedThroughGeneration: number; health: string };
  importExternalSession(input: {
    accountId: string;
    platform: string;
    expectedNativeIdentity: string;
    generation: number;
    session: Uint8Array;
    networkRoute: { id: string; material: Uint8Array };
  }): unknown;
  revokeAccount(input: { accountId: string; generation: number }): unknown;
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
    case "x_followers": return { operation: "followers.list", data: page([X_FIXTURE_ENTITIES.profile], request.cursor), previousCursor: request.cursor };
    case "x_following": return { operation: "following.list", data: page([X_FIXTURE_ENTITIES.profile], request.cursor), previousCursor: request.cursor };
    case "x_list": return { operation: "lists.lookup", data: { entity: { ...X_FIXTURE_ENTITIES.list, nativeId: request.listId, canonicalUrl: `https://x.com/i/lists/${request.listId}` } } };
    case "x_list_memberships": return { operation: "lists.memberships", data: page([X_FIXTURE_ENTITIES.list], request.cursor), previousCursor: request.cursor };
    case "x_list_members": return { operation: "lists.members", data: page([X_FIXTURE_ENTITIES.profile], request.cursor), previousCursor: request.cursor };
    case "x_list_timeline": return { operation: "lists.timeline", data: page([X_FIXTURE_ENTITIES.post], request.cursor), previousCursor: request.cursor };
    default: throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "The read kind is not an X operation.");
  }
}

function mapXWrite(request: XWriteRequest, actionId: string): { operation: string; result: { nativeId: string; canonicalUrl?: string } } {
  const generated = numericFixtureId(`${actionId}:${request.kind}`);
  const post = (nativeId: string) => ({ nativeId, canonicalUrl: `https://x.com/fixture_owner/status/${nativeId}` });
  switch (request.kind) {
    case "x_post_create": return { operation: "post.create", result: post(generated) };
    case "x_reply_create": return { operation: "post.reply", result: post(generated) };
    case "x_post_delete": return { operation: "post.delete", result: post(request.postId) };
    case "x_like_set": return { operation: "post.like.set", result: post(request.postId) };
    case "x_repost_set": return { operation: "post.repost.set", result: post(request.postId) };
    case "x_follow_set": return { operation: "profile.follow.set", result: { nativeId: request.userNativeId, canonicalUrl: `https://x.com/i/user/${request.userNativeId}` } };
    case "x_bookmark_set": return { operation: "bookmark.set", result: post(request.postId) };
    case "x_media_post": return { operation: "post.media.create", result: post(generated) };
    case "x_direct_message": return { operation: "message.send", result: { nativeId: generated } };
  }
}

function numericFixtureId(value: string) {
  return (BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 15)}`) + 1n).toString(10);
}

function isXWrite(request: WriteRequest): request is XWriteRequest { return request.kind.startsWith("x_"); }

function beginMediaSubmission(execution: ActionExecutionContext | undefined, actionId: string, complete: boolean) {
  if (!execution) throw new AdapterExecutionError("PROTOCOL_DRIFT", "Core media execution context is missing.");
  const ticket = `x-fixture:${actionId}`;
  let flow = execution.flow;
  if (flow.phase === "reserved") flow = execution.transition("reserved", "leased", ticket);
  if (flow.phase === "leased") flow = execution.transition("leased", "uploaded", ticket);
  if (flow.phase === "uploaded") flow = execution.beginSubmission(ticket);
  if (!complete) return;
  if (flow.phase === "submitting") flow = execution.transition("submitting", "submitted", ticket);
  if (flow.phase === "submitted") execution.transition("submitted", "processed", ticket);
}

function scenarioResponse(scenario: Scenario, operation: string, data: Record<string, unknown>) {
  if (scenario === "rate_limited") return { status: 429, body: {}, headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "2000000000" } };
  if (scenario === "revoked") return { status: 401, body: {} };
  if (scenario === "access_denied") return { status: 403, body: {} };
  if (scenario === "protocol_drift") return { status: 200, body: { unknown: true } };
  return xFixture(operation, data);
}
