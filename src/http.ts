import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OPERATIONS, generateOpenApi, type OperationDefinition } from "./contract.ts";
import { executeOperation } from "./dispatcher.ts";
import { ServiceError, toPublicError } from "./errors.ts";
import type { Principal, SocialGitService } from "./service.ts";

export type Authenticator = (request: IncomingMessage) => Promise<Principal | null> | Principal | null;

export function bearerAuthenticator(tokens: ReadonlyMap<string, Principal>): Authenticator {
  return (request) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return null;
    return tokens.get(authorization.slice(7)) ?? null;
  };
}

export function createSocialGitHttpServer(options: { service: SocialGitService; authenticate: Authenticator }) {
  return createServer(async (request, response) => {
    const requestId = validRequestId(request.headers["x-request-id"]) ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/openapi.json") return sendJson(response, 200, generateOpenApi());
      const match = matchOperation(request.method ?? "", url.pathname);
      if (!match) throw new ServiceError("NOT_FOUND", "Route not found.");
      const principal = await options.authenticate(request);
      if (!principal) throw new ServiceError("UNAUTHENTICATED", "Authentication is required.");
      const input: Record<string, unknown> = {};
      for (const [key, value] of url.searchParams) input[key] = value;
      if (match.operation.method === "POST") {
        const body = await readJson(request);
        if (match.operation.operationId === "actions.create") input.action = body;
        else Object.assign(input, body);
      }
      Object.assign(input, match.pathParameters);
      if (match.operation.operationId === "actions.create") input.idempotencyKey = request.headers["idempotency-key"];
      const result = await executeOperation(options.service, match.operation, principal, input);
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
    }
  });
}

function validRequestId(value: string | string[] | undefined) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 262_144) throw new ServiceError("VALIDATION_FAILED", "Request body exceeds the 262144 byte limit.", { status: 413 });
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
