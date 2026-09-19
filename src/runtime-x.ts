import { createHash, randomInt, randomUUID } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import {
  X_TRANSPORT_ADMISSION,
  XContractError,
  X_MAX_HOME_HTML_BYTES,
  XSessionTransport,
  X_WEB_CLIENT_TOKEN,
  buildXTransactionState,
  createXSessionConnector,
  createXPublicAssetConnector,
  discoverXTransactionAsset,
  generateXClientTransactionId,
} from "@social-git/x-adapter";
import {
  SessionRuntime,
  decodeWorkerMessage,
  encodeWorkerMessage,
  type WorkerCommand,
  type WorkerResultStatus,
} from "@social-git/core";
import { createPinnedXHttpsConnector, createXRouteAuthority } from "@social-git/worker-security";
import type { AccountRecord } from "./persistence.ts";
import { X_COMMAND_MAC_CONTEXT, XCommandMacSigner, XCommandMacVerifier } from "./x-ipc-auth.ts";

export interface XCandidateBinding {
  tenantId: string;
  accountId: string;
  routeId: string;
  generation: number;
}

export interface XWireRequest {
  method: "GET" | "POST";
  url: string;
  body: Uint8Array | null;
  headers: Readonly<Record<string, string>>;
  selectedAddress: string;
  serverName: string;
  redirectMode: "manual";
  deadlineEpochMs: number;
  signal: AbortSignal;
}

export interface XAdmissionDecision {
  readonly requested: boolean;
  readonly enabled: boolean;
  readonly productionEnabled: boolean;
  readonly disabledReasons: readonly string[];
  readonly certification?: Readonly<{ grantFingerprint: string; sourceCommit: string; deploymentId: string; evidenceKeyFingerprint: string }>;
}

export interface XProductionResult {
  readonly data: Readonly<Record<string, unknown>>;
  readonly native: Readonly<{ nativeId: string; canonicalUrl?: string }> | null;
  readonly rateLimit?: Readonly<Record<string, number | string>>;
}

export const X_WORKER_FAIL_CLOSED_MESSAGE = "The X worker failed closed.";
export const X_WORKER_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  ACCESS_DENIED: "ACCESS_DENIED",
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  CHALLENGE_REQUIRED: "CHALLENGE_REQUIRED",
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_CALLER_OWNED: "NOT_CALLER_OWNED",
  POLICY_DENIED: "POLICY_DENIED",
  PROTOCOL_DRIFT: "PROTOCOL_DRIFT",
  RATE_LIMITED: "RATE_LIMITED",
  SESSION_REVOKED: "SESSION_REVOKED",
  UNKNOWN: "UNKNOWN",
  WORKER_UNAVAILABLE: "WORKER_UNAVAILABLE",
  WRONG_IDENTITY: "WRONG_IDENTITY",
  X_TRANSPORT_NOT_ADMITTED: "X_TRANSPORT_NOT_ADMITTED",
});
const X_WORKER_ERROR_CODE_SET = new Set(Object.values(X_WORKER_ERROR_CODES));
const X_RATE_LIMIT_KEYS = new Set(["limit", "remaining", "resetAt", "retryAfterSeconds"]);

export function sanitizeXWorkerFailure(error: {
  code: string;
  retryable?: boolean;
  actionRequired?: boolean;
  submissionMayHaveStarted?: boolean;
  rateLimit?: unknown;
}): { code: string; message: string; retryable: boolean; actionRequired: boolean; submissionMayHaveStarted: boolean; rateLimit?: Readonly<Record<string, number | string>> } {
  const code = X_WORKER_ERROR_CODE_SET.has(error.code) ? error.code : X_WORKER_ERROR_CODES.PROTOCOL_DRIFT!;
  // Never forward worker/upstream messages across the custody boundary, even
  // for an allowlisted code. Only the fixed fail-closed message crosses.
  return {
    code,
    message: X_WORKER_FAIL_CLOSED_MESSAGE,
    retryable: error.retryable === true,
    actionRequired: error.actionRequired === true,
    submissionMayHaveStarted: error.submissionMayHaveStarted === true,
    ...(error.rateLimit === undefined ? {} : { rateLimit: sanitizeXRateLimit(error.rateLimit) }),
  };
}

function sanitizeXRateLimit(value: unknown): Readonly<Record<string, number | string>> | undefined {
  const rate = optionalRateLimit(value);
  return rate;
}

export class XRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly actionRequired: boolean;
  readonly submissionMayHaveStarted: boolean;
  readonly rateLimit?: Readonly<Record<string, number | string>>;
  readonly observedNativeIdentity?: string;

  constructor(code: string, message: string, options: {
    retryable?: boolean;
    actionRequired?: boolean;
    submissionMayHaveStarted?: boolean;
    rateLimit?: Readonly<Record<string, number | string>>;
    observedNativeIdentity?: string;
  } = {}) {
    super(message);
    this.name = "XRuntimeError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.actionRequired = options.actionRequired === true;
    this.submissionMayHaveStarted = options.submissionMayHaveStarted === true;
    this.rateLimit = options.rateLimit;
    this.observedNativeIdentity = options.observedNativeIdentity;
  }
}

/**
 * An operator flag can only request X. It cannot admit X: every committed gate
 * and the committed productionEnabled decision must already be true.
 */
