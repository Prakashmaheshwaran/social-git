import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capabilityMappingErrors, generateCapabilityMatrix } from "./product-reset-docs.ts";

const root = new URL("../", import.meta.url);
const required = [
  "docs/product-reset/prd-v1.md",
  "docs/product-reset/adr-001-product-boundary.md",
  "docs/product-reset/milestone-plan-v1.md",
  "docs/product-reset/capability-matrix.md",
  "docs/product-reset/keep-replace-delete-v1.md",
];
for (const path of required) {
  const content = readFileSync(new URL(path, root), "utf8");
  assert.match(content, /Document version: 1\.0\.0/u, `${path} has no version marker`);
  assert.doesNotMatch(content, /X[^\n]{0,60}production[^\n]{0,30}(enabled|ready)/iu, `${path} overstates X production status`);
}
assert.deepEqual(capabilityMappingErrors(), []);
assert.equal(readFileSync(new URL("docs/product-reset/capability-matrix.md", root), "utf8"), generateCapabilityMatrix(), "Capability matrix is stale; run npm run generate:product-docs");

const prd = readFileSync(new URL("docs/product-reset/prd-v1.md", root), "utf8");
for (const truthSource of ["src/contract.ts", "packages/reddit-adapter/src/contract.mjs", "packages/x-adapter/src/admission.mjs"]) assert.match(prd, new RegExp(truthSource.replaceAll(".", "\\."), "u"));
const map = readFileSync(new URL("docs/product-reset/keep-replace-delete-v1.md", root), "utf8");
for (const decision of ["KEEP", "REPLACE", "DELETE"]) assert.match(map, new RegExp(`\\| ${decision} \\|`, "u"));
process.stdout.write(`product_reset_docs_validation=ok files=${required.length}\n`);
