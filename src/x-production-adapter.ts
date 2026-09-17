import { X_CAPABILITIES } from "@social-git/x-adapter";
import {
  AdapterExecutionError,
  type ActionExecutionContext,
  type AdapterWriteOutcome,
  type PlatformAdapter,
  type ReadRequest,
  type ReconcileOutcome,
  type WriteRequest,
  type XReadRequest,
  type XWriteRequest,
} from "./adapter.ts";
import type { AccountRecord, ActionRecord } from "./persistence.ts";
import { CoreXTransportProvider, XRuntimeError, type XAdmissionDecision, type XProductionResult } from "./runtime-x.ts";

/** Production bridge. It is constructed only from the committed admission decision. */
export class ProductionXPlatformAdapter implements PlatformAdapter {
  readonly platform = "x";
  readonly directSessionIdentityVerificationAdmitted: boolean;
  private readonly provider: CoreXTransportProvider;
  private readonly admission: XAdmissionDecision;

  constructor(provider: CoreXTransportProvider, admission: XAdmissionDecision) {
    this.provider = provider;
    this.admission = admission;
    this.directSessionIdentityVerificationAdmitted = admission.enabled;
  }

  nextConnectionGeneration(account: AccountRecord) { return this.provider.nextConnectionGeneration(account); }

  prepareDirectConnection(input: {
    account: AccountRecord;
    generation: number;
    session: Uint8Array;
    networkRoute: { id: string; material: Uint8Array };
  }) {
    this.assertAdmitted();
    this.provider.importDirectConnection(input);
  }

  async capabilities(_account: AccountRecord) {
    return this.admission.enabled ? X_CAPABILITIES.map((capability) => capability.operation) : [];
  }

  async capabilityDetails(_account: AccountRecord) {
    return X_CAPABILITIES.map((capability) => Object.freeze({
      ...capability,
      productionEnabled: this.admission.enabled,
      status: this.admission.enabled ? "available" : "disabled",
      disabledReason: this.admission.enabled ? undefined : this.admission.disabledReasons[0],
      disabledReasons: this.admission.enabled ? [] : this.admission.disabledReasons,
    }));
  }

  capabilityCatalog() { return this.capabilityDetails({} as AccountRecord); }

  unsupportedCapabilities() {
    return this.admission.enabled ? {} : Object.fromEntries(X_CAPABILITIES.map((capability) => [capability.operation, this.admission.disabledReasons[0] ?? "X_TRANSPORT_NOT_ADMITTED"]));
  }

  async verifyIdentity(input: { account: AccountRecord; vaultHandle: string }) {
    void input.vaultHandle;
    this.assertAdmitted();
    try {
      const result = await this.provider.execute({ account: input.account, intent: "identity_validation", operation: "account.identity", payload: {} });
      const entity = object(result.data.entity, "X identity");
      const nativeUserId = numericId(entity.nativeId, "X identity");
      return { nativeUserId };
    } catch (error) { throw adapterError(error); }
  }

