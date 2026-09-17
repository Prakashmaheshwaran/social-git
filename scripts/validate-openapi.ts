import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateOpenApi, OPERATIONS } from "../src/contract.ts";
import { X_TRANSPORT_ADMISSION } from "@social-git/x-adapter";

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
  if (definition.operationId.startsWith("x.")) {
    assert.equal(operation["x-social-git-platform"], "x");
    assert.equal(operation["x-social-git-availability"], "fixture_only");
    assert.deepEqual(operation["x-social-git-disabled-reasons"], X_TRANSPORT_ADMISSION.disabledReasons);
  } else if (definition.operationId.startsWith("reads.") || definition.operationId === "actions.create") {
    assert.equal(operation["x-social-git-platform"], "reddit");
    assert.equal(operation["x-social-git-availability"], "production");
  } else {
    assert.equal(operation["x-social-git-platform"], "core");
    assert.equal(operation["x-social-git-availability"], "production");
  }
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
  validateMediaExamples(operation.requestBody?.content?.["application/json"], `${definition.operationId} request`);
  validateMediaExamples(success?.content?.["application/json"], `${definition.operationId} success`);
  validateMediaExamples(operation.responses.default?.content?.["application/json"], `${definition.operationId} error`);
}

assert.equal(new Set(OPERATIONS.map(({ mcpName }) => mcpName)).size, OPERATIONS.length, "MCP tool names must be unique");
const document = committed as any;
assert.deepEqual(Object.keys(document.paths["/v1/accounts/{accountId}/feed"].get.responses["200"].content["application/json"].examples), ["page"]);
assert.deepEqual(Object.keys(document.paths["/v1/accounts/{accountId}/actions"].post.requestBody.content["application/json"].examples), ["textPost", "save"]);
assert.deepEqual(Object.keys(document.paths["/v1/actions/{actionId}"].get.responses["200"].content["application/json"].examples), ["queued", "running", "succeeded", "failed", "actionRequired", "unknown", "cancelled"]);
assert.deepEqual(Object.keys(document.paths["/v1/webhooks/subscriptions"].post.requestBody.content["application/json"].examples), ["actionEvents"]);
assert.deepEqual(Object.keys(document.paths["/v1/webhooks/deliveries"].get.responses["200"].content["application/json"].examples), ["retryScheduled"]);
process.stdout.write(`openapi_validation=ok operations=${OPERATIONS.length}\n`);

function validateMediaExamples(media: any, label: string) {
  if (!media?.examples) return;
  for (const [name, example] of Object.entries(media.examples as Record<string, any>)) {
    assert.ok(example && Object.hasOwn(example, "value"), `${label} example ${name} has no value`);
    validateSchema(example.value, media.schema, `${label} example ${name}`);
  }
}

function validateSchema(value: unknown, schema: any, label: string): void {
  if (!schema || Object.keys(schema).length === 0) return;
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate: any) => {
      try { validateSchema(value, candidate, label); return true; } catch { return false; }
    });
    assert.equal(matches.length, 1, `${label} must match exactly one oneOf branch`);
    return;
  }
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${label} violates const`);
  if (schema.enum) assert.equal(schema.enum.includes(value), true, `${label} violates enum`);
  if (schema.type === "null") assert.equal(value, null, `${label} must be null`);
  if (schema.type === "string") {
    assert.equal(typeof value, "string", `${label} must be a string`);
    const text = value as string;
    if (schema.minLength !== undefined) assert.ok(text.length >= schema.minLength, `${label} is shorter than minLength`);
    if (schema.maxLength !== undefined) assert.ok(text.length <= schema.maxLength, `${label} is longer than maxLength`);
    if (schema.pattern) assert.match(text, new RegExp(schema.pattern, "u"), `${label} violates pattern`);
  }
  if (schema.type === "integer") {
    assert.equal(Number.isInteger(value), true, `${label} must be an integer`);
    if (schema.minimum !== undefined) assert.ok((value as number) >= schema.minimum, `${label} is below minimum`);
    if (schema.maximum !== undefined) assert.ok((value as number) <= schema.maximum, `${label} exceeds maximum`);
  }
  if (schema.type === "boolean") assert.equal(typeof value, "boolean", `${label} must be a boolean`);
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${label} must be an array`);
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${label} has too few items`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${label} has too many items`);
    for (const [index, item] of value.entries()) validateSchema(item, schema.items, `${label}[${index}]`);
  }
  if (schema.type === "object") {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) assert.equal(Object.hasOwn(object, key), true, `${label} is missing ${key}`);
    for (const [key, item] of Object.entries(object)) {
      if (schema.properties?.[key]) validateSchema(item, schema.properties[key], `${label}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${label} has unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(item, schema.additionalProperties, `${label}.${key}`);
    }
  }
}
