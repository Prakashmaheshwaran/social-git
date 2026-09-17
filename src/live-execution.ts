import { decodeWorkerMessage, encodeWorkerMessage, type SessionRuntime, type WorkerCommand } from "@social-git/core";
import type { RedditProductionResult } from "@social-git/reddit-adapter";
import {
  AuthorizationError,
  AuthorizationErrorCode,
  LiveAuthorizationLedger,
  LiveOutcome,
  LiveTestController,
  StopReason,
  type LiveEvidence,
  type LiveTestGrant,
  type TrustedActor,
} from "@social-git/security";
import { ServiceError } from "./errors.ts";
import type { ActionRecord, InternalActionRecord, LedgerStore } from "./persistence.ts";
import type { RedditCommandExecution } from "./runtime-reddit.ts";

const WRITE_OPERATIONS: Readonly<Record<string, string>> = Object.freeze({
  text_post: "reddit.post.text.create",
  link_post: "reddit.post.link.create",
  media_post: "reddit.post.media.create",
  comment: "reddit.comment.create",
  reply: "reddit.comment.reply",
  edit: "reddit.item.edit-own",
  vote: "reddit.vote.set",
  save: "reddit.item.save",
  unsave: "reddit.item.unsave",
  subscribe: "reddit.subreddit.subscribe",
  unsubscribe: "reddit.subreddit.unsubscribe",
  delete: "reddit.item.delete",
});

export interface LiveDeploymentEvidence {
  environment: string;
  artifactDigest: string;
  sbomDigest: string;
  testEvidenceDigest: string;
}

export interface LiveActionExecutor {
  recoverInterrupted(store: LedgerStore): number;
  execute(action: InternalActionRecord, store: LedgerStore, options?: { crashAfterRecord?: boolean }): Promise<ActionRecord>;
}

export class BoundedLiveActionExecutor implements LiveActionExecutor {
  private readonly controller: LiveTestController;
  private readonly options: {
    ledger: LiveAuthorizationLedger;
    grant: LiveTestGrant;
    executor: TrustedActor;
    coreActor: TrustedActor;
    sessionRuntime: SessionRuntime;
    deployment: LiveDeploymentEvidence;
    dispatch(command: Uint8Array): Promise<string | Uint8Array> | string | Uint8Array;
    executeCommand?(command: Uint8Array): Promise<RedditCommandExecution>;
    now?: () => number;
    leaseTtlMs?: number;
  };

  constructor(options: {
    ledger: LiveAuthorizationLedger;
    grant: LiveTestGrant;
    executor: TrustedActor;
    coreActor: TrustedActor;
    sessionRuntime: SessionRuntime;
    deployment: LiveDeploymentEvidence;
    dispatch(command: Uint8Array): Promise<string | Uint8Array> | string | Uint8Array;
    executeCommand?(command: Uint8Array): Promise<RedditCommandExecution>;
    now?: () => number;
    leaseTtlMs?: number;
  }) {
    this.options = options;
    this.controller = new LiveTestController(options.ledger);
  }

  recoverInterrupted(store: LedgerStore): number {
    return store.recoverLiveAuthorizationUnknown(this.options.ledger.unknownActionIds(store.ledgerId));
  }

