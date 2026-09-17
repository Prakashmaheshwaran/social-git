import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateOpenApi } from "../../src/contract.ts";
import { buildCurl, flattenOperations, renderExplorer } from "../api-docs-view.js";

const spec = generateOpenApi();

test("local explorer derives its complete inventory and availability from OpenAPI", () => {
  const operations = flattenOperations(spec);
  assert.ok(operations.length >= 40);
  assert.equal(operations.find(({ operationId }) => operationId === "reads.feed")?.availability, "production");
  const x = operations.find(({ operationId }) => operationId === "x.actions.create");
  assert.equal(x?.availability, "fixture_only");
  assert.deepEqual(x?.disabledReasons, [
    "ENDPOINT_CURRENTNESS_UNPROVEN",
    "CLIENT_TRANSACTION_HEADER_UNPROVEN",
    "AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING",
    "AUTHORIZED_LIVE_READ_PROOF_MISSING",
    "AUTHORIZED_LIVE_WRITE_PROOF_MISSING",
  ]);
});

test("explorer renders filters, validated examples, and disables X production dispatch", () => {
  const html = renderExplorer({ spec, query: "x.actions", platform: "all", availability: "all", activeOperationId: "x.actions.create", error: null });
  assert.match(html, /LOCAL RELEASE ASSET/u);
  assert.match(html, /Fixture contract only/u);
  assert.match(html, /Production dispatch is disabled/u);
  assert.match(html, /CLIENT_TRANSACTION_HEADER_UNPROVEN/u);
  assert.match(html, /data-filter="platform"/u);
});

test("representative read, write, pagination, webhook, error and action-state examples are visible", () => {
  const feed = renderExplorer({ spec, query: "", platform: "all", availability: "all", activeOperationId: "reads.feed", error: null });
  assert.match(feed, /t3_next_opaque_cursor/u);
  const errors = renderExplorer({ spec, query: "", platform: "all", availability: "all", activeOperationId: "reads.profile", error: null });
  assert.match(errors, /Structured error examples/u);
  assert.match(errors, /wrongIdentity/u);
  const action = renderExplorer({ spec, query: "", platform: "all", availability: "all", activeOperationId: "actions.get", error: null });
  for (const state of ["queued", "running", "succeeded", "failed", "actionRequired", "unknown", "cancelled"]) assert.match(action, new RegExp(`>${state}<`, "u"));
  const webhook = renderExplorer({ spec, query: "", platform: "all", availability: "all", activeOperationId: "webhooks.deliveries.list", error: null });
  assert.match(webhook, /retryScheduled/u);
  assert.match(webhook, /DELIVERY_HTTP_ERROR/u);
});

test("cURL builder uses bounded placeholders and never embeds an API key", () => {
  const operation = flattenOperations(spec).find(({ operationId }) => operationId === "actions.create");
  assert.ok(operation);
  const curl = buildCurl(operation, { "path:accountId": "account-1", "header:Idempotency-Key": "once-1", body: '{"kind":"save","targetId":"t3_example"}' });
  assert.match(curl, /Bearer <API_KEY>/u);
  assert.match(curl, /Idempotency-Key: once-1/u);
  assert.match(curl, /\/v1\/accounts\/account-1\/actions/u);
  assert.doesNotMatch(curl, /sgk_[A-Za-z0-9_-]+/u);
});

test("explorer escapes contract text and release page has no hosted assets or inline code", () => {
  const malicious = structuredClone(spec);
  malicious.paths["/healthz"].get.summary = '<img src=x onerror="alert(1)">';
  const html = renderExplorer({ spec: malicious, query: "", platform: "all", availability: "all", activeOperationId: "health.get", error: null });
  assert.doesNotMatch(html, /<img src=x/u);
  assert.match(html, /&lt;img src=x/u);
  const page = readFileSync(new URL("../api-docs.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /https?:\/\//u);
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/u);
  assert.match(page, /\/docs\/assets\/api-docs\.js/u);
});
