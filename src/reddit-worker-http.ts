import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_WORKER_MESSAGE_BYTES } from "@social-git/core";
import { CORE_ERROR_CODES, RedditTransportError } from "@social-git/reddit-adapter";
import type { RedditCommandDispatcher } from "./runtime-reddit.ts";
import { REDDIT_COMMAND_MAC_CONTEXT, RedditCommandMacSigner, RedditCommandMacVerifier } from "./reddit-ipc-auth.ts";

export function createRedditWorkerHttpServer(options: { dispatcher: RedditCommandDispatcher; commandKey: Uint8Array; now?: () => number }) {
  const verifier = new RedditCommandMacVerifier(options.commandKey, { ...(options.now ? { now: options.now } : {}) });
  const signer = new RedditCommandMacSigner(options.commandKey, { ...(options.now ? { now: options.now } : {}) });
  let inFlight = 0;
  let stopping = false;
  const server = createServer(async (request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://reddit-worker.invalid"); }
    catch { request.resume(); return json(response, 400, { code: "MALFORMED_REDDIT_WORKER_ROUTE" }); }
    if (request.method === "GET" && url.pathname === "/healthz") { request.resume(); return json(response, 200, { role: "reddit-worker", status: "ok" }); }
    if (request.method === "GET" && url.pathname === "/readyz") {
      request.resume();
      const empty = Buffer.alloc(0);
      if (!verifier.verify(request.headers, empty, REDDIT_COMMAND_MAC_CONTEXT.readinessRequest)) return json(response, 401, { version: 1, code: "REDDIT_COMMAND_UNAUTHENTICATED" });
      const requestNonce = one(request.headers["x-social-git-command-nonce"]);
      const status = stopping ? 503 : 200;
      return json(response, status, { version: 1, role: "reddit-worker", status: stopping ? "stopping" : "ready", inFlight, requestNonce }, signer);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/dispatch") { request.resume(); return json(response, 404, { error: "not found" }); }
    let command: Buffer | undefined;
    let requestNonce = "";
    let authenticated = false;
    let countedInFlight = false;
    try {
      command = await boundedBody(request, MAX_WORKER_MESSAGE_BYTES);
      if (!verifier.verify(request.headers, command, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest)) return json(response, 401, { version: 1, code: "REDDIT_COMMAND_UNAUTHENTICATED" });
      authenticated = true;
      requestNonce = one(request.headers["x-social-git-command-nonce"]);
      if (stopping) return json(response, 503, { version: 1, code: "WORKER_STOPPING", requestNonce }, signer);
      inFlight += 1;
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
      response.writeHead(200, { "content-type": "application/json", "content-length": body.length, ...signer.headers(body, REDDIT_COMMAND_MAC_CONTEXT.response(200)) });
      endWiping(response, body);
    } catch {
      if (!response.headersSent) json(response, 400, { version: 1, code: "MALFORMED_REDDIT_WORKER_COMMAND", ...(authenticated ? { requestNonce } : {}) }, authenticated ? signer : undefined);
    } finally { command?.fill(0); if (countedInFlight) inFlight -= 1; }
  });
  server.once("close", () => { verifier.close(); signer.close(); });
  return Object.assign(server, {
    beginShutdown() { stopping = true; },
    diagnostics() { return Object.freeze({ inFlight, stopping }); },
  });
}

function boundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const wipe = () => { for (const item of chunks) item.fill(0); chunks.length = 0; };
    const fail = (error: Error) => { if (settled) return; settled = true; wipe(); reject(error); };
    request.on("data", (chunk: Buffer) => {
      const copy = Buffer.from(chunk);
      chunk.fill(0);
      if (settled) { copy.fill(0); return; }
      bytes += copy.length;
      if (bytes > maximum) { copy.fill(0); fail(new RangeError("Reddit worker request exceeds its byte bound")); request.destroy(); }
      else chunks.push(copy);
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

function json(response: ServerResponse, status: number, value: unknown, signer?: RedditCommandMacSigner) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...(signer ? signer.headers(body, REDDIT_COMMAND_MAC_CONTEXT.response(status)) : {}) });
  endWiping(response, body);
}

function endWiping(response: ServerResponse, body: Buffer) {
  let wiped = false;
  const wipe = () => { if (!wiped) { wiped = true; body.fill(0); } };
  response.once("finish", wipe);
  response.once("close", wipe);
  response.once("error", wipe);
  response.end(body, wipe);
}

function one(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }

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