  async read(input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }) {
    void input.vaultHandle;
    this.assertAdmitted();
    if (!isXRead(input.request)) throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "The X adapter cannot execute a Reddit read.");
    try {
      let mapped = mapXRead(input.request);
      if (input.request.kind === "x_user_timeline") {
        const profile = await this.provider.execute({
          account: input.account,
          intent: "read",
          operation: "profile.get",
          payload: { username: input.request.username },
        });
        const entity = object(profile.data.entity, "X profile");
        mapped = { operation: "timeline.user", payload: compact({ userNativeId: numericId(entity.nativeId, "X user identity"), cursor: input.request.cursor, limit: input.request.limit }) };
      }
      const result = await this.provider.execute({ account: input.account, intent: "read", operation: mapped.operation, payload: mapped.payload });
      return Object.freeze({ ...result.data, ...(result.rateLimit ? { rateLimit: result.rateLimit } : {}) });
    } catch (error) { throw adapterError(error); }
  }

  async submit(input: {
    account: AccountRecord;
    vaultHandle: string;
    action: ActionRecord;
    request: WriteRequest;
    execution?: ActionExecutionContext;
  }): Promise<AdapterWriteOutcome> {
    void input.vaultHandle;
    this.assertAdmitted();
    if (!isXWrite(input.request)) return { status: "failed", code: "CAPABILITY_UNAVAILABLE", message: "The X adapter cannot execute a Reddit write." };
    if (input.request.kind === "x_media_post") return this.submitMedia(input as typeof input & { request: Extract<XWriteRequest, { kind: "x_media_post" }> });
    try {
      const mapped = mapXWrite(input.request);
      const result = await this.provider.execute({
        account: input.account,
        intent: "write",
        operation: mapped.operation,
        payload: mapped.payload,
        requestId: actionRequestId(input.action.id),
      });
      if (!result.native?.nativeId) throw new AdapterExecutionError("PROTOCOL_DRIFT", "The confirmed X write has no native result.", { submissionMayHaveStarted: true });
      return { status: "confirmed", result: { nativeId: result.native.nativeId, ...(result.native.canonicalUrl ? { canonicalUrl: result.native.canonicalUrl } : {}) } };
    } catch (error) { return writeOutcome(error); }
  }

  async reconcile(_input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome> {
    // No admitted operation can prove an unknown mutation without its native
    // result. Recovery is deliberately read-only and never repeats a write.
    return { status: "pending" };
  }

  async revoke(input: { account: AccountRecord; vaultHandle: string }) {
    void input.vaultHandle;
    this.provider.revoke(input.account);
  }

  async close() { this.provider.close(); }

  private async submitMedia(input: {
    account: AccountRecord;
    vaultHandle: string;
    action: ActionRecord;
    request: Extract<XWriteRequest, { kind: "x_media_post" }>;
    execution?: ActionExecutionContext;
  }): Promise<AdapterWriteOutcome> {
    if (!input.execution) return { status: "failed", code: "CAPABILITY_DISABLED", message: "X media submission requires the Core media flow.", retryable: false };
    let flow = input.execution.flow;
    let mediaBase64 = "";
    try {
      if (flow.phase === "reserved") {
        const initialized = await this.provider.execute({
          account: input.account,
          intent: "write",
          operation: "post.media.init",
          payload: {
            mimeType: input.execution.media.mimeType,
            sizeBytes: input.execution.media.sizeBytes,
            sha256: input.execution.media.sha256,
          },
          requestId: mediaRequestId(input.action.id, "init"),
        });
        flow = input.execution.transition("reserved", "leased", ticketValue(initialized));
      }
      if (flow.phase === "leased") {
        const ticket = requiredTicket(flow.workerTicket);
        mediaBase64 = Buffer.from(input.execution.media.data.buffer, input.execution.media.data.byteOffset, input.execution.media.data.byteLength).toString("base64");
        const uploaded = await this.provider.execute({
          account: input.account,
          intent: "write",
          operation: "post.media.append",
          payload: { ticket, dataBase64: mediaBase64 },
          requestId: mediaRequestId(input.action.id, "append"),
        });
        if (ticketValue(uploaded) !== ticket) throw new AdapterExecutionError("PROTOCOL_DRIFT", "The X media worker changed its bound ticket.");
        flow = input.execution.transition("leased", "uploaded", ticket);
      }
      if (flow.phase === "uploaded") flow = input.execution.beginSubmission(requiredTicket(flow.workerTicket));
      if (flow.phase === "submitting") {
        const ticket = requiredTicket(flow.workerTicket);
        const submitted = await this.provider.execute({
          account: input.account,
          intent: "write",
          operation: "post.media.submit",
          payload: { ticket, text: input.request.text },
          requestId: mediaRequestId(input.action.id, "submit"),
        });
        if (!submitted.native?.nativeId) throw new AdapterExecutionError("PROTOCOL_DRIFT", "The confirmed X media post has no native result.", { submissionMayHaveStarted: true });
        flow = input.execution.transition("submitting", "submitted", ticket);
        input.execution.transition("submitted", "processed", ticket);
        return { status: "confirmed", result: { nativeId: submitted.native.nativeId, ...(submitted.native.canonicalUrl ? { canonicalUrl: submitted.native.canonicalUrl } : {}) } };
      }
      throw new AdapterExecutionError("PROTOCOL_DRIFT", "The X media flow is not executable.", { submissionMayHaveStarted: ["submitting", "submitted", "processed"].includes(flow.phase) });
    } catch (error) {
      return writeOutcome(error, ["submitting", "submitted", "processed"].includes(flow.phase));
    } finally { mediaBase64 = ""; }
  }

  private assertAdmitted() {
    if (!this.admission.enabled) throw new AdapterExecutionError("CAPABILITY_UNAVAILABLE", "No X production transport has passed committed admission.");
  }
}

