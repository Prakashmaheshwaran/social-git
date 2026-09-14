import { OPERATIONS } from "./contract.ts";
import { executeOperation } from "./dispatcher.ts";
import { toPublicError } from "./errors.ts";
import type { Principal, SocialGitService } from "./service.ts";

export interface McpCallContext { principal: Principal | null }

export function createMcpTools(service: SocialGitService) {
  return OPERATIONS.map((operation) => ({
    name: operation.mcpName,
    title: operation.summary,
    description: `${operation.summary}. Requires ${operation.scope}.`,
    inputSchema: operation.mcpInputSchema,
    annotations: { readOnlyHint: operation.method === "GET", destructiveHint: ["actions.create", "accounts.revoke"].includes(operation.operationId) },
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
