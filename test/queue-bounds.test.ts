import assert from "node:assert/strict";
import test from "node:test";
import {
  LedgerStore,
  MockRedditAdapter,
  SocialGitService,
  WebhookManager,
} from "../src/index.ts";
import { allScopes } from "./helpers.ts";

const webhookKey = Buffer.alloc(32, 7);
const callerA = { callerId: "caller-a", scopes: allScopes };
const callerB = { callerId: "caller-b", scopes: allScopes };

function saveRequest(target: string) {
  return { kind: "save", targetId: target };
}

function assertRateLimited(error: unknown, expected: { limit: number; retryAfterSeconds: number }) {
  assert.ok(error instanceof Error, "expected a ServiceError");
  const coded = error as { code?: string; status?: number; retryable?: boolean; rateLimit?: Record<string, unknown> };
  assert.equal(coded.code, "RATE_LIMITED");
  assert.equal(coded.status, 429);
  assert.equal(coded.retryable, true);
  assert.equal(coded.rateLimit?.limit, expected.limit);
  assert.equal(coded.rateLimit?.remaining, 0);
  assert.equal(coded.rateLimit?.retryAfterSeconds, expected.retryAfterSeconds);
}

test("queue bounds: action backlog admits under-limit, rejects at-limit, and recovers after drain", () => {
  const store = new LedgerStore(":memory:", {
    actionQueueLimits: { maxPerAccount: 3, maxPerCallerAccount: 2 },
  });
  try {
    const accountA = store.createAccount({ platform: "reddit", expectedNativeUserId: "native-a", callerId: callerA.callerId });
    const accountB = store.createAccount({ platform: "reddit", expectedNativeUserId: "native-b", callerId: callerA.callerId });

    // Under-limit success.
    const first = store.createAction({ callerId: callerA.callerId, accountId: accountA.id, idempotencyKey: "a-1", request: saveRequest("post-1") });
    assert.equal(first.replayed, false);
    const second = store.createAction({ callerId: callerA.callerId, accountId: accountA.id, idempotencyKey: "a-2", request: saveRequest("post-2") });
    assert.equal(second.replayed, false);

    // At-limit rejection for the same caller/account (per-caller bound = 2).
    assert.throws(
      () => store.createAction({ callerId: callerA.callerId, accountId: accountA.id, idempotencyKey: "a-3", request: saveRequest("post-3") }),
      (error: unknown) => {
        assertRateLimited(error, { limit: 2, retryAfterSeconds: 60 });
        return true;
      },
    );

    // Idempotent replay at the bound still succeeds without growing the queue.
    const replay = store.createAction({ callerId: callerA.callerId, accountId: accountA.id, idempotencyKey: "a-1", request: saveRequest("post-1") });
    assert.equal(replay.replayed, true);
    assert.deepEqual(store.pendingActionDepth({ accountId: accountA.id, callerId: callerA.callerId }), { perAccount: 2, perCallerAccount: 2 });

    // Caller isolation: another caller can still use the same account until the
    // per-account bound is reached.
    const other = store.createAction({ callerId: callerB.callerId, accountId: accountA.id, idempotencyKey: "b-1", request: saveRequest("post-9") });
    assert.equal(other.replayed, false);
    assert.throws(
      () => store.createAction({ callerId: callerB.callerId, accountId: accountA.id, idempotencyKey: "b-2", request: saveRequest("post-10") }),
      (error: unknown) => {
        assertRateLimited(error, { limit: 3, retryAfterSeconds: 60 });
        return true;
      },
    );

    // Account isolation: a different account is unaffected by accountA pressure.
    const isolated = store.createAction({ callerId: callerA.callerId, accountId: accountB.id, idempotencyKey: "iso-1", request: saveRequest("post-1") });
    assert.equal(isolated.replayed, false);

    // Recovery once backlog drains: terminal transition frees admission.
    store.transitionAction(first.action.id, ["queued"], "succeeded", { result: { nativeId: "post-1" } });
    const recovered = store.createAction({ callerId: callerA.callerId, accountId: accountA.id, idempotencyKey: "a-4", request: saveRequest("post-4") });
    assert.equal(recovered.replayed, false);

    // UNKNOWN rows are preserved as evidence and do not count as backlog.
    store.transitionAction(second.action.id, ["queued"], "UNKNOWN", { error: { code: "UNKNOWN_RESULT" } });
    assert.equal(store.getActionInternal(second.action.id).state, "UNKNOWN");
    const afterUnknown = store.createAction({ callerId: callerA.callerId, accountId: accountA.id, idempotencyKey: "a-5", request: saveRequest("post-5") });
    assert.equal(afterUnknown.replayed, false);
    assert.equal(store.getActionInternal(second.action.id).state, "UNKNOWN");
  } finally {
    store.close();
  }
});

