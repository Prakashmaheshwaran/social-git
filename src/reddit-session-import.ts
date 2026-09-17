import type { IncomingMessage, ServerResponse } from "node:http";
import { ServiceError, toPublicError } from "./errors.ts";
import type { Principal, SocialGitService } from "./service.ts";

const MAX_IMPORT_BYTES = 24 * 1024;
const PATH = /^\/v1\/control-plane\/accounts\/([^/]+)\/reddit-session$/u;

export class OwnerRedditSessionImportController {
  private readonly service: SocialGitService;
  private readonly authenticateOwner: (request: IncomingMessage) => Principal | null;

  constructor(service: SocialGitService, authenticateOwner: (request: IncomingMessage) => Principal | null) {
    this.service = service;
    this.authenticateOwner = authenticateOwner;
  }

  ownsPath(pathname: string) { return PATH.test(pathname); }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = PATH.exec(url.pathname);
    if (!match) return false;
    try {
      if (request.method !== "POST") throw new ServiceError("NOT_FOUND", "Route not found.");
      if (request.headers.authorization !== undefined) {
        throw new ServiceError("FORBIDDEN", "Social-session import accepts only the signed-in owner browser session.");
      }
      if (request.headers["sec-fetch-site"] !== "same-origin") {
        throw new ServiceError("FORBIDDEN", "Social-session import requires a same-origin browser request.");
      }
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) {
        throw new ServiceError("VALIDATION_FAILED", "Upload the explicitly exported Reddit session JSON file.", { status: 415 });
      }
      const owner = this.authenticateOwner(request);
      if (!owner) {
        throw new ServiceError("UNAUTHENTICATED", "A valid owner session and fresh CSRF token are required.");
      }
      if (owner.role !== "owner") {
        throw new ServiceError("FORBIDDEN", "Only the signed-in owner can import a social session.");
      }
      const accountId = safePath(match[1]!);
      const imported = await readRedditSessionFile(request);
      try {
        const result = await this.service.importOwnerRedditSession(owner, accountId, imported);
        return sendJson(response, 201, result);
      } finally {
        imported.session.fill(0);
        imported.networkRoute.material.fill(0);
      }
    } catch (error) {
      const requestId = response.getHeader("x-request-id");
      const safe = toPublicError(error, typeof requestId === "string" ? requestId : "unknown");
      return sendJson(response, safe.status, safe.body);
    }
  }
}

async function readRedditSessionFile(request: IncomingMessage): Promise<{
  expectedNativeUserId: string;
  session: Uint8Array;
  networkRoute: { id: string; material: Uint8Array };
}> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_IMPORT_BYTES)) {
    throw new ServiceError("VALIDATION_FAILED", `Session file exceeds the ${MAX_IMPORT_BYTES} byte limit.`, { status: 413 });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_IMPORT_BYTES) {
        bytes.fill(0);
        throw new ServiceError("VALIDATION_FAILED", `Session file exceeds the ${MAX_IMPORT_BYTES} byte limit.`, { status: 413 });
      }
      chunks.push(bytes);
    }
    if (size < 2) throw new ServiceError("VALIDATION_FAILED", "The exported Reddit session file is empty.");
    const joined = Buffer.concat(chunks, size);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(joined.toString("utf8")); }
      catch { throw new ServiceError("VALIDATION_FAILED", "The exported Reddit session file must be valid JSON."); }
      const body = exactObject(parsed, ["version", "platform", "expectedNativeUserId", "redditSessionCookie", "csrfToken"]);
      if (body.version !== 1 || body.platform !== "reddit") {
        throw new ServiceError("VALIDATION_FAILED", "The session file must use the Reddit session export v1 schema.");
      }
      const expectedNativeUserId = boundedText(body.expectedNativeUserId, "expectedNativeUserId", 128, /^[A-Za-z0-9_:.-]+$/u);
      const redditSessionCookie = boundedText(body.redditSessionCookie, "redditSessionCookie", 8192, /^[^;\s\0\r\n]+$/u);
      const csrfToken = boundedText(body.csrfToken, "csrfToken", 4096, /^[^\s\0\r\n]+$/u);
      const session = Buffer.from(JSON.stringify({ cookies: { reddit_session: redditSessionCookie }, csrfToken }), "utf8");
      const route = Buffer.from(JSON.stringify({ kind: "direct" }), "utf8");
      return { expectedNativeUserId, session, networkRoute: { id: "reddit-direct", material: route } };
    } finally {
      joined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ServiceError("VALIDATION_FAILED", "The exported Reddit session file must be a plain JSON object.");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ServiceError("VALIDATION_FAILED", "The exported Reddit session file contains missing or unsupported fields.");
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, maximum: number, pattern: RegExp) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new ServiceError("VALIDATION_FAILED", `${field} is invalid.`, { details: { field } });
  }
  return value;
}

function safePath(value: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new ServiceError("VALIDATION_FAILED", "accountId is invalid."); }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(decoded)) throw new ServiceError("VALIDATION_FAILED", "accountId is invalid.");
  return decoded;
}

function sendJson(response: ServerResponse, status: number, value: unknown): true {
  if (response.writableEnded) return true;
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
  return true;
}
