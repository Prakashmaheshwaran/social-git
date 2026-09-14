import { AdapterExecutionError, type PlatformAdapter, type ReadRequest, type WriteRequest } from "./adapter.ts";
import { assertObject, assertString, redactDetails, ServiceError, type RateLimitInfo } from "./errors.ts";
import { LedgerStore, type AccountRecord, type ActionRecord, type ActionState } from "./persistence.ts";
import { WRITE_KINDS } from "./contract.ts";
import type { LiveActionExecutor } from "./live-execution.ts";

export interface Principal {
  callerId: string;
  scopes: string[];
}

export interface Authorizer {
  authorize(input: { principal: Principal; operationId: string; scope: string; resource: Record<string, string> }): Promise<void> | void;
}

export class ScopeAuthorizer implements Authorizer {
  authorize(input: { principal: Principal; operationId: string; scope: string }) {
    if (!input.principal.scopes.includes(input.scope) && !input.principal.scopes.includes("*")) {
      throw new ServiceError("FORBIDDEN", "The caller does not have the required scope.", {
        details: { requiredScope: input.scope, operationId: input.operationId },
      });
    }
  }
}

class SimulatedProcessCrash extends Error {}

export class SocialGitService {
  readonly store: LedgerStore;
  readonly startupRecovery: { requeued: number; unknown: number };
  private readonly adapters = new Map<string, PlatformAdapter>();
  private readonly authorizer: Authorizer;
  private readonly liveActionExecutor?: LiveActionExecutor;

  constructor(options: { store: LedgerStore; adapters: PlatformAdapter[]; authorizer?: Authorizer; recoverOnStart?: boolean; liveActionExecutor?: LiveActionExecutor }) {
    this.store = options.store;
    this.authorizer = options.authorizer ?? new ScopeAuthorizer();
    this.liveActionExecutor = options.liveActionExecutor;
    for (const adapter of options.adapters) this.adapters.set(adapter.platform, adapter);
    if (options.recoverOnStart === false) {
      this.startupRecovery = { requeued: 0, unknown: 0 };
    } else {
      const recovered = this.store.recoverInterruptedActions();
      const liveUnknown = this.liveActionExecutor?.recoverInterrupted(this.store) ?? 0;
      this.startupRecovery = {
        requeued: Math.max(0, recovered.requeued - liveUnknown),
        unknown: recovered.unknown + liveUnknown,
      };
    }
  }

  async authorize(principal: Principal | null | undefined, operationId: string, scope: string, resource: Record<string, string> = {}) {
    if (!principal?.callerId) throw new ServiceError("UNAUTHENTICATED", "Authentication is required.");
    await this.authorizer.authorize({ principal, operationId, scope, resource });
    return principal;
  }

  async createAccount(principal: Principal, input: unknown) {
    await this.authorize(principal, "accounts.create", "accounts:write");
    const body = assertObject(input);
    const platform = assertString(body.platform, "platform", 32);
    if (!this.adapters.has(platform)) throw new ServiceError("VALIDATION_FAILED", "The platform is not supported.", { details: { field: "platform" } });
    const expectedNativeUserId = assertString(body.expectedNativeUserId, "expectedNativeUserId", 128);
    const label = body.label === undefined ? undefined : assertString(body.label, "label", 120);
    return { account: this.store.createAccount({ platform, expectedNativeUserId, label, callerId: principal.callerId }) };
  }

  async listAccounts(principal: Principal, input: { cursor?: string; limit?: number }) {
    await this.authorize(principal, "accounts.list", "accounts:read");
    return this.store.listAccounts(pageInput(input));
  }

  async getAccount(principal: Principal, accountId: string) {
    await this.authorize(principal, "accounts.get", "accounts:read", { accountId });
    return { account: this.store.getAccount(assertString(accountId, "accountId", 128)) };
  }

