// @ts-check

/** @typedef {{id:string, platform:'reddit'|'x', expectedNativeUserId:string, actualNativeUserId:string|null, label:string|null, status:'disconnected'|'active'|'suspended'|'revoked', connectionHealth:'disconnected'|'pending_identity'|'healthy'|'action_required'|'revoked', actionRequiredReason:string|null, healthGeneration:number, lastVerifiedAt:string|null, createdAt:string, updatedAt:string}} Account */
/** @typedef {{accountId:string, generation:number, status:'active'|'revoked', connectedAt:string, revokedAt:string|null}} Connection */
/** @typedef {{id:string, sequence:number, callerId:string|null, accountId:string|null, type:string, outcome:string, data:unknown, occurredAt:string}} AuditEvent */
/** @typedef {{id:string, callerId:string, accountId:string, idempotencyKey:string, kind:string, state:'queued'|'running'|'succeeded'|'failed'|'action_required'|'UNKNOWN'|'cancelled', submissionMayHaveStarted:boolean, result:unknown, error:unknown, createdAt:string, updatedAt:string}} Action */
/** @typedef {{tenantId:string,keyId:string|null,callerId:string|null,accountId:string|null,operationId:string|null,outcome:'succeeded'|'failed',count:number,firstRecordedAt:string,lastRecordedAt:string}} UsageAggregate */
/** @typedef {{operation:string,summary?:string,mode?:'read'|'write',fixtureEnabled?:boolean,productionEnabled?:boolean,status?:string,disabledReason?:string,disabledReasons?:string[],authorizationScope?:string}} CapabilityDetail */
/** @typedef {{platform:string,capabilities:string[],unsupportedCapabilities:Record<string,string>,details:CapabilityDetail[],source:'account'|'platform',error?:string}} AccountCapabilities */
/** @typedef {{required:boolean}} SetupStatus */
/** @typedef {{authenticated:true, expiresAt?:string, tenantId:string, workspaceId:string, role:'owner'|'admin'|'member'}} OwnerSession */
/** @typedef {{id:string, name:string, prefix:string, scopes:string[], createdAt:string, lastUsedAt:string|null}} ApiKeySummary */
/** @typedef {{id:string, status:'ready'|'running'|'failed', createdAt:string, expiresAt:string, completedAt:string|null, sizeBytes:number|null, databaseCount:3, errorCode?:string}} BackupSummary */
/** @typedef {{currentVersion:string, latestVersion:null, updateAvailable:false, channel:'manual', automation:'unavailable', message:string}} UpgradeStatus */
/** @typedef {{ready:boolean, contractVersion:number|null, checks:Record<string, unknown>}} Health */
/** @typedef {{accounts:Account[], connections:Record<string, Connection|null>, capabilities:Record<string, AccountCapabilities|null>, audit:AuditEvent[], health:Health}} Overview */

