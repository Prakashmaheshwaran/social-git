// @ts-check

/** @typedef {{id:string, platform:string, expectedNativeUserId:string, actualNativeUserId:string|null, label:string|null, status:'disconnected'|'active'|'suspended'|'revoked', createdAt:string, updatedAt:string}} Account */
/** @typedef {{accountId:string, generation:number, status:'active'|'revoked', connectedAt:string, revokedAt:string|null}} Connection */
/** @typedef {{id:string, sequence:number, callerId:string|null, accountId:string|null, type:string, outcome:string, data:unknown, occurredAt:string}} AuditEvent */
/** @typedef {{id:string, callerId:string, accountId:string, idempotencyKey:string, kind:string, state:'queued'|'running'|'succeeded'|'failed'|'action_required'|'UNKNOWN', submissionMayHaveStarted:boolean, result:unknown, error:unknown, createdAt:string, updatedAt:string}} Action */
/** @typedef {{state:'needs_setup'|'ready', instanceName:string, version:string, ownerEmail?:string}} InstanceStatus */
/** @typedef {{id:string, name:string, prefix:string, scopes:string[], createdAt:string, lastUsedAt:string|null}} ApiKeySummary */
/** @typedef {{id:string, status:'ready'|'running'|'failed', createdAt:string, sizeBytes:number|null}} BackupSummary */
/** @typedef {{currentVersion:string, latestVersion:string|null, updateAvailable:boolean, channel:string}} UpgradeStatus */
/** @typedef {{ready:boolean, checks:Record<string, boolean|string|number>}} Health */
/** @typedef {{accounts:Account[], connections:Record<string, Connection|null>, audit:AuditEvent[], health:Health}} Overview */

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
  /** @param {{baseUrl?:string, token?:string, fetchImpl?:typeof fetch}} [options] */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/u, "");
    this.token = options.token ?? "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** @param {string} token */
  setToken(token) { this.token = token.trim(); }

  async validateSession() {
    await this.listAccounts(1);
    return true;
  }

  /** @returns {Promise<InstanceStatus>} */
  async getInstanceStatus() {
    return /** @type {InstanceStatus} */ (await this.controlRequest("First-run setup", "/v1/control-plane/status"));
  }

  /** @param {{instanceName:string, ownerEmail:string, password:string}} input */
  async setupInstance(input) {
    return this.controlRequest("First-run setup", "/v1/control-plane/setup", { method: "POST", body: input });
  }

  /** @param {number} [limit] @returns {Promise<{items:Account[],nextCursor:string|null}>} */
  async listAccounts(limit = 100) {
    return /** @type {Promise<{items:Account[],nextCursor:string|null}>} */ (this.request(`/v1/accounts?limit=${limit}`));
  }

  /** @param {{platform:'reddit',expectedNativeUserId:string,label?:string}} input */
  async createAccount(input) { return this.request("/v1/accounts", { method: "POST", body: input }); }

  /** @param {string} accountId @returns {Promise<{connection:Connection}>} */
  async getConnection(accountId) { return /** @type {Promise<{connection:Connection}>} */ (this.request(`/v1/accounts/${encodeURIComponent(accountId)}/connection`)); }

  /** @param {string} accountId @param {{vaultHandle:string,generation:number}} input */
  async importConnection(accountId, input) { return this.request(`/v1/accounts/${encodeURIComponent(accountId)}/connections`, { method: "POST", body: input }); }

  /** @param {string} accountId */
  async revokeAccount(accountId) { return this.request(`/v1/accounts/${encodeURIComponent(accountId)}/revoke`, { method: "POST", body: { reason: "Revoked from the control plane" } }); }

  /** @param {number} [limit] @returns {Promise<{items:AuditEvent[],nextCursor:string|null}>} */
  async listAudit(limit = 50) { return /** @type {Promise<{items:AuditEvent[],nextCursor:string|null}>} */ (this.request(`/v1/audit-events?limit=${limit}`)); }

  /** @param {string} actionId @returns {Promise<{action:Action}>} */
  async getAction(actionId) { return /** @type {Promise<{action:Action}>} */ (this.request(`/v1/actions/${encodeURIComponent(actionId)}`)); }

  /** @returns {Promise<Health>} */
  async getHealth() {
    const result = /** @type {{status:string,checks?:Record<string,boolean|string|number>}} */ (await this.request("/readyz", { authenticated: false }));
    return { ready: result.status === "ready", checks: result.checks ?? {} };
  }

  /** @returns {Promise<Overview>} */
  async getOverview() {
    const [accountPage, auditPage, health] = await Promise.all([this.listAccounts(), this.listAudit(12), this.getHealth()]);
    /** @type {Record<string, Connection|null>} */
    const connections = {};
    await Promise.all(accountPage.items.map(async (account) => {
      try { connections[account.id] = (await this.getConnection(account.id)).connection; }
      catch (error) { if (error instanceof ApiError && error.status === 404) connections[account.id] = null; else throw error; }
    }));
    return { accounts: accountPage.items, connections, audit: auditPage.items, health };
  }

  /** @returns {Promise<{items:ApiKeySummary[],nextCursor:string|null}>} */
  async listApiKeys() { return /** @type {Promise<{items:ApiKeySummary[],nextCursor:string|null}>} */ (this.controlRequest("API key management", "/v1/control-plane/api-keys")); }

  /** @param {{name:string,scopes:string[]}} input */
  async createApiKey(input) { return this.controlRequest("API key management", "/v1/control-plane/api-keys", { method: "POST", body: input }); }

  /** @param {string} keyId */
  async revokeApiKey(keyId) { return this.controlRequest("API key management", `/v1/control-plane/api-keys/${encodeURIComponent(keyId)}/revoke`, { method: "POST", body: {} }); }

  /** @returns {Promise<{items:BackupSummary[]}>} */
  async listBackups() { return /** @type {Promise<{items:BackupSummary[]}>} */ (this.controlRequest("Backup management", "/v1/control-plane/backups")); }

  async createBackup() { return this.controlRequest("Backup management", "/v1/control-plane/backups", { method: "POST", body: {} }); }

  /** @returns {Promise<UpgradeStatus>} */
  async getUpgradeStatus() { return /** @type {Promise<UpgradeStatus>} */ (this.controlRequest("Upgrade management", "/v1/control-plane/upgrades/status")); }

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
    if (options.authenticated !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const requestId = response.headers.get("x-request-id");
    const payload = response.status === 204 ? null : await safeJson(response);
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      const code = typeof error.code === "string" ? error.code : `HTTP_${response.status}`;
      const message = typeof error.message === "string" ? error.message : "The request could not be completed.";
      throw new ApiError(code, message, response.status, requestId);
    }
    return payload;
  }
}

/** @typedef {{method?:'GET'|'POST',body?:unknown,authenticated?:boolean}} RequestOptions */

/** @param {Response} response */
async function safeJson(response) {
  try { return await response.json(); }
  catch { throw new ApiError("INVALID_RESPONSE", "The server returned an invalid response.", 502, response.headers.get("x-request-id")); }
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
