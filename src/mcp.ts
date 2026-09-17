import { OPERATIONS } from "./contract.ts";
import { executeOperation } from "./dispatcher.ts";
import { ServiceError, toPublicError } from "./errors.ts";
import type { Principal, SocialGitService } from "./service.ts";

export interface McpCallContext { principal: Principal | null }

export function createMcpTools(service: SocialGitService) {
  return OPERATIONS.map((operation) => ({
    name: operation.mcpName,
    title: operation.summary,
    description: `${operation.summary}. Requires ${operation.scope}.`,
    inputSchema: operation.mcpInputSchema,
    annotations: { readOnlyHint: operation.method === "GET", destructiveHint: [
      "actions.create", "x.actions.create", "accounts.revoke",
      "webhooks.subscriptions.rotate", "webhooks.subscriptions.disable",
    ].includes(operation.operationId) },
    operationId: operation.operationId,
    async call(args: Record<string, unknown>, context: McpCallContext) {
      try {
        const result = await executeOperation(service, operation, context.principal, args);
        return { isError: false, structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        const safe = toPublicError(error, "mcp");
        return { isError: true, structuredContent: safe.body, content: [{ type: "text" as const, text: JSON.stringify(safe.body) }] };
      }
    },
  }));
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export function createMcpGateway(service: SocialGitService) {
  const tools = createMcpTools(service);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    async handle(message: unknown, context: McpCallContext, requestId: string) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return rpcError(null, -32600, "Invalid Request", requestId);
      }
      const request = message as Record<string, unknown>;
      const id = request.id ?? null;
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
        return rpcError(id, -32600, "Invalid Request", requestId);
      }
      try {
        switch (request.method) {
          case "initialize":
            return rpcResult(id, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "social-git", version: "0.1.0" },
            });
          case "notifications/initialized":
            return null;
          case "ping":
            return rpcResult(id, {});
          case "tools/list":
            return rpcResult(id, { tools: tools.map(({ call: _call, operationId: _operationId, ...tool }) => tool) });
          case "tools/call": {
            const params = objectParams(request.params);
            const name = typeof params.name === "string" ? params.name : "";
            const tool = byName.get(name);
            if (!tool) throw new ServiceError("NOT_FOUND", "MCP tool not found.");
            const args = params.arguments === undefined ? {} : objectParams(params.arguments);
            return rpcResult(id, await tool.call(args, context));
          }
          default:
            return rpcError(id, -32601, "Method not found", requestId);
        }
      } catch (error) {
        const safe = toPublicError(error, requestId);
        return rpcError(id, -32000, safe.body.error.message, requestId, safe.body);
      }
    },
  };
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("VALIDATION_FAILED", "MCP params must be an object.");
  }
  return value as Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string, requestId: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, data: data ?? { requestId } } };
}
