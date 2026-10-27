import { MAX_WORKER_MESSAGE_BYTES } from "@social-git/core";
import type { XAdmissionDecision, XCommandDispatcher } from "./runtime-x.ts";
import { sanitizeXWorkerFailure } from "./runtime-x.ts";
import { X_COMMAND_MAC_CONTEXT, XCommandMacSigner, XCommandMacVerifier } from "./x-ipc-auth.ts";
import {
  boundedWorkerBody,
  createIsolatedWorkerServer,
  discardBoundedBody,
  oneHeader,
  writeWorkerBuffer,
  writeWorkerJson,
  type WorkerMacAuth,
} from "./platform-worker-http.ts";

export function createXWorkerHttpServer(options: { admission: XAdmissionDecision; dispatcher?: XCommandDispatcher; commandKey?: Uint8Array; now?: () => number }) {
  if (options.admission.enabled && (!options.dispatcher || !options.commandKey)) throw new TypeError("An admitted X worker requires its dispatcher and distinct command key");
  const verifier = options.commandKey ? new XCommandMacVerifier(options.commandKey, { ...(options.now ? { now: options.now } : {}) }) : undefined;
  const signer = options.commandKey ? new XCommandMacSigner(options.commandKey, { ...(options.now ? { now: options.now } : {}) }) : undefined;
  const auth: WorkerMacAuth = { signer, context: X_COMMAND_MAC_CONTEXT };
  const signerAuth = signer ? auth : undefined;
  const json = (response: Parameters<typeof writeWorkerJson>[0], status: number, value: unknown, activeAuth?: WorkerMacAuth) => writeWorkerJson(response, status, value, activeAuth);
  const server = createIsolatedWorkerServer({
    async handle(request, response, state) {
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://x-worker.invalid"); }
      catch { request.resume(); return json(response, 400, { error: "malformed request target" }); }
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { role: "x-worker", status: "ok", admission: options.admission });
      if (request.method === "GET" && url.pathname === "/readyz") {
        request.resume();
        const empty = Buffer.alloc(0);
        const authenticated = options.admission.enabled && verifier?.verify(request.headers, empty, X_COMMAND_MAC_CONTEXT.readinessRequest);
        if (!authenticated) return json(response, options.admission.enabled ? 401 : 200, {
          version: 1,
          role: "x-worker",
          status: options.admission.enabled ? "unauthenticated" : "candidate-ready-production-disabled",
          inFlight: state.inFlight,
          admission: options.admission,
        });
        const requestNonce = oneHeader(request.headers["x-social-git-command-nonce"]);
        const dispatcherReady = !state.stopping && await options.dispatcher!.ready().catch(() => false);
        const status = dispatcherReady ? 200 : 503;
        return json(response, status, {
          version: 1,
          role: "x-worker",
          status: state.stopping ? "stopping" : dispatcherReady ? "ready" : "unavailable",
          inFlight: state.inFlight,
          admission: options.admission,
          requestNonce,
        }, signerAuth);
      }
      if (request.method !== "POST" || url.pathname !== "/v1/dispatch") {
        request.resume();
        return json(response, 404, { error: "not found" });
      }
      if (!options.admission.enabled || !options.dispatcher) {
        try { await discardBoundedBody(request, 1024); }
        catch { return json(response, 413, { code: "REQUEST_TOO_LARGE" }); }
        return json(response, 503, { code: "X_TRANSPORT_NOT_ADMITTED", disabledReasons: options.admission.disabledReasons });
      }
      let command: Buffer | undefined;
      let requestNonce = "";
      let authenticated = false;
      let countedInFlight = false;
      try {
        command = await boundedWorkerBody(request, MAX_WORKER_MESSAGE_BYTES, "X");
        if (!verifier?.verify(request.headers, command, X_COMMAND_MAC_CONTEXT.dispatchRequest)) return json(response, 401, { code: "X_COMMAND_UNAUTHENTICATED" });
        authenticated = true;
        requestNonce = oneHeader(request.headers["x-social-git-command-nonce"]);
        if (state.stopping) return json(response, 503, { version: 1, code: "WORKER_STOPPING", requestNonce }, signerAuth);
        state.inFlight += 1;
        countedInFlight = true;
        const result = await options.dispatcher.execute(command);
        const message = Buffer.from(result.message);
        let body: Buffer;
        try {
          body = Buffer.from(JSON.stringify({
            version: 1,
            requestNonce,
            messageBase64: message.toString("base64url"),
            ...(result.platformResult ? { platformResult: result.platformResult } : {}),
            ...(result.error ? {
              failure: safeFailure(result.error),
            } : {}),
          }));
        } finally { message.fill(0); result.message.fill(0); }
        if (body.length > 1024 * 1024) throw new RangeError("X worker response exceeds its byte bound");
        writeWorkerBuffer(response, 200, body, signerAuth);
      } catch {
        if (!response.headersSent) json(response, 400, {
          version: 1,
          code: "MALFORMED_X_WORKER_COMMAND",
          ...(authenticated ? { requestNonce } : {}),
        }, authenticated ? signerAuth : undefined);
      } finally { command?.fill(0); if (countedInFlight) state.inFlight -= 1; }
    },
    diagnostics(state) { return { inFlight: state.inFlight, stopping: state.stopping, admission: options.admission }; },
    onClose() { verifier?.close(); signer?.close(); options.dispatcher?.close?.(); },
  });
  return server;
}

function safeFailure(error: { code: string; retryable?: unknown; actionRequired?: unknown; submissionMayHaveStarted?: unknown; rateLimit?: unknown }) {
  try {
    return sanitizeXWorkerFailure({
      code: typeof error.code === "string" ? error.code : "PROTOCOL_DRIFT",
      retryable: (error as { retryable?: unknown }).retryable === true,
      actionRequired: (error as { actionRequired?: unknown }).actionRequired === true,
      submissionMayHaveStarted: (error as { submissionMayHaveStarted?: unknown }).submissionMayHaveStarted === true,
      ...(error.rateLimit === undefined ? {} : { rateLimit: error.rateLimit }),
    });
  } catch {
    return sanitizeXWorkerFailure({ code: "PROTOCOL_DRIFT" });
  }
}
