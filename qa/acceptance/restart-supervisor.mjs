#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execute = promisify(execFile);
const container = required("SOCIAL_GIT_QA_CONTAINER");
const tokenDigest = required("SOCIAL_GIT_QA_TOKEN_SHA256");
const host = process.env.SOCIAL_GIT_QA_SUPERVISOR_HOST ?? "127.0.0.1";
const port = integer(process.env.SOCIAL_GIT_QA_SUPERVISOR_PORT ?? "8090");
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(container)) throw new TypeError("SOCIAL_GIT_QA_CONTAINER is invalid");
if (!/^[a-f0-9]{64}$/u.test(tokenDigest)) throw new TypeError("SOCIAL_GIT_QA_TOKEN_SHA256 is invalid");
if (!["127.0.0.1", "::1"].includes(host)) throw new TypeError("the restart supervisor must bind to loopback");

let restarting = false;
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/restart") return reply(response, 404, { error: "not found" });
  if (!authorized(request.headers.authorization)) return reply(response, 401, { error: "unauthorized" });
  if (restarting) return reply(response, 409, { error: "restart already active" });
  restarting = true;
  try {
    await execute("docker", ["restart", "--time", "5", container], {
      timeout: 30_000,
      windowsHide: true,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
        ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
      },
    });
    reply(response, 200, { restarted: true });
  } catch {
    reply(response, 502, { error: "candidate restart failed" });
  } finally {
    restarting = false;
  }
});

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ event: "restart_supervisor.ready", url: `http://${host}:${port}/restart` })}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => { process.exitCode = 0; }));
}

function authorized(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 8192) return false;
  const candidate = createHash("sha256").update(header.slice(7)).digest();
  const expected = Buffer.from(tokenDigest, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function integer(value) {
  if (!/^\d+$/u.test(value)) throw new TypeError("supervisor port must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new TypeError("supervisor port is out of range");
  return parsed;
}

function reply(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}
