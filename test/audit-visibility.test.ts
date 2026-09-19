import assert from "node:assert/strict";
import test from "node:test";
import { LedgerStore, MockRedditAdapter, SocialGitService } from "../src/index.ts";
import { allScopes } from "./helpers.ts";

function principalFor(callerId: string, role?: "owner" | "admin" | "member") {
  return { callerId, scopes: allScopes, ...(role === undefined ? {} : { role }) };
}

test("audit visibility: owner and admin see all callers, member sees only its own events", async () => {
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()] });
  try {
    const owner = principalFor("user:owner-1", "owner");
    const admin = principalFor("user:admin-1", "admin");
    const memberA = principalFor("user:member-a", "member");
    const memberB = principalFor("user:member-b", "member");

    await service.createAccount(owner, { platform: "reddit", expectedNativeUserId: "native-owner" });
    await service.createAccount(memberA, { platform: "reddit", expectedNativeUserId: "native-a" });
    await service.createAccount(memberB, { platform: "reddit", expectedNativeUserId: "native-b" });

    const ownerView = await service.listAuditEvents(owner, { limit: 100 });
    const adminView = await service.listAuditEvents(admin, { limit: 100 });
    const memberAView = await service.listAuditEvents(memberA, { limit: 100 });
    const memberBView = await service.listAuditEvents(memberB, { limit: 100 });

    assert.ok(ownerView.items.length >= 3);
    assert.ok(adminView.items.length >= 3);
    // Owner/admin retain workspace-wide visibility.
    assert.deepEqual(
      new Set(ownerView.items.map((item) => item.callerId)),
      new Set(["user:owner-1", "user:member-a", "user:member-b"]),
    );
    assert.deepEqual(
      new Set(adminView.items.map((item) => item.callerId)),
      new Set(["user:owner-1", "user:member-a", "user:member-b"]),
    );
    // Ordinary members see only their own callerId.
    assert.ok(memberAView.items.length >= 1);
    assert.ok(memberAView.items.every((item) => item.callerId === "user:member-a"));
    assert.ok(memberBView.items.length >= 1);
    assert.ok(memberBView.items.every((item) => item.callerId === "user:member-b"));
    assert.equal(memberAView.items.some((item) => item.callerId === "user:member-b"), false);
  } finally {
    store.close();
  }
});

test("audit visibility: role-less API-key caller is restricted to its own events", async () => {
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()] });
  try {
    const owner = principalFor("user:owner-1", "owner");
    const apiKey = { callerId: "api-key:key-1", scopes: allScopes };
    await service.createAccount(owner, { platform: "reddit", expectedNativeUserId: "native-owner" });
    await service.createAccount(apiKey, { platform: "reddit", expectedNativeUserId: "native-key" });
    const view = await service.listAuditEvents(apiKey, { limit: 100 });
    assert.ok(view.items.length >= 1);
    assert.ok(view.items.every((item) => item.callerId === "api-key:key-1"));
  } finally {
    store.close();
  }
});

test("audit visibility: persistence callerId filter composes with accountId", async () => {
  const store = new LedgerStore(":memory:");
  try {
    store.audit({ callerId: "user:a", accountId: "acc-1", type: "t", outcome: "succeeded", data: {} });
    store.audit({ callerId: "user:b", accountId: "acc-1", type: "t", outcome: "succeeded", data: {} });
    store.audit({ callerId: "user:a", accountId: "acc-2", type: "t", outcome: "succeeded", data: {} });
    assert.equal(store.listAuditEvents({ callerId: "user:a", limit: 100 }).items.length, 2);
    assert.equal(store.listAuditEvents({ callerId: "user:a", accountId: "acc-1", limit: 100 }).items.length, 1);
    assert.equal(store.listAuditEvents({ callerId: "user:b", accountId: "acc-1", limit: 100 }).items.length, 1);
    assert.equal(store.listAuditEvents({ callerId: "user:b", accountId: "acc-2", limit: 100 }).items.length, 0);
  } finally {
    store.close();
  }
});
