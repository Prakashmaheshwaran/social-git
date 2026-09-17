#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const role = process.argv[2] ?? "core";
const argumentsForRole = process.argv.slice(3);
const targets = {
  core: new URL("../src/main.ts", import.meta.url),
  worker: new URL("../src/reddit-worker-main.ts", import.meta.url),
  "reddit-worker": new URL("../src/reddit-worker-main.ts", import.meta.url),
  "x-worker": new URL("../src/x-worker-main.ts", import.meta.url),
  "compose-smoke-core": new URL("../src/compose-smoke-main.ts", import.meta.url),
  backup: new URL("./backup.mjs", import.meta.url),
  "secrets-init": new URL("./secrets-init.mjs", import.meta.url),
  "restore-promote": new URL("./promote-restore.mjs", import.meta.url),
};

const target = targets[role];
if (!target) {
  process.stderr.write("usage: entrypoint.mjs {core|worker|reddit-worker|x-worker|compose-smoke-core|backup|secrets-init|restore-promote} [arguments...]\n");
  process.exitCode = 2;
} else {
  process.argv = [process.execPath, fileURLToPath(target), ...argumentsForRole];
  await import(target.href);
}
