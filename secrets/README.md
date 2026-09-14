# Local secret mounts

Development Compose expects four ignored, private files:

- `secrets/master-key`: canonical base64url for one random 32-byte encryption key.
- `secrets/audit-key`: canonical base64url for a different random 32-byte audit key.
- `secrets/backup-key`: canonical base64url for a different random 32-byte backup key.
- `secrets/auth.json`: bearer-token SHA-256 digests, caller IDs, and scopes. It must not contain a bearer token.

Create the three keys with a local secret tool and set mode `0600`. Keep them outside source control. Production supplies their paths through `SOCIAL_GIT_MASTER_KEY_FILE`, `SOCIAL_GIT_AUDIT_KEY_FILE`, and `SOCIAL_GIT_BACKUP_KEY_FILE`. Supply the private authentication file through `SOCIAL_GIT_AUTH_FILE`.

Compose mounts these files only into Core. Reddit worker receives no secret, database, backup, import, or restore mount.
