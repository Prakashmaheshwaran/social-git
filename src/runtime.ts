import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { SessionRuntime, createSafeLogger, redactError } from "@social-git/core";
import {
  LiveAuthorizationLedger,
  Role,
  RoleAuthority,
  approveLiveTestGrant,
  type LiveTestGrantInput,
} from "@social-git/security";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { SequentialActionWorker } from "./action-worker.ts";
import { createSocialGitHttpServer, hashedBearerAuthenticator } from "./http.ts";
import {
  createDefaultApiKeyRateLimit,
  IdentityHttpController,
  IdentityStore,
  type ApiKeyRateLimitHook,
} from "./identity.ts";
import { BoundedLiveActionExecutor } from "./live-execution.ts";
import { LedgerStore } from "./persistence.ts";
import { ProductionRedditAdapter } from "./reddit-adapter.ts";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.ts";
import { CoreRedditTransportProvider, DirectorySessionSource, RemoteRedditCommandDispatcher } from "./runtime-reddit.ts";
import { ScopeAuthorizer, SocialGitService, type Principal } from "./service.ts";
import { DisabledXPlatformAdapter, XFixturePlatformAdapter } from "./x-adapter.ts";
import { deriveWebhookEncryptionKey, WebhookDeliveryWorker, WebhookManager } from "./webhooks.ts";

export interface RunningSocialGitRuntime {
  readonly url: string;
  readonly config: RuntimeConfig;
  readonly service: SocialGitService;
  close(): Promise<void>;
}

