import type { SessionRuntime } from "@social-git/core";
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

const WRITE_OPERATIONS: Readonly<Record<string, string>> = Object.freeze({
  text_post: "reddit.post.text.create",
  link_post: "reddit.post.link.create",
  media_post: "reddit.post.media.create",
  comment: "reddit.comment.create",
  reply: "reddit.comment.reply",
  vote: "reddit.vote.set",
  save: "reddit.item.save",
  unsave: "reddit.item.unsave",
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
    now?: () => number;
    leaseTtlMs?: number;
  }) {
    this.options = options;
    this.controller = new LiveTestController(options.ledger);
  }

  recoverInterrupted(store: LedgerStore): number {
    return store.recoverLiveAuthorizationUnknown(this.options.ledger.recoveredUnknownActionIds);
  }

  async execute(
    action: InternalActionRecord,
    store: LedgerStore,
    options: { crashAfterRecord?: boolean } = {},
  ): Promise<ActionRecord> {
    let evidence: LiveEvidence;
    try {
      const operation = operationFor(action);
      const resources = validateActionAgainstGrant(action, this.options.grant.resourceConstraints);
      const session = this.options.sessionRuntime.getAccountState(action.accountId);
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
        actionStore: store,
        dispatch: this.options.dispatch,
        payload: action.request,
        leaseTtlMs: this.options.leaseTtlMs,
        crashAfterRecord: options.crashAfterRecord,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "SIMULATED_CRASH_AFTER_RECORD") throw error;
      return store.transitionAction(action.id, ["running"], stateForAuthorizationFailure(error), {
        error: safeAuthorizationError(error),
      });
    }

    if (evidence.outcome === LiveOutcome.SUCCEEDED) {
      const result = {
        ...(evidence.nativeId === null ? {} : { nativeId: evidence.nativeId }),
        ...(evidence.canonicalUrl === null ? {} : { canonicalUrl: evidence.canonicalUrl }),
      };
      return store.transitionAction(action.id, ["running"], "succeeded", { result });
    }
    if (evidence.outcome === StopReason.UNKNOWN) {
      return store.transitionAction(action.id, ["running"], "UNKNOWN", {
        error: { code: "UNKNOWN_RESULT", message: "The live worker result could not be verified.", retryable: false },
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
    });
  }
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
