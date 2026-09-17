#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { X_TRANSPORT_ADMISSION } from "@social-git/x-adapter";

const host = process.env.SOCIAL_GIT_HOST ?? "0.0.0.0";
const port = boundedPort(process.env.SOCIAL_GIT_PORT ?? "8082");
let stopping = false;

// The isolated runtime/container boundary exists now, but dispatch is
// deliberately unavailable until every admission gate and authorized live
// proof passes. This server never accepts cookies while disabled.
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { role: "x-worker", status: "ok", admission: X_TRANSPORT_ADMISSION });
  if (request.method === "GET" && url.pathname === "/readyz") return json(response, stopping ? 503 : 200, { role: "x-worker", status: stopping ? "stopping" : "candidate-ready-production-disabled", admission: X_TRANSPORT_ADMISSION });
  if (request.method === "POST" && url.pathname === "/v1/dispatch") {
    try { await discardBounded(request, 1024); }
    catch { return json(response, 413, { code: "REQUEST_TOO_LARGE" }); }
    return json(response, 503, { code: "X_TRANSPORT_NOT_ADMITTED", disabledReasons: X_TRANSPORT_ADMISSION.disabledReasons });
  }
  request.resume();
  return json(response, 404, { error: "not found" });
});

server.listen(port, host);
await Promise.race([once(server, "listening"), once(server, "error").then(([error]) => Promise.reject(error))]);
process.stdout.write(`${JSON.stringify({ level: "info", message: "x_worker.candidate_ready_production_disabled", host, port, disabledReasons: X_TRANSPORT_ADMISSION.disabledReasons })}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { if (stopping) return; stopping = true; server.close(() => { process.exitCode = 0; }); });

function json(response: ServerResponse, status: number, value: unknown) { const body = Buffer.from(JSON.stringify(value)); response.writeHead(status, { "content-type": "application/json", "content-length": body.length }); response.end(body); }
function boundedPort(value: string) { if (!/^\d+$/u.test(value)) throw new TypeError("X worker port must be an integer"); const port = Number(value); if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("X worker port is out of range"); return port; }
function discardBounded(request: IncomingMessage, maximum: number): Promise<void> { return new Promise((resolve, reject) => { let bytes = 0; request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximum) { request.destroy(); reject(new RangeError("request exceeds disabled-worker bound")); } }); request.once("end", resolve); request.once("error", reject); }); }
