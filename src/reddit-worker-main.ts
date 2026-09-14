#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { redactError } from "@social-git/core";
import { MAX_IPC_MESSAGE_BYTES } from "@social-git/reddit-adapter";
import { ProductionRedditCommandDispatcher } from "./runtime-reddit.ts";

const host = process.env.SOCIAL_GIT_HOST ?? "0.0.0.0";
const port = number(process.env.SOCIAL_GIT_PORT ?? "8081", 1, 65_535);
const dispatcher = new ProductionRedditCommandDispatcher();
let inFlight = 0;
let stopping = false;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { role: "reddit-worker", status: "ok" });
  if (request.method === "GET" && url.pathname === "/readyz") {
    return json(response, stopping ? 503 : 200, {
      role: "reddit-worker",
      status: stopping ? "stopping" : "ready",
      inFlight,
    });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/dispatch") return json(response, 404, { error: "not found" });
  if (stopping) return json(response, 503, { error: "worker is stopping" });
  inFlight += 1;
  try {
    const command = await boundedBody(request, MAX_IPC_MESSAGE_BYTES);
    const result = await dispatcher.execute(command);
    const body = Buffer.from(JSON.stringify({
      version: 1,
      messageBase64: Buffer.from(result.message).toString("base64url"),
      ...(result.platformResult ? { platformResult: result.platformResult } : {}),
      ...(result.error ? {
        failure: {
          ...redactError(result.error),
          retryable: (result.error as { retryable?: unknown }).retryable === true,
          actionRequired: (result.error as { actionRequired?: unknown }).actionRequired === true,
          submissionMayHaveStarted: (result.error as { submissionMayHaveStarted?: unknown }).submissionMayHaveStarted === true,
        },
      } : {}),
    }));
    if (body.length > 1024 * 1024) throw new RangeError("worker response exceeds its byte bound");
    response.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    response.end(body);
  } catch (error) {
    json(response, 400, { error: redactError(error) });
  } finally {
    inFlight -= 1;
  }
});

server.listen(port, host);
await Promise.race([
  once(server, "listening"),
  once(server, "error").then(([error]) => Promise.reject(error)),
]);
process.stdout.write(`${JSON.stringify({ level: "info", message: "reddit_worker.ready", host, port })}\n`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ level: "info", message: "reddit_worker.shutdown", signal })}\n`);
    server.close(() => { process.exitCode = 0; });
  });
}

function boundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        request.destroy();
        reject(new RangeError("worker request exceeds its byte bound"));
      } else {
        chunks.push(chunk);
      }
    });
    request.once("end", () => resolve(Buffer.concat(chunks, bytes)));
    request.once("error", reject);
  });
}

function json(response: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

function number(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/u.test(value)) throw new TypeError("worker port must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError("worker port is out of range");
  return parsed;
}
