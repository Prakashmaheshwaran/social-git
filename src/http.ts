import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OPERATIONS, generateOpenApi, type OperationDefinition } from "./contract.ts";
import { executeOperation } from "./dispatcher.ts";
import { ServiceError, toPublicError } from "./errors.ts";
import { createMcpGateway } from "./mcp.ts";
import type { Principal, SocialGitService } from "./service.ts";
import { serveWebApplication } from "./web.ts";
import type { RuntimeMaintenanceGate } from "./maintenance.ts";

export type Authenticator = (request: IncomingMessage) => Promise<Principal | null> | Principal | null;

export function bearerAuthenticator(tokens: ReadonlyMap<string, Principal>): Authenticator {
  return (request) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return null;
    return tokens.get(authorization.slice(7)) ?? null;
  };
}

export function hashedBearerAuthenticator(entries: ReadonlyMap<string, Principal>): Authenticator {
  return (request) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice(7);
    if (token.length < 16 || token.length > 4096) return null;
    const digest = createHash("sha256").update(token).digest("hex");
    return entries.get(digest) ?? null;
  };
}

export interface HttpServerOptions {
  service: SocialGitService;
  authenticate: Authenticator;
  identity?: {
    handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  };
  ownerOperations?: {
    ownsPath(pathname: string): boolean;
    handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  };
  maintenanceGate?: RuntimeMaintenanceGate;
  readiness?: () => { ready: boolean; checks?: Record<string, boolean | number | string> }
    | Promise<{ ready: boolean; checks?: Record<string, boolean | number | string> }>;
  onActionQueued?: () => void;
  onRequest?: (event: { requestId: string; method: string; path: string; status: number; durationMs: number }) => void;
  fixtureControl?: {
    control(command: string, payload: Record<string, unknown>): Promise<unknown> | unknown;
    inspect(target: string): Promise<unknown> | unknown;
  };
}