  async importConnection(principal: Principal, accountId: string, input: unknown) {
    await this.authorize(principal, "connections.import", "connections:write", { accountId });
    const body = assertObject(input);
    const vaultHandle = assertString(body.vaultHandle, "vaultHandle", 256);
    const generation = requireInteger(body.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
    const account = this.store.getAccount(accountId);
    const adapter = this.adapterFor(account.platform);
    let identity: { nativeUserId: string };
    try {
      identity = await adapter.verifyIdentity({ account, vaultHandle });
    } catch (error) {
      this.store.audit({ callerId: principal.callerId, accountId, type: "connection.imported", outcome: "failed", data: { code: adapterCode(error) } });
      throw normalizeAdapterError(error, false);
    }
    if (identity.nativeUserId !== account.expectedNativeUserId) {
      this.store.markAccountStatus(accountId, "suspended");
      this.store.audit({ callerId: principal.callerId, accountId, type: "identity.mismatch", outcome: "action_required", data: { expectedIdentityBound: true } });
      throw new ServiceError("IDENTITY_MISMATCH", "The native account identity does not match the account binding.");
    }
    return { connection: this.store.upsertConnection({ accountId, vaultHandle, generation, actualNativeUserId: identity.nativeUserId, callerId: principal.callerId }) };
  }

  async getConnection(principal: Principal, accountId: string) {
    await this.authorize(principal, "connections.get", "connections:read", { accountId });
    this.store.getAccount(accountId);
    return { connection: this.store.getConnection(accountId) };
  }

  async listCapabilities(principal: Principal, accountId: string) {
    await this.authorize(principal, "capabilities.list", "social:read", { accountId });
    const ready = await this.ensureReady(accountId, principal.callerId);
    return { platform: ready.account.platform, capabilities: await ready.adapter.capabilities(ready.account) };
  }

  async revokeAccount(principal: Principal, accountId: string, input: unknown) {
    await this.authorize(principal, "accounts.revoke", "connections:write", { accountId });
    const body = input === undefined ? {} : assertObject(input);
    const reason = body.reason === undefined ? undefined : assertString(body.reason, "reason", 200);
    const account = this.store.getAccount(accountId);
    const connection = this.store.getConnectionInternal(accountId);
    const adapter = this.adapterFor(account.platform);
    try {
      await adapter.revoke({ account, vaultHandle: connection.vaultHandle });
    } catch (error) {
      throw normalizeAdapterError(error, false);
    }
    return { connection: this.store.revokeAccount({ accountId, callerId: principal.callerId, reason }) };
  }

  async read(principal: Principal, accountId: string, operationId: string, request: ReadRequest) {
    await this.authorize(principal, operationId, "social:read", { accountId });
    const ready = await this.ensureReady(accountId, principal.callerId);
    try {
      const adapterResult = await ready.adapter.read({ account: ready.account, vaultHandle: ready.connection.vaultHandle, request });
      const result = normalizeReadResult(request, adapterResult);
      this.store.audit({ callerId: principal.callerId, accountId, type: operationId, outcome: "succeeded", data: { kind: request.kind } });
      return result;
    } catch (error) {
      const normalized = normalizeAdapterError(error, false);
      this.store.audit({ callerId: principal.callerId, accountId, type: operationId, outcome: "failed", data: { code: normalized.code } });
      throw normalized;
    }
  }

  async enqueueAction(principal: Principal, accountId: string, idempotencyKey: string, input: unknown) {
    await this.authorize(principal, "actions.create", "social:write", { accountId });
    const key = assertString(idempotencyKey, "idempotencyKey", 128);
    const action = validateWriteRequest(input);
    await this.ensureReady(accountId, principal.callerId);
    const created = this.store.createAction({ callerId: principal.callerId, accountId, idempotencyKey: key, request: action });
    return { action: publicAction(created.action), replayed: created.replayed };
  }

  async getAction(principal: Principal, actionId: string) {
    await this.authorize(principal, "actions.get", "actions:read", { actionId });
    return { action: this.store.getActionForCaller(assertString(actionId, "actionId", 128), principal.callerId) };
  }

  async runNextAction(options: { crashAfterSubmit?: boolean; crashAfterRecord?: boolean } = {}): Promise<ActionRecord | null> {
    const action = this.store.claimNextAction();
    if (!action) return null;
    if (this.liveActionExecutor) {
      return this.liveActionExecutor.execute(action, this.store, { crashAfterRecord: options.crashAfterRecord });
    }
    let ready: Awaited<ReturnType<SocialGitService["ensureReady"]>>;
    try {
      ready = await this.ensureReady(action.accountId, action.callerId);
    } catch (error) {
      const normalized = error instanceof ServiceError ? error : normalizeAdapterError(error, false);
      return this.store.transitionAction(action.id, ["running"], normalized.code === "CHALLENGE_REQUIRED" || normalized.code === "IDENTITY_MISMATCH" || normalized.code === "SESSION_REVOKED" ? "action_required" : "failed", {
        error: publicActionError(normalized),
      });
    }
    try {
      this.store.markSubmissionStarted(action.id);
      const outcome = await ready.adapter.submit({ account: ready.account, vaultHandle: ready.connection.vaultHandle, action, request: action.request as WriteRequest });
      if (options.crashAfterSubmit) throw new SimulatedProcessCrash("simulated crash after adapter returned");
      return this.applyOutcome(action.id, ["running"], outcome);
    } catch (error) {
      if (error instanceof SimulatedProcessCrash) throw error;
      const resultMayBeUnknown = !(error instanceof AdapterExecutionError) || error.submissionMayHaveStarted;
      const normalized = normalizeAdapterError(error, resultMayBeUnknown);
      const nextState: ActionState = error instanceof AdapterExecutionError && !error.submissionMayHaveStarted
        ? error.code === "CHALLENGE_REQUIRED" ? "action_required" : "failed"
        : "UNKNOWN";
      return this.store.transitionAction(action.id, ["running"], nextState, { error: publicActionError(normalized) });
    }
  }

  async reconcileAction(principal: Principal, actionId: string) {
    await this.authorize(principal, "actions.reconcile", "social:write", { actionId });
    const action = this.store.getActionForCaller(actionId, principal.callerId);
    if (action.state !== "UNKNOWN") throw new ServiceError("ACTION_STATE_CONFLICT", "Only an UNKNOWN action can be reconciled.");
    const ready = await this.ensureReady(action.accountId, principal.callerId);
    let outcome;
    try {
      outcome = await ready.adapter.reconcile({ account: ready.account, vaultHandle: ready.connection.vaultHandle, action });
    } catch {
      throw new ServiceError("UNKNOWN_RESULT", "The action result is still unknown.", { retryable: true });
    }
    if (outcome.status === "pending") return { action, reconciled: false };
    return { action: this.applyOutcome(action.id, ["UNKNOWN"], outcome), reconciled: true };
  }

  async listAuditEvents(principal: Principal, input: { accountId?: string; cursor?: string; limit?: number }) {
    await this.authorize(principal, "audit.list", "audit:read", input.accountId ? { accountId: input.accountId } : {});
    return this.store.listAuditEvents({ ...pageInput(input), accountId: input.accountId });
  }

  async ingestAdapterEvent(principal: Principal, input: unknown) {
    await this.authorize(principal, "events.ingest", "events:ingest");
    const body = assertObject(input);
    if (Buffer.byteLength(JSON.stringify(body)) > 65_536) throw new ServiceError("VALIDATION_FAILED", "Adapter event exceeds the 65536 byte limit.");
    if (body.version !== 1) throw new ServiceError("PROTOCOL_DRIFT", "Adapter event version is not supported.");
    const type = assertString(body.type, "type", 64);
    if (type !== "action.result") throw new ServiceError("PROTOCOL_DRIFT", "Adapter event type is not supported.");
    assertString(body.occurredAt, "occurredAt", 64);
    const payload = assertObject(body.payload, "payload");
    const state = assertString(payload.state, "payload.state", 32) as ActionState;
    if (!["succeeded", "failed", "action_required", "UNKNOWN"].includes(state)) throw new ServiceError("VALIDATION_FAILED", "payload.state is invalid.");
    const result = this.store.applyActionResultEvent({
      source: assertString(body.source, "source", 128),
      eventId: assertString(body.eventId, "eventId", 128),
      accountId: assertString(body.accountId, "accountId", 128),
      payload: {
        actionId: assertString(payload.actionId, "payload.actionId", 128),
        state: state as "succeeded" | "failed" | "action_required" | "UNKNOWN",
        result: state === "succeeded" ? normalizeActionResult(payload.result) : undefined,
        error: state === "succeeded" ? undefined : normalizeEventError(state, payload.error),
      },
    });
    return { replayed: result.replayed, action: publicAction(result.action) };
  }

  private adapterFor(platform: string): PlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new ServiceError("PROTOCOL_DRIFT", "No admitted adapter is available for the account platform.");
    return adapter;
  }

