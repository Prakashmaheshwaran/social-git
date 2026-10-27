import type { IncomingMessage, ServerResponse } from "node:http";
import { ServiceError, toPublicError } from "./errors.ts";
import type { Principal } from "./service.ts";

/**
 * Shared owner-only secret-ingest boundary for explicitly exported platform
 * sessions.
 *
 * Every platform uploads through the same same-origin, owner-cookie-and-CSRF
 * JSON route; only the JSON schema, the human-readable platform label, and the
 * admitted response status differ. Those three differences are parameters, so a
 * new platform's controller is a schema module plus one registration.
 *
 * This module is deliberately free of platform types: it never names a
 * platform, never logs request material, and wipes every staged buffer on the
 * way out, including when the import callback throws.
 */

export const OWNER_SESSION_IMPORT_MAX_BYTES = 24 * 1024;

/** Material staged from one upload. Both buffers are wiped by the caller. */
export interface OwnerSessionImportMaterial {
  expectedNativeUserId: string;
  session: Uint8Array;
  networkRoute: { id: string; material: Uint8Array };
}

export interface OwnerSessionImportOutcome {
  /** HTTP status to send when the import succeeds. */
  status: number;
  /** JSON body to send. Never contains session material. */
  body: unknown;
}

export interface OwnerSessionImportSchema {
  /**
   * Parse the decoded JSON body into custody material. Every rejection must be
   * a `ServiceError`; the factory does not add or remove checks.
   */
  parse(parsed: unknown): OwnerSessionImportMaterial;
}

export interface OwnerSessionImportOptions<Service> {
  /** Route pathname pattern whose first capture is the raw account id. */
  path: RegExp;
  /** Display name used verbatim in operator-facing messages, e.g. "Reddit". */
  platformLabel: string;
  /** Exact-key JSON schema for this platform's export file. */
  schema: OwnerSessionImportSchema;
  /** Core custody call. Resolves to the status and body to return. */
  importSession(
    service: Service,
    principal: Principal,
    accountId: string,
    material: OwnerSessionImportMaterial,
  ): Promise<OwnerSessionImportOutcome>;
}

/**
 * Build the controller class for one platform.
 *
 * The returned class keeps the historic public constructor
 * `(service, authenticateOwner)`. `authenticateOwner` must be the
 * owner-cookie-and-CSRF verifier: passing a bearer-capable authenticator would
 * defeat the browser-session-only gate that `handle` enforces before it runs.
 */
export function createOwnerSessionImportController<Service>(options: OwnerSessionImportOptions<Service>) {
  const { path, platformLabel, schema, importSession } = options;

  return class OwnerSessionImportController {
    private readonly service: Service;
    private readonly authenticateOwner: (request: IncomingMessage) => Principal | null;

    constructor(service: Service, authenticateOwner: (request: IncomingMessage) => Principal | null) {
      this.service = service;
      this.authenticateOwner = authenticateOwner;
    }

    ownsPath(pathname: string) { return path.test(pathname); }

    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const match = path.exec(url.pathname);
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
          throw new ServiceError("VALIDATION_FAILED", `Upload the explicitly exported ${platformLabel} session JSON file.`, { status: 415 });
        }
        const owner = this.authenticateOwner(request);
        if (!owner) throw new ServiceError("UNAUTHENTICATED", "A valid owner session and fresh CSRF token are required.");
        if (owner.role !== "owner") throw new ServiceError("FORBIDDEN", "Only the signed-in owner can import a social session.");
        const accountId = safePath(match[1]!);
        const imported = await readOwnerSessionFile(request, platformLabel, schema);
        try {
          const result = await importSession(this.service, owner, accountId, imported);
          return sendJson(response, result.status, result.body);
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
  };
}

async function readOwnerSessionFile(
  request: IncomingMessage,
  platformLabel: string,
  schema: OwnerSessionImportSchema,
): Promise<OwnerSessionImportMaterial> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > OWNER_SESSION_IMPORT_MAX_BYTES)) {
    throw new ServiceError("VALIDATION_FAILED", `Session file exceeds the ${OWNER_SESSION_IMPORT_MAX_BYTES} byte limit.`, { status: 413 });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > OWNER_SESSION_IMPORT_MAX_BYTES) {
        bytes.fill(0);
        throw new ServiceError("VALIDATION_FAILED", `Session file exceeds the ${OWNER_SESSION_IMPORT_MAX_BYTES} byte limit.`, { status: 413 });
      }
      chunks.push(bytes);
    }
    if (size < 2) throw new ServiceError("VALIDATION_FAILED", `The exported ${platformLabel} session file is empty.`);
    const joined = Buffer.concat(chunks, size);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(joined.toString("utf8")); }
      catch { throw new ServiceError("VALIDATION_FAILED", `The exported ${platformLabel} session file must be valid JSON.`); }
      return schema.parse(parsed);
    } finally {
      joined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/**
 * Accept exactly the schema's keys. Shared because every platform export is a
 * closed envelope: an unknown key is a rejected upload, never ignored.
 */
export function exactSessionObject(value: unknown, platformLabel: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ServiceError("VALIDATION_FAILED", `The exported ${platformLabel} session file must be a plain JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ServiceError("VALIDATION_FAILED", `The exported ${platformLabel} session file contains missing or unsupported fields.`);
  }
  return value as Record<string, unknown>;
}

export function boundedSessionText(value: unknown, field: string, maximum: number, pattern: RegExp) {
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