export function evaluateCommittedXRuntimeAdmission(requested: boolean): XAdmissionDecision {
  const committed = Boolean(X_TRANSPORT_ADMISSION.productionEnabled)
    && Object.values(X_TRANSPORT_ADMISSION.gates).every((passed) => passed === true)
    && X_TRANSPORT_ADMISSION.disabledReasons.length === 0;
  return Object.freeze({
    requested: requested === true,
    enabled: requested === true && committed,
    productionEnabled: committed,
    disabledReasons: X_TRANSPORT_ADMISSION.disabledReasons,
  });
}

/**
 * Build the isolated candidate transport from already-decrypted Core command
 * material. The caller owns and zeroes sessionBytes. No default resolver or
 * connector is provided, preventing this helper from making an accidental
 * live call outside the admitted worker composition.
 */
export async function bootstrapXCandidateTransport(input: {
  binding: XCandidateBinding;
  expectedNativeIdentity: string;
  sessionBytes: Uint8Array;
  routeBytes: Uint8Array;
  resolver: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
  wireConnector: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
  now?: () => number;
  randomByte?: () => number;
}) {
  const now = input.now ?? Date.now;
  const randomByte = input.randomByte ?? (() => randomInt(0, 256));
  const session = parseXSession(input.sessionBytes);
  const route = parseDirectRoute(input.routeBytes);
  void route;
  const bootstrapConnector = createXSessionConnector({ ...session, profile: "home", wireConnector: input.wireConnector });
  const assetConnector = createXPublicAssetConnector({ wireConnector: input.wireConnector });
  const bootstrapAuthority = createXRouteAuthority({
    route: input.binding,
    connectors: { web: bootstrapConnector, api: bootstrapConnector, upload: bootstrapConnector, asset: assetConnector },
    resolver: input.resolver,
    maxResponseBytes: 1024 * 1024,
    now,
  });
  const bootstrapLease = bootstrapAuthority.issueLease(input.binding);
  const home = await bootstrapAuthority.request(bootstrapLease, { target: "web", method: "GET", path: "/home", body: null, contentType: null, deadlineEpochMs: now() + 10_000 });
  const homeHtml = decodeText(home.body, X_MAX_HOME_HTML_BYTES, "X home HTML");
  const assetDescriptor = discoverXTransactionAsset(homeHtml);
  const asset = await bootstrapAuthority.request(bootstrapLease, { target: "asset", method: "GET", path: assetDescriptor.path, body: null, contentType: null, deadlineEpochMs: now() + 10_000 });
  const assetText = decodeText(asset.body, 1024 * 1024, "X ondemand asset");
  let state: ReturnType<typeof buildXTransactionState>;
  try { state = buildXTransactionState(homeHtml, assetText); }
  finally { /* immutable strings are scoped to this worker call and never returned */ }

  const connector = createXSessionConnector({
    ...session,
    transactionIdFor(method: string, path: string) {
      return generateXClientTransactionId(state, {
        method,
        path,
        nowSeconds: Math.floor(now() / 1000),
        randomByte: randomByte(),
      });
    },
    wireConnector: input.wireConnector,
  });
  const authority = createXRouteAuthority({
    route: input.binding,
    connectors: { web: connector, api: connector, upload: connector, asset: assetConnector },
    resolver: input.resolver,
    maxResponseBytes: 1024 * 1024,
    now,
  });
  return new XSessionTransport({
    routeAuthority: authority,
    binding: input.binding,
    expectedNativeIdentity: input.expectedNativeIdentity,
    now,
  });
}

interface XMediaTicket {
  readonly ticket: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly generation: number;
  readonly routeId: string;
  readonly mediaId: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  phase: "initialized" | "uploaded" | "submitting";
  expiresAt: number;
}

export interface XCommandExecution {
  readonly message: Uint8Array;
  readonly platformResult?: XProductionResult;
  readonly error?: XRuntimeError;
}

export interface XCommandDispatcher {
  ready(): Promise<boolean>;
  execute(serialized: Uint8Array): Promise<XCommandExecution>;
  close?(): void;
}

interface XWorkerTransport {
  verifyIdentity(): Promise<any>;
  execute(operation: string, input: Record<string, unknown>, options?: { previousCursor?: string | null }): Promise<any>;
  executeMediaPhase(phase: "init" | "append" | "finalize" | "submit", input: Record<string, unknown>): Promise<any>;
}

type BootstrapTransport = (input: Parameters<typeof bootstrapXCandidateTransport>[0]) => Promise<XWorkerTransport>;

/** Isolated worker-side executor. It has no database or durable secret access. */
export class ProductionXCommandDispatcher {
  private readonly admission: XAdmissionDecision;
  private readonly resolver: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
  private readonly wireConnector: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
  private readonly bootstrap: BootstrapTransport;
  private readonly now: () => number;
  private readonly mediaTickets = new Map<string, XMediaTicket>();

  constructor(options: {
    admission: XAdmissionDecision;
    resolver?: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
    wireConnector?: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
    bootstrap?: BootstrapTransport;
    now?: () => number;
  }) {
    this.admission = options.admission;
    this.resolver = options.resolver ?? resolvePublicAddresses;
    this.wireConnector = options.wireConnector ?? createPinnedXHttpsConnector({ publicBearerToken: X_WEB_CLIENT_TOKEN });
    this.bootstrap = options.bootstrap ?? bootstrapXCandidateTransport;
    this.now = options.now ?? Date.now;
  }

