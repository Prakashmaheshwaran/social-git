import { ACTION_LEDGER_SCHEMA_VERSION } from "./ledger-backup.ts";
import { IDENTITY_SCHEMA_VERSION } from "./identity.ts";
import { SESSION_RUNTIME_SCHEMA_VERSION } from "@social-git/core";

export const READINESS_CONTRACT_VERSION = 1;
export const DIAGNOSTIC_COUNT_LIMIT = 10_000;

export interface RuntimeReadinessInput {
  mode: "production" | "fixture";
  databases: {
    actions: { migrationVersion: number; journalMode: string; integrity: string };
    sessions: { schemaVersion: number; journalMode: string };
    identity: { schemaVersion: number; journalMode: string; integrity: string };
  };
  workers: {
    action: { running: boolean; paused: boolean; busy: boolean; processed: number; failures?: number };
    webhook: { running: boolean; paused: boolean; busy: boolean; processed: number; failures?: number };
    redditReachable: boolean;
    xReachable: boolean;
  };
  maintenance: { active: boolean; activeRequests: number };
  counts: { queuedActions: number; runningActions: number; unknownActions: number; webhookPending: number; webhookExhausted: number };
  xAdmission: { productionEnabled: boolean; disabledReasons: readonly string[] };
  certificationGrantActive: boolean;
}

export interface RuntimeReadiness {
  ready: boolean;
  contractVersion: typeof READINESS_CONTRACT_VERSION;
  checks: Record<string, unknown>;
}

export function buildRuntimeReadiness(input: RuntimeReadinessInput): RuntimeReadiness {
  const actionsReady = input.databases.actions.migrationVersion === ACTION_LEDGER_SCHEMA_VERSION
    && input.databases.actions.integrity === "ok";
  const sessionsReady = input.databases.sessions.schemaVersion === SESSION_RUNTIME_SCHEMA_VERSION;
  const identityReady = input.databases.identity.schemaVersion === IDENTITY_SCHEMA_VERSION
    && input.databases.identity.integrity === "ok";
  const actionWorkerReady = input.workers.action.running && !input.workers.action.paused;
  const webhookWorkerReady = input.workers.webhook.running && !input.workers.webhook.paused;
  const redditRequired = input.mode === "production";
  const redditReady = !redditRequired || input.workers.redditReachable;
  // X is deliberately optional until its production admission succeeds. Its
  // worker is still probed so deployment drift is visible without falsely
  // advertising X as an available capability.
  const xRequired = input.mode === "production" && input.xAdmission.productionEnabled;
  const xReady = !xRequired || input.workers.xReachable;
  const ready = actionsReady && sessionsReady && identityReady && actionWorkerReady
    && webhookWorkerReady && redditReady && xReady && !input.maintenance.active;

  return Object.freeze({
    ready,
    contractVersion: READINESS_CONTRACT_VERSION,
    checks: Object.freeze({
      // Compatibility summaries retained for pre-v1 clients. Detailed fields
      // below are the versioned contract and never include tenant identifiers.
      actionWorker: actionWorkerReady,
      webhookWorker: webhookWorkerReady,
      redditWorker: input.mode === "fixture" || input.workers.redditReachable,
      xWorkerReachable: input.mode === "fixture" || input.workers.xReachable,
      productWritesReady: actionWorkerReady && redditReady && actionsReady && sessionsReady && !input.maintenance.active,
      certificationGrantActive: input.certificationGrantActive,
      writeExecutionMode: input.certificationGrantActive ? "product_with_certification" : "product",
      databases: Object.freeze({
        actions: databaseCheck(actionsReady, input.databases.actions.migrationVersion, ACTION_LEDGER_SCHEMA_VERSION, input.databases.actions.journalMode, input.databases.actions.integrity),
        sessions: databaseCheck(sessionsReady, input.databases.sessions.schemaVersion, SESSION_RUNTIME_SCHEMA_VERSION, input.databases.sessions.journalMode),
        identity: databaseCheck(identityReady, input.databases.identity.schemaVersion, IDENTITY_SCHEMA_VERSION, input.databases.identity.journalMode, input.databases.identity.integrity),
      }),
      workers: Object.freeze({
        action: backgroundWorkerCheck(input.workers.action),
        webhook: backgroundWorkerCheck(input.workers.webhook),
        reddit: Object.freeze({
          required: redditRequired,
          reachable: input.mode === "fixture" ? null : input.workers.redditReachable,
          state: input.mode === "fixture" ? "fixture_embedded" : input.workers.redditReachable ? "reachable" : "unreachable",
        }),
        x: Object.freeze({
          required: xRequired,
          reachable: input.mode === "fixture" ? null : input.workers.xReachable,
          state: input.mode === "fixture" ? "fixture_embedded" : input.workers.xReachable ? "reachable" : "unreachable",
          admission: input.xAdmission.productionEnabled ? "enabled" : "capability_disabled",
          productionEnabled: input.xAdmission.productionEnabled,
          disabledReasons: Object.freeze([...input.xAdmission.disabledReasons]),
        }),
      }),
      maintenance: Object.freeze({
        ready: !input.maintenance.active,
        state: input.maintenance.active ? "active" : "idle",
        activeRequests: boundedCount(input.maintenance.activeRequests),
      }),
      backlog: Object.freeze({
        limit: DIAGNOSTIC_COUNT_LIMIT,
        actions: Object.freeze({
          queued: boundedCount(input.counts.queuedActions),
          running: boundedCount(input.counts.runningActions),
          unknown: boundedCount(input.counts.unknownActions),
        }),
        webhooks: Object.freeze({
          pending: boundedCount(input.counts.webhookPending),
          exhausted: boundedCount(input.counts.webhookExhausted),
        }),
      }),
      product: Object.freeze({
        redditWritesReady: actionWorkerReady && redditReady && actionsReady && sessionsReady && !input.maintenance.active,
        certificationGrantActive: input.certificationGrantActive,
        writeExecutionMode: input.certificationGrantActive ? "product_with_certification" : "product",
      }),
    }),
  });
}

function databaseCheck(ready: boolean, current: number, expected: number, journalMode: string, integrity = "not_reported") {
  return Object.freeze({ ready, migration: Object.freeze({ current, expected }), journalMode, integrity });
}

function backgroundWorkerCheck(input: RuntimeReadinessInput["workers"]["action"]) {
  const ready = input.running && !input.paused;
  return Object.freeze({
    ready,
    state: !input.running ? "stopped" : input.paused ? "paused" : input.busy ? "busy" : "idle",
    processed: boundedCount(input.processed),
    failures: boundedCount(input.failures ?? 0),
  });
}

export function boundedCount(value: number) {
  const safe = Number.isSafeInteger(value) && value > 0 ? value : 0;
  return Object.freeze({ value: Math.min(safe, DIAGNOSTIC_COUNT_LIMIT), truncated: safe > DIAGNOSTIC_COUNT_LIMIT });
}

export class InternalWorkerReadinessProbe {
  private readonly url: string;

  constructor(dispatchUrl: string) {
    this.url = new URL("/readyz", dispatchUrl).toString();
  }

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(this.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(2_000) });
      // No response content is trusted or returned by Core. Status is enough to
      // prove the fixed internal endpoint answered within the deadline.
      await response.body?.cancel();
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
