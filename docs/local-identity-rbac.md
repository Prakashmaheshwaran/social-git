# Local identity, workspaces, and RBAC

Social Git keeps human identity local to each self-hosted installation. The one-step first run creates the initial owner, default workspace, owner membership, and an HttpOnly browser session. There are no default credentials and no hosted identity dependency.

## Roles

- `owner` controls memberships, one-time invitations, API keys, backups, and all workspace operations. The final active owner cannot be demoted or deactivated.
- `admin` can operate the social data plane using the documented API scopes but cannot manage identities, invitations, or owner API keys.
- `member` receives bounded read and action scopes; it cannot manage webhooks, identities, or API keys.

Authorization is based on the active `identity_memberships` row. Deactivating a membership immediately revokes its browser sessions and API keys in that workspace.

## Provisioning

An owner can create a local member directly at `POST /v1/control-plane/members`, or create a one-time invitation at `POST /v1/control-plane/invitations`. Social Git does not send mail. The invitation token is returned once and must be shared through a trusted channel. Only its SHA-256 digest is stored; it expires after 24 hours by default (configurable from 1 through 168 hours) and cannot be replayed.

Invitations are accepted at `POST /v1/invitations/accept`. Passwords are processed locally with the same bounded scrypt parameters as the first owner. Login and API-key authentication retain bounded, fail-closed rate limits.

## Workspace binding

Browser sessions and API keys contain an explicit workspace binding. `POST /v1/auth/workspace` verifies an active membership, revokes the old browser session, rotates both cookie and CSRF proof, and issues a new workspace-bound session. API-key listing, rotation, and revocation use the selected workspace and return `NOT_FOUND` for a key belonging to another workspace.

Every control-plane mutation requires the same-site HttpOnly cookie plus the in-memory CSRF proof. Neither passwords, invitation tokens, API-key secrets, nor CSRF values appear in audit payloads. Identity events are mirrored into the existing redacted tenant audit cursor under the `identity.*` namespace while the dedicated identity database remains part of encrypted backup and restore.

The generated OpenAPI document is authoritative for request and response shapes. Use the Team page for routine provisioning and membership lifecycle operations.