  private async ensureReady(accountId: string, callerId: string) {
    const account = this.store.getAccount(accountId);
    if (account.status === "revoked") throw new ServiceError("SESSION_REVOKED", "The account connection is revoked.");
    const connection = this.store.getConnectionInternal(accountId);
    if (connection.status !== "active") throw new ServiceError("SESSION_REVOKED", "The account connection is revoked.");
    const adapter = this.adapterFor(account.platform);
    let identity;
    try {
      identity = await adapter.verifyIdentity({ account, vaultHandle: connection.vaultHandle });
    } catch (error) {
      throw normalizeAdapterError(error, false);
    }
    if (identity.nativeUserId !== account.expectedNativeUserId) {
      this.store.markAccountStatus(accountId, "suspended");
      this.store.audit({ callerId, accountId, type: "identity.mismatch", outcome: "action_required", data: { expectedIdentityBound: true } });
      throw new ServiceError("IDENTITY_MISMATCH", "The native account identity does not match the account binding.");
    }
    return { account: this.store.getAccount(accountId), connection, adapter };
  }

  private applyOutcome(actionId: string, from: ActionState[], outcome: Awaited<ReturnType<PlatformAdapter["submit"]>>): ActionRecord {
    switch (outcome.status) {
      case "confirmed": return this.store.transitionAction(actionId, from, "succeeded", { result: normalizeActionResult(outcome.result) });
      case "failed": return this.store.transitionAction(actionId, from, "failed", { error: { code: safeAdapterCode(outcome.code), message: "The platform rejected the action.", retryable: outcome.retryable ?? false, ...(outcome.rateLimit ? { rateLimit: normalizeRateLimit(outcome.rateLimit) } : {}) } });
      case "action_required": return this.store.transitionAction(actionId, from, "action_required", { error: { code: safeAdapterCode(outcome.code), message: "Human action is required on the platform.", retryable: false } });
      case "unknown": return this.store.transitionAction(actionId, from, "UNKNOWN", { error: { code: "UNKNOWN_RESULT", message: "The platform result could not be verified.", retryable: false } });
    }
  }
}