  async ready() { return this.admission.enabled; }

  async execute(serialized: Uint8Array): Promise<XCommandExecution> {
    if (!this.admission.enabled) {
      throw new XRuntimeError("X_TRANSPORT_NOT_ADMITTED", "The X production transport has not passed committed admission.", { actionRequired: true });
    }
    const command = decodeWorkerMessage(serialized);
    if (command.type !== "social-git.worker.command") {
      throw new XRuntimeError("PROTOCOL_DRIFT", "A bound X worker command is required.");
    }
    let sessionBytes: Buffer | undefined;
    let routeBytes: Buffer | undefined;
    try {
      // Decode into wipeable bytes and immediately drop the immutable secret
      // strings before any policy/expiry rejection can retain them until GC.
      sessionBytes = Buffer.from(command.sessionBase64, "base64url");
      routeBytes = Buffer.from(command.networkRoute.materialBase64, "base64url");
      command.sessionBase64 = "REDACTED";
      command.networkRoute.materialBase64 = "REDACTED";
      if (command.platform !== "x") {
        throw new XRuntimeError("PROTOCOL_DRIFT", "A bound X worker command is required.");
      }
      if (command.expiresAt <= this.now()) {
        throw new XRuntimeError("WORKER_UNAVAILABLE", "The X worker command expired before dispatch.", { retryable: command.intent !== "write" });
      }
      assertXIntentOperation(command.intent, command.operation);
      try {
        const transport = await this.bootstrap({
          binding: {
            tenantId: command.tenantId,
            accountId: command.accountId,
            routeId: command.networkRoute.id,
            generation: command.generation,
          },
          expectedNativeIdentity: command.expectedNativeIdentity,
          sessionBytes,
          routeBytes,
          resolver: this.resolver,
          wireConnector: this.wireConnector,
          now: this.now,
        });
        const result = await this.executeOperation(command, transport);
        return {
          message: xWorkerResult(command, "SUCCEEDED", command.expectedNativeIdentity, result.native ?? undefined),
          platformResult: result,
        };
      } catch (error) {
        const failure = normalizeXRuntimeError(error, command.intent === "write");
        return {
          message: xWorkerResult(command, xWorkerStatus(failure), failure.observedNativeIdentity ?? command.expectedNativeIdentity),
          error: failure,
        };
      }
    } finally {
      sessionBytes?.fill(0);
      routeBytes?.fill(0);
      command.sessionBase64 = "REDACTED";
      command.networkRoute.materialBase64 = "REDACTED";
      this.expireMediaTickets();
    }
  }

  private async executeOperation(command: WorkerCommand, transport: XWorkerTransport): Promise<XProductionResult> {
    const input = plainPayload(command.payload);
    if (command.operation === "post.media.init") return this.initializeMedia(command, transport, input);
    if (command.operation === "post.media.append") return this.appendMedia(command, transport, input);
    if (command.operation === "post.media.submit") return this.submitMedia(command, transport, input);

    if (command.operation === "post.delete") {
      const existing = await transport.execute("post.get", { postId: input.postId });
      const entity = record(existing.entity, "X post ownership response");
      if (nativeId(entity.nativeId, "X fetched post ID") !== nativeId(input.postId, "X requested post ID")) {
        throw new XContractError("PROTOCOL_DRIFT", "The X ownership preflight returned a different post.");
      }
      if (entity.authorNativeId !== command.expectedNativeIdentity) {
        throw new XContractError("NOT_CALLER_OWNED", "The authenticated X account does not own the post.");
      }
    }

    const operationInput = command.operation === "message.send" && input.recipientNativeId !== undefined
      ? { conversationId: participantConversationId(command.expectedNativeIdentity, input.recipientNativeId), text: input.text }
      : input;
    const value = command.operation === "account.identity"
      ? await transport.verifyIdentity()
      : await transport.execute(command.operation, operationInput, { previousCursor: optionalCursor(input.cursor) });
    return productionResult(value);
  }

  private async initializeMedia(command: WorkerCommand, transport: XWorkerTransport, input: Record<string, unknown>): Promise<XProductionResult> {
    const metadata = xMediaMetadata(input);
    const initialized = record(await transport.executeMediaPhase("init", {
      sizeBytes: metadata.sizeBytes,
      mimeType: metadata.mimeType,
    }), "X media initialization");
    const mediaId = nativeId(initialized.mediaId, "X media ID");
    const ticket = randomUUID();
    this.mediaTickets.set(ticket, {
      ticket,
      tenantId: command.tenantId,
      accountId: command.accountId,
      generation: command.generation,
      routeId: command.networkRoute.id,
      mediaId,
      mimeType: metadata.mimeType,
      sizeBytes: metadata.sizeBytes,
      sha256: metadata.sha256,
      phase: "initialized",
      expiresAt: this.now() + 5 * 60_000,
    });
    return resultData({ ticket, phase: "initialized" }, initialized.rateLimit);
  }

