import {
  DEFAULT_DATA_LIMITS,
  assertBoundedValue,
  decodeBoundedJson,
  deepFreeze
} from "./bounds.mjs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { SECURITY_ERROR_CODES, fail } from "./errors.mjs";

export const PLATFORM_RESPONSE_LIMITS = Object.freeze({
  ...DEFAULT_DATA_LIMITS,
  maxBytes: 2 * 1024 * 1024,
  maxEntries: 10_000,
  maxCollectionLength: 1_000,
  maxStringBytes: 128 * 1024
});

export function decodeBoundedPlatformBody(
  body,
  contentEncoding = "identity",
  { maxCompressedBytes = 512 * 1024, maxDecompressedBytes = PLATFORM_RESPONSE_LIMITS.maxBytes } = {}
) {
  if (!(body instanceof Uint8Array) || body.byteLength > maxCompressedBytes) {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The compressed platform body exceeds its byte bound");
  }
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes < 1) {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The decompressed platform bound is invalid");
  }
  try {
    switch (String(contentEncoding).trim().toLowerCase()) {
      case "":
      case "identity":
        if (body.byteLength > maxDecompressedBytes) {
          fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The platform body exceeds its decompressed byte bound");
        }
        return Buffer.from(body);
      case "gzip":
        return gunzipSync(body, { maxOutputLength: maxDecompressedBytes });
      case "br":
        return brotliDecompressSync(body, { maxOutputLength: maxDecompressedBytes });
      default:
        fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The platform content encoding is not admitted");
    }
  } catch (error) {
    if (error?.code === SECURITY_ERROR_CODES.RESPONSE_BOUNDS) {
      throw error;
    }
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The platform body could not be decompressed within bounds");
  }
}

export function decodeHostilePlatformJson(frame, project, limits = PLATFORM_RESPONSE_LIMITS) {
  if (typeof project !== "function") {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "A strict response projector is required");
  }
  const hostile = decodeBoundedJson(frame, limits, SECURITY_ERROR_CODES.RESPONSE_BOUNDS);
  let projected;
  try {
    projected = project(hostile);
  } catch (error) {
    if (error?.code) {
      throw error;
    }
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The platform response did not match its strict schema");
  }
  assertBoundedValue(projected, limits, SECURITY_ERROR_CODES.RESPONSE_BOUNDS);
  assertNoActiveContent(projected);
  return deepFreeze(structuredClone(projected));
}

export function assertRedditCanonicalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The canonical URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.reddit.com" ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.startsWith("/") ||
    url.pathname.startsWith("//")
  ) {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The canonical URL is not an admitted Reddit URL");
  }
  return url.href;
}

function assertNoActiveContent(value) {
  const forbiddenAuthorityFields = new Set([
    "proxy",
    "proxyUrl",
    "destination",
    "targetId",
    "routeId",
    "authorization"
  ]);
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") {
      if (typeof item === "string" && /(?:<\s*script\b|javascript\s*:)/iu.test(item)) {
        fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "Projected output contains active content");
      }
      continue;
    }
    for (const [key, child] of Object.entries(item)) {
      if (forbiddenAuthorityFields.has(key)) {
        fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, `Projected output contains authority field: ${key}`);
      }
      if (/(?:^|_)html$/iu.test(key)) {
        fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "Projected output contains an HTML field");
      }
      stack.push(child);
    }
  }
}
