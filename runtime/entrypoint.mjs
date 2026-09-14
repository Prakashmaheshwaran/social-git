#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const role = process.argv[2] ?? "core";
const argumentsForRole = process.argv.slice(3);
const targets = {
  core: new URL("../src/main.ts", import.meta.url),
  worker: new URL("../src/reddit-worker-main.ts", import.meta.url),
  backup: new URL("./backup.mjs", import.meta.url),
};

const target = targets[role];
if (!target) {
  process.stderr.write("usage: entrypoint.mjs {core|worker|backup} [arguments...]\n");
  process.exitCode = 2;
} else {
  process.argv = [process.execPath, fileURLToPath(target), ...argumentsForRole];
  await import(target.href);
}
