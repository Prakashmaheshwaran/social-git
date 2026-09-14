import { createHash, randomUUID } from "node:crypto";
import { SessionRuntime, decodeWorkerMessage, encodeWorkerMessage, type WorkerCommand, type WorkerResultStatus } from "@social-git/core";
import { RedditFixtureAdapter, capabilityFor } from "@social-git/reddit-adapter";
import { AdapterExecutionError, type AdapterWriteOutcome, type PlatformAdapter, type ReadRequest, type ReconcileOutcome, type WriteRequest } from "./adapter.ts";
import type { AccountRecord, ActionRecord } from "./persistence.ts";

interface StagedFixtureSession {
  nativeIdentity: string;
  routeId: string;
  session: Uint8Array;
  route: Uint8Array;
}

export class FixtureRedditPlatformAdapter implements PlatformAdapter {
  readonly platform = "reddit";
  private readonly runtime: SessionRuntime;
  private readonly staged = new Map<string, StagedFixtureSession>();
  private readonly identities = new Map<string, string>();
  private readonly routeIds = new Map<string, string>();
  private readonly ownedNativeIds = new Map<string, Set<string>>();
  private readonly nextOutcomes = new Map<string, string>();
  private readonly crashWrites = new Set<string>();
  private readonly reconciliationOutcomes = new Map<string, Record<string, unknown>>();
  private readonly calls: Array<{ accountId: string; operation: string; routeId: string }> = [];
  private readonly unknowns = new Map<string, { adapter: RedditFixtureAdapter; result: any; context: any; accountId: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(runtime: SessionRuntime) { this.runtime = runtime; }

  stageSession(input: {
    vaultHandle: string;
    nativeIdentity: string;
    routeId: string;
    session: Uint8Array;
    route: Uint8Array;
  }) {
    if (this.staged.has(input.vaultHandle)) throw new TypeError("Fixture vault handle is already staged");
    this.staged.set(input.vaultHandle, {
      nativeIdentity: input.nativeIdentity,
      routeId: input.routeId,
      session: Buffer.from(input.session),
      route: Buffer.from(input.route),
    });
  }

  setNextOutcome(accountId: string, operation: string, outcome: string) {
    this.nextOutcomes.set(`${accountId}\0${operation}`, outcome);
  }

  setCrashAfterSubmit(accountId: string, operation: string) {
    this.crashWrites.add(`${accountId}\0${operation}`);
  }

  seedOwned(accountId: string, nativeIds: string[]) {
    this.ownedNativeIds.set(accountId, new Set(nativeIds));
  }

  setReconciliationOutcome(actionId: string, outcome: Record<string, unknown>) {
    this.reconciliationOutcomes.set(actionId, structuredClone(outcome));
  }

  async rearmIfStopped(account: AccountRecord) {
    const state = this.runtime.getAccountState(account.id);
    if (["healthy", "pending_identity"].includes(state.health)) return null;
    const identity = this.identities.get(account.id) ?? account.expectedNativeUserId;
    const routeId = this.routeIds.get(account.id) ?? `fixture-route-${account.id}`;
    const generation = Math.max(state.generation, state.revokedThroughGeneration) + 1;
    const session = Buffer.from(JSON.stringify({ fixture: "rearmed" }), "utf8");
    const route = Buffer.from(JSON.stringify({ kind: "fixture", route: routeId }), "utf8");
    try {
      this.runtime.importExternalSession({
        accountId: account.id,
        platform: account.platform,
        expectedNativeIdentity: account.expectedNativeUserId,
        generation,
        session,
        networkRoute: { id: routeId, material: route },
      });
      const result = await this.serial(() => this.executeFixture(account, "identity_validation", "session.import", {}, "session.import"));
      if (result.status !== "SUCCEEDED") throw fixtureFailure(result);
      return { generation, identity, routeId };
    } finally {
      session.fill(0);
      route.fill(0);
    }
  }

  inspectCalls() { return structuredClone(this.calls); }

  async reset() {
    for (const value of this.staged.values()) { value.session.fill(0); value.route.fill(0); }
    this.staged.clear();
    this.identities.clear();
    this.routeIds.clear();
    this.ownedNativeIds.clear();
    this.nextOutcomes.clear();
    this.crashWrites.clear();
    this.reconciliationOutcomes.clear();
    this.calls.length = 0;
    await Promise.all([...this.unknowns.values()].map(({ adapter }) => adapter.close()));
    this.unknowns.clear();
  }

  async prepareConnection(input: { account: AccountRecord; vaultHandle: string; generation: number }) {
    const staged = this.staged.get(input.vaultHandle);
    if (!staged) throw new AdapterExecutionError("AUTHENTICATION_FAILED", "The fixture session handle is not staged");
    this.staged.delete(input.vaultHandle);
    try {
      this.runtime.importExternalSession({
        accountId: input.account.id,
        platform: input.account.platform,
        expectedNativeIdentity: input.account.expectedNativeUserId,
        generation: input.generation,
        session: staged.session,
        networkRoute: { id: staged.routeId, material: staged.route },
      });
      this.identities.set(input.account.id, staged.nativeIdentity);
      this.routeIds.set(input.account.id, staged.routeId);
    } finally {
      staged.session.fill(0);
      staged.route.fill(0);
    }
  }

  async capabilities(_account: AccountRecord): Promise<string[]> {
    return ["profile:read", "subreddit:read", "feed:read", "post:read", "comments:read", "search:read", "text_post:write"];
  }

  async verifyIdentity(input: { account: AccountRecord; vaultHandle: string }) {
    const result = await this.serial(() => this.executeFixture(input.account, "identity_validation", "session.import", {}, "session.import"));
    if (result.status !== "SUCCEEDED") throw fixtureFailure(result);
    return { nativeUserId: this.identities.get(input.account.id) ?? input.account.expectedNativeUserId };
  }

  async read(input: { account: AccountRecord; vaultHandle: string; request: ReadRequest }) {
    const mapped = mapRead(input.request);
    const result = await this.serial(() => this.executeFixture(input.account, "read", mapped.operation, mapped.input, publicReadOperation(input.request.kind)));
    if (result.status !== "SUCCEEDED") throw fixtureFailure(result);
    if (["feed", "comments", "search"].includes(input.request.kind)) {
      return { items: result.data.items ?? [], nextCursor: result.data.page?.after ?? null };
    }
    if (input.request.kind === "profile") {
      const identity = this.identities.get(input.account.id) ?? input.account.expectedNativeUserId;
      return {
        ...(result.native ?? {}),
        ...result.data,
        nativeId: `t2_${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`,
        canonicalUrl: `https://www.reddit.com/user/${encodeURIComponent(identity)}/`,
        username: identity,
      };
    }
    return { ...(result.native ?? {}), ...result.data };
  }

  async submit(input: { account: AccountRecord; vaultHandle: string; action: ActionRecord; request: WriteRequest }): Promise<AdapterWriteOutcome> {
    const mapped = mapWrite(input.request);
    const publicOperation = publicWriteOperation(input.request.kind);
    if (input.request.kind === "delete" && !this.ownedNativeIds.get(input.account.id)?.has(input.request.targetId)) {
      return {
        status: "failed",
        code: "NOT_CALLER_OWNED",
        message: "The authenticated account does not own the native item.",
        retryable: false,
      };
    }
    const crashKey = `${input.account.id}\0${publicOperation}`;
    const scenario = this.crashWrites.delete(crashKey)
      ? { outcome: "crash_after_submit", recoveryOutcome: "SUCCEEDED" }
      : undefined;
    const result = await this.serial(() => this.executeFixture(
      input.account,
      "write",
      mapped.operation,
      mapped.input,
      publicOperation,
      input.action,
      scenario,
    ));
    if (result.status === "SUCCEEDED") return { status: "confirmed", result: result.native };
    if (result.status === "UNKNOWN") return { status: "unknown", message: "The fixture write result is unknown." };
    const error = result.error ?? {};
    if (error.actionRequired) return { status: "action_required", code: error.code, message: error.message };
    return { status: "failed", code: error.code, message: error.message, retryable: error.retryable, ...(result.rateLimit ? { rateLimit: result.rateLimit } : {}) };
  }

  async reconcile(input: { account: AccountRecord; vaultHandle: string; action: ActionRecord }): Promise<ReconcileOutcome> {
    const unknown = this.unknowns.get(input.action.id);
    const configured = this.reconciliationOutcomes.get(input.action.id);
    if (configured?.outcome !== "confirmed") return { status: "pending" };
    const result = unknown
      ? await unknown.adapter.recoverUnknown(unknown.result, unknown.context)
      : { status: "SUCCEEDED", native: null };
    if (result.status !== "SUCCEEDED") return { status: "pending" };
    this.reconciliationOutcomes.delete(input.action.id);
    this.unknowns.delete(input.action.id);
    if (unknown) await unknown.adapter.close();
    const native = (result.native ?? {}) as { nativeId?: unknown; canonicalUrl?: unknown };
    const nativeId = typeof configured.nativeId === "string"
      ? configured.nativeId
      : typeof native.nativeId === "string" ? native.nativeId : undefined;
    if (!nativeId) return { status: "pending" };
    return {
      status: "confirmed",
      result: {
        nativeId,
        ...(typeof configured.canonicalUrl === "string"
          ? { canonicalUrl: configured.canonicalUrl }
          : typeof native.canonicalUrl === "string" ? { canonicalUrl: native.canonicalUrl } : {}),
      },
    };
  }

  async revoke(input: { account: AccountRecord; vaultHandle: string }) {
    try {
      const state = this.runtime.getAccountState(input.account.id);
      if (state.health !== "revoked") this.runtime.revokeAccount({ accountId: input.account.id, generation: state.generation });
    } catch (error) {
      if (!new Set(["NOT_FOUND", "REVOKED"]).has((error as { code?: string })?.code ?? "")) throw error;
    }
    this.identities.delete(input.account.id);
  }

  async close() {
    await this.reset();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async executeFixture(
    account: AccountRecord,
    intent: "identity_validation" | "read" | "write",
    operation: string,
    input: Record<string, unknown>,
    publicOperation: string,
    action?: ActionRecord,
    forcedScenario?: Record<string, unknown>,
  ): Promise<any> {
    const state = this.runtime.getAccountState(account.id);
    if (state.health === "revoked") throw new AdapterExecutionError("SESSION_REVOKED", "The fixture session is revoked");
    if (state.health === "challenged") throw new AdapterExecutionError("CHALLENGE_REQUIRED", "The fixture session is challenged");
    if (state.health === "wrong_identity") throw new AdapterExecutionError("WRONG_IDENTITY", "The fixture session has the wrong identity");
    if (["protocol_drift", "unknown", "rate_limited"].includes(state.health)) {
      throw new AdapterExecutionError("PROTOCOL_DRIFT", "The fixture Core session is stopped");
    }
    const commandBytes = this.runtime.acquireWorkerCommand({
      accountId: account.id,
      generation: state.generation,
      requestId: action?.id ?? `fixture-${randomUUID()}`,
      intent,
      operation,
      payload: input,
    });
    const command = decodeWorkerMessage(commandBytes);
    if (command.type !== "social-git.worker.command") throw new TypeError("Expected a Core worker command");
    const outcomeKey = `${account.id}\0${publicOperation}`;
    const outcome = forcedScenario?.outcome ?? this.nextOutcomes.get(outcomeKey);
    this.nextOutcomes.delete(outcomeKey);
    const nativeIdentity = this.identities.get(account.id) ?? account.expectedNativeUserId;
    const adapter = new RedditFixtureAdapter({ scenario: {
      nativeIdentity: "fixture_user",
      ownedNativeIds: [...(this.ownedNativeIds.get(account.id) ?? new Set(["t3_owned", "t1_owned"]))]
        .map((nativeId) => fixtureFullname(nativeId, nativeId.startsWith("t1_") ? "t1" : "t3")),
      ...(outcome ? { outcome } : {}),
      ...forcedScenario,
    } });
    const sessionBytes = Buffer.from(command.sessionBase64, "base64url");
    const sessionMaterial = parseFixtureSession(sessionBytes);
    const context: any = {
      accountId: account.id,
      expectedNativeIdentity: "fixture_user",
      session: {
        kind: "core_decrypted_worker_session",
        version: 1,
        accountId: account.id,
        expectedNativeIdentity: "fixture_user",
        generation: state.generation,
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        sessionMaterial,
      },
      ...(action ? {
        authorization: {
          accountId: account.id,
          callerId: action.callerId,
          operation,
          scope: capabilityFor(operation)?.authorizationScope ?? "reddit.fixture.unsupported",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
        idempotency: { callerId: action.callerId, key: action.idempotencyKey },
      } : {}),
    };
    let result: any;
    try {
      result = operation === "session.import"
        ? await adapter.importSession(context)
        : await adapter.execute(operation as never, input as never, context);
      this.calls.push({ accountId: account.id, operation: publicOperation, routeId: command.networkRoute.id });
      const message = fixtureWorkerResult(command, result, nativeIdentity);
      try {
        this.runtime.completeWorkerResult({ accountId: account.id, generation: state.generation, message });
      } catch (error) {
        if (result.status !== "FAILED") {
          await adapter.close();
          if ((error as { code?: string })?.code === "WRONG_IDENTITY") {
            throw new AdapterExecutionError("WRONG_IDENTITY", "The fixture identity does not match the account binding");
          }
          throw error;
        }
      } finally {
        message.fill(0);
      }
      if (result.status === "UNKNOWN" && action) {
        this.unknowns.set(action.id, {
          adapter,
          result,
          accountId: account.id,
          context: {
            ...context,
            session: { ...context.session, sessionMaterial: { fixture: "recovery" } },
          },
        });
      } else {
        await adapter.close();
      }
      return result;
    } finally {
      sessionBytes.fill(0);
      commandBytes.fill(0);
      command.sessionBase64 = "REDACTED";
      command.networkRoute.materialBase64 = "REDACTED";
    }
  }
}

function fixtureWorkerResult(command: WorkerCommand, result: any, observed: string) {
  const status = fixtureStatus(result) as WorkerResultStatus;
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.result",
    requestId: command.requestId,
    tenantId: command.tenantId,
    accountId: command.accountId,
    platform: command.platform,
    generation: command.generation,
    leaseId: command.leaseId,
    fence: command.fence,
    status,
    observedNativeIdentity: observed,
    ...(result.status === "SUCCEEDED" && result.native?.nativeId ? { nativeId: result.native.nativeId } : {}),
    ...(result.status === "SUCCEEDED" && result.native?.canonicalUrl ? { canonicalUrl: result.native.canonicalUrl } : {}),
  });
}

function fixtureStatus(result: any): WorkerResultStatus {
  if (result.status === "SUCCEEDED") return "SUCCEEDED";
  if (result.status === "UNKNOWN") return "UNKNOWN";
  return ({
    AUTHENTICATION_FAILED: "AUTH_FAILURE",
    CHALLENGE_REQUIRED: "CHALLENGE",
    CHECKPOINT_REQUIRED: "CHECKPOINT",
    CAPTCHA_REQUIRED: "CAPTCHA",
    RATE_LIMITED: "RATE_LIMITED",
    SESSION_REVOKED: "REVOKED",
  } as Record<string, WorkerResultStatus>)[result.error?.code] ?? "PROTOCOL_DRIFT";
}

function fixtureFailure(result: any): AdapterExecutionError {
  const error = result.error ?? {};
  return new AdapterExecutionError(String(error.code ?? "PROTOCOL_DRIFT"), "The independent Reddit fixture stopped.", {
    retryable: error.retryable === true,
    submissionMayHaveStarted: result.status === "UNKNOWN",
    ...(result.rateLimit ? { rateLimit: result.rateLimit } : {}),
  });
}

function parseFixtureSession(bytes: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { fixture: true };
  } catch {
    return { fixture: true };
  }
}

