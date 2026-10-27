import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Shared worker-process HTTP primitives.
 *
 * These helpers are the parts of the Reddit and X worker HTTP surfaces that are
 * genuinely identical in behaviour. Anything that differs between the platforms
 * — readiness semantics, admission, failure sanitisation, response codes — stays
 * in the platform module so it remains visible and cannot drift silently.
 */

/**
 * The subset of a command-MAC signer the worker response writer needs. It is
 * declared as returning `object` because the platform header types are
 * interfaces without an index signature.
 */
export interface WorkerMacSigner {
  headers(body: Uint8Array, context: string): object;
}

export interface WorkerMacContext {
  response(status: number): string;
}

export interface WorkerMacAuth {
  readonly signer: WorkerMacSigner | undefined;
  readonly context: WorkerMacContext;
}

export interface WorkerServerState {
  inFlight: number;
  stopping: boolean;
}

export interface WorkerWriteOptions {
  /**
   * Reddit wipes a response body as soon as the response finishes; X only wipes
   * on close/error. Kept explicit so the buffer-lifetime behaviour is unchanged.
   */
  wipeOnFinish?: boolean;
}

export function createIsolatedWorkerServer<TDiagnostics extends object>(options: {
  handle: (request: IncomingMessage, response: ServerResponse, state: WorkerServerState) => Promise<void> | void;
  diagnostics: (state: WorkerServerState) => TDiagnostics;
  onClose?: () => void;
}) {
  const state: WorkerServerState = { inFlight: 0, stopping: false };
  const server = createServer(async (request, response) => { await options.handle(request, response, state); });
  server.once("close", () => { options.onClose?.(); });
  return Object.assign(server, {
    beginShutdown() { state.stopping = true; },
    diagnostics() { return Object.freeze(options.diagnostics(state)); },
  });
}

export function boundedWorkerBody(request: IncomingMessage, maximum: number, productLabel: string): Promise<Buffer> {
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
      if (bytes > maximum) { copy.fill(0); fail(new RangeError(`${productLabel} worker request exceeds its byte bound`)); request.destroy(); }
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

/** Drains and discards a bounded request body, wiping every chunk. */
export function discardBoundedBody(request: IncomingMessage, maximum: number, label = "disabled-worker"): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; chunk.fill(0); if (bytes > maximum) { request.destroy(); reject(new RangeError(`request exceeds ${label} bound`)); } });
    request.once("end", resolve);
    request.once("error", reject);
  });
}

/** Writes a pre-serialised JSON body, optionally MAC-signed for the given status. */
export function writeWorkerBuffer(response: ServerResponse, status: number, body: Buffer, auth?: WorkerMacAuth, options: WorkerWriteOptions = {}) {
  const signature = auth?.signer ? auth.signer.headers(body, auth.context.response(status)) : {};
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...signature });
  endAndWipe(response, body, options.wipeOnFinish === true);
}

export function writeWorkerJson(response: ServerResponse, status: number, value: unknown, auth?: WorkerMacAuth, options: WorkerWriteOptions = {}) {
  writeWorkerBuffer(response, status, Buffer.from(JSON.stringify(value)), auth, options);
}

export function endAndWipe(response: ServerResponse, body: Buffer, wipeOnFinish: boolean) {
  let wiped = false;
  const wipe = () => { if (!wiped) { wiped = true; body.fill(0); } };
  if (wipeOnFinish) response.once("finish", wipe);
  response.once("close", wipe);
  response.once("error", wipe);
  response.end(body, wipe);
}

export function oneHeader(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }