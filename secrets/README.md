# Local secret mount

Create `secrets/session-key` locally before starting the development Compose stack. The file is ignored by Git and must contain at least 32 random bytes. It is an application encryption key, not a social-network credential.

```sh
umask 077
python3 -c 'import secrets,sys; sys.stdout.buffer.write(secrets.token_bytes(32))' > secrets/session-key
```

Production operators must set `SOCIAL_GIT_SESSION_KEY_FILE` to an existing host file with equivalent permissions. Compose mounts it only into the core container at `/run/secrets/social_git_session_key`. The worker never receives it.