export class ApiError extends Error {
  /** @param {string} code @param {string} message @param {number} status @param {string|null} requestId */
  constructor(code, message, status, requestId = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export class ControlPlaneUnavailableError extends ApiError {
  /** @param {string} feature */
  constructor(feature) {
    super("CONTROL_PLANE_UNAVAILABLE", `${feature} is not available in this server build yet.`, 404);
    this.feature = feature;
  }
}

export class SocialGitClient {
  #csrfToken = "";

  /** @param {{baseUrl?:string, fetchImpl?:typeof fetch}} [options] */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  hasMutationSession() { return this.#csrfToken.length > 0; }
  clearSession() { this.#csrfToken = ""; }

  /** @returns {Promise<SetupStatus>} */
  async getSetupStatus() {
    return /** @type {Promise<SetupStatus>} */ (this.request("/v1/setup/status", { authenticated: false }));
  }

  /** @param {{email:string,password:string,displayName:string}} input @returns {Promise<OwnerSession>} */
  async createOwner(input) {
    const result = await this.request("/v1/setup/owner", { method: "POST", body: input, authenticated: false, csrf: false });
    return this.#captureOwnerSession(result);
  }

  /** @param {{email:string,password:string}} input @returns {Promise<OwnerSession>} */
  async login(input) {
    const result = await this.request("/v1/auth/login", { method: "POST", body: input, authenticated: false, csrf: false });
    return this.#captureOwnerSession(result);
  }

  /** @returns {Promise<OwnerSession>} */
  async getSession() {
    return /** @type {Promise<OwnerSession>} */ (this.request("/v1/auth/session"));
  }

  async logout() {
    try { return await this.request("/v1/auth/logout", { method: "POST", body: {} }); }
    finally { this.clearSession(); }
  }

  /** @param {number} [limit] @returns {Promise<{items:Account[],nextCursor:string|null}>} */
  async listAccounts(limit = 100) {
    return /** @type {Promise<{items:Account[],nextCursor:string|null}>} */ (this.request(`/v1/accounts?limit=${limit}`));
  }

  /** @param {{platform:'reddit'|'x',expectedNativeUserId:string,label?:string}} input */
  async createAccount(input) { return this.request("/v1/accounts", { method: "POST", body: input }); }

  /** @param {string} accountId @returns {Promise<{connection:Connection}>} */
  async getConnection(accountId) { return /** @type {Promise<{connection:Connection}>} */ (this.request(`/v1/accounts/${encodeURIComponent(accountId)}/connection`)); }

  /** @param {string} accountId @param {{vaultHandle:string,generation:number}} input */
  async importConnection(accountId, input) {
    validateImportHandle(input.vaultHandle);
    return this.request(`/v1/accounts/${encodeURIComponent(accountId)}/connections`, { method: "POST", body: input });
  }

  /** @param {string} accountId @param {{vaultHandle:string,generation:number}} input */
  async refreshConnection(accountId, input) {
    validateImportHandle(input.vaultHandle);
    return this.request(`/v1/accounts/${encodeURIComponent(accountId)}/connection/refresh`, { method: "POST", body: input });
  }

  /** @param {string} accountId @param {File} file */
  async importRedditSessionFile(accountId, file) {
    if (!(file instanceof Blob) || file.size < 2 || file.size > 24 * 1024) {
      throw new ApiError("VALIDATION_FAILED", "Choose an exported Reddit session JSON file no larger than 24 KiB.", 422);
    }
    if (file instanceof File && (!file.name.toLowerCase().endsWith(".json") || (file.type && file.type !== "application/json"))) {
      throw new ApiError("VALIDATION_FAILED", "Choose the explicitly exported Reddit .json session file.", 422);
    }
    return this.request(`/v1/control-plane/accounts/${encodeURIComponent(accountId)}/reddit-session`, {
      method: "POST",
      rawBody: file,
      contentType: "application/json",
    });
  }

  /** @param {string} accountId @param {File} file */
  async importXSessionFile(accountId, file) {
    if (!(file instanceof Blob) || file.size < 2 || file.size > 24 * 1024) {
      throw new ApiError("VALIDATION_FAILED", "Choose an exported X session JSON file no larger than 24 KiB.", 422);
    }
    if (file instanceof File && (!file.name.toLowerCase().endsWith(".json") || (file.type && file.type !== "application/json"))) {
      throw new ApiError("VALIDATION_FAILED", "Choose the explicitly exported X .json session file.", 422);
    }
    return this.request(`/v1/control-plane/accounts/${encodeURIComponent(accountId)}/x-session`, {
      method: "POST",
      rawBody: file,
      contentType: "application/json",
      acceptedStatuses: [200, 201, 202],
    });
  }

  /** @param {string} accountId @returns {Promise<AccountCapabilities>} */
  async getCapabilities(accountId) {
    return /** @type {Promise<AccountCapabilities>} */ (this.request(`/v1/accounts/${encodeURIComponent(accountId)}/capabilities`));
  }

  /** @param {'x'} platform @returns {Promise<{platform:string,details:CapabilityDetail[]}>} */
  async getPlatformCapabilities(platform) {
    return /** @type {Promise<{platform:string,details:CapabilityDetail[]}>} */ (this.request(`/v1/platforms/${encodeURIComponent(platform)}/capabilities`));
  }

  /** @param {string} accountId */
  async revokeAccount(accountId) { return this.request(`/v1/accounts/${encodeURIComponent(accountId)}/revoke`, { method: "POST", body: { reason: "Revoked from the control plane" } }); }

  /** @param {number} [limit] @returns {Promise<{items:AuditEvent[],nextCursor:string|null}>} */
  async listAudit(limit = 50) { return /** @type {Promise<{items:AuditEvent[],nextCursor:string|null}>} */ (this.request(`/v1/audit-events?limit=${limit}`)); }

  /** @param {string} actionId @returns {Promise<{action:Action}>} */
  async getAction(actionId) { return /** @type {Promise<{action:Action}>} */ (this.request(`/v1/actions/${encodeURIComponent(actionId)}`)); }

  /** @param {{state?:string,accountId?:string,kind?:string,limit?:number}} [filters] @returns {Promise<{items:Action[],nextCursor:string|null}>} */
  async listActions(filters = {}) {
    const query = new URLSearchParams({ limit: String(filters.limit ?? 50) });
    if (filters.state) query.set("state", filters.state);
    if (filters.accountId) query.set("accountId", filters.accountId);
    if (filters.kind) query.set("kind", filters.kind);
    return /** @type {Promise<{items:Action[],nextCursor:string|null}>} */ (this.request(`/v1/actions?${query}`));
  }

  /** @param {string} actionId @param {string} idempotencyKey @returns {Promise<{action:Action,replayed:boolean}>} */
  async cancelAction(actionId, idempotencyKey) {
    return /** @type {Promise<{action:Action,replayed:boolean}>} */ (this.request(`/v1/actions/${encodeURIComponent(actionId)}/cancel`, { method: "POST", body: {}, idempotencyKey }));
  }

  /**
   * Verify an UNKNOWN action's real platform outcome without resubmitting it.
   * The contract requires no Idempotency-Key because nothing is dispatched.
   * @param {string} actionId @returns {Promise<{action:Action,reconciled:boolean}>}
   */
  async reconcileAction(actionId) {
    return /** @type {Promise<{action:Action,reconciled:boolean}>} */ (this.request(`/v1/actions/${encodeURIComponent(actionId)}/reconcile`, { method: "POST", body: {} }));
  }

  /** @returns {Promise<{items:UsageAggregate[],retentionDays:number}>} */
  async getUsage() {
    return /** @type {Promise<{items:UsageAggregate[],retentionDays:number}>} */ (this.request("/v1/usage?groupBy=operation,account&limit=100"));
  }

  /** @returns {Promise<Health>} */
  async getHealth() {
    const result = /** @type {{status:string,contractVersion?:number,checks?:Record<string,unknown>}} */ (await this.request("/readyz", { authenticated: false, acceptedStatuses: [503] }));
    return { ready: result.status === "ready", contractVersion: Number.isSafeInteger(result.contractVersion) ? result.contractVersion ?? null : null, checks: result.checks ?? {} };
  }

  /** @returns {Promise<Overview>} */
  async getOverview() {
    const [accountPage, auditPage, health] = await Promise.all([this.listAccounts(), this.listAudit(12), this.getHealth()]);
    /** @type {Record<string, Connection|null>} */
    const connections = {};
    /** @type {Record<string, AccountCapabilities|null>} */
    const capabilities = {};
    /** @type {{platform:string,details:CapabilityDetail[]}|null} */
    let xCatalog = null;
    if (accountPage.items.some((account) => account.platform === "x")) {
      try { xCatalog = await this.getPlatformCapabilities("x"); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    await Promise.all(accountPage.items.map(async (account) => {
      try { connections[account.id] = (await this.getConnection(account.id)).connection; }
      catch (error) { if (error instanceof ApiError && error.status === 404) connections[account.id] = null; else throw error; }
      if (connections[account.id]?.status === "active") {
        try {
          const discovered = await this.getCapabilities(account.id);
          capabilities[account.id] = { ...discovered, details: Array.isArray(discovered.details) ? discovered.details : [], source: "account" };
        }
        catch (error) {
          if (!(error instanceof ApiError)) throw error;
          if (error.status === 401) throw error;
          capabilities[account.id] = account.platform === "x"
            ? catalogFor(account.platform, xCatalog, error.code)
            : unavailableCapabilities(account.platform, error.code);
        }
      } else capabilities[account.id] = catalogFor(account.platform, xCatalog);
    }));
    return { accounts: accountPage.items, connections, capabilities, audit: auditPage.items, health };
  }

  /** @returns {Promise<{items:ApiKeySummary[],nextCursor:string|null}>} */
  async listApiKeys() { return /** @type {Promise<{items:ApiKeySummary[],nextCursor:string|null}>} */ (this.controlRequest("API key management", "/v1/control-plane/api-keys")); }

  /** @param {{name:string,scopes:string[]}} input */
  async createApiKey(input) { return this.controlRequest("API key management", "/v1/control-plane/api-keys", { method: "POST", body: input }); }

  /** @param {string} keyId */
  async revokeApiKey(keyId) { return this.controlRequest("API key management", `/v1/control-plane/api-keys/${encodeURIComponent(keyId)}/revoke`, { method: "POST", body: {} }); }

  /** @returns {Promise<{items:Array<{id:string,name:string,role:string}>,nextCursor:null}>} */
  async listWorkspaces() { return /** @type {any} */ (this.request("/v1/control-plane/workspaces")); }
  /** @returns {Promise<{items:Array<{userId:string,email:string,displayName:string,role:string,status:string}>,nextCursor:null}>} */
  async listMembers() { return /** @type {any} */ (this.controlRequest("member management", "/v1/control-plane/members")); }
  /** @param {{email:string,displayName:string,password:string,role:string}} input */
  async provisionMember(input) { return this.controlRequest("member management", "/v1/control-plane/members", { method: "POST", body: input }); }
  /** @param {string} userId @param {{role?:string,status?:string}} input */
  async updateMember(userId, input) { return this.controlRequest("member management", `/v1/control-plane/members/${encodeURIComponent(userId)}`, { method: "POST", body: input }); }
  /** @param {{email:string,role:string}} input @returns {Promise<{token?:string}>} */
  async createInvitation(input) { return /** @type {any} */ (this.controlRequest("member management", "/v1/control-plane/invitations", { method: "POST", body: input })); }

  /** @returns {Promise<{items:BackupSummary[]}>} */
  async listBackups() { return /** @type {Promise<{items:BackupSummary[]}>} */ (this.controlRequest("Backup management", "/v1/control-plane/backups")); }

  async createBackup() { return this.controlRequest("Backup management", "/v1/control-plane/backups", { method: "POST", body: {} }); }

  /** @returns {Promise<UpgradeStatus>} */
  async getUpgradeStatus() { return /** @type {Promise<UpgradeStatus>} */ (this.controlRequest("Upgrade management", "/v1/control-plane/upgrades/status")); }

  async getAdmissionStatus() { return this.controlRequest("Release certification", "/v1/control-plane/admission"); }
  /** @param {Record<string,unknown>} input */
  async prepareAdmissionProof(input) { return this.controlRequest("Release certification", "/v1/control-plane/admission/proofs", { method: "POST", body: input }); }
  /** @param {string} proofId @param {Record<string,unknown>} input */
  async executeAdmissionProof(proofId, input) { return this.controlRequest("Release certification", `/v1/control-plane/admission/proofs/${encodeURIComponent(proofId)}/execute`, { method: "POST", body: input }); }
  /** @param {string} proofId */
  async getAdmissionEvidence(proofId) { return this.controlRequest("Release certification", `/v1/control-plane/admission/proofs/${encodeURIComponent(proofId)}/evidence`); }

  /** @param {string} feature @param {string} path @param {RequestOptions} [options] */
  async controlRequest(feature, path, options = {}) {
    try { return await this.request(path, options); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new ControlPlaneUnavailableError(feature);
      throw error;
    }
  }

  /** @param {string} path @param {RequestOptions} [options] @returns {Promise<unknown>} */
  async request(path, options = {}) {
    /** @type {Record<string,string>} */
    const headers = { accept: "application/json" };
    const csrfRequired = options.csrf ?? (options.authenticated !== false && options.method === "POST");
    if (csrfRequired) {
      if (!this.#csrfToken) throw new ApiError("CSRF_REQUIRED", "Confirm your password before making changes in this browser tab.", 401);
      headers["x-csrf-token"] = this.#csrfToken;
    }
    if (options.body !== undefined || options.rawBody !== undefined) headers["content-type"] = options.contentType ?? "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "same-origin",
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const requestId = response.headers.get("x-request-id");
    const payload = response.status === 204 ? null : await safeJson(response);
    if (!response.ok && !options.acceptedStatuses?.includes(response.status)) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      const code = typeof error.code === "string" ? error.code : `HTTP_${response.status}`;
      const message = typeof error.message === "string" ? error.message : "The request could not be completed.";
      throw new ApiError(code, message, response.status, requestId);
    }
    return payload;
  }

  /** @param {unknown} value @returns {OwnerSession} */
  #captureOwnerSession(value) {
    if (!isRecord(value) || value.authenticated !== true || !["owner", "admin", "member"].includes(String(value.role)) || typeof value.tenantId !== "string" || typeof value.workspaceId !== "string" || typeof value.csrfToken !== "string") {
      throw new ApiError("INVALID_RESPONSE", "The server returned an invalid owner session.", 502);
    }
    this.#csrfToken = value.csrfToken;
    return {
      authenticated: true,
      tenantId: value.tenantId,
      workspaceId: value.workspaceId,
      role: /** @type {'owner'|'admin'|'member'} */ (value.role),
      ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
    };
  }
}

/** @typedef {{method?:'GET'|'POST',body?:unknown,rawBody?:BodyInit,contentType?:string,authenticated?:boolean,csrf?:boolean,idempotencyKey?:string,acceptedStatuses?:number[]}} RequestOptions */

/** @param {Response} response */
async function safeJson(response) {
  try { return await response.json(); }
  catch { throw new ApiError("INVALID_RESPONSE", "The server returned an invalid response.", 502, response.headers.get("x-request-id")); }
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** @param {string} value */
function validateImportHandle(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value) || value.toLowerCase().endsWith(".json")) {
    throw new ApiError("VALIDATION_FAILED", "Use only the staged import filename without .json: letters, numbers, dot, underscore, or hyphen; no path or URI.", 422);
  }
}

/** @param {string} platform @param {{platform:string,details:CapabilityDetail[]}|null} xCatalog @param {string} [error] @returns {AccountCapabilities|null} */
function catalogFor(platform, xCatalog, error) {
  if (platform !== "x" || !xCatalog) return null;
  const details = Array.isArray(xCatalog.details) ? xCatalog.details : [];
  /** @type {Record<string,string>} */
  const unsupportedCapabilities = {};
  for (const detail of details) {
    if (detail.productionEnabled === true) continue;
    const reasons = Array.isArray(detail.disabledReasons) && detail.disabledReasons.length
      ? detail.disabledReasons
      : [detail.disabledReason ?? "PRODUCTION_NOT_ADMITTED"];
    unsupportedCapabilities[detail.operation] = reasons.join(",");
  }
  return { platform, capabilities: details.filter((detail) => detail.productionEnabled === true).map((detail) => detail.operation), unsupportedCapabilities, details, source: "platform", ...(error ? { error } : {}) };
}

/** @param {string} platform @param {string} error @returns {AccountCapabilities} */
function unavailableCapabilities(platform, error) {
  return { platform, capabilities: [], unsupportedCapabilities: {}, details: [], source: "account", error };
}
