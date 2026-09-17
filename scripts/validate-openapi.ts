import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateOpenApi, OPERATIONS } from "../src/contract.ts";

const committed = JSON.parse(readFileSync(new URL("../openapi/social-git.openapi.json", import.meta.url), "utf8"));
assert.deepEqual(committed, generateOpenApi(), "Committed OpenAPI is stale; run npm run generate:openapi");
assert.equal(committed.openapi, "3.1.0");

const operationIds = new Set<string>();
for (const definition of OPERATIONS) {
  assert.match(definition.path, /^\/v1\//u, `${definition.operationId} is not versioned under /v1`);
  assert.equal(operationIds.has(definition.operationId), false, `Duplicate operationId ${definition.operationId}`);
  operationIds.add(definition.operationId);
  const operation: any = committed.paths[definition.path]?.[definition.method.toLowerCase()];
  assert.ok(operation, `Missing OpenAPI operation ${definition.operationId}`);
  assert.equal(operation.operationId, definition.operationId);
  assert.equal(operation["x-mcp-tool"], definition.mcpName);
  assert.equal(operation["x-required-scope"], definition.scope);
  const declaredPathParameters = new Set((operation.parameters ?? [])
    .filter((parameter: { in: string }) => parameter.in === "path")
    .map((parameter: { name: string }) => parameter.name));
  for (const name of definition.path.matchAll(/\{([^}]+)\}/gu)) {
    assert.equal(declaredPathParameters.has(name[1]!), true, `${definition.operationId} does not declare path parameter ${name[1]}`);
  }
  const success = operation.responses[String(definition.successStatus ?? 200)];
  assert.ok(success?.headers?.["X-Request-ID"], `${definition.operationId} must document X-Request-ID`);
  if (definition.parameters?.some((parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key")) {
    assert.ok(success.headers["Idempotency-Replayed"], `${definition.operationId} must document idempotency replay`);
  }
  assert.ok(operation.responses.default?.content?.["application/json"]?.schema, `${definition.operationId} lacks the common error schema`);
}

assert.equal(new Set(OPERATIONS.map(({ mcpName }) => mcpName)).size, OPERATIONS.length, "MCP tool names must be unique");
process.stdout.write(`openapi_validation=ok operations=${OPERATIONS.length}\n`);
