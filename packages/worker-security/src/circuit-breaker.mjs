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
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") {
      fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, "A clock function is required");
    }
    this.#now = now;
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
    const circuit = this.#circuits.get(binding.platform);
    if (circuit) {
      fail(
        SECURITY_ERROR_CODES.CIRCUIT_OPEN,
        `${binding.platform} dispatch is stopped by ${circuit.code}; route or account rotation is not permitted`
      );
    }
    return true;
  }

  recover({ platform, previousGeneration, newGeneration, authorizedBy, reason }) {
    const circuit = this.#circuits.get(platform);
    if (
      !circuit ||
      circuit.generation !== previousGeneration ||
      !Number.isSafeInteger(newGeneration) ||
      newGeneration <= previousGeneration ||
      typeof authorizedBy !== "string" ||
      authorizedBy.length === 0 ||
      typeof reason !== "string" ||
      reason.length === 0
    ) {
      fail(SECURITY_ERROR_CODES.CIRCUIT_OPEN, "Explicit authorized recovery with a newer generation is required");
    }
    this.#circuits.delete(platform);
    return deepFreeze({ platform, previousGeneration, newGeneration, authorizedBy, reason });
  }

  inspect(platform) {
    return this.#circuits.get(platform) ?? null;
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