  async execute(
    action: InternalActionRecord,
    store: LedgerStore,
    options: { crashAfterRecord?: boolean } = {},
  ): Promise<ActionRecord> {
    let evidence: LiveEvidence;
    let mediaData: Uint8Array | undefined;
    let mediaBase64 = "";
    let mediaTicket: string | undefined;
    let mediaFlowCompleted = false;
    try {
      const operation = operationFor(action);
      const resources = validateActionAgainstGrant(action, this.options.grant.resourceConstraints);
      const session = this.options.sessionRuntime.getAccountState(action.accountId);
      let payload: unknown = action.request;
      let actionStore: { markSubmissionStarted(actionId: string): void } = {
        markSubmissionStarted: (actionId) => store.markSubmissionStarted(actionId, action.claimToken ?? undefined),
      };
      if (action.kind === "media_post") {
        const resolved = store.resolveMediaForAction(action);
        mediaData = resolved.asset.data;
        mediaBase64 = Buffer.from(mediaData.buffer, mediaData.byteOffset, mediaData.byteLength).toString("base64");
        payload = {
          ...action.request,
          media: {
            filename: resolved.asset.filename,
            mimeType: resolved.asset.mimeType,
            sizeBytes: resolved.asset.sizeBytes,
            sha256: resolved.asset.sha256,
            dataBase64: mediaBase64,
          },
        };
        mediaTicket = `live:${action.id}`;
        if (!this.options.executeCommand) {
          throw new ServiceError("PROTOCOL_DRIFT", "The live media worker does not support phased commands.");
        }
        actionStore = { markSubmissionStarted: () => undefined };
      }
      evidence = await this.controller.execute(this.options.grant, {
        actionId: action.id,
        ledgerId: store.ledgerId,
        environment: this.options.deployment.environment,
        artifactDigest: this.options.deployment.artifactDigest,
        sbomDigest: this.options.deployment.sbomDigest,
        testEvidenceDigest: this.options.deployment.testEvidenceDigest,
        canaryAccountId: action.accountId,
        observedNativeIdentity: session.expectedNativeIdentity,
        sessionGeneration: session.generation,
        routeId: session.networkRouteId,
        operation,
        resourceConstraints: resources,
        executor: this.options.executor,
      }, {
        now: this.options.now?.() ?? Date.now(),
        coreActor: this.options.coreActor,
        sessionRuntime: this.options.sessionRuntime,
        actionStore,
        dispatch: action.kind === "media_post"
          ? async (command) => {
            const result = await this.dispatchMedia(command, action, store);
            mediaTicket = result.ticket;
            mediaFlowCompleted = result.completed;
            return result.message;
          }
          : this.options.dispatch,
        payload,
        leaseTtlMs: this.options.leaseTtlMs,
        crashAfterRecord: options.crashAfterRecord,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "SIMULATED_CRASH_AFTER_RECORD") throw error;
      return store.transitionAction(action.id, ["running"], stateForAuthorizationFailure(error), {
        error: safeAuthorizationError(error),
        claimToken: action.claimToken ?? undefined,
      });
    } finally {
      mediaData?.fill(0);
      mediaBase64 = "";
    }

    if (evidence.outcome === LiveOutcome.SUCCEEDED) {
      if (mediaTicket && !mediaFlowCompleted) {
        return store.transitionAction(action.id, ["running"], "UNKNOWN", {
          error: { code: "UNKNOWN_RESULT", message: "The live media phase result was incomplete.", retryable: false },
          claimToken: action.claimToken ?? undefined,
        });
      }
      const result = {
        ...(evidence.nativeId === null ? {} : { nativeId: evidence.nativeId }),
        ...(evidence.canonicalUrl === null ? {} : { canonicalUrl: evidence.canonicalUrl }),
      };
      return store.transitionAction(action.id, ["running"], "succeeded", { result, claimToken: action.claimToken ?? undefined });
    }
    if (evidence.outcome === StopReason.UNKNOWN) {
      return store.transitionAction(action.id, ["running"], "UNKNOWN", {
        error: { code: "UNKNOWN_RESULT", message: "The live worker result could not be verified.", retryable: false },
        claimToken: action.claimToken ?? undefined,
      });
    }
    const actionRequired = ([
      StopReason.CHALLENGE,
      StopReason.CHECKPOINT,
      StopReason.CAPTCHA,
      StopReason.WRONG_IDENTITY,
      StopReason.REVOKED_SESSION,
    ] as readonly string[]).includes(evidence.outcome);
    return store.transitionAction(action.id, ["running"], actionRequired ? "action_required" : "failed", {
      error: { code: evidence.outcome, message: "The bounded live worker stopped.", retryable: false },
      claimToken: action.claimToken ?? undefined,
    });
  }

  private async dispatchMedia(
    serialized: Uint8Array,
    action: InternalActionRecord,
    store: LedgerStore,
  ): Promise<{ message: Uint8Array; ticket?: string; completed: boolean }> {
    const original = decodeWorkerMessage(serialized);
    if (original.type !== "social-git.worker.command") {
      throw new ServiceError("PROTOCOL_DRIFT", "The live media worker command is invalid.");
    }
    if (original.operation !== "reddit.post.media.create") {
      return { message: mediaPhaseFailure(original, "PROTOCOL_DRIFT"), completed: false };
    }
    const root = recordValue(original.payload, "live media payload");
    const publicAction = recordValue(root.action, "live media action");
    const media = recordValue(publicAction.media, "live Core media");
    const execute = this.options.executeCommand!;
    let ticket: string | undefined;
    let flow = store.resolveMediaForAction(action).flow;

    const phase = async (operation: string, payload: Record<string, unknown>) => {
      const command = encodeWorkerMessage({ ...original, operation, payload } as WorkerCommand);
      try {
        return await execute(command);
      } finally {
        command.fill(0);
      }
    };
    const stop = (executed: RedditCommandExecution, postSubmit: boolean) => {
      if (!executed.error && executed.platformResult) return null;
      if (!postSubmit) return { message: executed.message, completed: false };
      executed.message.fill(0);
      return { message: mediaPhaseFailure(original, "UNKNOWN"), ticket, completed: false };
    };

    try {
      const leased = await phase("reddit.post.media.lease", {
        filename: media.filename,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
      });
      const leaseStop = stop(leased, false);
      if (leaseStop) return leaseStop;
      ticket = mediaPhaseTicket(leased.platformResult);
      leased.message.fill(0);
      flow = store.transitionMediaFlow(action.id, flow.phase, "leased", ticket, action.claimToken ?? undefined);

      const uploaded = await phase("reddit.post.media.upload", {
        ticket,
        dataBase64: media.dataBase64,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
      });
      const uploadStop = stop(uploaded, false);
      if (uploadStop) return { ...uploadStop, ticket };
      requireMediaPhaseTicket(uploaded.platformResult, ticket);
      uploaded.message.fill(0);
      flow = store.transitionMediaFlow(action.id, flow.phase, "uploaded", ticket, action.claimToken ?? undefined);

      flow = store.beginMediaSubmission(action.id, ticket, action.claimToken ?? undefined);
      const submitted = await phase("reddit.post.media.submit", {
        ticket,
        subreddit: publicAction.subreddit,
        title: publicAction.title,
      });
      const submitStop = stop(submitted, true);
      if (submitStop) return submitStop;
      requireMediaPhaseTicket(submitted.platformResult, ticket);
      submitted.message.fill(0);
      flow = store.transitionMediaFlow(action.id, flow.phase, "submitted", ticket, action.claimToken ?? undefined);

      const processed = await phase("reddit.post.media.process", { ticket });
      const processStop = stop(processed, true);
      if (processStop) return processStop;
      if (!processed.platformResult?.native?.nativeId || !processed.platformResult.native.canonicalUrl) {
        processed.message.fill(0);
        return { message: mediaPhaseFailure(original, "UNKNOWN"), ticket, completed: false };
      }
      store.transitionMediaFlow(action.id, flow.phase, "processed", ticket, action.claimToken ?? undefined);
      return { message: processed.message, ticket, completed: true };
    } catch {
      return {
        message: mediaPhaseFailure(original, store.getActionInternal(action.id).submissionMayHaveStarted ? "UNKNOWN" : "PROTOCOL_DRIFT"),
        ticket,
        completed: false,
      };
    }
  }
}

function mediaPhaseTicket(result: RedditProductionResult | undefined): string {
  const ticket = result && typeof result.data === "object" && result.data !== null
    ? (result.data as Record<string, unknown>).ticket
    : undefined;
  if (typeof ticket !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(ticket)) {
    throw new ServiceError("PROTOCOL_DRIFT", "The live media worker returned an invalid ticket.");
  }
  return ticket;
}

function requireMediaPhaseTicket(result: RedditProductionResult | undefined, expected: string) {
  if (mediaPhaseTicket(result) !== expected) {
    throw new ServiceError("PROTOCOL_DRIFT", "The live media worker changed its ticket.");
  }
}

function mediaPhaseFailure(command: WorkerCommand, status: "PROTOCOL_DRIFT" | "UNKNOWN") {
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
    observedNativeIdentity: command.expectedNativeIdentity,
  });
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("PROTOCOL_DRIFT", `The ${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function operationFor(action: InternalActionRecord): string {
  const operation = WRITE_OPERATIONS[action.kind];
  if (!operation) throw new ServiceError("PROTOCOL_DRIFT", "The persisted action kind has no exact live operation mapping.");
  return operation;
}

function validateActionAgainstGrant(
  action: InternalActionRecord,
  constraints: readonly (readonly [string, string])[],
): Record<string, string> {
  const request = action.request;
  const actual = Object.fromEntries(constraints);
  for (const [name, bound] of constraints) {
    switch (name) {
      case "subreddit": requireExact(request.subreddit, bound, name); break;
      case "post_id": requireExact(request.postId, bound, name); break;
      case "comment_id": requireExact(request.commentId, bound, name); break;
      case "target_id": requireExact(request.targetId, bound, name); break;
      case "media_ref": requireExact(request.mediaRef, bound, name); break;
      case "max_body_bytes": requireMaximumBytes(request.text, bound, name); break;
      case "max_title_bytes": requireMaximumBytes(request.title, bound, name); break;
      default: throw new ServiceError("FORBIDDEN", `The live grant has an unsupported resource constraint: ${name}.`);
    }
  }
  return actual;
}

function requireExact(value: unknown, expected: string, name: string) {
  if (value !== expected) throw new ServiceError("FORBIDDEN", `The persisted action does not satisfy ${name}.`);
}

function requireMaximumBytes(value: unknown, bound: string, name: string) {
  if (!/^[1-9][0-9]{0,8}$/.test(bound) || typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > Number(bound)) {
    throw new ServiceError("FORBIDDEN", `The persisted action does not satisfy ${name}.`);
  }
}

function stateForAuthorizationFailure(error: unknown): "failed" | "action_required" | "UNKNOWN" {
  const code = (error as { code?: string })?.code;
  if (code === AuthorizationErrorCode.STOPPED) return "action_required";
  if (code === "UNKNOWN_RESULT") return "UNKNOWN";
  return "failed";
}

function safeAuthorizationError(error: unknown) {
  if (error instanceof AuthorizationError) {
    return { code: error.code, message: "The bounded live authorization denied the action.", retryable: false };
  }
  if (error instanceof ServiceError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "INTERNAL", message: "The bounded live action failed before a verified result.", retryable: false };
}
