#!/usr/bin/env node

import { once } from "node:events";
import { ProductionRedditCommandDispatcher } from "./runtime-reddit.ts";
import { readRedditCommandKeyFile } from "./reddit-ipc-auth.ts";
import { createRedditWorkerHttpServer } from "./reddit-worker-http.ts";

const host = process.env.SOCIAL_GIT_HOST ?? "0.0.0.0";
const port = number(process.env.SOCIAL_GIT_PORT ?? "8081", 1, 65_535);
const commandKey = readRedditCommandKeyFile(required(process.env.SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE, "SOCIAL_GIT_REDDIT_COMMAND_KEY_FILE"));
const server = createRedditWorkerHttpServer({ dispatcher: new ProductionRedditCommandDispatcher(), commandKey });
commandKey.fill(0);

server.listen(port, host);
await Promise.race([
  once(server, "listening"),
  once(server, "error").then(([error]) => Promise.reject(error)),
]);
process.stdout.write(`${JSON.stringify({ level: "info", message: "reddit_worker.ready", host, port })}\n`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.beginShutdown();
    process.stdout.write(`${JSON.stringify({ level: "info", message: "reddit_worker.shutdown", signal })}\n`);
    server.close(() => { process.exitCode = 0; });
  });
}

function required(value: string | undefined, name: string) { if (!value) throw new TypeError(`${name} is required`); return value; }
function number(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/u.test(value)) throw new TypeError("worker port must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError("worker port is out of range");
  return parsed;
}
