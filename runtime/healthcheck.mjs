#!/usr/bin/env node

import { request } from "node:http";

const path = process.argv[2] ?? "/readyz";
if (!["/healthz", "/readyz"].includes(path)) {
  process.stderr.write("healthcheck path must be /healthz or /readyz\n");
  process.exit(2);
}

const port = Number(process.env.SOCIAL_GIT_PORT ?? "8080");
const probe = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 2_000 }, (response) => {
  response.resume();
  response.once("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
});
probe.once("timeout", () => probe.destroy(new Error("healthcheck timed out")));
probe.once("error", () => process.exit(1));
probe.end();
