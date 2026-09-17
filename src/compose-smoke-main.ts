#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadRuntimeConfig } from "./runtime-config.ts";
import { safeStartupFailure, startSocialGitRuntime } from "./runtime.ts";
import type { WebhookTransport } from "./webhooks.ts";

const config = loadRuntimeConfig();
if (config.mode !== "fixture" || process.env.NODE_ENV !== "test") {
  throw new TypeError("The Compose smoke entrypoint requires fixture test mode");
}
const expectedSink = join(config.dataDir, "webhook-smoke.jsonl");
const configuredSink = resolve(process.env.SOCIAL_GIT_FIXTURE_WEBHOOK_SINK_FILE ?? "");
if (configuredSink !== expectedSink) throw new TypeError("The Compose smoke webhook sink path is invalid");

const transport: WebhookTransport = Object.freeze({
  async send(url: string, headers: Readonly<Record<string, string>>, body: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new TypeError("The Compose smoke webhook URL is invalid");
    }
    if (Buffer.byteLength(body) > 64 * 1024 || Object.keys(headers).length > 32) {
      throw new RangeError("The Compose smoke webhook record is too large");
    }
    const line = `${JSON.stringify({ url: parsed.toString(), headers, body })}\n`;
    const descriptor = openSync(
      expectedSink,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size + Buffer.byteLength(line) > 1024 * 1024) {
        throw new TypeError("The Compose smoke webhook sink is not a private bounded regular file");
      }
      writeSync(descriptor, line);
    } finally {
      closeSync(descriptor);
    }
    return { status: 204 };
  },
});

let runtime: Awaited<ReturnType<typeof startSocialGitRuntime>> | undefined;
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ level: "info", message: "compose_smoke.shutdown", signal })}\n`);
  await runtime?.close();
}

try {
  runtime = await startSocialGitRuntime(config, { webhookTransport: transport });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void shutdown(signal).finally(() => { process.exitCode = 0; }); });
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: "error", message: "compose_smoke.startup_failed", error: safeStartupFailure(error) })}\n`);
  process.exitCode = 1;
}