function mapRead(request: ReadRequest): { operation: string; input: Record<string, unknown> } {
  switch (request.kind) {
    case "profile": return { operation: "profile.get", input: {} };
    case "subreddit": return { operation: "subreddit.get", input: { name: request.subreddit } };
    case "feed": return { operation: "listing.list", input: compact({ subreddit: request.subreddit, after: request.cursor, limit: request.limit }) };
    case "post": return { operation: "post.get", input: { nativeId: fullname(request.postId, "t3") } };
    case "comments": return { operation: "comments.list", input: { postNativeId: fullname(request.postId, "t3"), limit: request.limit } };
    case "search": return { operation: "search.query", input: { query: request.query, limit: request.limit } };
  }
}

function mapWrite(request: WriteRequest): { operation: string; input: Record<string, unknown> } {
  switch (request.kind) {
    case "text_post": return { operation: "post.createText", input: { subreddit: request.subreddit, title: request.title, body: request.text } };
    case "link_post": return { operation: "post.createLink", input: { subreddit: request.subreddit, title: request.title, url: request.url } };
    case "media_post": return { operation: "post.createMedia", input: { subreddit: request.subreddit, title: request.title, mediaRef: request.mediaRef } };
    case "comment": return { operation: "comment.create", input: { postNativeId: fullname(request.postId, "t3"), body: request.text } };
    case "reply": return { operation: "reply.create", input: { commentNativeId: fullname(request.commentId, "t1"), body: request.text } };
    case "vote": return { operation: "vote.set", input: { nativeId: fixtureTargetFullname(request.targetId), direction: request.direction } };
    case "save": return { operation: "save.set", input: { nativeId: fixtureTargetFullname(request.targetId) } };
    case "unsave": return { operation: "save.unset", input: { nativeId: fixtureTargetFullname(request.targetId) } };
    case "delete": return { operation: "item.deleteOwn", input: { nativeId: fixtureTargetFullname(request.targetId) } };
  }
}

function publicReadOperation(kind: ReadRequest["kind"]) {
  return ({ profile: "read.account-profile", subreddit: "read.subreddit-metadata", feed: "read.feed", post: "read.post", comments: "read.comments", search: "read.search" })[kind];
}

function publicWriteOperation(kind: WriteRequest["kind"]) {
  return ({ text_post: "write.post.text", link_post: "write.post.link", media_post: "write.post.media", comment: "write.comment", reply: "write.reply", vote: "write.vote", save: "write.save", unsave: "write.unsave", delete: "write.delete" })[kind];
}

function fullname(value: string, prefix: "t1" | "t3") { return fixtureFullname(value, prefix); }
function fixtureTargetFullname(value: string) { return fixtureFullname(value, value.startsWith("t1_") ? "t1" : "t3"); }
function fixtureFullname(value: string, prefix: "t1" | "t3") {
  if (new RegExp(`^${prefix}_[a-z0-9]+$`, "u").test(value)) return value;
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}
function compact(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
