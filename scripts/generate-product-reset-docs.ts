import { mkdirSync, writeFileSync } from "node:fs";
import { capabilityMappingErrors, generateCapabilityMatrix } from "./product-reset-docs.ts";

const errors = capabilityMappingErrors();
if (errors.length) throw new Error(errors.join("\n"));
mkdirSync(new URL("../docs/product-reset/", import.meta.url), { recursive: true });
writeFileSync(new URL("../docs/product-reset/capability-matrix.md", import.meta.url), generateCapabilityMatrix());
