const MESSAGES = Object.freeze({
  INVALID_ARGUMENT: "The request is invalid.",
  NOT_FOUND: "The account was not found.",
  WRONG_ACCOUNT: "The worker result does not belong to this account.",
  WRONG_IDENTITY: "The native identity did not match the expected identity.",
  STALE_GENERATION: "The account generation is stale.",
  REVOKED: "The account generation is revoked.",
  LEASE_BUSY: "The account already has an active worker lease.",
  STALE_LEASE: "The worker lease is stale.",
  LEASE_EXPIRED: "The worker lease expired.",
  INVALID_STATE: "The account is not in a valid state for this operation.",
  MALFORMED_ENVELOPE: "The encrypted envelope is malformed.",
  BINDING_MISMATCH: "The encrypted envelope binding does not match.",
  CRYPTO_FAILURE: "The encrypted material could not be authenticated.",
  NONCE_REUSE: "The encryption nonce was already used for this context.",
  TENANT_MISMATCH: "The storage tenant does not match.",
  AUDIT_INTEGRITY_FAILURE: "The audit log integrity check failed.",
  MALFORMED_BACKUP: "The encrypted backup is malformed.",
  BACKUP_AUTH_FAILURE: "The encrypted backup could not be authenticated.",
  BACKUP_CONTEXT_MISMATCH: "The encrypted backup context does not match.",
  BACKUP_EXPIRED: "The encrypted backup expired.",
  BACKUP_TOO_LARGE: "The encrypted backup exceeds the size limit.",
  PATH_CONFLICT: "The destination path already exists.",
  MESSAGE_TOO_LARGE: "The worker message exceeds the size limit.",
  MALFORMED_MESSAGE: "The worker message is malformed.",
  OWNERSHIP_VIOLATION: "Only the owning core process can use this runtime.",
  STORAGE_FAILURE: "The core storage operation failed.",
  INTERNAL: "The operation failed."
});

export class SessionRuntimeError extends Error {
  constructor(code, options = undefined) {
    super(MESSAGES[code] ?? MESSAGES.INTERNAL, options);
    this.name = "SessionRuntimeError";
    this.code = MESSAGES[code] ? code : "INTERNAL";
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export function runtimeError(code, _cause = undefined) {
  // Never attach an upstream error. SQLite and protocol-library errors can carry
  // request headers, cookies, or SQL values in their message and cause chain.
  return new SessionRuntimeError(code);
}

export function requireValue(condition, code = "INVALID_ARGUMENT") {
  if (!condition) {
    throw runtimeError(code);
  }
}
