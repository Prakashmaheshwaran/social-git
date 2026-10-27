import { MAX_WORKER_MESSAGE_BYTES } from "@social-git/core";
import { CORE_ERROR_CODES, RedditTransportError } from "@social-git/reddit-adapter";
import type { RedditCommandDispatcher } from "./runtime-reddit.ts";
import { REDDIT_COMMAND_MAC_CONTEXT, RedditCommandMacSigner, RedditCommandMacVerifier } from "./reddit-ipc-auth.ts";
import {
  boundedWorkerBody,
  createIsolatedWorkerServer,
  oneHeader,
  writeWorkerBuffer,
  writeWorkerJson,
  type WorkerMacAuth,
} from "./platform-worker-http.ts";

export function createRedditWorkerHttpServer(options: { dispatcher: RedditCommandDispatcher; commandKey: Uint8Array; now?: () => number }) {
  const verifier = new RedditCommandMacVerifier(options.commandKey, { ...(options.now ? { now: options.now } : {}) });
  const signer = new RedditCommandMacSigner(options.commandKey, { ...(options.now ? { now: options.now } : {}) });
  const auth: WorkerMacAuth = { signer, context: REDDIT_COMMAND_MAC_CONTEXT };
  const json = (response: Parameters<typeof writeWorkerJson>[0], status: number, value: unknown, activeAuth?: WorkerMacAuth) =>
    writeWorkerJson(response, status, value, activeAuth, { wipeOnFinish: true });
  const server = createIsolatedWorkerServer({
    async handle(request, response, state) {
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://reddit-worker.invalid"); }
      catch { request.resume(); return json(response, 400, { code: "MALFORMED_REDDIT_WORKER_ROUTE" }); }
      if (request.method === "GET" && url.pathname === "/healthz") { request.resume(); return json(response, 200, { role: "reddit-worker", status: "ok" }); }
      if (request.method === "GET" && url.pathname === "/readyz") {
        request.resume();
        const empty = Buffer.alloc(0);
        if (!verifier.verify(request.headers, empty, REDDIT_COMMAND_MAC_CONTEXT.readinessRequest)) return json(response, 401, { version: 1, code: "REDDIT_COMMAND_UNAUTHENTICATED" });
        const requestNonce = oneHeader(request.headers["x-social-git-command-nonce"]);
        const status = state.stopping ? 503 : 200;
        return json(response, status, { version: 1, role: "reddit-worker", status: state.stopping ? "stopping" : "ready", inFlight: state.inFlight, requestNonce }, auth);
      }
      if (request.method !== "POST" || url.pathname !== "/v1/dispatch") { request.resume(); return json(response, 404, { error: "not found" }); }
      let command: Buffer | undefined;
      let requestNonce = "";
      let authenticated = false;
      let countedInFlight = false;
      try {
        command = await boundedWorkerBody(request, MAX_WORKER_MESSAGE_BYTES, "Reddit");
        if (!verifier.verify(request.headers, command, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest)) return json(response, 401, { version: 1, code: "REDDIT_COMMAND_UNAUTHENTICATED" });
        authenticated = true;
        requestNonce = oneHeader(request.headers["x-social-git-command-nonce"]);
        if (state.stopping) return json(response, 503, { version: 1, code: "WORKER_STOPPING", requestNonce }, auth);
        state.inFlight += 1;
        countedInFlight = true;
        const result = await options.dispatcher.execute(command);
        const resultMessage = Buffer.from(result.message);
        let messageBase64: string;
        try { messageBase64 = resultMessage.toString("base64url"); }
        finally { resultMessage.fill(0); result.message.fill(0); }
        const body = Buffer.from(JSON.stringify({
          version: 1,
          requestNonce,
          messageBase64,
          ...(result.platformResult ? { platformResult: result.platformResult } : {}),
          ...(result.error ? { failure: safeFailure(result.error) } : {}),
        }));
        if (body.length > 1024 * 1024) throw new RangeError("Reddit worker response exceeds its byte bound");
        writeWorkerBuffer(response, 200, body, auth, { wipeOnFinish: true });
      } catch {
        if (!response.headersSent) json(response, 400, { version: 1, code: "MALFORMED_REDDIT_WORKER_COMMAND", ...(authenticated ? { requestNonce } : {}) }, authenticated ? auth : undefined);
      } finally { command?.fill(0); if (countedInFlight) state.inFlight -= 1; }
    },
    diagnostics(state) { return { inFlight: state.inFlight, stopping: state.stopping }; },
    onClose() { verifier.close(); signer.close(); },
  });
  return server;
}

function safeFailure(error: unknown) {
  if (!(error instanceof RedditTransportError) || !Object.values(CORE_ERROR_CODES).includes(error.code)) {
    const submissionMayHaveStarted = (error as { submissionMayHaveStarted?: unknown } | null)?.submissionMayHaveStarted === true;
    return {
      name: "RedditTransportError",
      code: CORE_ERROR_CODES.PROTOCOL_DRIFT,
      message: "The Reddit worker failed closed",
      retryable: false,
      actionRequired: true,
      submissionMayHaveStarted,
    };
  }
  return {
    name: "RedditTransportError",
    code: error.code,
    // Worker errors may wrap upstream or future adapter text. Never forward
    // their message across the custody boundary, even for an allowlisted code.
    message: "The Reddit worker failed closed",
    retryable: error.retryable === true,
    actionRequired: error.actionRequired === true,
    submissionMayHaveStarted: error.submissionMayHaveStarted === true,
  };
}
