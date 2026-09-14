#!/usr/bin/env node

import { startSocialGitRuntime, safeStartupFailure } from "./runtime.ts";

let runtime: Awaited<ReturnType<typeof startSocialGitRuntime>> | undefined;
let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ level: "info", message: "runtime.shutdown", signal })}\n`);
  await runtime?.close();
}

try {
  runtime = await startSocialGitRuntime();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void shutdown(signal).finally(() => { process.exitCode = 0; }); });
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: "error", message: "runtime.startup_failed", error: safeStartupFailure(error) })}\n`);
  process.exitCode = 1;
}