  private async appendMedia(command: WorkerCommand, transport: XWorkerTransport, input: Record<string, unknown>): Promise<XProductionResult> {
    const ticket = this.boundMediaTicket(command, input.ticket, "initialized");
    const data = canonicalMediaBytes(input.dataBase64, ticket);
    try {
      const appended = record(await transport.executeMediaPhase("append", { mediaId: ticket.mediaId, data }), "X media append");
      ticket.phase = "uploaded";
      ticket.expiresAt = this.now() + 5 * 60_000;
      return resultData({ ticket: ticket.ticket, phase: "uploaded" }, appended.rateLimit);
    } finally {
      data.fill(0);
    }
  }

  private async submitMedia(command: WorkerCommand, transport: XWorkerTransport, input: Record<string, unknown>): Promise<XProductionResult> {
    const ticket = this.boundMediaTicket(command, input.ticket, "uploaded");
    ticket.phase = "submitting";
    // A ticket is single-use once finalization might start. Removing it before
    // network submission makes an HTTP replay fail closed instead of posting twice.
    this.mediaTickets.delete(ticket.ticket);
    await transport.executeMediaPhase("finalize", { mediaId: ticket.mediaId });
    const submitted = await transport.executeMediaPhase("submit", {
      mediaId: ticket.mediaId,
      text: boundedText(input.text ?? "", "X media post text", 280, true),
    });
    return productionResult(submitted);
  }

  private boundMediaTicket(command: WorkerCommand, value: unknown, phase: XMediaTicket["phase"]) {
    const id = boundedText(value, "X media ticket", 128);
    const ticket = this.mediaTickets.get(id);
    if (!ticket || ticket.expiresAt <= this.now() || ticket.tenantId !== command.tenantId || ticket.accountId !== command.accountId
      || ticket.generation !== command.generation || ticket.routeId !== command.networkRoute.id || ticket.phase !== phase) {
      if (ticket) this.mediaTickets.delete(id);
      throw new XContractError("PROTOCOL_DRIFT", "The X media ticket is expired, reused, or wrongly bound.");
    }
    return ticket;
  }

  private expireMediaTickets() {
    for (const [id, ticket] of this.mediaTickets) if (ticket.expiresAt <= this.now()) this.mediaTickets.delete(id);
  }
}

/** Core-side HTTP dispatcher for the private command network. */
export class RemoteXCommandDispatcher implements XCommandDispatcher {
  private readonly url: string;
  private readonly readinessUrl: string;
  private readonly signer: XCommandMacSigner;
  private readonly verifier: XCommandMacVerifier;
  private readonly expectedCertificationIdentity?: XAdmissionDecision["certification"];

  constructor(url: string, commandKey: Uint8Array, options: { now?: () => number; nonce?: () => Buffer; expectedCertificationIdentity?: NonNullable<XAdmissionDecision["certification"]> } = {}) {
    this.url = url;
    this.readinessUrl = new URL("/readyz", url).toString();
    this.signer = new XCommandMacSigner(commandKey, options);
    this.verifier = new XCommandMacVerifier(commandKey, options);
    this.expectedCertificationIdentity = options.expectedCertificationIdentity;
  }

  async ready(): Promise<boolean> {
    let bytes: Buffer | undefined;
    const empty = Buffer.alloc(0);
    try {
      const requestHeaders = this.signer.headers(empty, X_COMMAND_MAC_CONTEXT.readinessRequest);
      const requestNonce = requestHeaders["x-social-git-command-nonce"];
      const response = await fetch(this.readinessUrl, { method: "GET", headers: { ...requestHeaders }, redirect: "error", signal: AbortSignal.timeout(2_000) });
      bytes = await boundedFetchBody(response, 16 * 1024);
      if (response.status !== 200 || !this.verifier.verify(Object.fromEntries(response.headers), bytes, X_COMMAND_MAC_CONTEXT.response(response.status))) return false;
      const body = record(JSON.parse(bytes.toString("utf8")), "X worker readiness");
      exactOptional(body, ["version", "role", "status", "inFlight", "admission", "requestNonce"], []);
      const admission = record(body.admission, "X worker readiness admission");
      const certificationMatches = this.expectedCertificationIdentity === undefined
        ? admission.certification === undefined
        : canonicalIdentity(admission.certification) === canonicalIdentity(this.expectedCertificationIdentity);
      return body.version === 1 && body.role === "x-worker" && body.status === "ready" && admission.enabled === true && body.requestNonce === requestNonce && certificationMatches;
    } catch { return false; }
    finally { empty.fill(0); bytes?.fill(0); }
  }

