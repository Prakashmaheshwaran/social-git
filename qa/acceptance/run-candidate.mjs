#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runAcceptance } from "./suite.mjs";

function usage() {
  return `Usage:
  npm run qa:acceptance -- \\
    --driver ./path/to/candidate-driver.mjs \\
    --candidate-ref git:<40-hex-commit> \\
    --image-digest sha256:<64-hex-digest> \\
    [--output ./acceptance-result.json]

The driver must export createDriver({ candidateRef, imageDigest }) and must
identify itself as metadata.kind = "integration_candidate". Fixture drivers
cannot produce a candidate verdict.`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!["--driver", "--candidate-ref", "--image-digest", "--output"].includes(value)) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${value}`);
    }
    parsed[value.slice(2)] = next;
    index += 1;
  }
  return parsed;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const required = ["driver", "candidate-ref", "image-digest"];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    process.stderr.write(`Missing required options: ${missing.join(", ")}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const moduleUrl = pathToFileURL(resolve(args.driver)).href;
  const driverModule = await import(moduleUrl);
  if (typeof driverModule.createDriver !== "function") {
    throw new TypeError("Candidate driver module must export createDriver()");
  }
  const driver = await driverModule.createDriver({
    candidateRef: args["candidate-ref"],
    imageDigest: args["image-digest"],
  });
  if (driver?.metadata?.kind !== "integration_candidate") {
    throw new Error("Refusing verdict: driver is not an integration_candidate");
  }
  if (driver.metadata.candidateRef !== args["candidate-ref"]) {
    throw new Error("Refusing verdict: driver candidateRef does not match the requested candidate");
  }
  if (driver.metadata.imageDigest !== args["image-digest"]) {
    throw new Error("Refusing verdict: driver imageDigest does not match the inspected image");
  }

  const report = await runAcceptance(driver);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    await writeFile(resolve(args.output), rendered, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(rendered);
  process.exitCode = report.verdict === "GO" ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`Acceptance runner failed: ${error.message}\n`);
  process.exitCode = 2;
});
