export type WorkerIntent = "identity_validation" | "refresh" | "read" | "write";
export type WorkerResultStatus =
  | "SUCCEEDED"
  | "AUTH_FAILURE"
  | "CHALLENGE"
  | "CHECKPOINT"
  | "CAPTCHA"
  | "RATE_LIMITED"
  | "REVOKED"
  | "PROTOCOL_DRIFT"
  | "UNEXPECTED_REDIRECT"
  | "POLICY_DENIED"
  | "NOT_EXECUTED"
  | "UNKNOWN";

export interface WorkerCommand {
  version: 1;
  type: "social-git.worker.command";
  requestId: string;
  tenantId: string;
  accountId: string;
  platform: string;
  generation: number;
  leaseId: string;
  fence: number;
  expiresAt: number;
  intent: WorkerIntent;
  operation: string;
  expectedNativeIdentity: string;
  sessionBase64: string;
  networkRoute: { id: string; materialBase64: string };
  payload: unknown;
}

export interface WorkerResult {
  version: 1;
  type: "social-git.worker.result";
  requestId: string;
  tenantId: string;
  accountId: string;
  platform: string;
  generation: number;
  leaseId: string;
  fence: number;
  status: WorkerResultStatus;
  observedNativeIdentity?: string;
}

export type WorkerMessage = WorkerCommand | WorkerResult;

export function validateWorkerCommand(message: unknown): WorkerCommand;
export function validateWorkerResult(message: unknown): WorkerResult;
export function validateWorkerMessage(message: unknown): WorkerMessage;
export function encodeWorkerMessage(message: WorkerMessage, maximumBytes?: number): Uint8Array;
export function decodeWorkerMessage(
  message: string | Uint8Array,
  maximumBytes?: number
): WorkerMessage;
export function summarizeWorkerMessage(message: WorkerMessage): Record<string, unknown>;

export const WORKER_MESSAGE_VERSION: 1;
export const MAX_WORKER_MESSAGE_BYTES: number;
export const MAX_SESSION_BYTES: number;
export const MAX_NETWORK_ROUTE_BYTES: number;
export const WORKER_RESULT_STATUSES: readonly WorkerResultStatus[];
