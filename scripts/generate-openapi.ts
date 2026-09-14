import { mkdirSync, writeFileSync } from "node:fs";
import { generateOpenApi } from "../src/contract.ts";

mkdirSync(new URL("../openapi/", import.meta.url), { recursive: true });
writeFileSync(new URL("../openapi/social-git.openapi.json", import.meta.url), `${JSON.stringify(generateOpenApi(), null, 2)}\n`);
