import { XContractError } from "./contract.mjs";
import { buildXProtocolRequest } from "./protocol-corpus.mjs";
import { normalizeXProtocolResponse } from "./production-normalizers.mjs";

export class XSessionTransport {
  #authority; #lease; #binding; #expected; #identity = null; #deadlineMs; #now; #revoked = false; #requests = 0;
  constructor({ routeAuthority, binding, expectedNativeIdentity, deadlineMs = 10_000, now = Date.now }) {
    if (!routeAuthority || typeof routeAuthority.issueLease !== "function" || typeof routeAuthority.request !== "function") throw invalid("A trusted X route authority is required.");
    bindingValue(binding); this.#binding = Object.freeze(structuredClone(binding)); this.#lease = routeAuthority.issueLease(this.#binding); this.#authority = routeAuthority;
    this.#expected = nativeId(expectedNativeIdentity); if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) throw invalid("The X deadline is invalid."); this.#deadlineMs = deadlineMs; this.#now = now;
  }
  binding() { return this.#binding; }
  diagnostics() { return Object.freeze({ binding: this.#binding, identityValidated: this.#identity !== null, revoked: this.#revoked, requests: this.#requests }); }
  async verifyIdentity() { this.#active(); if (this.#identity) return this.#identity; const result = await this.#perform("account.identity", {}); if (result.entity.nativeId !== this.#expected) { this.#revoked = true; throw new XContractError("WRONG_IDENTITY", "The authenticated X identity does not match the immutable account binding."); } this.#identity = result; return result; }
  async execute(operation, input, { previousCursor = null } = {}) { this.#active(); if (operation === "account.identity") return this.verifyIdentity(); await this.verifyIdentity(); return this.#perform(operation, input, previousCursor); }
  async executeMediaPhase(phase, input) { this.#active(); await this.verifyIdentity(); return this.#perform("post.media.create", input, null, phase); }
  revoke() { this.#revoked = true; this.#identity = null; }
  async #perform(operation, input, previousCursor = null, phase) { const protocol = buildXProtocolRequest(operation, input, phase); this.#requests += 1; let response; try { response = await this.#authority.request(this.#lease, { target: protocol.target, method: protocol.method, path: protocol.path, body: protocol.body, deadlineEpochMs: this.#now() + this.#deadlineMs }); } catch (error) { const write = protocol.submission === "SINGLE_ATTEMPT"; throw new XContractError(write ? "UNKNOWN" : "WORKER_UNAVAILABLE", write ? "The X write result is unverified." : "The X request failed before a result was received.", { submissionMayHaveStarted: write, retryable: !write }); } try { return normalizeXProtocolResponse(operation, { status: response.status, headers: response.headers, body: decode(response.body) }, previousCursor, phase ?? null); } catch (error) { if (protocol.submission === "SINGLE_ATTEMPT" && error instanceof XContractError && error.code === "PROTOCOL_DRIFT") throw new XContractError("UNKNOWN", "The X write result is unverified.", { submissionMayHaveStarted: true }); throw error; } }
  #active() { if (this.#revoked) throw new XContractError("SESSION_REVOKED", "The X transport is revoked."); }
}

function decode(value) { if (value && typeof value === "object" && !(value instanceof Uint8Array)) return value; if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 1024 * 1024) throw new XContractError("PROTOCOL_DRIFT", "The X response body is invalid."); try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); } catch { throw new XContractError("PROTOCOL_DRIFT", "The X response body is not valid JSON."); } }
function bindingValue(value) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "accountId,generation,routeId,tenantId" || !Number.isSafeInteger(value.generation) || value.generation < 1 || [value.tenantId, value.accountId, value.routeId].some((item) => typeof item !== "string" || item.length < 1 || item.length > 128)) throw invalid("The X route binding is invalid."); }
function nativeId(value) { if (typeof value !== "string" || !/^\d+$/u.test(value) || value.length > 128) throw invalid("The expected X identity is invalid."); return value; }
function invalid(message) { return new XContractError("INVALID_REQUEST", message); }
