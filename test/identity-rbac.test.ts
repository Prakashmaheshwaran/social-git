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

test("legacy secondary workspace identities are preserved but fail closed outside the primary data boundary", () => {
  const database = tempDatabase();
  const identity = new IdentityStore(database.path, { tenantId: "tenant-alpha" });
  try {
    const first = identity.createFirstOwner({
      email: "owner@example.test", displayName: "Owner", password: "owner-password-42!",
    });
    const key = identity.createApiKey(first.principal, { name: "primary", scopes: ["accounts:read"] });
    const invitation = identity.createInvitation(first.principal, { email: "legacy@example.test", role: "member" });
    const timestamp = Date.now();
    identity.db.prepare(`INSERT INTO identity_workspaces(id, tenant_id, name, created_by_user_id, created_at, archived_at)
      VALUES ('legacy-secondary', 'tenant-alpha', 'Legacy secondary', ?, ?, NULL)`).run(first.principal.userId, timestamp);
    identity.db.prepare(`INSERT INTO identity_memberships(workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ('legacy-secondary', ?, 'owner', 'active', ?, ?)`).run(first.principal.userId, timestamp, timestamp);

    identity.db.prepare("UPDATE identity_sessions SET workspace_id='legacy-secondary' WHERE user_id=?").run(first.principal.userId);
    identity.db.prepare("UPDATE identity_api_keys SET workspace_id='legacy-secondary' WHERE id=?").run(key.apiKey.id);
    identity.db.prepare("UPDATE identity_invitations SET workspace_id='legacy-secondary' WHERE id=?").run(invitation.invitation.id);

    assert.equal(identity.authenticate(first.token, first.csrfToken), null);
    assert.equal(identity.authenticateApiKey(key.secret), null);
    assert.throws(
      () => identity.acceptInvitation({ token: invitation.token, displayName: "Legacy", password: "legacy-password-42!" }),
      /invalid or expired/u,
    );
    assert.deepEqual(identity.listWorkspaces(first.principal).map(({ id }) => id), ["tenant-alpha"]);
    assert.equal((identity as any).createWorkspace, undefined);
    assert.equal((identity as any).selectWorkspace, undefined);
    assert.equal((identity.db.prepare("SELECT COUNT(*) AS count FROM identity_workspaces WHERE id='legacy-secondary'").get() as any).count, 1);

    const relogin = identity.login({ email: "owner@example.test", password: "owner-password-42!" });
    assert.ok(relogin);
    assert.equal(relogin.principal.workspaceId, "tenant-alpha");
  } finally {
    identity.close();
    database.cleanup();
  }
});
