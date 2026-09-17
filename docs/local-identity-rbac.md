# Local identity, the data workspace, and RBAC

Social Git keeps human identity local to each self-hosted installation. The one-step first run creates the initial owner, the installation's primary data workspace, an owner membership, and an HttpOnly browser session. There are no default credentials and no hosted identity dependency.

Each installation intentionally has exactly one data workspace. Multiple local users and API keys can share that boundary through role-based access, but secondary data workspaces cannot be created or selected. This matches the current storage boundary: accounts, encrypted social sessions and routes, actions and idempotency, usage, webhooks, audit history, and the encrypted three-database backup are installation-scoped. Pretending those stores were separately partitioned would expose an unsafe, non-functional workspace surface.

## Roles

- `owner` controls memberships, one-time invitations, API keys, backups, and all installation operations. The final active owner cannot be demoted or deactivated.
- `admin` can operate the social data plane using the documented API scopes but cannot manage identities, invitations, or owner API keys.
- `member` receives bounded read and action scopes; it cannot manage webhooks, identities, or API keys.

Authorization is based on the active `identity_memberships` row for the primary workspace. Deactivating a membership immediately revokes its browser sessions and API keys. Role changes take effect for existing browser sessions on their next request and revoke API keys minted under the prior role so durable credentials cannot retain stale authority.

## Provisioning

An owner can create a local member directly at `POST /v1/control-plane/members`, or create a one-time invitation at `POST /v1/control-plane/invitations`. Social Git does not send mail. The invitation token is returned once and must be shared through a trusted channel. Only its SHA-256 digest is stored; it expires after 24 hours by default (configurable from 1 through 168 hours) and cannot be replayed.

Invitations are accepted at `POST /v1/invitations/accept`. Passwords are processed locally with the same bounded scrypt parameters as the first owner. Login and API-key authentication retain bounded, fail-closed rate limits.

## Data-boundary binding

Browser sessions and API keys contain an explicit `workspaceId`, which must equal the installation `tenantId`. Login, invitation acceptance, browser-session authentication, API-key authentication, and owner authorization all enforce that invariant. Legacy records bound to any other workspace are retained by backup and restore but cannot authenticate or reach the data plane.

`GET /v1/control-plane/workspaces` returns the single primary workspace and the caller's active role. There is no workspace-creation or workspace-switch endpoint. To obtain an independent social-data boundary, deploy another Social Git installation with separate keys and volumes.

Every control-plane mutation requires the same-site HttpOnly cookie plus the in-memory CSRF proof. Neither passwords, invitation tokens, API-key secrets, nor CSRF values appear in audit payloads. Identity events are mirrored into the existing redacted tenant audit cursor under the `identity.*` namespace while the dedicated identity database remains part of encrypted backup and restore.

The generated OpenAPI document is authoritative for request and response shapes. Use the Team page for routine provisioning and membership lifecycle operations.
