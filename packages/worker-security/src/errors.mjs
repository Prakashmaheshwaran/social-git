export const SECURITY_ERROR_CODES = Object.freeze({
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
  DESTINATION_DENIED: "DESTINATION_DENIED",
  DNS_REBINDING: "DNS_REBINDING",
  IPC_BOUNDS: "IPC_BOUNDS",
  IPC_FENCE: "IPC_FENCE",
  IPC_SCHEMA: "IPC_SCHEMA",
  REDIRECT_DENIED: "REDIRECT_DENIED",
  RESPONSE_BOUNDS: "RESPONSE_BOUNDS",
  ROUTE_DENIED: "ROUTE_DENIED",
  RUNTIME_ISOLATION: "RUNTIME_ISOLATION"
});

export class WorkerSecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkerSecurityError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new WorkerSecurityError(code, message);
}
