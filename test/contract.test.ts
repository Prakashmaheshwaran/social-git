import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMcpTools, generateOpenApi, LedgerStore, MockRedditAdapter, OPERATIONS, SocialGitService } from "../src/index.ts";
import { principal } from "./helpers.ts";

test("contract: committed OpenAPI and MCP tools come from every typed operation", () => {
  const generated = generateOpenApi();
  const committed = JSON.parse(readFileSync(new URL("../openapi/social-git.openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, generated);
  assert.equal(new Set(OPERATIONS.map((item) => item.operationId)).size, OPERATIONS.length);
  assert.equal(new Set(OPERATIONS.map((item) => item.mcpName)).size, OPERATIONS.length);
  assert.equal("/v1/adapter-events" in generated.paths, false);
  assert.equal("/v1/auth/workspace" in generated.paths, false);
  assert.equal("post" in (generated.paths["/v1/control-plane/workspaces"] as Record<string, unknown>), false);
  assert.equal(OPERATIONS.some((item) => item.operationId === "events.ingest" || item.mcpName === "social_adapter_event_ingest"), false);
  for (const operation of OPERATIONS) {
    const openApiOperation = (generated.paths as Record<string, Record<string, { operationId: string; "x-mcp-tool": string }>>)[operation.path]![operation.method.toLowerCase()]!;
    assert.equal(openApiOperation.operationId, operation.operationId);
    assert.equal(openApiOperation["x-mcp-tool"], operation.mcpName);
  }
  const productionActions = (generated.paths["/v1/accounts/{accountId}/actions"] as any).post;
  const productionKinds = productionActions.requestBody.content["application/json"].schema.oneOf
    .map((variant: any) => variant.properties.kind.const);
  assert.equal(productionActions["x-social-git-availability"], "production");
  assert.equal(productionKinds.includes("message_send"), false);
  assert.equal(productionKinds.includes("message_reply"), false);

  const messageActions = (generated.paths["/v1/accounts/{accountId}/reddit/messages/actions"] as any).post;
  const messageKinds = messageActions.requestBody.content["application/json"].schema.oneOf
    .map((variant: any) => variant.properties.kind.const);
  assert.equal(messageActions["x-social-git-availability"], "fixture_only");
  assert.deepEqual(messageKinds, ["message_send", "message_reply"]);

  const inboxSchema = (generated.paths["/v1/accounts/{accountId}/reddit/messages"] as any)
    .get.responses["200"].content["application/json"].schema;
  assert.equal(inboxSchema.additionalProperties, false);
  assert.equal(inboxSchema.properties.items.maxItems, 100);
  assert.equal(inboxSchema.properties.items.items.additionalProperties, false);
  assert.deepEqual(inboxSchema.properties.items.items.required, [
    "nativeId", "canonicalUrl", "authorNativeId", "recipientNativeId", "subject",
    "body", "wasRead", "parentNativeId", "createdAt",
  ]);
  assert.equal(inboxSchema.properties.items.items.properties.body.maxLength, 10_000);

  const threadSchema = (generated.paths["/v1/accounts/{accountId}/reddit/messages/{messageId}"] as any)
    .get.responses["200"].content["application/json"].schema;
  assert.equal(threadSchema.additionalProperties, false);
  assert.equal(threadSchema.properties.replies.maxItems, 100);
  assert.equal(threadSchema.properties.replies.items.additionalProperties, false);
  const store = new LedgerStore(":memory:");
  const tools = createMcpTools(new SocialGitService({ store, adapters: [new MockRedditAdapter()] }));
  assert.deepEqual(tools.map((tool) => tool.operationId), OPERATIONS.map((operation) => operation.operationId));
  store.close();
});

test("MCP: mapped tools enforce the same auth and invoke the same service", async () => {
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()] });
  const tool = createMcpTools(service).find((item) => item.operationId === "accounts.create")!;
  const denied = await tool.call({ platform: "reddit", expectedNativeUserId: "native-user-1" }, { principal: null });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as any).error.code, "UNAUTHENTICATED");
  const accepted = await tool.call({ platform: "reddit", expectedNativeUserId: "native-user-1" }, { principal });
  assert.equal(accepted.isError, false);
  assert.equal((accepted.structuredContent as any).account.platform, "reddit");
  const isolated = await createMcpTools(service).find((item) => item.operationId === "accounts.list")!.call({}, {
    principal: { ...principal, tenantId: "default", workspaceId: "legacy-secondary" },
  });
  assert.equal(isolated.isError, true);
  assert.equal((isolated.structuredContent as any).error.code, "FORBIDDEN");
  store.close();
});

test("dependency contract excludes official APIs and browser automation", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dependencies = JSON.stringify({ dependencies: manifest.dependencies ?? {}, devDependencies: manifest.devDependencies ?? {} }).toLowerCase();
  for (const forbidden of ["playwright", "selenium", "puppeteer", "chromium", "reddit-api", "snoowrap"]) assert.equal(dependencies.includes(forbidden), false);
});