export function createSocialGitHttpServer(options: HttpServerOptions) {
  const mcp = createMcpGateway(options.service);
  return createServer({ maxHeaderSize: 16_384, headersTimeout: 5_000, requestTimeout: 15_000 }, async (request, response) => {
    const startedAt = performance.now();
    const requestId = validRequestId(request.headers["x-request-id"]) ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    let tracedPath = "/";
    response.once("finish", () => options.onRequest?.({
      requestId,
      method: request.method ?? "UNKNOWN",
      path: tracedPath,
      status: response.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    }));
    let releaseMaintenanceLease: (() => void) | undefined;
    try {
      if ((request.url?.length ?? 0) > 4096) throw new ServiceError("VALIDATION_FAILED", "Request target exceeds the 4096 character limit.", { status: 414 });
      const url = new URL(request.url ?? "/", "http://localhost");
      tracedPath = url.pathname;
      if (serveWebApplication(request, response, url.pathname)) return;
      if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/readyz") {
        const readiness = await options.readiness?.() ?? { ready: true };
        return sendJson(response, readiness.ready ? 200 : 503, { status: readiness.ready ? "ready" : "not_ready", ...(readiness.checks ? { checks: readiness.checks } : {}) });
      }
      if (request.method === "GET" && url.pathname === "/openapi.json") return sendJson(response, 200, generateOpenApi());
      if (tracksRuntimeState(url.pathname) && !options.ownerOperations?.ownsPath(url.pathname)) {
        releaseMaintenanceLease = options.maintenanceGate?.tryEnter() ?? undefined;
        if (options.maintenanceGate && !releaseMaintenanceLease) {
          throw new ServiceError("CAPABILITY_UNAVAILABLE", "A backup maintenance window is active. Retry after the backup finishes.", { status: 503, retryable: true });
        }
      }
      if (options.identity && await options.identity.handle(request, response)) return;
      if (options.ownerOperations && await options.ownerOperations.handle(request, response)) return;
      if (options.fixtureControl && url.pathname === "/__fixture/control") {
        const principal = await options.authenticate(request);
        if (!principal) throw new ServiceError("UNAUTHENTICATED", "Authentication is required.");
        if (!principal.scopes.includes("fixture:control") && !principal.scopes.includes("*")) {
          throw new ServiceError("FORBIDDEN", "Fixture control scope is required.");
        }
        if (request.method === "POST") {
          const body = await readJson(request);
          const command = typeof body.command === "string" ? body.command : "";
          if (!command || command.length > 128) throw new ServiceError("VALIDATION_FAILED", "Fixture control command is invalid.");
          const payload = body.payload === undefined ? {} : body.payload;
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ServiceError("VALIDATION_FAILED", "Fixture control payload is invalid.");
          return sendJson(response, 200, { data: await options.fixtureControl.control(command, payload as Record<string, unknown>) });
        }
        throw new ServiceError("NOT_FOUND", "Route not found.");
      }
      if (options.fixtureControl && request.method === "GET" && url.pathname === "/__fixture/inspect") {
        const principal = await options.authenticate(request);
        if (!principal) throw new ServiceError("UNAUTHENTICATED", "Authentication is required.");
        if (!principal.scopes.includes("fixture:control") && !principal.scopes.includes("*")) {
          throw new ServiceError("FORBIDDEN", "Fixture control scope is required.");
        }
        const target = url.searchParams.get("target") ?? "";
        if (!target || target.length > 128) throw new ServiceError("VALIDATION_FAILED", "Fixture inspection target is invalid.");
        return sendJson(response, 200, { data: await options.fixtureControl.inspect(target) });
      }
      if (url.pathname === "/mcp") {
        if (request.method !== "POST") throw new ServiceError("NOT_FOUND", "Route not found.");
        const principal = await options.authenticate(request);
        if (!principal) throw new ServiceError("UNAUTHENTICATED", "Authentication is required.");
        const body = await readJson(request, 12 * 1024 * 1024);
        const result = await mcp.handle(body, { principal }, requestId);
        return result === null ? sendEmpty(response, 202) : sendJson(response, 200, result);
      }
      const match = matchOperation(request.method ?? "", url.pathname);
      if (!match) throw new ServiceError("NOT_FOUND", "Route not found.");
      const principal = await options.authenticate(request);
      if (!principal) throw new ServiceError("UNAUTHENTICATED", "Authentication is required.");
      const input: Record<string, unknown> = {};
      for (const [key, value] of url.searchParams) input[key] = value;
      if (match.operation.method === "POST") {
        const body = await readJson(request, match.operation.operationId === "media.create" ? 12 * 1024 * 1024 : 262_144);
        if (isActionCreateOperation(match.operation.operationId)) input.action = body;
        else Object.assign(input, body);
      }
      Object.assign(input, match.pathParameters);
      if (usesIdempotencyKey(match.operation)) input.idempotencyKey = request.headers["idempotency-key"];
      const result = await executeOperation(options.service, match.operation, principal, input);
      if (isActionCreateOperation(match.operation.operationId)) options.onActionQueued?.();
      if (result && typeof result === "object") {
        const responseShape = result as { replayed?: unknown; nextCursor?: unknown };
        if (typeof responseShape.replayed === "boolean") response.setHeader("idempotency-replayed", String(responseShape.replayed));
        if (typeof responseShape.nextCursor === "string") response.setHeader("x-next-cursor", responseShape.nextCursor);
      }
      sendJson(response, match.operation.successStatus ?? 200, result);
    } catch (error) {
      const safe = toPublicError(error, requestId);
      if (error instanceof ServiceError && error.rateLimit) {
        if (error.rateLimit.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(error.rateLimit.retryAfterSeconds));
        if (error.rateLimit.limit !== undefined) response.setHeader("x-ratelimit-limit", String(error.rateLimit.limit));
        if (error.rateLimit.remaining !== undefined) response.setHeader("x-ratelimit-remaining", String(error.rateLimit.remaining));
        if (error.rateLimit.resetAt !== undefined) response.setHeader("x-ratelimit-reset", error.rateLimit.resetAt);
      }
      sendJson(response, safe.status, safe.body);
    } finally {
      releaseMaintenanceLease?.();
    }
  });
}

function tracksRuntimeState(pathname: string) {
  return pathname.startsWith("/v1/") || pathname === "/mcp" || pathname.startsWith("/__fixture/");
}

function sendEmpty(response: ServerResponse, status: number) {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-length", "0");
  response.end();
}

function validRequestId(value: string | string[] | undefined) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

async function readJson(request: IncomingMessage, maximum = 262_144): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximum) throw new ServiceError("VALIDATION_FAILED", `Request body exceeds the ${maximum} byte limit.`, { status: 413 });
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ServiceError("VALIDATION_FAILED", "Request body must be a JSON object.");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  if (response.writableEnded) return;
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

interface OperationMatch { operation: OperationDefinition; pathParameters: Record<string, string> }

export function matchOperation(method: string, pathname: string): OperationMatch | null {
  for (const operation of OPERATIONS) {
    if (operation.method !== method) continue;
    const names: string[] = [];
    const pattern = operation.path.split("/").map((part) => {
      const match = /^\{(.+)\}$/.exec(part);
      if (!match) return escapeRegex(part);
      names.push(match[1]!);
      return "([^/]+)";
    }).join("/");
    const values = new RegExp(`^${pattern}$`).exec(pathname);
    if (!values) continue;
    const pathParameters: Record<string, string> = {};
    for (let index = 0; index < names.length; index += 1) {
      pathParameters[names[index]!] = decodeURIComponent(values[index + 1]!);
    }
    return { operation, pathParameters };
  }
  return null;
}

function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function isActionCreateOperation(operationId: string) {
  return operationId === "actions.create" || operationId === "x.actions.create";
}

function usesIdempotencyKey(operation: OperationDefinition) {
  return operation.parameters?.some((parameter) => parameter.in === "header" && parameter.name.toLowerCase() === "idempotency-key") ?? false;
}