  async execute(serialized: Uint8Array): Promise<XCommandExecution> {
    let write = true;
    try {
      const command = decodeWorkerMessage(serialized);
      write = command.type === "social-git.worker.command" && command.intent === "write";
    } catch {
      throw new XRuntimeError("PROTOCOL_DRIFT", "The X worker command failed validation.");
    }
    let response: Response;
    const requestBody = Buffer.from(serialized);
    const requestHeaders = this.signer.headers(requestBody, X_COMMAND_MAC_CONTEXT.dispatchRequest);
    const requestNonce = requestHeaders["x-social-git-command-nonce"];
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...requestHeaders },
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new XRuntimeError("WORKER_UNAVAILABLE", "The X worker was unavailable.", {
        retryable: !write,
        submissionMayHaveStarted: write,
      });
    } finally { requestBody.fill(0); }

    const bytes = await boundedFetchBody(response, 1024 * 1024).catch(() => Buffer.alloc(0));
    try {
      const authenticated = bytes.length > 0 && this.verifier.verify(Object.fromEntries(response.headers), bytes, X_COMMAND_MAC_CONTEXT.response(response.status));
      if (response.status !== 200 || bytes.length < 1) {
        let provenPreSubmit = false;
        if (response.status === 503 && authenticated) {
          const rejection = record(JSON.parse(bytes.toString("utf8")), "X worker rejection");
          exactOptional(rejection, ["version", "code", "requestNonce"], []);
          provenPreSubmit = rejection.version === 1 && rejection.code === "WORKER_STOPPING" && rejection.requestNonce === requestNonce;
        }
        throw new XRuntimeError(provenPreSubmit ? "X_TRANSPORT_NOT_ADMITTED" : "PROTOCOL_DRIFT", "The X worker rejected the command.", { actionRequired: provenPreSubmit, submissionMayHaveStarted: write && !provenPreSubmit });
      }
      if (!authenticated) {
        throw new XRuntimeError("PROTOCOL_DRIFT", "The X worker response was not authenticated.", { submissionMayHaveStarted: write });
      }
      const envelope = record(JSON.parse(bytes.toString("utf8")), "X worker response");
      exactOptional(envelope, ["version", "requestNonce", "messageBase64"], ["platformResult", "failure"]);
      if (envelope.version !== 1 || envelope.requestNonce !== requestNonce || typeof envelope.messageBase64 !== "string" || !/^[A-Za-z0-9_-]+$/u.test(envelope.messageBase64)) throw new TypeError("invalid X worker envelope");
      const message = Buffer.from(envelope.messageBase64, "base64url");
      if (message.toString("base64url") !== envelope.messageBase64) throw new TypeError("non-canonical X worker message");
      const result = decodeWorkerMessage(message);
      if (result.type !== "social-git.worker.result") throw new TypeError("X worker returned a command");
      if (envelope.failure !== undefined) {
        if (envelope.platformResult !== undefined || result.status === "SUCCEEDED") throw new TypeError("X worker failure conflicts with result");
        return { message, error: remoteFailure(envelope.failure, result.status === "UNKNOWN") };
      }
      if (result.status !== "SUCCEEDED" || envelope.platformResult === undefined) throw new TypeError("X worker success is incomplete");
      return { message, platformResult: validateRemoteXResult(envelope.platformResult) };
    } catch (error) {
      if (error instanceof XRuntimeError) throw error;
      throw new XRuntimeError("PROTOCOL_DRIFT", "The X worker response failed validation.", { submissionMayHaveStarted: write });
    } finally { bytes.fill(0); }
  }

  close() { this.signer.close(); this.verifier.close(); }
}

function canonicalIdentity(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const source = value as Record<string, unknown>;
  const keys = ["deploymentId", "evidenceKeyFingerprint", "grantFingerprint", "sourceCommit"];
  if (Object.keys(source).sort().join(",") !== [...keys].sort().join(",") || keys.some((key) => typeof source[key] !== "string")) return "";
  return keys.map((key) => `${key}=${source[key]}`).join("\n");
}

/** Core owns encrypted auth_token/ct0 custody and creates one fenced command per call. */
export class CoreXTransportProvider {
  private readonly runtime: SessionRuntime;
  private readonly dispatcher: XCommandDispatcher;

  constructor(options: { runtime: SessionRuntime; dispatcher: XCommandDispatcher }) {
    this.runtime = options.runtime;
    this.dispatcher = options.dispatcher;
  }

  nextConnectionGeneration(account: AccountRecord) {
    try {
      const state = this.runtime.getAccountState(account.id);
      return Math.max(state.generation, state.revokedThroughGeneration) + 1;
    } catch (error) {
      if ((error as { code?: string })?.code === "NOT_FOUND") return 1;
      throw error;
    }
  }

  importDirectConnection(input: { account: AccountRecord; generation: number; session: Uint8Array; networkRoute: { id: string; material: Uint8Array } }) {
    this.runtime.importExternalSession({
      accountId: input.account.id,
      platform: input.account.platform,
      expectedNativeIdentity: input.account.expectedNativeUserId,
      generation: input.generation,
      session: input.session,
      networkRoute: input.networkRoute,
    });
  }

