import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { SessionRuntime, createSafeLogger, redactError } from "@social-git/core";
import {
  LiveAuthorizationLedger,
  Role,
  RoleAuthority,
  approveLiveTestGrant,
  liveTestGrantFingerprint,
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
import { IdentityAuditBridge } from "./identity-audit-bridge.ts";
import { BoundedLiveActionExecutor } from "./live-execution.ts";
import { LedgerStore } from "./persistence.ts";
import { ProductionRedditAdapter } from "./reddit-adapter.ts";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.ts";
import { CoreRedditTransportProvider, DirectorySessionSource, RemoteRedditCommandDispatcher } from "./runtime-reddit.ts";
import { OwnerRedditSessionImportController } from "./reddit-session-import.ts";
import { OwnerXSessionImportController } from "./x-session-import.ts";
import { AdmissionProofCoordinator, OwnerAdmissionProofController } from "./admission-proof.ts";
import { loadAdmissionEnvelope, loadEvidenceSigner, type VerifiedAdmissionEnvelope } from "./admission-envelope.ts";
import { ScopeAuthorizer, SocialGitService, type Principal } from "./service.ts";
import { RuntimeMaintenanceGate } from "./maintenance.ts";
import { buildRuntimeReadiness, InternalWorkerReadinessProbe } from "./readiness.ts";
import { OwnerBackupManager, OwnerOperationsHttpController } from "./owner-operations.ts";
import { DisabledXPlatformAdapter, XFixturePlatformAdapter } from "./x-adapter.ts";
import { ProductionXPlatformAdapter } from "./x-production-adapter.ts";
import { CoreXTransportProvider, RemoteXCommandDispatcher, evaluateCommittedXRuntimeAdmission } from "./runtime-x.ts";
import {
  deriveWebhookEncryptionKey,
  WebhookDeliveryWorker,
  WebhookManager,
  type WebhookTransport,
} from "./webhooks.ts";

export interface RunningSocialGitRuntime {
  readonly url: string;
  readonly config: RuntimeConfig;
  readonly service: SocialGitService;
  close(): Promise<void>;
}

export async function startSocialGitRuntime(
  config = loadRuntimeConfig(),
  options: { apiKeyRateLimit?: ApiKeyRateLimitHook; webhookTransport?: WebhookTransport } = {},
): Promise<RunningSocialGitRuntime> {
  const traces: Array<Record<string, unknown>> = [];
  const logger = createSafeLogger((level, message, fields) => {
    const event = { level, message, ...(fields && typeof fields === "object" ? fields as Record<string, unknown> : {}) };
    traces.push(event);
    if (traces.length > 1000) traces.shift();
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });
  const store = new LedgerStore(config.actionDatabasePath, { ledgerId: config.ledgerId, auditKey: config.auditKey });
  const identityStore = new IdentityStore(config.identityDatabasePath, {
    tenantId: config.tenantId,
    auditKey: config.auditKey,
  });
  const identityAuditBridge = new IdentityAuditBridge(identityStore, store);
  identityAuditBridge.start();
  const ownedBackupKey = Buffer.from(config.backupKey);
  const ownedAuditKey = Buffer.from(config.auditKey);
  config.backupKey.fill(0);
  const webhookKey = deriveWebhookEncryptionKey(config.masterKey);
  const webhooks = new WebhookManager(store, {
    tenantId: config.tenantId,
    encryptionKey: webhookKey,
    ...(options.webhookTransport ? { transport: options.webhookTransport } : {}),
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
    ownedBackupKey.fill(0);
    ownedAuditKey.fill(0);
    identityAuditBridge.stop();
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
  let backupManager: OwnerBackupManager | undefined;
  const dispatcher = new RemoteRedditCommandDispatcher(config.redditWorkerUrl, config.redditCommandKey);
  config.redditCommandKey.fill(0);
  let admissionCoordinator: AdmissionProofCoordinator | undefined;
  let verifiedAdmission: VerifiedAdmissionEnvelope | undefined;
  const xAdmission = evaluateCommittedXRuntimeAdmission(config.xTransportRequested);
  const xWorkerProbe = new InternalWorkerReadinessProbe(config.xWorkerUrl);
  let xDispatcher: RemoteXCommandDispatcher | undefined;
  let xCertificationDispatcher: RemoteXCommandDispatcher | undefined;
  let xCertificationProvider: CoreXTransportProvider | undefined;
  let redditCertificationProvider: CoreRedditTransportProvider | undefined;
  let adapter: ProductionRedditAdapter | import("./fixture-reddit-adapter.ts").FixtureRedditPlatformAdapter;
  let xAdapter: DisabledXPlatformAdapter | ProductionXPlatformAdapter | XFixturePlatformAdapter;

  try {
    if (config.admissionEnvelopeFile && config.admissionQaPublicKeyFile && config.admissionApproverPublicKeyFile) {
      verifiedAdmission = loadAdmissionEnvelope({
        envelopePath: config.admissionEnvelopeFile,
        qaPublicKeyPath: config.admissionQaPublicKeyFile,
        approverPublicKeyPath: config.admissionApproverPublicKeyFile,
        releaseMetadataDirectory: config.admissionReleaseMetadataDirectory!,
      });
      if (verifiedAdmission.grant.ledgerId !== config.ledgerId || verifiedAdmission.tenantId !== config.tenantId) throw new TypeError("The admission envelope tenant or ledger ID does not match this runtime");
    }
    if (config.mode === "fixture") {
      const { FixtureRedditPlatformAdapter } = await import("./fixture-reddit-adapter.ts");
      fixtureAdapter = new FixtureRedditPlatformAdapter(sessionRuntime);
      adapter = fixtureAdapter;
      xFixtureAdapter = new XFixturePlatformAdapter();
      xAdapter = xFixtureAdapter;
    } else {
      const provider = new CoreRedditTransportProvider({
        runtime: sessionRuntime,
        source: new DirectorySessionSource(config.sessionImportDir!),
        dispatcher,
      });
      redditCertificationProvider = provider;
      adapter = new ProductionRedditAdapter(provider);
      if (xAdmission.enabled) {
        xDispatcher = new RemoteXCommandDispatcher(config.xWorkerUrl, config.xCommandKey);
        xAdapter = new ProductionXPlatformAdapter(new CoreXTransportProvider({ runtime: sessionRuntime, dispatcher: xDispatcher }), xAdmission);
      } else {
        xAdapter = new DisabledXPlatformAdapter(sessionRuntime, xAdmission);
        if (verifiedAdmission?.grant.platform === "x") {
          xCertificationDispatcher = new RemoteXCommandDispatcher(config.xWorkerUrl, config.xCommandKey, { expectedCertificationIdentity: {
            grantFingerprint: liveTestGrantFingerprint(verifiedAdmission.grant), sourceCommit: verifiedAdmission.sourceCommit,
            deploymentId: verifiedAdmission.deploymentId, evidenceKeyFingerprint: verifiedAdmission.evidenceKeyFingerprint,
          } });
          xCertificationProvider = new CoreXTransportProvider({ runtime: sessionRuntime, dispatcher: xCertificationDispatcher });
        }
      }
      if (config.liveGrantFile) {
        const live = loadLiveAuthorization(config, sessionRuntime, dispatcher);
        authorizationLedger = live.ledger;
        liveExecutor = live.executor;
      }
    }
    // Each consumer clones this key into its private signer. RuntimeConfig must
    // never retain an extra long-lived copy, including in disabled/fixture mode.
    config.xCommandKey.fill(0);

    const service = new SocialGitService({
      store,
      adapters: [adapter, xAdapter],
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
    const maintenanceGate = new RuntimeMaintenanceGate();

    const fixtureControl = fixtureAdapter && xFixtureAdapter ? createFixtureControl(fixtureAdapter, xFixtureAdapter, sessionRuntime, store, config, traces) : undefined;
    const baseAuthenticator = hashedBearerAuthenticator(config.authEntries);
    const identity = new IdentityHttpController(
      identityStore,
      config.sessionCookieSecure,
      options.apiKeyRateLimit ?? createDefaultApiKeyRateLimit(),
    );
    try {
      backupManager = new OwnerBackupManager({
        directory: config.backupsDirectory,
        backupKey: ownedBackupKey,
        auditKey: ownedAuditKey,
        sessionRuntime,
        actionDatabasePath: config.actionDatabasePath,
        identityDatabasePath: config.identityDatabasePath,
        tenantId: config.tenantId,
        ledgerId: config.ledgerId,
        gate: maintenanceGate,
        pause: async () => {
          // The identity outbox spans the identity and action databases. Drain
          // and stop it before either snapshot so a restored identity database
          // can never acknowledge a projection absent from the action ledger.
          identityAuditBridge.pause();
          await Promise.all([worker.pause(), webhookWorker.pause()]);
        },
        resume: () => {
          worker.resume();
          webhookWorker.resume();
          identityAuditBridge.resume();
        },
      });
    } finally {
      ownedBackupKey.fill(0);
      ownedAuditKey.fill(0);
    }
    const ownerOperations = new OwnerOperationsHttpController(
      backupManager,
      (request, csrfRequired) => identity.authenticateRequest(request, csrfRequired, false),
    );
    const ownerSessionImport = new OwnerRedditSessionImportController(
      service,
      (request) => identity.authenticateRequest(request, true, false),
    );
    const ownerXSessionImport = new OwnerXSessionImportController(
      service,
      (request) => identity.authenticateRequest(request, true, false),
    );
    let ownerAdmission: OwnerAdmissionProofController | undefined;
    if (verifiedAdmission) {
      const verified = verifiedAdmission;
      const evidenceSigner = loadEvidenceSigner({
        privateKeyPath: config.admissionEvidencePrivateKeyFile!,
        publicKeyPath: config.admissionEvidencePublicKeyFile!,
        forbiddenFingerprints: [verified.qaKeyFingerprint, verified.approverKeyFingerprint],
        expectedFingerprint: verified.evidenceKeyFingerprint,
      });
      admissionCoordinator = new AdmissionProofCoordinator({
        databasePath: config.authorizationDatabasePath,
        evidenceSigner,
        grant: verified.grant,
        qaOperator: verified.qaOperator,
        qaKeyFingerprint: verified.qaKeyFingerprint,
        approverKeyFingerprint: verified.approverKeyFingerprint,
        sourceCommit: verified.sourceCommit,
        compatibilityEvidenceDigest: verified.compatibilityEvidenceDigest,
        deploymentId: verified.deploymentId,
        tenantId: verified.tenantId,
        verifyExecutionChallenge: verified.verifyExecutionChallenge,
        sessionRuntime,
        service,
        wakeAction: () => worker.wake(),
        ...(xCertificationProvider ? { xCertificationProvider } : {}),
        ...(verified.grant.platform === "reddit" && redditCertificationProvider ? { redditCertificationProvider } : {}),
      });
      ownerAdmission = new OwnerAdmissionProofController(
        admissionCoordinator,
        (request, csrfRequired) => identity.authenticateRequest(request, csrfRequired, false),
      );
    }
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
      ownerOperations,
      ownerSessionImport: {
        ownsPath: (pathname) => ownerSessionImport.ownsPath(pathname) || ownerXSessionImport.ownsPath(pathname),
        handle: async (request, response) => await ownerSessionImport.handle(request, response)
          || await ownerXSessionImport.handle(request, response),
      },
      ...(ownerAdmission ? { ownerAdmission } : {}),
      maintenanceGate,
      readiness: async () => {
        const ledger = store.diagnostics();
        const sessions = sessionRuntime.diagnostics();
        const identityDiagnostics = identityStore.diagnostics();
        const webhook = webhooks.diagnostics();
        const [redditWorkerReady, xWorkerReady] = config.mode === "fixture"
          ? [true, true]
          : await Promise.all([dispatcher.ready(), xDispatcher ? xDispatcher.ready() : xCertificationDispatcher ? xCertificationDispatcher.ready() : xWorkerProbe.ready()]);
        const releaseCertificationActive = admissionCurrentlyActive(verifiedAdmission);
        return buildRuntimeReadiness({
          mode: config.mode,
          databases: {
            actions: { migrationVersion: ledger.migrationVersion, journalMode: ledger.journalMode, integrity: ledger.integrity },
            sessions: { schemaVersion: sessions.schemaVersion, journalMode: sessions.journalMode },
            identity: identityDiagnostics,
          },
          workers: {
            action: worker.diagnostics(),
            webhook: webhookWorker.diagnostics(),
            redditReachable: redditWorkerReady,
            xReachable: xWorkerReady,
          },
          maintenance: maintenanceGate.diagnostics(),
          counts: {
            queuedActions: ledger.queuedActions,
            runningActions: ledger.runningActions,
            unknownActions: ledger.unknownActions,
            webhookPending: webhook.pending,
            webhookExhausted: webhook.exhausted,
          },
          xAdmission,
          certificationGrantActive: liveExecutor !== undefined || releaseCertificationActive,
          ...(verifiedAdmission ? { releaseCertification: { configured: true, active: releaseCertificationActive, platform: verifiedAdmission.grant.platform as "reddit" | "x", workerReachable: verifiedAdmission.grant.platform === "x" ? xWorkerReady : redditWorkerReady } } : {}),
          identityAudit: identityAuditBridge.diagnostics(),
        });
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
    const [redditWorkerReady, xWorkerReady] = config.mode === "fixture"
      ? [true, true]
      : await Promise.all([dispatcher.ready(), xDispatcher ? xDispatcher.ready() : xCertificationDispatcher ? xCertificationDispatcher.ready() : xWorkerProbe.ready()]);
    const releaseCertificationActive = admissionCurrentlyActive(verifiedAdmission);
    logger.info("runtime.ready", {
      mode: config.mode,
      host: address.address,
      port: address.port,
      startupRecovery: service.startupRecovery,
      redditWorkerReady,
      xWorkerReady,
      productWritesReady: worker.diagnostics().running && redditWorkerReady,
      certificationGrantActive: liveExecutor !== undefined || releaseCertificationActive,
      releaseCertificationConfigured: verifiedAdmission !== undefined,
      writeExecutionMode: releaseCertificationActive ? "product_with_release_certification" : liveExecutor ? "product_with_certification" : "product",
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
        // Expedite keep-alive drain; bound total shutdown so a held-open
        // connection cannot block SIGTERM/SIGINT handling indefinitely.
        try { server.closeIdleConnections(); } catch { /* older typings */ }
        await Promise.race([
          serverClosed.then(() => undefined),
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            try { server.closeAllConnections(); } catch { /* older typings */ }
            await serverClosed;
          })(),
        ]);
        await Promise.allSettled([worker.stop(), webhookWorker.stop()]);
        await backupManager?.close();
        admissionCoordinator?.close();
        xCertificationDispatcher?.close();
        await service.closeAdapters();
        dispatcher.close();
        xDispatcher?.close();
        authorizationLedger?.close();
        sessionRuntime.close();
        identityAuditBridge.stop();
        try { identityAuditBridge.drain(); } catch { /* the durable outbox replays on the next start */ }
        identityStore.close();
        webhooks.close();
        store.close();
      },
    };
  } catch (error) {
    try { await fixtureAdapter?.close(); } catch { /* startup keeps the first failure */ }
    try { dispatcher.close(); } catch { /* startup keeps the first failure */ }
    try { xDispatcher?.close(); } catch { /* startup keeps the first failure */ }
    config.redditCommandKey.fill(0);
    try { xCertificationDispatcher?.close(); } catch { /* startup keeps the first failure */ }
    config.xCommandKey.fill(0);
    try { await backupManager?.close(); } catch { /* startup keeps the first failure */ }
    try { admissionCoordinator?.close(); } catch { /* startup keeps the first failure */ }
    ownedBackupKey.fill(0);
    ownedAuditKey.fill(0);
    try { authorizationLedger?.close(); } catch { /* startup keeps the first failure */ }
    try { sessionRuntime.close(); } catch { /* startup keeps the first failure */ }
    identityAuditBridge.stop();
    try { identityStore.close(); } catch { /* startup keeps the first failure */ }
    try { webhooks.close(); } catch { /* startup keeps the first failure */ }
    try { store.close(); } catch { /* startup keeps the first failure */ }
    throw error;
  }
}

function admissionCurrentlyActive(envelope: VerifiedAdmissionEnvelope | undefined, timestamp = Date.now()) {
  return envelope !== undefined && timestamp >= envelope.grant.notBefore && timestamp < envelope.grant.expiresAt;
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
          DELETE FROM webhook_idempotency;
          DELETE FROM webhook_subscriptions;
          DELETE FROM inbound_events;
          DELETE FROM actions;
          DELETE FROM connections;
          DELETE FROM accounts;
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
