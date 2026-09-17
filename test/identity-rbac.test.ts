import assert from "node:assert/strict";
import test from "node:test";
import { IdentityStore } from "../src/identity.ts";
import { tempDatabase } from "./helpers.ts";

test("local workspace RBAC provisions users, binds sessions and keys, and enforces least privilege", () => {
  const database = tempDatabase();
  const identity = new IdentityStore(database.path, { tenantId: "tenant-alpha" });
  try {
    const owner = identity.createFirstOwner({
      email: "owner@example.test", displayName: "Owner", password: "owner-password-42!",
    }).principal;
    assert.equal(owner.workspaceId, "tenant-alpha");
    assert.deepEqual(identity.listWorkspaces(owner).map(({ id, role }) => ({ id, role })), [
      { id: "tenant-alpha", role: "owner" },
    ]);

    const member = identity.provisionUser(owner, {
      email: "member@example.test", displayName: "Member", password: "member-password-42!", role: "member",
    });
    const session = identity.login({ email: member.email, password: "member-password-42!" });
    assert.ok(session);
    assert.equal(session.principal.role, "member");
    assert.equal(session.principal.workspaceId, owner.workspaceId);
    assert.equal(session.principal.scopes.includes("webhooks:write"), false);
    assert.throws(() => identity.createApiKey(session.principal, { name: "forbidden", scopes: ["accounts:read"] }), /Owner authorization/u);

    const admin = identity.provisionUser(owner, {
      email: "admin@example.test", displayName: "Admin", password: "admin-password-42!", role: "admin",
    });
    assert.equal(admin.role, "admin");
    assert.equal(identity.login({ email: admin.email, password: "admin-password-42!" })?.principal.role, "admin");
  } finally {
    identity.close();
    database.cleanup();
  }
});

test("one-time invitations never persist plaintext tokens and cannot be replayed", () => {
  const database = tempDatabase();
  const identity = new IdentityStore(database.path, { tenantId: "tenant-alpha" });
  try {
    const owner = identity.createFirstOwner({
      email: "owner@example.test", displayName: "Owner", password: "owner-password-42!",
    }).principal;
    const created = identity.createInvitation(owner, { email: "invitee@example.test", role: "member", expiresInHours: 1 });
    const row = identity.db.prepare("SELECT token_hash, consumed_at FROM identity_invitations WHERE id=?").get(created.invitation.id) as any;
    assert.equal(Buffer.from(row.token_hash).length, 32);
    assert.notEqual(Buffer.from(row.token_hash).toString("utf8"), created.token);
    assert.equal(row.consumed_at, null);
    const accepted = identity.acceptInvitation({ token: created.token, displayName: "Invitee", password: "invitee-password-42!" });
    assert.equal(accepted.principal.role, "member");
    assert.equal(accepted.principal.workspaceId, owner.workspaceId);
    assert.throws(() => identity.acceptInvitation({ token: created.token, displayName: "Replay", password: "replay-password-42!" }), /invalid or expired/u);
  } finally {
    identity.close();
    database.cleanup();
  }
});

test("membership deactivation revokes sessions and owned keys, and last-owner guard is transactional", () => {
  const database = tempDatabase();
  const identity = new IdentityStore(database.path, { tenantId: "tenant-alpha" });
  try {
    const ownerSession = identity.createFirstOwner({
      email: "owner@example.test", displayName: "Owner", password: "owner-password-42!",
    });
    assert.throws(
      () => identity.updateMembership(ownerSession.principal, ownerSession.principal.userId, { role: "admin" }),
      (error: any) => error.code === "LAST_OWNER",
    );
    const second = identity.provisionUser(ownerSession.principal, {
      email: "owner2@example.test", displayName: "Second owner", password: "owner2-password-42!", role: "owner",
    });
    const secondSession = identity.login({ email: second.email, password: "owner2-password-42!" })!;
    const key = identity.createApiKey(secondSession.principal, { name: "worker", scopes: ["accounts:read"] });
    identity.updateMembership(ownerSession.principal, second.userId, { status: "inactive" });
    assert.equal(identity.authenticate(secondSession.token, secondSession.csrfToken), null);
    assert.equal(identity.authenticateApiKey(key.secret), null);
    assert.equal(identity.listMembers(ownerSession.principal).find((item) => item.userId === second.userId)?.status, "inactive");
  } finally {
    identity.close();
    database.cleanup();
  }
});

test("workspace switching rotates the browser session and prevents cross-workspace key management", () => {
  const database = tempDatabase();
  const identity = new IdentityStore(database.path, { tenantId: "tenant-alpha" });
  try {
    const first = identity.createFirstOwner({
      email: "owner@example.test", displayName: "Owner", password: "owner-password-42!",
    });
    const secondWorkspace = identity.createWorkspace(first.principal, { name: "Operations" });
    const selected = identity.selectWorkspace(first.principal, secondWorkspace.id, first.token);
    assert.equal(identity.authenticate(first.token, first.csrfToken), null);
    assert.equal(selected.principal.workspaceId, secondWorkspace.id);
    const key = identity.createApiKey(selected.principal, { name: "ops", scopes: ["accounts:read"] });
    assert.equal(key.apiKey.workspaceId, secondWorkspace.id);
    const back = identity.selectWorkspace(selected.principal, "tenant-alpha", selected.token);
    assert.deepEqual(identity.listApiKeys(back.principal), []);
    assert.throws(() => identity.revokeApiKey(back.principal, key.apiKey.id), /not found/u);
  } finally {
    identity.close();
    database.cleanup();
  }
});