  async execute(input: {
    account: AccountRecord;
    intent: "identity_validation" | "read" | "write";
    operation: string;
    payload: Record<string, unknown>;
    requestId?: string;
    certification?: { proofDigest: string; proofRequest: Record<string, unknown>; expiresAt: string; qaExecutionSignature: string };
  }): Promise<XProductionResult> {
    const state = this.runtime.getAccountState(input.account.id);
    const command = this.runtime.acquireWorkerCommand({
      accountId: input.account.id,
      generation: state.generation,
      requestId: input.requestId ?? `x-adapter-${randomUUID()}`,
      intent: input.intent,
      operation: input.operation,
      payload: input.certification ? {
        certification: { schema: "social-git.x-certification-command/v1", ...input.certification },
        operationPayload: input.payload,
      } : input.payload,
    });
    const decoded = decodeWorkerMessage(command);
    if (decoded.type !== "social-git.worker.command") {
      command.fill(0);
      throw new XRuntimeError("PROTOCOL_DRIFT", "Core produced an invalid X worker command.");
    }
    let executed: XCommandExecution;
    try {
      executed = await this.dispatcher.execute(command);
    } catch (error) {
      const failure = normalizeXRuntimeError(error, input.intent === "write");
      const terminal = xWorkerResult(decoded, failure.submissionMayHaveStarted ? "UNKNOWN" : xWorkerStatus(failure), input.account.expectedNativeUserId);
      try {
        this.runtime.completeWorkerResult({ accountId: input.account.id, generation: state.generation, message: terminal });
      } finally {
        terminal.fill(0);
        command.fill(0);
        decoded.sessionBase64 = "REDACTED";
        decoded.networkRoute.materialBase64 = "REDACTED";
      }
      throw failure;
    }
    try {
      this.runtime.completeWorkerResult({ accountId: input.account.id, generation: state.generation, message: executed.message });
    } catch (error) {
      // Once a write was dispatched, an unauthenticated/misbinding response can
      // never downgrade uncertainty to a retryable or failed outcome. Complete
      // the still-bound lease with Core's own terminal result when possible.
      const terminal = xWorkerResult(decoded, input.intent === "write" ? "UNKNOWN" : "PROTOCOL_DRIFT", input.account.expectedNativeUserId);
      try {
        this.runtime.completeWorkerResult({ accountId: input.account.id, generation: state.generation, message: terminal });
      } catch { /* a concurrently fenced lease is already terminal and cannot be reused */ }
      finally { terminal.fill(0); }
      throw new XRuntimeError(input.intent === "write" ? "UNKNOWN" : "PROTOCOL_DRIFT", input.intent === "write" ? "The X write result is unverified." : "The X worker result binding was rejected.", {
        submissionMayHaveStarted: input.intent === "write",
      });
    } finally {
      command.fill(0);
      executed.message.fill(0);
      decoded.sessionBase64 = "REDACTED";
      decoded.networkRoute.materialBase64 = "REDACTED";
    }
    if (executed.error) throw executed.error;
    if (!executed.platformResult) throw new XRuntimeError("PROTOCOL_DRIFT", "The X worker returned no platform result.");
    return executed.platformResult;
  }

  revoke(account: AccountRecord) {
    try {
      const state = this.runtime.getAccountState(account.id);
      if (state.health !== "revoked") this.runtime.revokeAccount({ accountId: account.id, generation: state.generation });
    } catch (error) {
      if (!new Set(["NOT_FOUND", "REVOKED"]).has(String((error as { code?: string })?.code))) throw error;
    }
  }

  close() { this.dispatcher.close?.(); }
}

function productionResult(value: unknown): XProductionResult {
  const source = record(value, "X platform result");
  const rateLimit = optionalRateLimit(source.rateLimit);
  const data = structuredClone(source) as Record<string, unknown>;
  delete data.rateLimit;
  let native: XProductionResult["native"] = null;
  if (source.nativeId !== undefined) {
    const nativeIdValue = nativeId(source.nativeId, "X native result");
    const canonicalUrl = source.canonicalUrl === undefined ? undefined : xCanonicalUrl(source.canonicalUrl);
    native = Object.freeze({ nativeId: nativeIdValue, ...(canonicalUrl ? { canonicalUrl } : {}) });
  }
  assertSecretFreeDto(data);
  return Object.freeze({ data: Object.freeze(data), native, ...(rateLimit ? { rateLimit } : {}) });
}

function resultData(data: Record<string, unknown>, rateLimit: unknown): XProductionResult {
  assertSecretFreeDto(data);
  const normalizedRate = optionalRateLimit(rateLimit);
  return Object.freeze({ data: Object.freeze(structuredClone(data)), native: null, ...(normalizedRate ? { rateLimit: normalizedRate } : {}) });
}

function xWorkerResult(command: WorkerCommand, status: WorkerResultStatus, observed: string, native?: { nativeId: string; canonicalUrl?: string }) {
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
    ...(native?.nativeId ? { nativeId: native.nativeId } : {}),
    ...(native?.canonicalUrl ? { canonicalUrl: native.canonicalUrl } : {}),
  });
}

function normalizeXRuntimeError(error: unknown, write: boolean): XRuntimeError {
  if (error instanceof XRuntimeError) return error;
  if (error instanceof XContractError) {
    const actionRequired = new Set(["CHALLENGE_REQUIRED", "SESSION_REVOKED", "WRONG_IDENTITY"]).has(error.code);
    return new XRuntimeError(error.code, error.message, {
      retryable: error.retryable === true && !error.submissionMayHaveStarted,
      actionRequired,
      submissionMayHaveStarted: error.submissionMayHaveStarted === true || error.code === "UNKNOWN",
      ...(error.rateLimit ? { rateLimit: optionalRateLimit(error.rateLimit) } : {}),
      ...(error.observedNativeIdentity ? { observedNativeIdentity: nativeId(error.observedNativeIdentity, "X observed identity") } : {}),
    });
  }
  return new XRuntimeError(write ? "UNKNOWN" : "PROTOCOL_DRIFT", write ? "The X write result is unverified." : "The X worker rejected an invalid result.", {
    submissionMayHaveStarted: write,
  });
}