export async function startSocialGitRuntime(
  config = loadRuntimeConfig(),
  options: { apiKeyRateLimit?: ApiKeyRateLimitHook } = {},
): Promise<RunningSocialGitRuntime> {
  const traces: Array<Record<string, unknown>> = [];
  const logger = createSafeLogger((level, message, fields) => {
    const event = { level, message, ...(fields && typeof fields === "object" ? fields as Record<string, unknown> : {}) };
    traces.push(event);
    if (traces.length > 1000) traces.shift();
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });
  const store = new LedgerStore(config.actionDatabasePath, { ledgerId: config.ledgerId });
  const identityStore = new IdentityStore(config.identityDatabasePath, { tenantId: config.tenantId });
  const webhookKey = deriveWebhookEncryptionKey(config.masterKey);
  const webhooks = new WebhookManager(store, {
    tenantId: config.tenantId,
    encryptionKey: webhookKey,
  });
  webhookKey.fill(0);
  let sessionRuntime: SessionRuntime;
  try {
    sessionRuntime = new SessionRuntime({
      databasePath: config.sessionDatabasePath,
      tenantId: config.tenantId,
      masterKey: config.masterKey,
      auditKey: config.auditKey,
    });
  } catch (error) {
    webhooks.close();
    identityStore.close();
    store.close();
    throw error;
  } finally {
    config.masterKey.fill(0);
    config.auditKey.fill(0);
  }

  let authorizationLedger: LiveAuthorizationLedger | undefined;
  let fixtureAdapter: import("./fixture-reddit-adapter.ts").FixtureRedditPlatformAdapter | undefined;
  let xFixtureAdapter: XFixturePlatformAdapter | undefined;
  let liveExecutor: BoundedLiveActionExecutor | undefined;
  const dispatcher = new RemoteRedditCommandDispatcher(config.redditWorkerUrl);
  let adapter: ProductionRedditAdapter | import("./fixture-reddit-adapter.ts").FixtureRedditPlatformAdapter;

  try {
    if (config.mode === "fixture") {
      const { FixtureRedditPlatformAdapter } = await import("./fixture-reddit-adapter.ts");
      fixtureAdapter = new FixtureRedditPlatformAdapter(sessionRuntime);
      adapter = fixtureAdapter;
      xFixtureAdapter = new XFixturePlatformAdapter();
    } else {
      const provider = new CoreRedditTransportProvider({
        runtime: sessionRuntime,
        source: new DirectorySessionSource(config.sessionImportDir!),
        dispatcher,
      });
      adapter = new ProductionRedditAdapter(provider);
      if (config.liveGrantFile) {
        const live = loadLiveAuthorization(config, sessionRuntime, dispatcher);
        authorizationLedger = live.ledger;
        liveExecutor = live.executor;
      }
    }

    const service = new SocialGitService({
      store,
      adapters: [adapter, xFixtureAdapter ?? new DisabledXPlatformAdapter()],
      authorizer: new ScopeAuthorizer(),
      tenantId: config.tenantId,
      ...(liveExecutor ? { liveActionExecutor: liveExecutor } : {}),
      webhooks,
    });
    webhooks.reconcileDurableEvents();
    const worker = new SequentialActionWorker(service, { intervalMs: config.workerIntervalMs });
    const webhookWorker = new WebhookDeliveryWorker(webhooks, Math.max(config.workerIntervalMs, 250));
    worker.start();
    webhookWorker.start();

    const fixtureControl = fixtureAdapter && xFixtureAdapter ? createFixtureControl(fixtureAdapter, xFixtureAdapter, sessionRuntime, store, config, traces) : undefined;
    const baseAuthenticator = hashedBearerAuthenticator(config.authEntries);
    const identity = new IdentityHttpController(
      identityStore,
      config.sessionCookieSecure,
      options.apiKeyRateLimit ?? createDefaultApiKeyRateLimit(),
    );
    const server = createSocialGitHttpServer({
      service,
      authenticate: async (request) => {
        const bearer = await baseAuthenticator(request);
        if (bearer) {
          const bound = { ...bearer, tenantId: bearer.tenantId ?? config.tenantId };
          return config.mode === "fixture" ? fixturePrincipal(request, bound) : bound;
        }
        const apiKey = identity.authenticateApiKeyRequest(request);
        if (apiKey) return apiKey;
        return identity.authenticateRequest(request);
      },
      identity,
      readiness: async () => {
        const ledger = store.diagnostics();
        const webhook = webhooks.diagnostics();
        const redditWorkerReady = config.mode === "fixture" || await dispatcher.ready();
        const productWritesReady = worker.diagnostics().running && redditWorkerReady;
        return {
          ready: ledger.integrity === "ok" && productWritesReady,
          checks: {
            ledgerMigration: ledger.migrationVersion,
            ledgerJournal: ledger.journalMode,
            ledgerIntegrity: ledger.integrity,
            queuedActions: ledger.queuedActions,
            runningActions: ledger.runningActions,
            unknownActions: ledger.unknownActions,
            sessionRuntime: sessionRuntime.diagnostics().schemaVersion,
            actionWorker: worker.diagnostics().running,
            redditWorker: redditWorkerReady,
            productWritesReady,
            certificationGrantActive: liveExecutor !== undefined,
            writeExecutionMode: liveExecutor ? "product_with_certification" : "product",
            webhookPending: webhook.pending,
            webhookExhausted: webhook.exhausted,
          },
        };
      },
      onActionQueued: () => worker.wake(),
      onRequest: (event) => logger.info("request.complete", event),
      ...(fixtureControl ? { fixtureControl } : {}),
    });
    server.listen(config.port, config.host);
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => Promise.reject(error)),
    ]);
    const address = server.address() as AddressInfo;
    const url = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
    const redditWorkerReady = config.mode === "fixture" || await dispatcher.ready();
    logger.info("runtime.ready", {
      mode: config.mode,
      host: address.address,
      port: address.port,
      startupRecovery: service.startupRecovery,
      redditWorkerReady,
      productWritesReady: worker.diagnostics().running && redditWorkerReady,
      certificationGrantActive: liveExecutor !== undefined,
      writeExecutionMode: liveExecutor ? "product_with_certification" : "product",
    });
    let closed = false;
    return {
      url,
      config,
      service,
      async close() {
        if (closed) return;
        closed = true;
        const serverClosed = once(server, "close");
        server.close();
        await Promise.allSettled([serverClosed, worker.stop(), webhookWorker.stop()]);
        await service.closeAdapters();
        authorizationLedger?.close();
        sessionRuntime.close();
        identityStore.close();
        webhooks.close();
        store.close();
      },
    };
  } catch (error) {
    try { await fixtureAdapter?.close(); } catch { /* startup keeps the first failure */ }
    try { authorizationLedger?.close(); } catch { /* startup keeps the first failure */ }
    try { sessionRuntime.close(); } catch { /* startup keeps the first failure */ }
    try { identityStore.close(); } catch { /* startup keeps the first failure */ }
    try { webhooks.close(); } catch { /* startup keeps the first failure */ }
    try { store.close(); } catch { /* startup keeps the first failure */ }
    throw error;
  }
}

