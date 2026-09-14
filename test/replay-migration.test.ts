import assert from "node:assert/strict";
import test from "node:test";
import { LedgerStore, SocialGitService } from "../src/index.ts";
import { fixture, principal, tempDatabase } from "./helpers.ts";

test("webhook/event replay: identical adapter events apply exactly once", async () => {
  const { service, store, accountId } = await fixture();
  const queued = await service.enqueueAction(principal, accountId, "event-key", { kind: "save", targetId: "post-1" });
  store.claimNextAction();
  const event = {
    version: 1, eventId: "worker-event-1", source: "reddit-worker-1", accountId, type: "action.result", occurredAt: "2026-09-14T00:00:00.000Z",
    payload: { actionId: queued.action.id, state: "succeeded", result: { nativeId: "post-1", canonicalUrl: "https://www.reddit.com/post-1/" } },
  };
  const first = await service.ingestAdapterEvent(principal, event);
  const replay = await service.ingestAdapterEvent(principal, event);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.action.state, "succeeded");
  assert.equal(store.listAuditEvents({ limit: 100 }).items.filter((item) => item.type === "adapter.event.applied").length, 1);
  await assert.rejects(() => service.ingestAdapterEvent(principal, { ...event, payload: { ...event.payload, state: "failed" } }), (error: any) => error.code === "IDEMPOTENCY_CONFLICT");
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
    assert.equal(upgraded.migrationVersion(), 4);
    assert.equal(upgraded.ledgerId, "default-action-ledger");
    assert.equal(upgraded.getAccount(account.id).expectedNativeUserId, "native-user-1");
    const indexes = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='actions_state_created_idx'").all();
    assert.equal(indexes.length, 1);
    upgraded.close();
  } finally { database.cleanup(); }
});
