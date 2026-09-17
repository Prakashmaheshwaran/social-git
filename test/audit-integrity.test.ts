import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { IdentityAuditBridge } from "../src/identity-audit-bridge.ts";
import { IdentityStore } from "../src/identity.ts";
import { LedgerStore } from "../src/persistence.ts";
import { WebhookManager } from "../src/webhooks.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "social-git-audit-chain-"));
  return {
    root,
    action: join(root, "actions.sqlite"),
    identity: join(root, "identity.sqlite"),
    key: randomBytes(32),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("authenticated action audit detects mutation and retained heads detect authenticated rollback", () => {
  const files = fixture();
  try {
    let store = new LedgerStore(files.action, { ledgerId: "ledger-test", auditKey: files.key });
    store.audit({ callerId: "operator", type: "test.first", outcome: "succeeded", data: { safe: "one" } });
    store.audit({ callerId: "operator", type: "test.second", outcome: "succeeded", data: { safe: "two" } });
    const retained = store.auditChainHeads().audit;
    store.close();

    let database = new DatabaseSync(files.action);
    database.exec("DROP TRIGGER audit_events_no_update; UPDATE audit_events SET outcome='failed' WHERE sequence=1;");
    database.close();
    assert.throws(() => new LedgerStore(files.action, { ledgerId: "ledger-test", auditKey: files.key }), /authentication failed/u);

    rmSync(files.action, { force: true });
    rmSync(`${files.action}-wal`, { force: true });
    rmSync(`${files.action}-shm`, { force: true });
    store = new LedgerStore(files.action, { ledgerId: "ledger-test", auditKey: files.key });
    store.audit({ callerId: "operator", type: "test.first", outcome: "succeeded" });
    const oldHead = store.auditChainHeads().audit;
    store.audit({ callerId: "operator", type: "test.second", outcome: "succeeded" });
    const newHead = store.auditChainHeads().audit;
    store.close();
    database = new DatabaseSync(files.action);
    database.exec("DROP TRIGGER audit_events_no_delete;");
    database.prepare("DELETE FROM audit_events WHERE sequence=2").run();
    database.prepare("UPDATE audit_chain_heads SET sequence=?, event_id=?, mac=? WHERE stream='ledger-audit-v1'")
      .run(oldHead.sequence, oldHead.eventId, oldHead.mac);
    database.close();
    store = new LedgerStore(files.action, { ledgerId: "ledger-test", auditKey: files.key });
    assert.throws(() => store.auditChainHeads({ audit: newHead }), /externally retained head/u);
    store.close();
    assert.notDeepEqual(retained, oldHead);
  } finally { files.key.fill(0); files.cleanup(); }
});

test("authenticated webhook chain rejects a tampered durable event", () => {
  const files = fixture();
  try {
    const store = new LedgerStore(files.action, { ledgerId: "ledger-test", auditKey: files.key });
    const webhooks = new WebhookManager(store, { tenantId: "tenant-test", encryptionKey: randomBytes(32) });
    webhooks.enqueue("action:one:queued", "action.queued", { actionId: "one", state: "queued" });
    assert.equal(store.auditChainHeads().webhooks.sequence, 1);
    webhooks.close();
    store.close();
    const database = new DatabaseSync(files.action);
    database.exec("DROP TRIGGER webhook_events_no_update; UPDATE webhook_events SET payload_json='{}' WHERE chain_sequence=1;");
    database.close();
    assert.throws(() => new LedgerStore(files.action, { ledgerId: "ledger-test", auditKey: files.key }), /authentication failed/u);
  } finally { files.key.fill(0); files.cleanup(); }
});

test("identity outbox replays a crash exactly once while preserving identity and order", () => {
  const files = fixture();
  try {
    const ledger = new LedgerStore(files.action, { ledgerId: "ledger-test", auditKey: files.key });
    const identity = new IdentityStore(files.identity, { tenantId: "tenant-test", auditKey: files.key });
    const owner = identity.createFirstOwner({ email: "owner@example.test", displayName: "Owner", password: "owner-password-42!" }).principal;
    const invitation = identity.createInvitation(owner, { email: "member@example.test", role: "member" });
    const source = identity.db.prepare("SELECT id, sequence FROM identity_audit_events ORDER BY sequence").all() as Array<{ id: string; sequence: number }>;
    assert.equal(source.length, 2);
    const crashing = new IdentityAuditBridge(identity, ledger, { afterPublicProjection() { throw new Error("simulated crash"); } });
    assert.throws(() => crashing.drain(), /simulated crash/u);
    assert.equal(identity.pendingAuditProjections().length, 2);

    const restarted = new IdentityAuditBridge(identity, ledger);
    assert.equal(restarted.drain(), 2);
    assert.equal(identity.pendingAuditProjections().length, 0);
    const projected = ledger.db.prepare("SELECT id, source_sequence FROM audit_events WHERE source_kind='identity' ORDER BY source_sequence").all() as Array<{ id: string; source_sequence: number }>;
    assert.deepEqual(projected.map(({ id, source_sequence }) => ({ id, source_sequence })), source.map(({ id, sequence }) => ({ id, source_sequence: sequence })));
    assert.equal(new Set(projected.map(({ id }) => id)).size, 2);
    assert.equal(JSON.stringify(ledger.listAuditEvents({ limit: 100 })).includes(invitation.token), false);
    ledger.auditChainHeads();
    identity.auditChainHead();
    identity.close();
    ledger.close();
  } finally { files.key.fill(0); files.cleanup(); }
});

test("identity audit chain and append-only guards reject mutation and deletion", () => {
  const files = fixture();
  try {
    let identity = new IdentityStore(files.identity, { tenantId: "tenant-test", auditKey: files.key });
    identity.createFirstOwner({ email: "owner@example.test", displayName: "Owner", password: "owner-password-42!" });
    assert.throws(() => identity.db.prepare("DELETE FROM identity_audit_events").run(), /append-only/u);
    identity.close();
    const database = new DatabaseSync(files.identity);
    database.exec("DROP TRIGGER identity_audit_no_update; UPDATE identity_audit_events SET outcome='failed' WHERE sequence=1;");
    database.close();
    assert.throws(() => { identity = new IdentityStore(files.identity, { tenantId: "tenant-test", auditKey: files.key }); }, /authentication failed/u);
  } finally { files.key.fill(0); files.cleanup(); }
});
