import { TextDecoder } from "node:util";
import { SECURITY_ERROR_CODES, fail } from "./errors.mjs";

export const DEFAULT_DATA_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 12,
  maxEntries: 2_048,
  maxCollectionLength: 500,
  maxStringBytes: 16 * 1024
});

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeBoundedJson(frame, limits = DEFAULT_DATA_LIMITS, code = SECURITY_ERROR_CODES.IPC_BOUNDS) {
  if (!(frame instanceof Uint8Array)) {
    fail(code, "The frame must be bytes");
  }
  const normalized = normalizeLimits(limits);
  if (frame.byteLength > normalized.maxBytes) {
    fail(code, `The frame exceeds ${normalized.maxBytes} bytes`);
  }

  let text;
  try {
    text = utf8Decoder.decode(frame);
  } catch {
    fail(code, "The frame is not valid UTF-8");
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code, "The frame is not valid JSON");
  }
  assertBoundedValue(value, normalized, code);
  return value;
}

export function encodeBoundedJson(value, limits = DEFAULT_DATA_LIMITS, code = SECURITY_ERROR_CODES.IPC_BOUNDS) {
  const normalized = normalizeLimits(limits);
  assertBoundedValue(value, normalized, code);
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    fail(code, "The value is not JSON serializable");
  }
  if (encoded.byteLength > normalized.maxBytes) {
    fail(code, `The frame exceeds ${normalized.maxBytes} bytes`);
  }
  return encoded;
}

export function assertBoundedValue(value, limits = DEFAULT_DATA_LIMITS, code = SECURITY_ERROR_CODES.IPC_BOUNDS) {
  const normalized = normalizeLimits(limits);
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  let entries = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const item = current.value;
    if (current.depth > normalized.maxDepth) {
      fail(code, `The value exceeds depth ${normalized.maxDepth}`);
    }
    if (item === null || typeof item === "boolean") {
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail(code, "The value contains a non-finite number");
      }
      continue;
    }
    if (typeof item === "string") {
      assertUnicode(item, code);
      if (Buffer.byteLength(item, "utf8") > normalized.maxStringBytes) {
        fail(code, `A string exceeds ${normalized.maxStringBytes} bytes`);
      }
      continue;
    }
    if (typeof item !== "object" || item === undefined) {
      fail(code, "The value contains a non-JSON type");
    }
    if (seen.has(item)) {
      fail(code, "The value contains a cycle or repeated object reference");
    }
    seen.add(item);

    const isArray = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      fail(code, "The value contains a non-plain object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Object.keys(descriptors);
    if (isArray) {
      const expectedKeys = Array.from({ length: item.length }, (_, index) => String(index));
      if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        fail(code, "An array contains sparse or named properties");
      }
      if (item.length > normalized.maxCollectionLength) {
        fail(code, `An array exceeds ${normalized.maxCollectionLength} items`);
      }
    } else if (keys.length > normalized.maxCollectionLength) {
      fail(code, `An object exceeds ${normalized.maxCollectionLength} fields`);
    }

    entries += keys.length;
    if (entries > normalized.maxEntries) {
      fail(code, `The value exceeds ${normalized.maxEntries} total entries`);
    }
    for (const key of keys) {
      assertUnicode(key, code);
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || descriptor.get || descriptor.set) {
        fail(code, "The value contains an accessor property");
      }
      if (descriptor.value === undefined) {
        fail(code, "The value contains undefined");
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return value;
}

export function assertExactKeys(value, requiredKeys, optionalKeys = [], code = SECURITY_ERROR_CODES.IPC_SCHEMA) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, "Expected a plain object");
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(code, `Unknown field: ${key}`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      fail(code, `Missing field: ${key}`);
    }
  }
  return value;
}

export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function assertUnicode(value, code) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(code, "The value contains an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(code, "The value contains an unpaired UTF-16 surrogate");
    }
  }
}

function normalizeLimits(limits) {
  const merged = { ...DEFAULT_DATA_LIMITS, ...limits };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail(SECURITY_ERROR_CODES.IPC_BOUNDS, `Invalid bound: ${key}`);
    }
  }
  return merged;
}