const X_READ_OPERATIONS = new Set([
  "account.identity", "profile.get", "post.get", "thread.get", "timeline.home", "timeline.user",
  "search.query", "notifications.list", "conversations.list", "bookmarks.list", "followers.list",
  "following.list", "lists.lookup", "lists.memberships", "lists.members", "lists.timeline",
]);
const X_WRITE_OPERATIONS = new Set([
  "post.create", "post.reply", "post.delete", "post.like.set", "post.repost.set", "profile.follow.set",
  "bookmark.set", "message.send", "post.media.init", "post.media.append", "post.media.submit",
]);

function assertXIntentOperation(intent: WorkerCommand["intent"], operation: string) {
  const admitted = intent === "identity_validation"
    ? operation === "account.identity"
    : intent === "read"
      ? X_READ_OPERATIONS.has(operation)
      : intent === "write" && X_WRITE_OPERATIONS.has(operation);
  if (!admitted) throw new XRuntimeError("POLICY_DENIED", "The X operation is not admitted for this command intent.");
}

function xWorkerStatus(error: XRuntimeError): WorkerResultStatus {
  if (error.code === "RATE_LIMITED") return "RATE_LIMITED";
  if (error.code === "SESSION_REVOKED") return "REVOKED";
  if (error.code === "CHALLENGE_REQUIRED") return "CHALLENGE";
  if (error.code === "WRONG_IDENTITY") return "AUTH_FAILURE";
  if (error.code === "NOT_CALLER_OWNED" || error.code === "ACCESS_DENIED" || error.code === "X_TRANSPORT_NOT_ADMITTED") return "POLICY_DENIED";
  if (error.submissionMayHaveStarted || error.code === "UNKNOWN") return "UNKNOWN";
  return "PROTOCOL_DRIFT";
}

function remoteFailure(value: unknown, unknownStatus: boolean) {
  const failure = record(value, "X worker failure");
  exactOptional(failure, ["code", "message", "retryable", "actionRequired", "submissionMayHaveStarted"], ["rateLimit"]);
  if (typeof failure.code !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(failure.code)) throw new TypeError("invalid X worker failure code");
  if (typeof failure.message !== "string" || failure.message.length < 1 || failure.message.length > 512) throw new TypeError("invalid X worker failure message");
  if (typeof failure.retryable !== "boolean" || typeof failure.actionRequired !== "boolean" || typeof failure.submissionMayHaveStarted !== "boolean") throw new TypeError("invalid X worker failure flags");
  const sanitized = sanitizeXWorkerFailure({
    code: failure.code,
    retryable: failure.retryable,
    actionRequired: failure.actionRequired,
    submissionMayHaveStarted: failure.submissionMayHaveStarted || unknownStatus,
    ...(failure.rateLimit === undefined ? {} : { rateLimit: failure.rateLimit }),
  });
  return new XRuntimeError(sanitized.code, sanitized.message, {
    retryable: sanitized.retryable && !unknownStatus,
    actionRequired: sanitized.actionRequired,
    submissionMayHaveStarted: sanitized.submissionMayHaveStarted,
    ...(sanitized.rateLimit ? { rateLimit: sanitized.rateLimit } : {}),
  });
}

function validateRemoteXResult(value: unknown): XProductionResult {
  const result = record(value, "X worker platform result");
  exactOptional(result, ["data", "native"], ["rateLimit"]);
  const data = record(result.data, "X worker result data");
  assertSecretFreeDto(data);
  const encoded = Buffer.from(JSON.stringify(data));
  try { if (encoded.length > 768 * 1024) throw new TypeError("X worker result exceeds its bound"); }
  finally { encoded.fill(0); }
  let native: XProductionResult["native"] = null;
  if (result.native !== null) {
    const reference = record(result.native, "X worker native result");
    exactOptional(reference, ["nativeId"], ["canonicalUrl"]);
    native = Object.freeze({
      nativeId: nativeId(reference.nativeId, "X native result"),
      ...(reference.canonicalUrl === undefined ? {} : { canonicalUrl: xCanonicalUrl(reference.canonicalUrl) }),
    });
  }
  const rateLimit = optionalRateLimit(result.rateLimit);
  return Object.freeze({ data: Object.freeze(structuredClone(data)), native, ...(rateLimit ? { rateLimit } : {}) });
}

function xMediaMetadata(value: Record<string, unknown>) {
  const mimeType = boundedText(value.mimeType, "X media MIME type", 64);
  if (!new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(mimeType)) throw new XContractError("INVALID_REQUEST", "The X media MIME type is invalid.");
  const sizeBytes = value.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1 || Number(sizeBytes) > 8 * 1024 * 1024) throw new XContractError("INVALID_REQUEST", "The X media size is invalid.");
  const sha256 = boundedText(value.sha256, "X media SHA-256", 64);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new XContractError("INVALID_REQUEST", "The X media digest is invalid.");
  return { mimeType, sizeBytes: Number(sizeBytes), sha256 };
}

