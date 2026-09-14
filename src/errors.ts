export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "IDENTITY_MISMATCH",
  "SESSION_REVOKED",
  "CHALLENGE_REQUIRED",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "ACTION_STATE_CONFLICT",
  "PROTOCOL_DRIFT",
  "UNKNOWN_RESULT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
}

const SECRET_KEY = /(authorization|cookie|credential|csrf|password|secret|session|token)/i;
const SECRET_TEXT = /(bearer\s+[a-z0-9._~+\/-]+=*|(?:cookie|csrf|password|secret|session|token)\s*[=:]\s*[^\s,;]+)/gi;

export function redactMessage(value: string): string {
  return value.replace(SECRET_TEXT, "[REDACTED]").slice(0, 512);
}

export function redactDetails(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDetails(item, depth + 1));
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      clean[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactDetails(item, depth + 1);
    }
    return clean;
  }
  if (typeof value === "string") return redactMessage(value);
  return value;
}

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly rateLimit?: RateLimitInfo;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      details?: unknown;
      rateLimit?: RateLimitInfo;
    } = {},
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = options.status ?? statusFor(code);
    this.retryable = options.retryable ?? false;
    this.details = options.details === undefined ? undefined : redactDetails(options.details);
    this.rateLimit = options.rateLimit;
  }
}

function statusFor(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED": return 401;
    case "FORBIDDEN": return 403;
    case "NOT_FOUND": return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "ACTION_STATE_CONFLICT": return 409;
    case "RATE_LIMITED": return 429;
    case "INTERNAL": return 500;
    default: return 422;
  }
}

export function toPublicError(error: unknown, requestId: string) {
  const safe = error instanceof ServiceError
    ? error
    : new ServiceError("INTERNAL", "The service could not complete the request.", { status: 500 });
  return {
    status: safe.status,
    body: {
      error: {
        code: safe.code,
        message: redactMessage(safe.message),
        requestId,
        retryable: safe.retryable,
        ...(safe.details === undefined ? {} : { details: safe.details }),
        ...(safe.rateLimit === undefined ? {} : { rateLimit: safe.rateLimit }),
      },
    },
  };
}

export function assertString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ServiceError("VALIDATION_FAILED", `${field} must be a non-empty string of at most ${maxLength} characters.`, {
      details: { field },
    });
  }
  return value;
}

export function assertObject(value: unknown, field = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("VALIDATION_FAILED", `${field} must be an object.`, { details: { field } });
  }
  return value as Record<string, unknown>;
}