test("queue bounds: service enqueueAction surfaces structured 429 and recovers after the worker drains", async () => {
  const store = new LedgerStore(":memory:", {
    actionQueueLimits: { maxPerAccount: 2, maxPerCallerAccount: 2 },
  });
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter("native-user-1")] });
  try {
    const account = (await service.createAccount(callerA, { platform: "reddit", expectedNativeUserId: "native-user-1" })).account;
    await service.importConnection(callerA, account.id, { vaultHandle: "vault://fixture/session", generation: 1 });
    await service.enqueueAction(callerA, account.id, "q-1", saveRequest("post-1"));
    await service.enqueueAction(callerA, account.id, "q-2", saveRequest("post-2"));
    await assert.rejects(
      service.enqueueAction(callerA, account.id, "q-3", saveRequest("post-3")),
      (error: unknown) => {
        assertRateLimited(error, { limit: 2, retryAfterSeconds: 60 });
        return true;
      },
    );
    const completed = await service.runNextAction();
    assert.equal(completed?.state, "succeeded");
    const afterDrain = await service.enqueueAction(callerA, account.id, "q-3", saveRequest("post-3"));
    assert.equal(afterDrain.replayed, false);
  } finally {
    store.close();
  }
});

test("queue bounds: webhook outbox admits under-limit, isolates subscriptions/tenants, and recovers", async () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, {
    tenantId: "tenant-a",
    encryptionKey: webhookKey,
    queueLimits: { maxPerSubscription: 2, maxPerTenant: 3 },
    transport: { async send() { return { status: 204 }; } },
  });
  const otherTenant = new WebhookManager(store, { tenantId: "tenant-b", encryptionKey: webhookKey });
  try {
    const succeeded = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "sub-succeeded", url: "https://example.com/succeeded",
      eventTypes: ["action.succeeded"],
    }).subscription;
    const failed = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "sub-failed", url: "https://example.com/failed",
      eventTypes: ["action.failed"],
    }).subscription;

    // Under-limit success.
    manager.enqueue("action:one:succeeded", "action.succeeded", { actionId: "one" });
    manager.enqueue("action:two:succeeded", "action.succeeded", { actionId: "two" });
    assert.deepEqual(manager.pendingDepth({ subscriptionId: succeeded.id }), { pending: 2 });

    // At-limit rejection for the saturated subscription.
    assert.throws(
      () => manager.enqueue("action:three:succeeded", "action.succeeded", { actionId: "three" }),
      (error: unknown) => {
        assertRateLimited(error, { limit: 2, retryAfterSeconds: 30 });
        return true;
      },
    );

    // Idempotent replay at the bound does not grow the outbox.
    const replay = manager.enqueue("action:one:succeeded", "action.succeeded", { actionId: "one" });
    assert.equal(replay.replayed, true);
    assert.deepEqual(manager.pendingDepth({ subscriptionId: succeeded.id }), { pending: 2 });

    // Subscription isolation: an unrelated event type still has capacity.
    manager.enqueue("action:nine:failed", "action.failed", { actionId: "nine" });
    assert.deepEqual(manager.pendingDepth({ subscriptionId: failed.id }), { pending: 1 });

    // Tenant isolation: another tenant is unaffected by tenant-a pressure.
    otherTenant.createSubscription({
      callerId: "owner-b", idempotencyKey: "other", url: "https://example.com/other",
      eventTypes: ["action.succeeded"],
    });
    const isolated = otherTenant.enqueue("action:other:succeeded", "action.succeeded", { actionId: "other" });
    assert.equal(isolated.replayed, false);

    // Recovery once backlog drains.
    const delivered = await manager.deliverNext();
    assert.equal(delivered?.state, "delivered");
    manager.enqueue("action:three:succeeded", "action.succeeded", { actionId: "three" });
    assert.deepEqual(manager.pendingDepth({ subscriptionId: succeeded.id }), { pending: 2 });
  } finally {
    manager.close();
    otherTenant.close();
    store.close();
  }
});

test("queue bounds: service actions still succeed when the webhook backlog is saturated", async () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, {
    tenantId: "default",
    encryptionKey: webhookKey,
    queueLimits: { maxPerSubscription: 1, maxPerTenant: 1 },
    transport: { async send() { return { status: 204 }; } },
  });
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter("native-user-1")], webhooks: manager });
  try {
    await service.createWebhookSubscription(callerA, {
      idempotencyKey: "saturated", url: "https://example.com/events",
      eventTypes: ["action.queued", "action.succeeded"],
    });
    // Saturate the single pending slot directly.
    manager.enqueue("action:seed:succeeded", "action.succeeded", { actionId: "seed" });
    const account = (await service.createAccount(callerA, { platform: "reddit", expectedNativeUserId: "native-user-1" })).account;
    await service.importConnection(callerA, account.id, { vaultHandle: "vault://fixture/session", generation: 1 });
    // The ledger admission succeeds even though action.queued notifications are
    // shedding load; the durable action remains authoritative.
    const queued = await service.enqueueAction(callerA, account.id, "ledger-wins", saveRequest("post-1"));
    assert.equal(queued.action.state, "queued");
    const completed = await service.runNextAction();
    assert.equal(completed?.state, "succeeded");
    assert.equal(store.getActionInternal(queued.action.id).state, "succeeded");
  } finally {
    manager.close();
    store.close();
  }
});