function pageInput(input: { cursor?: unknown; limit?: unknown }) {
  const cursor = input.cursor === undefined ? undefined : assertString(input.cursor, "cursor", 512);
  const limit = input.limit === undefined ? 25 : requireInteger(input.limit, "limit", 1, 100);
  return { cursor, limit };
}

function requireInteger(value: unknown, field: string, minimum: number, maximum: number) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || Number(number) < minimum || Number(number) > maximum) {
    throw new ServiceError("VALIDATION_FAILED", `${field} must be an integer from ${minimum} through ${maximum}.`, { details: { field } });
  }
  return Number(number);
}

function validateWriteRequest(input: unknown): Record<string, unknown> {
  const body = assertObject(input, "action");
  const kind = assertString(body.kind, "action.kind", 32);
  if (!(WRITE_KINDS as readonly string[]).includes(kind)) throw new ServiceError("VALIDATION_FAILED", "action.kind is not supported.", { details: { field: "action.kind" } });
  const allowed: Record<string, string[]> = {
    text_post: ["kind", "subreddit", "title", "text"], link_post: ["kind", "subreddit", "title", "url"], media_post: ["kind", "subreddit", "title", "mediaRef"],
    comment: ["kind", "postId", "text"], reply: ["kind", "commentId", "text"], vote: ["kind", "targetId", "direction"],
    save: ["kind", "targetId"], unsave: ["kind", "targetId"], delete: ["kind", "targetId"],
  };
  for (const key of Object.keys(body)) if (!allowed[kind]!.includes(key)) throw new ServiceError("VALIDATION_FAILED", `action.${key} is not allowed for ${kind}.`, { details: { field: `action.${key}` } });
  if (["text_post", "link_post", "media_post"].includes(kind)) {
    assertString(body.subreddit, "action.subreddit", 128); assertString(body.title, "action.title", 300);
  }
  if (kind === "text_post") {
    if (typeof body.text !== "string" || body.text.length > 40_000) throw new ServiceError("VALIDATION_FAILED", "action.text is invalid.");
  }
  if (kind === "link_post") validateUrl(body.url, "action.url");
  if (kind === "media_post") assertString(body.mediaRef, "action.mediaRef", 512);
  if (kind === "comment") { assertString(body.postId, "action.postId", 128); assertString(body.text, "action.text", 10_000); }
  if (kind === "reply") { assertString(body.commentId, "action.commentId", 128); assertString(body.text, "action.text", 10_000); }
  if (["vote", "save", "unsave", "delete"].includes(kind)) assertString(body.targetId, "action.targetId", 128);
  if (kind === "vote" && ![-1, 0, 1].includes(body.direction as number)) throw new ServiceError("VALIDATION_FAILED", "action.direction must be -1, 0, or 1.");
  return structuredClone(body);
}

