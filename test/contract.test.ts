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
  for (const operation of OPERATIONS) {
    const openApiOperation = (generated.paths as Record<string, Record<string, { operationId: string; "x-mcp-tool": string }>>)[operation.path]![operation.method.toLowerCase()]!;
    assert.equal(openApiOperation.operationId, operation.operationId);
    assert.equal(openApiOperation["x-mcp-tool"], operation.mcpName);
  }
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
  store.close();
});

test("dependency contract excludes official APIs and browser automation", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dependencies = JSON.stringify({ dependencies: manifest.dependencies ?? {}, devDependencies: manifest.devDependencies ?? {} }).toLowerCase();
  for (const forbidden of ["playwright", "selenium", "puppeteer", "chromium", "reddit-api", "snoowrap"]) assert.equal(dependencies.includes(forbidden), false);
});