function mapXRead(request: XReadRequest): { operation: string; payload: Record<string, unknown> } {
  switch (request.kind) {
    case "x_account_health": return { operation: "account.identity", payload: {} };
    case "x_profile": return { operation: "profile.get", payload: { username: request.username } };
    case "x_post": return { operation: "post.get", payload: { postId: request.postId } };
    case "x_thread": return { operation: "thread.get", payload: compact({ postId: request.postId, cursor: request.cursor, limit: request.limit }) };
    case "x_home_timeline": return { operation: "timeline.home", payload: compact({ cursor: request.cursor, limit: request.limit }) };
    case "x_user_timeline": return { operation: "timeline.user", payload: compact({ cursor: request.cursor, limit: request.limit }) };
    case "x_search": return { operation: "search.query", payload: compact({ query: request.query, cursor: request.cursor, limit: request.limit }) };
    case "x_notifications": return { operation: "notifications.list", payload: compact({ cursor: request.cursor, limit: request.limit }) };
    case "x_conversations": return { operation: "conversations.list", payload: compact({ cursor: request.cursor, limit: request.limit }) };
    case "x_bookmarks": return { operation: "bookmarks.list", payload: compact({ cursor: request.cursor, limit: request.limit }) };
    case "x_followers": return { operation: "followers.list", payload: compact({ userNativeId: request.userNativeId, cursor: request.cursor, limit: request.limit }) };
    case "x_following": return { operation: "following.list", payload: compact({ userNativeId: request.userNativeId, cursor: request.cursor, limit: request.limit }) };
    case "x_list": return { operation: "lists.lookup", payload: { listId: request.listId } };
    case "x_list_memberships": return { operation: "lists.memberships", payload: compact({ cursor: request.cursor, limit: request.limit }) };
    case "x_list_members": return { operation: "lists.members", payload: compact({ listId: request.listId, cursor: request.cursor, limit: request.limit }) };
    case "x_list_timeline": return { operation: "lists.timeline", payload: compact({ listId: request.listId, cursor: request.cursor, limit: request.limit }) };
  }
}

function mapXWrite(request: Exclude<XWriteRequest, { kind: "x_media_post" }>) {
  switch (request.kind) {
    case "x_post_create": return { operation: "post.create", payload: { text: request.text } };
    case "x_reply_create": return { operation: "post.reply", payload: { postId: request.postId, text: request.text } };
    case "x_post_delete": return { operation: "post.delete", payload: { postId: request.postId } };
    case "x_like_set": return { operation: "post.like.set", payload: { postId: request.postId, enabled: request.enabled } };
    case "x_repost_set": return { operation: "post.repost.set", payload: { postId: request.postId, enabled: request.enabled } };
    case "x_follow_set": return { operation: "profile.follow.set", payload: { userNativeId: request.userNativeId, enabled: request.enabled } };
    case "x_bookmark_set": return { operation: "bookmark.set", payload: { postId: request.postId, enabled: request.enabled } };
    case "x_direct_message": return { operation: "message.send", payload: { recipientNativeId: request.recipientNativeId, text: request.text } };
  }
}

function writeOutcome(error: unknown, submissionStarted = false): AdapterWriteOutcome {
  const normalized = adapterError(error);
  if (submissionStarted || normalized.submissionMayHaveStarted) return { status: "unknown", message: "The X write result could not be verified." };
  if (new Set(["AUTHENTICATION_FAILED", "CHALLENGE_REQUIRED", "SESSION_REVOKED", "WRONG_IDENTITY", "X_TRANSPORT_NOT_ADMITTED"]).has(normalized.code)) {
    return { status: "action_required", code: normalized.code, message: "X requires account or transport action." };
  }
  return { status: "failed", code: normalized.code, message: "X rejected the action before a result was accepted.", retryable: normalized.retryable, ...(normalized.rateLimit ? { rateLimit: normalized.rateLimit } : {}) };
}

function adapterError(error: unknown) {
  if (error instanceof AdapterExecutionError) return error;
  if (error instanceof XRuntimeError) return new AdapterExecutionError(error.code, error.message, { retryable: error.retryable, submissionMayHaveStarted: error.submissionMayHaveStarted, ...(error.rateLimit ? { rateLimit: error.rateLimit } : {}) });
  const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "PROTOCOL_DRIFT";
  return new AdapterExecutionError(code, "The X transport failed closed.");
}

function ticketValue(result: XProductionResult) { return requiredTicket(result.data.ticket); }
function requiredTicket(value: unknown) { if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(value)) throw new AdapterExecutionError("PROTOCOL_DRIFT", "The X media ticket is invalid."); return value; }
function numericId(value: unknown, label: string) { if (typeof value !== "string" || !/^\d+$/u.test(value) || value.length > 128) throw new AdapterExecutionError("PROTOCOL_DRIFT", `${label} is invalid.`); return value; }
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdapterExecutionError("PROTOCOL_DRIFT", `${label} is invalid.`); return value as Record<string, unknown>; }
function compact(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function isXRead(request: ReadRequest): request is XReadRequest { return request.kind.startsWith("x_"); }
function isXWrite(request: WriteRequest): request is XWriteRequest { return request.kind.startsWith("x_"); }
function actionRequestId(actionId: string) { return `x-${actionId}`.slice(0, 128); }
function mediaRequestId(actionId: string, phase: string) { return `x-${actionId}-${phase}`.slice(0, 128); }
