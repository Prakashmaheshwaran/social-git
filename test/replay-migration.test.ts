import assert from "node:assert/strict";
import test from "node:test";
import { INTERNAL_ACTION_RESULT_SOURCE, LedgerStore, SocialGitService } from "../src/index.ts";
import { fixture, principal, tempDatabase } from "./helpers.ts";

const internalEventPrincipal = { ...principal, scopes: [...principal.scopes, "events:ingest"] };

test("webhook/event replay: identical adapter events apply exactly once", async () => {
  const { service, store, accountId } = await fixture();
  const queued = await service.enqueueAction(principal, accountId, "event-key", { kind: "save", targetId: "post-1" });
  const claim = store.claimNextAction()!;
  const event = {
    version: 1, eventId: "worker-event-1", source: INTERNAL_ACTION_RESULT_SOURCE, accountId, type: "action.result", occurredAt: "2026-09-14T00:00:00.000Z",
    payload: { actionId: queued.action.id, attempt: 1, claimToken: claim.claimToken, state: "succeeded", result: { nativeId: "post-1", canonicalUrl: "https://www.reddit.com/post-1/" } },
  };
  const first = await service.ingestAdapterEvent(internalEventPrincipal, event);
  const replay = await service.ingestAdapterEvent(internalEventPrincipal, event);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.action.state, "succeeded");
  assert.equal(store.listAuditEvents({ limit: 100 }).items.filter((item) => item.type === "adapter.event.applied").length, 1);
  await assert.rejects(() => service.ingestAdapterEvent(internalEventPrincipal, { ...event, payload: { ...event.payload, state: "failed" } }), (error: any) => error.code === "IDEMPOTENCY_CONFLICT");
  store.close();
});

test("webhook/event replay: a stale attempt cannot complete a replacement worker claim", async () => {
  const { service, store, accountId } = await fixture({ recoverOnStart: false });
  const queued = await service.enqueueAction(principal, accountId, "event-fence", { kind: "save", targetId: "post-1" });
  const staleClaim = store.claimNextAction()!;
  store.recoverInterruptedActions();
  const currentClaim = store.claimNextAction()!;
  const event = {
    version: 1,
    eventId: "stale-worker-event",
    source: INTERNAL_ACTION_RESULT_SOURCE,
    accountId,
    type: "action.result",
    occurredAt: "2026-09-14T00:00:00.000Z",
    payload: { actionId: queued.action.id, attempt: 1, claimToken: staleClaim.claimToken, state: "succeeded", result: { nativeId: "stale" } },
  };
  await assert.rejects(
    () => service.ingestAdapterEvent(internalEventPrincipal, event),
    (error: any) => error.code === "ACTION_STATE_CONFLICT",
  );
  assert.equal(store.getActionInternal(queued.action.id).state, "running");
  const current = await service.ingestAdapterEvent(internalEventPrincipal, {
    ...event,
    eventId: "current-worker-event",
    payload: { ...event.payload, attempt: 2, claimToken: currentClaim.claimToken, result: { nativeId: "current" } },
  });
  assert.equal(current.action.state, "succeeded");
  assert.equal((current.action.result as any).nativeId, "current");
  store.close();
});

test("adapter result fencing rejects wrong tenant, caller, source, account, claim, and attempt without leaking a result", async () => {
  const { service, store, accountId } = await fixture({ recoverOnStart: false });
  const queued = await service.enqueueAction(principal, accountId, "event-bindings", { kind: "save", targetId: "post-guarded" });
  const claim = store.claimNextAction()!;
  const event = {
    version: 1,
    eventId: "bound-worker-event",
    source: INTERNAL_ACTION_RESULT_SOURCE,
    accountId,
    type: "action.result",
    occurredAt: "2026-09-14T00:00:00.000Z",
    payload: {
      actionId: queued.action.id,
      attempt: claim.attemptCount,
      claimToken: claim.claimToken,
      state: "succeeded",
      result: { nativeId: "guarded-result" },
    },
  };
  const cases = [
    [{ ...internalEventPrincipal, tenantId: "wrong-tenant" }, event, "FORBIDDEN"],
    [{ ...internalEventPrincipal, callerId: "other-caller" }, event, "NOT_FOUND"],
    [internalEventPrincipal, { ...event, source: "unregistered-worker" }, "ACTION_STATE_CONFLICT"],
    [internalEventPrincipal, { ...event, accountId: "other-account" }, "ACTION_STATE_CONFLICT"],
    [internalEventPrincipal, { ...event, payload: { ...event.payload, claimToken: "wrong-claim" } }, "ACTION_STATE_CONFLICT"],
    [internalEventPrincipal, { ...event, payload: { ...event.payload, attempt: claim.attemptCount + 1 } }, "ACTION_STATE_CONFLICT"],
  ] as const;
  for (const [actor, candidate, code] of cases) {
    await assert.rejects(
      () => service.ingestAdapterEvent(actor, candidate),
      (error: any) => error.code === code && !JSON.stringify(error).includes("guarded-result"),
    );
    assert.equal(store.getActionInternal(queued.action.id).state, "running");
  }

  const accepted = await service.ingestAdapterEvent(internalEventPrincipal, event);
  assert.equal((accepted.action.result as any).nativeId, "guarded-result");
  await assert.rejects(
    () => service.ingestAdapterEvent({ ...internalEventPrincipal, callerId: "other-caller" }, event),
    (error: any) => error.code === "NOT_FOUND" && !JSON.stringify(error).includes("guarded-result"),
  );
  await assert.rejects(
    () => service.getAction({ ...principal, callerId: "other-caller" }, queued.action.id),
    (error: any) => error.code === "NOT_FOUND" && !JSON.stringify(error).includes("guarded-result"),
  );
  store.close();
});

test("migration: a version-one ledger upgrades in place and preserves records", async () => {
  const database = tempDatabase();
  try {
    const legacy = new LedgerStore(database.path, { maxMigrationVersion: 1 });
    const account = legacy.createAccount({ platform: "reddit", expectedNativeUserId: "native-user-1", callerId: "migration-test" });
    assert.equal(legacy.migrationVersion(), 1);
    legacy.close();
    const upgraded = new LedgerStore(database.path);
    assert.equal(upgraded.migrationVersion(), 7);
    assert.equal(upgraded.ledgerId, "default-action-ledger");
    assert.equal(upgraded.getAccount(account.id).expectedNativeUserId, "native-user-1");
    const indexes = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='actions_state_created_idx'").all();
    assert.equal(indexes.length, 1);
    const actionColumns = upgraded.db.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>;
    assert.equal(actionColumns.some((column) => column.name === "claim_token"), true);
    assert.equal(actionColumns.some((column) => column.name === "attempt_count"), true);
    upgraded.close();
  } finally { database.cleanup(); }
});