function loadLiveAuthorization(
  config: RuntimeConfig,
  sessionRuntime: SessionRuntime,
  dispatcher: RemoteRedditCommandDispatcher,
) {
  const document = JSON.parse(readFileSync(config.liveGrantFile!, "utf8")) as Record<string, unknown>;
  if (document.version !== 1 || !document.grant || !document.actors) throw new TypeError("The live authorization file is invalid");
  const actors = document.actors as Record<string, unknown>;
  const qaOperatorId = requiredText(actors.qaOperatorId, "qaOperatorId");
  const approverId = requiredText(actors.approverId, "approverId");
  const coreActorId = requiredText(actors.coreActorId, "coreActorId");
  const authority = new RoleAuthority([
    { actorId: qaOperatorId, role: Role.INDEPENDENT_LIVE_QA },
    { actorId: approverId, role: Role.SECURITY_REVIEWER },
    { actorId: coreActorId, role: Role.CORE_RUNTIME },
  ]);
  const qaOperator = authority.principalFor(qaOperatorId);
  const approver = authority.principalFor(approverId);
  const coreActor = authority.principalFor(coreActorId);
  const grant = approveLiveTestGrant(document.grant as LiveTestGrantInput, { qaOperator, approver });
  if (grant.ledgerId !== config.ledgerId) throw new TypeError("The live authorization ledger ID does not match the runtime ledger");
  const ledger = new LiveAuthorizationLedger(config.authorizationDatabasePath);
  try {
    ledger.registerGrant(grant);
    return {
      ledger,
      executor: new BoundedLiveActionExecutor({
        ledger,
        grant,
        executor: qaOperator,
        coreActor,
        sessionRuntime,
        deployment: {
          environment: grant.environment,
          artifactDigest: grant.artifactDigest,
          sbomDigest: grant.sbomDigest,
          testEvidenceDigest: grant.testEvidenceDigest,
        },
        dispatch: (command) => dispatcher.dispatch(command),
        executeCommand: (command) => dispatcher.execute(command),
      }),
    };
  } catch (error) {
    ledger.close();
    throw error;
  }
}

