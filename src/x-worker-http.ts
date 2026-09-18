import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_WORKER_MESSAGE_BYTES } from "@social-git/core";
import type { XAdmissionDecision, XCommandDispatcher } from "./runtime-x.ts";
import { X_COMMAND_MAC_CONTEXT, XCommandMacSigner, XCommandMacVerifier } from "./x-ipc-auth.ts";

export function createXWorkerHttpServer(options: { admission: XAdmissionDecision; dispatcher?: XCommandDispatcher; commandKey?: Uint8Array; now?: () => number }) {
  if (options.admission.enabled && (!options.dispatcher || !options.commandKey)) throw new TypeError("An admitted X worker requires its dispatcher and distinct command key");
  const verifier = options.commandKey ? new XCommandMacVerifier(options.commandKey, { ...(options.now ? { now: options.now } : {}) }) : undefined;
  const signer = options.commandKey ? new XCommandMacSigner(options.commandKey, { ...(options.now ? { now: options.now } : {}) }) : undefined;
  let inFlight = 0;
  let stopping = false;
  const server = createServer(async (request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://x-worker.internal"); }
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
        inFlight,
        admission: options.admission,
      });
      const requestNonce = one(request.headers["x-social-git-command-nonce"]);
      const dispatcherReady = !stopping && await options.dispatcher!.ready().catch(() => false);
      const status = dispatcherReady ? 200 : 503;
      return json(response, status, {
        version: 1,
        role: "x-worker",
        status: stopping ? "stopping" : dispatcherReady ? "ready" : "unavailable",
        inFlight,
        admission: options.admission,
        requestNonce,
      }, signer);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/dispatch") {
      request.resume();
      return json(response, 404, { error: "not found" });
    }
    if (!options.admission.enabled || !options.dispatcher) {
      try { await discardBounded(request, 1024); }
      catch { return json(response, 413, { code: "REQUEST_TOO_LARGE" }); }
      return json(response, 503, { code: "X_TRANSPORT_NOT_ADMITTED", disabledReasons: options.admission.disabledReasons });
    }
    let command: Buffer | undefined;
    let requestNonce = "";
    let authenticated = false;
    let countedInFlight = false;
    try {
      command = await boundedBody(request, MAX_WORKER_MESSAGE_BYTES);
      if (!verifier?.verify(request.headers, command, X_COMMAND_MAC_CONTEXT.dispatchRequest)) return json(response, 401, { code: "X_COMMAND_UNAUTHENTICATED" });
      authenticated = true;
      requestNonce = one(request.headers["x-social-git-command-nonce"]);
      if (stopping) return json(response, 503, { version: 1, code: "WORKER_STOPPING", requestNonce }, signer);
      inFlight += 1;
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
            failure: {
              code: safeCode(result.error.code),
              message: safeMessage(result.error.message),
              retryable: result.error.retryable,
              actionRequired: result.error.actionRequired,
              submissionMayHaveStarted: result.error.submissionMayHaveStarted,
              ...(result.error.rateLimit ? { rateLimit: result.error.rateLimit } : {}),
            },
          } : {}),
        }));
      } finally { message.fill(0); result.message.fill(0); }
      if (body.length > 1024 * 1024) throw new RangeError("X worker response exceeds its byte bound");
      response.writeHead(200, { "content-type": "application/json", "content-length": body.length, ...signer!.headers(body, X_COMMAND_MAC_CONTEXT.response(200)) });
      endAndWipe(response, body);
    } catch {
      if (!response.headersSent) json(response, 400, {
        version: 1,
        code: "MALFORMED_X_WORKER_COMMAND",
        ...(authenticated ? { requestNonce } : {}),
      }, authenticated ? signer : undefined);
    } finally { command?.fill(0); if (countedInFlight) inFlight -= 1; }
  });
  server.once("close", () => { verifier?.close(); signer?.close(); options.dispatcher?.close?.(); });
  return Object.assign(server, {
    beginShutdown() { stopping = true; },
    diagnostics() { return Object.freeze({ inFlight, stopping, admission: options.admission }); },
  });
}

function boundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const wipe = () => { for (const item of chunks) item.fill(0); chunks.length = 0; };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      wipe();
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      const copy = Buffer.from(chunk);
      chunk.fill(0);
      if (settled) { copy.fill(0); return; }
      bytes += copy.length;
      if (bytes > maximum) {
        copy.fill(0);
        fail(new RangeError("X worker request exceeds its byte bound"));
        request.destroy();
      } else chunks.push(copy);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      const result = Buffer.concat(chunks, bytes);
      wipe();
      resolve(result);
    });
    request.once("error", (error) => fail(error));
  });
}

function discardBounded(request: IncomingMessage, maximum: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; chunk.fill(0); if (bytes > maximum) { request.destroy(); reject(new RangeError("request exceeds disabled-worker bound")); } });
    request.once("end", resolve);
    request.once("error", reject);
  });
}

function json(response: ServerResponse, status: number, value: unknown, signer?: XCommandMacSigner) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...(signer ? signer.headers(body, X_COMMAND_MAC_CONTEXT.response(status)) : {}) });
  endAndWipe(response, body);
}

function endAndWipe(response: ServerResponse, body: Buffer) {
  let wiped = false;
  const wipe = () => { if (!wiped) { wiped = true; body.fill(0); } };
  response.once("close", wipe);
  response.once("error", wipe);
  response.end(body, wipe);
}

function safeCode(value: string) { return /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : "PROTOCOL_DRIFT"; }
function safeMessage(value: string) { return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : "The X worker failed closed."; }
function one(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }
