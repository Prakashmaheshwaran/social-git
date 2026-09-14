import type { SessionRuntime } from "@social-git/core";

export type RoleValue = string;
export interface TrustedActor { readonly actorId: string; readonly role: RoleValue }
export interface LiveTestGrant {
  readonly authorizationId: string;
  readonly ledgerId: string;
  readonly environment: string;
  readonly artifactDigest: string;
  readonly sbomDigest: string;
  readonly testEvidenceDigest: string;
  readonly canaryAccountId: string;
  readonly expectedNativeIdentity: string;
  readonly sessionGeneration: number;
  readonly routeId: string;
  readonly platform: string;
  readonly readOperations: readonly string[];
  readonly writeOperations: readonly string[];
  readonly resourceConstraints: readonly (readonly [string, string])[];
  readonly cleanupOperation: string | null;
  readonly actionLimit: number;
  readonly qaOperatorId: string;
  readonly qaOperatorRole: string;
  readonly approverId: string;
  readonly approverRole: string;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface LiveTestGrantInput {
  authorizationId: string;
  ledgerId: string;
  environment: string;
  artifactDigest: string;
  sbomDigest: string;
  testEvidenceDigest: string;
  canaryAccountId: string;
  expectedNativeIdentity: string;
  sessionGeneration: number;
  routeId: string;
  readOperations: string[];
  writeOperations: string[];
  resourceConstraints: Record<string, string>;
  cleanupOperation?: string | null;
  actionLimit: number;
  notBefore: number;
  expiresAt: number;
}

export interface LiveEvidence {
  readonly authorizationId: string;
  readonly actionId: string;
  readonly artifactDigest: string;
  readonly operation: string;
  readonly outcome: string;
  readonly nativeId: string | null;
  readonly canonicalUrl: string | null;
}

export const Role: Readonly<{
  PLATFORM_SECURITY_ADMIN: "platform_security_admin";
  SESSION_NETWORK_CUSTODIAN: "session_network_custodian";
  API_CALLER: "api_caller";
  CORE_RUNTIME: "core_runtime";
  PLATFORM_WORKER: "platform_worker";
  DEVELOPER: "developer";
  RESEARCHER: "researcher";
  SECURITY_REVIEWER: "security_reviewer";
  BACKUP_OPERATOR: "backup_operator";
  INDEPENDENT_LIVE_QA: "independent_live_qa";
}>;
export const Permission: Readonly<{
  [key: string]: string;
  CONSUME_LIVE_AUTHORIZATION: "consume_live_authorization";
  DECRYPT_FENCED_JOB_SECRET: "decrypt_fenced_job_secret";
}>;
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>>;
export const AuthorizationErrorCode: Readonly<{
  [key: string]: string;
  STOPPED: "STOPPED";
}>;
export const StopReason: Readonly<{
  CHALLENGE: "CHALLENGE";
  CHECKPOINT: "CHECKPOINT";
  CAPTCHA: "CAPTCHA";
  RATE_LIMIT: "RATE_LIMIT";
  WRONG_IDENTITY: "WRONG_IDENTITY";
  REVOKED_SESSION: "REVOKED_SESSION";
  PROTOCOL_DRIFT: "PROTOCOL_DRIFT";
  UNEXPECTED_REDIRECT: "UNEXPECTED_REDIRECT";
  POLICY_DENIED: "POLICY_DENIED";
  UNKNOWN: "UNKNOWN";
}>;
export const LiveOutcome: Readonly<{ SUCCEEDED: "SUCCEEDED" }>;

export class AuthorizationError extends Error {
  readonly code: string;
  toJSON(): { name: string; code: string; message: string };
}

export class RoleAuthority {
  constructor(bindings: Array<{ actorId: string; role: string }>);
  principalFor(actorId: string): TrustedActor;
}

export function hasPermission(principal: TrustedActor, permission: string): boolean;
export function assertPermission(principal: TrustedActor, permission: string): void;
export function approveLiveTestGrant(
  input: LiveTestGrantInput,
  actors: { qaOperator: TrustedActor; approver: TrustedActor }
): LiveTestGrant;
export function liveTestGrantFingerprint(grant: LiveTestGrant): string;

export class LiveAuthorizationLedger {
  constructor(databasePath: string);
  readonly startupRecovery: Readonly<{ unknown: number }>;
  readonly recoveredUnknownActionIds: readonly string[];
  registerGrant(grant: LiveTestGrant, now?: number): string;
  authorizeAndRecord(grant: LiveTestGrant, request: Record<string, unknown>, now?: number): Readonly<Record<string, unknown>>;
  complete(decision: Readonly<Record<string, unknown>>, outcome: string, now?: number): void;
  actionState(authorizationId: string, actionId: string): Readonly<{ state: string; outcome: string | null }> | null;
  stop(authorizationId: string, reason: string): void;
  close(): void;
}

export class LiveTestController {
  constructor(ledger: LiveAuthorizationLedger);
  execute(
    grant: LiveTestGrant,
    request: Record<string, unknown>,
    options: {
      now?: number;
      coreActor: TrustedActor;
      sessionRuntime: SessionRuntime;
      actionStore: { markSubmissionStarted(actionId: string): void };
      dispatch(command: Uint8Array): Promise<string | Uint8Array> | string | Uint8Array;
      payload: unknown;
      leaseTtlMs?: number;
      crashAfterRecord?: boolean;
    }
  ): Promise<LiveEvidence>;
}
