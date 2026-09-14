import { SessionRuntimeError } from "./errors.js";

const REDACTED = "[REDACTED]";
const REDACTED_BYTES = "[REDACTED_BYTES]";
const SECRET_KEY = /(?:authorization|cookie|csrf|xsrf|token|secret|password|passcode|mfa|session|envelope|route.*material|materialbase64|private.?key)/i;
const HEADER_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi,
  /((?:x-)?(?:csrf|xsrf)(?:-token)?\s*[:=]\s*)[^\s,;]+/gi,
  /((?:access|refresh|id)[_-]?token\s*[:=]\s*)[^\s,;&]+/gi,
  /((?:password|passcode|mfa(?:_code)?)\s*[:=]\s*)[^\s,;&]+/gi
];

function scrubString(value) {
  let scrubbed = value;
  for (const pattern of HEADER_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, `$1${REDACTED}`);
  }
  return scrubbed;
}

function redactInternal(value, seen, depth) {
  if (depth > 12) return "[TRUNCATED]";
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value === "function" || typeof value === "symbol") return "[UNSUPPORTED]";
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return REDACTED_BYTES;
  if (value instanceof Error) return redactError(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => redactInternal(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key)
      ? REDACTED
      : redactInternal(item, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

export function redact(value) {
  return redactInternal(value, new WeakSet(), 0);
}

export function redactError(error) {
  if (error instanceof SessionRuntimeError) return error.toJSON();
  return { name: "Error", code: "INTERNAL", message: "The operation failed." };
}

export function createSafeLogger(sink) {
  if (typeof sink !== "function") throw new TypeError("A log sink function is required.");
  const write = (level, message, fields = undefined) => {
    sink(level, scrubString(String(message)), fields === undefined ? undefined : redact(fields));
  };
  return Object.freeze({
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields)
  });
}