function canonicalMediaBytes(value: unknown, ticket: XMediaTicket) {
  const encoded = boundedText(value, "X media bytes", 11_184_812);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new XContractError("INVALID_REQUEST", "The X media bytes are invalid.");
  const data = Buffer.from(encoded, "base64");
  if (data.length !== ticket.sizeBytes || data.toString("base64") !== encoded || createHash("sha256").update(data).digest("hex") !== ticket.sha256) {
    data.fill(0);
    throw new XContractError("INVALID_REQUEST", "The X media integrity check failed.");
  }
  return data;
}

function participantConversationId(self: string, recipient: unknown) {
  const other = nativeId(recipient, "X recipient identity");
  const own = nativeId(self, "X authenticated identity");
  if (own === other) throw new XContractError("INVALID_REQUEST", "The X message recipient must be another account.");
  return BigInt(own) < BigInt(other) ? `${own}-${other}` : `${other}-${own}`;
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([resolve4(hostname).catch(() => []), resolve6(hostname).catch(() => [])]);
  const addresses = [...v4, ...v6];
  if (addresses.length < 1) throw new XRuntimeError("WORKER_UNAVAILABLE", "The admitted X hostname did not resolve.", { retryable: true });
  return addresses;
}

async function boundedFetchBody(response: Response, maximum: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum) throw new RangeError("X worker response exceeds its byte bound");
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function optionalRateLimit(value: unknown): Readonly<Record<string, number | string>> | undefined {
  if (value === undefined) return undefined;
  const rate = record(value, "X rate limit");
  const keys = Object.keys(rate);
  if (keys.length > 16 || keys.some((key) => !X_RATE_LIMIT_KEYS.has(key))) throw new TypeError("invalid X rate limit");
  if (Object.values(rate).some((item) => typeof item !== "string" && typeof item !== "number")) throw new TypeError("invalid X rate limit");
  return Object.freeze(structuredClone(rate) as Record<string, number | string>);
}

function optionalCursor(value: unknown) {
  if (value === undefined || value === null) return null;
  return boundedText(value, "X cursor", 512);
}

function assertSecretFreeDto(value: unknown, depth = 0): void {
  if (depth > 32) throw new TypeError("X result nesting exceeds its bound");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 102) throw new TypeError("X result array exceeds its bound");
    for (const item of value) assertSecretFreeDto(item, depth + 1);
    return;
  }
  const source = record(value, "X result DTO");
  if (Object.keys(source).length > 128) throw new TypeError("X result object exceeds its bound");
  for (const [key, item] of Object.entries(source)) {
    if (/^(?:auth_token|ct0|cookie|authorization|session|csrf)$/iu.test(key)) throw new TypeError("X result contains forbidden authority material");
    assertSecretFreeDto(item, depth + 1);
  }
}

function xCanonicalUrl(value: unknown) {
  const text = boundedText(value, "X canonical URL", 2048);
  const url = new URL(text);
  if (url.protocol !== "https:" || !new Set(["x.com", "www.x.com"]).has(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.hash) throw new TypeError("invalid X canonical URL");
  return url.toString();
}

function nativeId(value: unknown, label: string) {
  const text = boundedText(value, label, 128);
  if (!/^\d+(?:-\d+)?$/u.test(text)) throw new XContractError("PROTOCOL_DRIFT", `${label} is invalid.`);
  return text;
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length < 1) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new XContractError("INVALID_REQUEST", `${label} is invalid.`);
  return value;
}

function plainPayload(value: unknown) {
  return record(value ?? {}, "X worker payload");
}

function exactOptional(value: Record<string, unknown>, required: string[], optional: string[]) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) throw new TypeError("X envelope has unexpected fields");
}

function parseXSession(bytes: Uint8Array) {
  const value = parseJson(bytes, 48 * 1024, "X session material");
  exact(value, ["cookies"]);
  const cookies = record(value.cookies, "X cookies");
  exact(cookies, ["auth_token", "ct0"]);
  return { authToken: secret(cookies.auth_token, "auth_token"), csrfToken: secret(cookies.ct0, "ct0") };
}

function parseDirectRoute(bytes: Uint8Array) {
  const value = parseJson(bytes, 16 * 1024, "X route material");
  exact(value, ["kind"]);
  if (value.kind !== "direct") throw new XContractError("PROTOCOL_DRIFT", "The configured X route is not admitted.");
  return value;
}

function parseJson(bytes: Uint8Array, maximum: number, label: string) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximum) throw new XContractError("INVALID_REQUEST", `${label} is invalid.`);
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), label); }
  catch (error) { if (error instanceof XContractError) throw error; throw new XContractError("INVALID_REQUEST", `${label} is invalid.`); }
}
function decodeText(bytes: Uint8Array, maximum: number, label: string) { if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximum) throw new XContractError("PROTOCOL_DRIFT", `${label} is invalid.`); try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new XContractError("PROTOCOL_DRIFT", `${label} is invalid.`); } }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new XContractError("INVALID_REQUEST", `${label} must be a plain object.`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) throw new XContractError("INVALID_REQUEST", "The X secret envelope has unexpected fields."); }
function secret(value: unknown, label: string) { if (typeof value !== "string" || value.length < 1 || value.length > 8192 || /[;\r\n\0]/u.test(value)) throw new XContractError("INVALID_REQUEST", `The X ${label} is invalid.`); return value; }
