import assert from "node:assert/strict";
import test from "node:test";
import { OPERATIONS, executeOperation } from "../src/index.ts";
import { allScopes, fixture, principal } from "./helpers.ts";

test("queue: caller list filters and cursors never expose request payloads", async () => {
  const { service, store, accountId } = await fixture();
  const other = { callerId: "api-key:key-other", scopes: allScopes };
  await service.enqueueAction(principal, accountId, "first", { kind: "save", targetId: "post-secret-1" });
  await service.enqueueAction(principal, accountId, "second", { kind: "unsave", targetId: "post-secret-2" });
  await service.enqueueAction(other, accountId, "third", { kind: "save", targetId: "post-secret-3" });

  const first = await service.listActions(principal, { state: "queued", kind: "save", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.nextCursor, null, "caller and kind filtering happens before pagination");
  assert.equal(JSON.stringify(first).includes("post-secret"), false);
  assert.equal((await service.listActions(other, { limit: 100 })).items.length, 1);
  await assert.rejects(
    () => service.listActions(other, { callerId: principal.callerId }),
    (error: any) => error.code === "FORBIDDEN",
  );

  const owner = { callerId: "owner:user-one", tenantId: "default", role: "owner" as const, scopes: ["*"] };
  const tenantPage = await service.listActions(owner, { limit: 2 });
  assert.equal(tenantPage.items.length, 2);
  assert.equal(typeof tenantPage.nextCursor, "string");
  const remainder = await service.listActions(owner, { cursor: tenantPage.nextCursor!, limit: 2 });
  assert.equal(remainder.items.length, 1);
  store.close();
});

test("cancellation: only an unclaimed queue record can reach immutable cancelled", async () => {
  const { service, store, accountId, adapter } = await fixture({ recoverOnStart: false });
  const queued = await service.enqueueAction(principal, accountId, "cancel-original", { kind: "save", targetId: "post-1" });
  const cancelled = await service.cancelAction(principal, queued.action.id, "cancel-request-1");
  assert.equal(cancelled.action.state, "cancelled");
  assert.equal(cancelled.action.submissionMayHaveStarted, false);
  assert.equal(cancelled.replayed, false);
  assert.equal((await service.cancelAction(principal, queued.action.id, "cancel-request-1")).replayed, true);
  await assert.rejects(
    () => service.cancelAction(principal, queued.action.id, "cancel-request-2"),
    (error: any) => error.code === "ACTION_STATE_CONFLICT",
  );
  const originalReplay = await service.enqueueAction(principal, accountId, "cancel-original", { kind: "save", targetId: "post-1" });
  assert.equal(originalReplay.action.state, "cancelled");
  assert.equal(originalReplay.action.id, queued.action.id);
  assert.equal(await service.runNextAction(), null);
  assert.equal(adapter.submitCount, 0);

  const claimable = await service.enqueueAction(principal, accountId, "claimed-original", { kind: "save", targetId: "post-2" });
  const claim = store.claimNextAction()!;
  assert.equal(claim.id, claimable.action.id);
  await assert.rejects(
    () => service.cancelAction(principal, claim.id, "cancel-after-claim"),
    (error: any) => error.code === "ACTION_STATE_CONFLICT",
  );
  store.markSubmissionStarted(claim.id, claim.claimToken!);
  store.transitionAction(claim.id, ["running"], "UNKNOWN", { error: { code: "UNKNOWN_RESULT" }, claimToken: claim.claimToken! });
  await assert.rejects(
    () => service.cancelAction(principal, claim.id, "cancel-after-submit"),
    (error: any) => error.code === "ACTION_STATE_CONFLICT",
  );
  const unknownReplay = await service.enqueueAction(principal, accountId, "claimed-original", { kind: "save", targetId: "post-2" });
  assert.equal(unknownReplay.action.state, "UNKNOWN");
  assert.equal(await service.runNextAction(), null);
  store.close();
});

test("usage: dispatcher records bounded redacted tenant/key/account/operation aggregates", async () => {
  const { service, store, accountId } = await fixture();
  const apiPrincipal = { callerId: "api-key:key-17", tenantId: "default", scopes: allScopes };
  const operation = OPERATIONS.find((candidate) => candidate.operationId === "actions.create")!;
  await executeOperation(service, operation, apiPrincipal, {
    accountId,
    idempotencyKey: "usage-action",
    action: { kind: "save", targetId: "content-never-in-usage" },
  });
  const owner = { callerId: "owner:user-one", tenantId: "default", role: "owner" as const, scopes: ["*"] };
  const aggregate = await service.usage(owner, { groupBy: "tenant,key,account,operation", limit: 100 });
  const item = aggregate.items.find((candidate) => candidate.operationId === "actions.create");
  assert.equal(item?.tenantId, "default");
  assert.equal(item?.keyId, "key-17");
  assert.equal(item?.accountId, accountId);
  assert.equal(item?.count, 1);
  assert.equal(JSON.stringify(aggregate).includes("content-never-in-usage"), false);
  const columns = store.db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>;
  assert.deepEqual(columns.map(({ name }) => name), [
    "sequence", "tenant_id", "caller_id", "key_id", "account_id", "operation_id", "outcome", "recorded_at",
  ]);
  const own = await service.usage(apiPrincipal, { groupBy: "operation", limit: 100 });
  assert.equal(own.items.some((candidate) => candidate.operationId === "actions.create"), true);
  await assert.rejects(
    () => service.usage(apiPrincipal, { groupBy: "key" }),
    (error: any) => error.code === "FORBIDDEN",
  );
  store.close();
});

test("usage: a non-primary workspace cannot write analytics into the primary ledger", async () => {
  const { service, store } = await fixture();
  service.recordOperationUsage({
    callerId: "user:other-workspace",
    tenantId: "default",
    workspaceId: "workspace-other",
    scopes: ["usage:read"],
  }, "accounts.list", "failed", "account-primary");
  assert.deepEqual(store.usageAggregates({ tenantId: "default" }).items, []);
  store.close();
});

test("contracts: action queue, cancellation, and usage are typed REST and MCP operations", () => {
  const byId = new Map(OPERATIONS.map((operation) => [operation.operationId, operation]));
  assert.equal(byId.get("actions.list")?.method, "GET");
  assert.equal(byId.get("actions.cancel")?.path, "/v1/actions/{actionId}/cancel");
  assert.equal(byId.get("actions.cancel")?.parameters?.some((parameter) => parameter.name === "Idempotency-Key"), true);
  assert.equal(byId.get("usage.list")?.scope, "usage:read");
  assert.equal(new Set(OPERATIONS.map((operation) => operation.mcpName)).size, OPERATIONS.length);
});