function validateUrl(value: unknown, field: string) {
  const raw = assertString(value, field, 2048);
  let url;
  try { url = new URL(raw); } catch { throw new ServiceError("VALIDATION_FAILED", `${field} must be a valid URL.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ServiceError("VALIDATION_FAILED", `${field} must use HTTP or HTTPS.`);
}

function normalizeAdapterError(error: unknown, submissionMayHaveStarted: boolean) {
  if (error instanceof ServiceError) return error;
  if (error instanceof AdapterExecutionError) {
    if (error.code === "SESSION_REVOKED") return new ServiceError("SESSION_REVOKED", "The account session is revoked.");
    if (error.code === "AUTHENTICATION_FAILED") return new ServiceError("SESSION_REVOKED", "The account session is not authenticated.");
    if (error.code === "WRONG_IDENTITY") return new ServiceError("IDENTITY_MISMATCH", "The native account identity does not match the account binding.");
    if (["CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED", "CAPTCHA_REQUIRED"].includes(error.code)) {
      return new ServiceError("CHALLENGE_REQUIRED", "Human action is required on the platform.");
    }
    if (error.code === "RATE_LIMITED") return new ServiceError("RATE_LIMITED", "The platform rate limit was reached.", { retryable: true, rateLimit: error.rateLimit });
    if (error.code === "NOT_CALLER_OWNED") return new ServiceError("FORBIDDEN", "The authenticated account does not own the native item.");
    if (error.submissionMayHaveStarted || submissionMayHaveStarted) return new ServiceError("UNKNOWN_RESULT", "The action result could not be verified.");
    return new ServiceError("PROTOCOL_DRIFT", "The platform adapter could not complete the operation.");
  }
  return submissionMayHaveStarted
    ? new ServiceError("UNKNOWN_RESULT", "The action result could not be verified.")
    : new ServiceError("INTERNAL", "The platform adapter could not complete the operation.", { status: 500 });
}

function adapterCode(error: unknown) { return error instanceof AdapterExecutionError ? error.code : "INTERNAL"; }

function publicActionError(error: ServiceError) {
  return { code: error.code, message: error.message, retryable: error.retryable, ...(error.rateLimit ? { rateLimit: error.rateLimit } : {}) };
}

function publicAction(action: ActionRecord & { request?: unknown; requestHash?: unknown }): ActionRecord {
  const { request: _request, requestHash: _hash, ...safe } = action;
  return safe;
}

const READ_FIELDS: Record<ReadRequest["kind"], readonly string[]> = {
  profile: ["nativeId", "canonicalUrl", "username", "displayName", "karma", "createdAt"],
  subreddit: ["nativeId", "canonicalUrl", "name", "title", "description", "subscribers"],
  feed: ["nativeId", "canonicalUrl", "title", "subreddit", "authorNativeId", "body", "score", "createdAt", "url"],
  post: ["nativeId", "canonicalUrl", "title", "subreddit", "authorNativeId", "body", "score", "createdAt", "url"],
  comments: ["nativeId", "canonicalUrl", "postId", "parentNativeId", "authorNativeId", "body", "score", "createdAt"],
  search: ["nativeId", "canonicalUrl", "title", "subreddit", "authorNativeId", "body", "score", "createdAt", "url"],
};

function normalizeReadResult(request: ReadRequest, value: unknown): unknown {
  const body = assertAdapterObject(value, "read result");
  if ("items" in body) {
    if (!Array.isArray(body.items) || body.items.length > 100) throw new ServiceError("PROTOCOL_DRIFT", "The adapter returned an invalid page.");
    const nextCursor = body.nextCursor === null || body.nextCursor === undefined ? null : adapterString(body.nextCursor, "nextCursor", 512);
    return { items: body.items.map((item) => normalizeReadEntity(request.kind, item)), nextCursor };
  }
  return normalizeReadEntity(request.kind, body);
}

function normalizeReadEntity(kind: ReadRequest["kind"], value: unknown) {
  const source = assertAdapterObject(value, "native entity");
  const output: Record<string, unknown> = {};
  for (const key of READ_FIELDS[kind]) {
    if (!(key in source)) continue;
    if (key === "nativeId") output[key] = adapterString(source[key], key, 128);
    else if (key === "canonicalUrl" || key === "url") output[key] = adapterUrl(source[key], key);
    else output[key] = redactDetails(source[key]);
  }
  if (typeof output.nativeId !== "string") throw new ServiceError("PROTOCOL_DRIFT", "The adapter result does not include a native identifier.");
  if (Buffer.byteLength(JSON.stringify(output)) > 65_536) throw new ServiceError("PROTOCOL_DRIFT", "The adapter entity exceeds the public result size limit.");
  return output;
}

function normalizeActionResult(value: unknown) {
  const source = assertAdapterObject(value, "action result");
  const result: Record<string, unknown> = { nativeId: adapterString(source.nativeId, "nativeId", 128) };
  if (source.canonicalUrl !== undefined) result.canonicalUrl = adapterUrl(source.canonicalUrl, "canonicalUrl");
  return result;
}

function normalizeEventError(state: ActionState, value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const code = safeAdapterCode(typeof source.code === "string" ? source.code : state === "UNKNOWN" ? "UNKNOWN_RESULT" : "PLATFORM_ERROR");
  return {
    code,
    message: state === "action_required" ? "Human action is required on the platform." : state === "UNKNOWN" ? "The platform result could not be verified." : "The platform rejected the action.",
    retryable: source.retryable === true,
    ...(source.rateLimit && typeof source.rateLimit === "object" ? { rateLimit: normalizeRateLimit(source.rateLimit as RateLimitInfo) } : {}),
  };
}

function normalizeRateLimit(value: RateLimitInfo): RateLimitInfo {
  const output: RateLimitInfo = {};
  if (Number.isInteger(value.limit) && Number(value.limit) >= 0) output.limit = Number(value.limit);
  if (Number.isInteger(value.remaining) && Number(value.remaining) >= 0) output.remaining = Number(value.remaining);
  if (Number.isInteger(value.retryAfterSeconds) && Number(value.retryAfterSeconds) >= 0) output.retryAfterSeconds = Number(value.retryAfterSeconds);
  if (typeof value.resetAt === "string" && !Number.isNaN(Date.parse(value.resetAt))) output.resetAt = new Date(value.resetAt).toISOString();
  return output;
}

function assertAdapterObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ServiceError("PROTOCOL_DRIFT", `The adapter returned an invalid ${name}.`);
  return value as Record<string, unknown>;
}

function adapterString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new ServiceError("PROTOCOL_DRIFT", `The adapter returned an invalid ${name}.`);
  return value;
}

function adapterUrl(value: unknown, name: string): string {
  const raw = adapterString(value, name, 2048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ServiceError("PROTOCOL_DRIFT", `The adapter returned an invalid ${name}.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ServiceError("PROTOCOL_DRIFT", `The adapter returned an invalid ${name}.`);
  return parsed.toString();
}

function safeAdapterCode(value: string) {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "PLATFORM_ERROR";
}
