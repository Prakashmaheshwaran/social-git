import { assertExactKeys, deepFreeze } from "./bounds.mjs";
import { SECURITY_ERROR_CODES, fail } from "./errors.mjs";

export const STOP_ERROR_CODES = Object.freeze([
  "CHALLENGE_REQUIRED",
  "CHECKPOINT_REQUIRED",
  "CAPTCHA_REQUIRED",
  "RATE_LIMITED",
  "WRONG_IDENTITY",
  "SESSION_REVOKED",
  "PROTOCOL_DRIFT"
]);

const stopCodeSet = new Set(STOP_ERROR_CODES);

export class PlatformStopCircuit {
  #circuits = new Map();
  #minimumGenerations = new Map();
  #now;
  #verifyRecoveryAuthorization;

  constructor({ now = Date.now, verifyRecoveryAuthorization = () => false } = {}) {
    if (typeof now !== "function" || typeof verifyRecoveryAuthorization !== "function") {
      fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, "Clock and recovery authorization verifier functions are required");
    }
    this.#now = now;
    this.#verifyRecoveryAuthorization = verifyRecoveryAuthorization;
  }

  observe(binding, normalizedResult) {
    validateDispatchBinding(binding);
    if (
      normalizedResult?.status !== "FAILED" ||
      !normalizedResult.error ||
      !stopCodeSet.has(normalizedResult.error.code)
    ) {
      return null;
    }
    const event = deepFreeze({
      platform: binding.platform,
      code: normalizedResult.error.code,
      openedAtEpochMs: this.#now(),
      generation: binding.generation,
      triggeringAccountId: binding.accountId,
      triggeringRouteId: binding.routeId,
      triggeringActionId: binding.actionId
    });
    this.#circuits.set(binding.platform, event);
    return event;
  }

  assertCanDispatch(binding) {
    validateDispatchBinding(binding);
    const minimumGeneration = this.#minimumGenerations.get(binding.platform) ?? 1;
    if (binding.generation < minimumGeneration) {
      fail(
        SECURITY_ERROR_CODES.CIRCUIT_OPEN,
        `${binding.platform} generation ${binding.generation} is fenced below ${minimumGeneration}`
      );
    }
    const circuit = this.#circuits.get(binding.platform);
    if (circuit) {
      fail(
        SECURITY_ERROR_CODES.CIRCUIT_OPEN,
        `${binding.platform} dispatch is stopped by ${circuit.code}; route or account rotation is not permitted`
      );
    }
    return true;
  }

  recover({ platform, previousGeneration, newGeneration, authorization, reason }) {
    const circuit = this.#circuits.get(platform);
    if (
      !circuit ||
      circuit.generation !== previousGeneration ||
      !Number.isSafeInteger(newGeneration) ||
      newGeneration <= previousGeneration ||
      typeof reason !== "string" ||
      reason.length === 0
    ) {
      fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, "Explicit authorized recovery with a newer generation is required");
    }
    validateRecoveryAuthorization(authorization, { platform, previousGeneration, newGeneration });
    if (this.#verifyRecoveryAuthorization(authorization) !== true) {
      fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, "The recovery authorization record was not verified");
    }
    this.#circuits.delete(platform);
    this.#minimumGenerations.set(platform, newGeneration);
    return deepFreeze({ platform, previousGeneration, newGeneration, authorizationId: authorization.id, reason });
  }

  inspect(platform) {
    return deepFreeze({
      circuit: this.#circuits.get(platform) ?? null,
      minimumGeneration: this.#minimumGenerations.get(platform) ?? 1
    });
  }
}

function validateRecoveryAuthorization(authorization, binding) {
  assertExactKeys(authorization, [
    "id", "kind", "platform", "previousGeneration", "newGeneration", "approvedBy", "approvedAtEpochMs"
  ]);
  if (
    authorization.kind !== "platform_stop_recovery" ||
    authorization.platform !== binding.platform ||
    authorization.previousGeneration !== binding.previousGeneration ||
    authorization.newGeneration !== binding.newGeneration ||
    typeof authorization.id !== "string" || authorization.id.length === 0 ||
    typeof authorization.approvedBy !== "string" || authorization.approvedBy.length === 0 ||
    !Number.isSafeInteger(authorization.approvedAtEpochMs) || authorization.approvedAtEpochMs < 1
  ) {
    fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, "The recovery authorization record does not match");
  }
}

function validateDispatchBinding(binding) {
  assertExactKeys(binding, ["platform", "tenantId", "accountId", "routeId", "generation", "actionId"]);
  for (const field of ["platform", "tenantId", "accountId", "routeId", "actionId"]) {
    if (typeof binding[field] !== "string" || binding[field].length === 0) {
      fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, `Invalid ${field} binding`);
    }
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, "Invalid generation binding");
  }
}