test("queue bounds: multi-subscription fan-out cannot overshoot the tenant cap", () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, {
    tenantId: "tenant-a",
    encryptionKey: webhookKey,
    queueLimits: { maxPerSubscription: 10, maxPerTenant: 3 },
    transport: { async send() { return { status: 204 }; } },
  });
  try {
    const first = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "fanout-one", url: "https://example.com/one",
      eventTypes: ["action.succeeded"],
    }).subscription;
    const second = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "fanout-two", url: "https://example.com/two",
      eventTypes: ["action.succeeded"],
    }).subscription;

    // One event matching both subscriptions consumes two tenant slots.
    manager.enqueue("action:fanout:one", "action.succeeded", { actionId: "fanout-one" });
    assert.deepEqual(manager.pendingDepth(), { pending: 2 });

    // A second two-target event would reach 4 pending and exceed the tenant
    // cap of 3, so the whole event is rejected atomically.
    assert.throws(
      () => manager.enqueue("action:fanout:two", "action.succeeded", { actionId: "fanout-two" }),
      (error: unknown) => {
        assertRateLimited(error, { limit: 3, retryAfterSeconds: 30 });
        return true;
      },
    );

    // No partial fan-out and no orphan event row were persisted.
    assert.deepEqual(manager.pendingDepth({ subscriptionId: first.id }), { pending: 1 });
    assert.deepEqual(manager.pendingDepth({ subscriptionId: second.id }), { pending: 1 });
    assert.deepEqual(manager.pendingDepth(), { pending: 2 });
    const orphan = store.db.prepare(
      "SELECT id FROM webhook_events WHERE tenant_id=? AND source_key=?",
    ).get("tenant-a", "action:fanout:two") as { id: string } | undefined;
    assert.equal(orphan, undefined);
  } finally {
    manager.close();
    store.close();
  }
});

test("queue bounds: saturated reconciliation stops safely without losing evidence", async () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, {
    tenantId: "tenant-a",
    encryptionKey: webhookKey,
    queueLimits: { maxPerSubscription: 10, maxPerTenant: 1 },
    transport: { async send() { return { status: 204 }; } },
  });
  try {
    manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "reconcile-sub", url: "https://example.com/reconcile",
      eventTypes: ["action.queued"],
    });
    const account = store.createAccount({ platform: "reddit", expectedNativeUserId: "native-a", callerId: callerA.callerId });
    const created = store.createAction({
      callerId: callerA.callerId, accountId: account.id, idempotencyKey: "durable-1", request: saveRequest("post-1"),
    });
    // Saturate the single tenant slot with an unrelated filler event.
    manager.enqueue("action:filler:queued", "action.queued", { actionId: "filler" });
    assert.deepEqual(manager.pendingDepth(), { pending: 1 });

    // Startup reconciliation must not throw when the outbox is full; it stops
    // and reports backpressure while leaving every row of evidence intact.
    const saturated = manager.reconcileDurableEvents();
    assert.equal(saturated.backpressured, true);
    assert.equal(store.getActionInternal(created.action.id).state, "queued");
    assert.deepEqual(manager.pendingDepth(), { pending: 1 });
    const missing = store.db.prepare(
      "SELECT id FROM webhook_events WHERE tenant_id=? AND source_key=?",
    ).get("tenant-a", `action:${created.action.id}:queued`) as { id: string } | undefined;
    assert.equal(missing, undefined);

    // Once a slot drains, the next reconciliation pass resumes and persists
    // the previously skipped durable event without duplicating the filler.
    const delivered = await manager.deliverNext();
    assert.equal(delivered?.state, "delivered");
    const resumed = manager.reconcileDurableEvents();
    assert.equal(resumed.backpressured, false);
    assert.deepEqual(manager.pendingDepth(), { pending: 1 });
    const restored = store.db.prepare(
      "SELECT id FROM webhook_events WHERE tenant_id=? AND source_key=?",
    ).get("tenant-a", `action:${created.action.id}:queued`) as { id: string } | undefined;
    assert.ok(restored);
  } finally {
    manager.close();
    store.close();
  }
});