function createFixtureControl(
  adapter: import("./fixture-reddit-adapter.ts").FixtureRedditPlatformAdapter,
  xAdapter: XFixturePlatformAdapter,
  runtime: SessionRuntime,
  store: LedgerStore,
  config: RuntimeConfig,
  traces: Array<Record<string, unknown>>,
) {
  return {
    control(command: string, payload: Record<string, unknown>) {
      if (command === "reset") {
        store.db.exec(`
          DELETE FROM webhook_delivery_attempts;
          DELETE FROM webhook_outbox;
          DELETE FROM webhook_events;
          DELETE FROM webhook_idempotency;
          DELETE FROM webhook_subscriptions;
          DELETE FROM inbound_events;
          DELETE FROM audit_events;
          DELETE FROM actions;
          DELETE FROM connections;
          DELETE FROM accounts;
          DELETE FROM sqlite_sequence WHERE name='audit_events';
        `);
        const core = new DatabaseSync(config.sessionDatabasePath);
        try {
          core.exec("DELETE FROM worker_leases; DELETE FROM accounts;");
        } finally {
          core.close();
        }
        traces.length = 0;
        xAdapter.reset();
        return adapter.reset().then(() => ({ reset: true }));
      }
      if (command === "stage-session") {
        const vaultHandle = requiredText(payload.vaultHandle, "vaultHandle");
        const nativeIdentity = requiredText(payload.nativeIdentity, "nativeIdentity");
        if (payload.platform === "x") {
          xAdapter.stageSession({ vaultHandle, nativeIdentity });
          return { staged: true, platform: "x" };
        }
        const routeId = requiredText(payload.routeId, "routeId");
        const sessionMaterial = Buffer.from(JSON.stringify({
          fixture: requiredText(payload.sessionFixture ?? "fixture", "sessionFixture"),
          ...(payload.syntheticSensitiveFields && typeof payload.syntheticSensitiveFields === "object"
            ? payload.syntheticSensitiveFields as Record<string, unknown> : {}),
        }), "utf8");
        const routeMaterial = Buffer.from(JSON.stringify({ kind: "fixture", route: routeId }), "utf8");
        try { adapter.stageSession({ vaultHandle, nativeIdentity, routeId, session: sessionMaterial, route: routeMaterial }); }
        finally { sessionMaterial.fill(0); routeMaterial.fill(0); }
        return { staged: true };
      }
      if (command === "x-scenario") {
        xAdapter.setScenario(requiredText(payload.vaultHandle, "vaultHandle"), requiredText(payload.scenario, "scenario") as "ok" | "rate_limited" | "revoked" | "access_denied" | "protocol_drift");
        return { configured: true, platform: "x" };
      }
      if (command === "x-next-write-outcome") {
        xAdapter.setNextWriteOutcome(
          requiredText(payload.vaultHandle, "vaultHandle"),
          requiredText(payload.outcome, "outcome") as "confirmed" | "failed" | "challenge" | "rate_limited" | "unknown" | "throw_after_submit",
        );
        return { configured: true, platform: "x" };
      }
      if (command === "next-platform-outcome") {
        const accountId = requiredText(payload.accountId, "accountId");
        return adapter.rearmIfStopped(store.getAccount(accountId)).then((rearmed) => {
          if (rearmed) {
            store.upsertConnection({
              accountId,
              vaultHandle: `fixture-rearmed-${rearmed.generation}`,
              generation: rearmed.generation,
              actualNativeUserId: rearmed.identity,
              callerId: "fixture-controller",
            });
          }
          adapter.setNextOutcome(accountId, requiredText(payload.operation, "operation"), requiredText(payload.outcome, "outcome"));
          return { configured: true, rearmed: rearmed !== null };
        });
      }
      if (command === "crash-after-submit") {
        adapter.setCrashAfterSubmit(requiredText(payload.accountId, "accountId"), requiredText(payload.operation, "operation"));
        return { configured: true };
      }
      if (command === "seed-owned") {
        const accountId = requiredText(payload.accountId, "accountId");
        if (!Array.isArray(payload.nativeIds) || payload.nativeIds.some((value) => typeof value !== "string" || value.length > 128)) {
          throw new TypeError("nativeIds is invalid");
        }
        adapter.seedOwned(accountId, payload.nativeIds as string[]);
        return { configured: true };
      }
      if (command === "reconciliation-outcome") {
        const actionId = requiredText(payload.actionId, "actionId");
        const outcome = requiredText(payload.outcome, "outcome");
        if (!["not_found", "confirmed"].includes(outcome)) throw new TypeError("outcome is invalid");
        adapter.setReconciliationOutcome(actionId, payload);
        return { configured: true };
      }
      if (command === "recover-expired-leases") return { recovered: runtime.recoverExpiredLeases() };
      throw new TypeError("Fixture control command is not supported");
    },
    inspect(target: string) {
      if (target === "platform-calls") return adapter.inspectCalls();
      if (target === "logs") return structuredClone(traces);
      if (target === "audit-events") return store.listAuditEvents({ limit: 100 }).items;
      if (target === "storage-records") return inspectEncryptedStorage(config.sessionDatabasePath);
      throw new TypeError("Fixture inspection target is not supported");
    },
  };
}

function fixturePrincipal(
  request: IncomingMessage,
  principal: Principal | null,
) {
  if (!principal || (!principal.scopes.includes("fixture:control") && !principal.scopes.includes("*"))) return principal;
  const callerId = request.headers["x-fixture-caller-id"];
  const scopes = request.headers["x-fixture-scopes"];
  if (callerId === undefined && scopes === undefined) return principal;
  if (typeof callerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(callerId)) return null;
  if (typeof scopes !== "string" || scopes.length > 4096) return null;
  const parsed = scopes === "" ? [] : scopes.split(",");
  if (parsed.some((scope) => !/^[A-Za-z0-9:*._-]{1,128}$/u.test(scope))) return null;
  return { callerId, scopes: parsed, tenantId: principal.tenantId };
}

function inspectEncryptedStorage(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("SELECT account_id, generation, session_envelope, route_envelope FROM accounts ORDER BY account_id").all() as Array<Record<string, unknown>>;
    return rows.flatMap((row) => [
      inspectEnvelope(row.account_id, row.generation, row.session_envelope),
      inspectEnvelope(row.account_id, row.generation, row.route_envelope),
    ].filter(Boolean));
  } finally {
    database.close();
  }
}

function inspectEnvelope(accountId: unknown, generation: unknown, value: unknown) {
  if (!(value instanceof Uint8Array)) return null;
  const envelope = JSON.parse(Buffer.from(value).toString("utf8")) as Record<string, any>;
  return {
    encrypted: true,
    accountId: String(accountId),
    purpose: String(envelope.binding?.purpose),
    generation: Number(generation),
    nonceId: String(envelope.nonce),
  };
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new TypeError(`${name} is invalid`);
  return value;
}

export function safeStartupFailure(error: unknown) {
  return redactError(error);
}
