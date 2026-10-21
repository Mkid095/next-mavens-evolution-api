import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import { publishMcpEvent } from './activity';
import { checkToolScopes, grantedScopes } from './scopes';
import { auditService, executeTool, isToolError, ToolContext } from './tool-executor';
import { CATEGORIES, MCP_TOOLS, McpTool, TOOL_SCOPES } from './tool-registry';

/**
 * The MCP server implementation.
 *
 * This is a *standard* Model Context Protocol server: a stock client
 * (Claude Desktop, Claude Code, Cursor, or anything built on the MCP SDK)
 * connects to it over the Streamable HTTP transport and runs the usual
 * handshake — `initialize` → `notifications/initialized` → `tools/list` →
 * `tools/call`.
 *
 * The tool implementations themselves are NOT duplicated here: `tools/call`
 * dispatches into the very same `executeTool()` the legacy
 * `POST /api/v1/platform/mcp/invoke` endpoint uses.
 */

/** Tools that destroy something — flagged with `destructiveHint`. */
const DESTRUCTIVE_TOOLS = new Set(['delete_instance', 'delete_webhook', 'revoke_api_key']);

/** Turn `list_instances` into `List instances`. */
function humanize(name: string): string {
  const spaced = name.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Map a registry tool onto the MCP tool descriptor shape.
 *
 * The category travels with the tool. It is not part of the MCP core
 * schema, but a client showing a catalogue of 31 tools needs the
 * grouping — and the spec allows extra fields. `_meta` is the spec's own
 * slot for server metadata, so the category is in both places: where a
 * client that only knows the core schema will look for it, and where one
 * that reads `_meta` will.
 */
export function toMcpToolDescriptor(tool: McpTool) {
  const scopes = TOOL_SCOPES[tool.name] ?? [];
  const readOnly = scopes.length > 0 && scopes.every((scope) => scope.endsWith(':read'));
  return {
    name: tool.name,
    title: humanize(tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
    category: tool.category,
    scopes,
    annotations: {
      title: humanize(tool.name),
      readOnlyHint: readOnly,
      destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name),
      idempotentHint: readOnly,
      openWorldHint: true,
    },
    _meta: { category: tool.category, scopes },
  };
}

/** Map a legacy tool error code onto an MCP error code. */
function toMcpErrorCode(code: number): number {
  switch (code) {
    case -32600:
      return ErrorCode.InvalidRequest;
    case -32601:
      return ErrorCode.MethodNotFound;
    case -32602:
      return ErrorCode.InvalidParams;
    default:
      return ErrorCode.InternalError;
  }
}

/**
 * Build an MCP server bound to one request context.
 *
 * A fresh instance is created per request (stateless mode), so the tenant
 * resolved by the auth middleware is baked into the tool handlers and no
 * session state has to be shared between requests.
 */
export function createMcpServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: 'viventure-whatsapp-api', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Viventure WhatsApp Business API. The tools are grouped into categories — ' +
        CATEGORIES.map((c) => `${c.id} (${c.label}): ${c.description.toLowerCase()}`).join('; ') +
        '. Each tool carries its category and the scopes it needs. Use the instance tools to provision, ' +
        'connect and monitor WhatsApp instances, the message tools to send WhatsApp messages, and ' +
        'get_documentation to read the platform documentation.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map(toMcpToolDescriptor),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (!checkToolScopes(ctx.req, name)) {
      throw new McpError(ErrorCode.InvalidRequest, `Forbidden: insufficient scopes for tool "${name}"`, {
        tool: name,
        required: TOOL_SCOPES[name] ?? [],
        granted: grantedScopes(ctx.req),
      });
    }

    const startedAt = Date.now();
    try {
      const outcome = await executeTool(name, args, ctx);
      const latencyMs = Date.now() - startedAt;

      if (isToolError(outcome)) {
        void auditService.record(
          ctx.tenant.accountId,
          'MCP_INVOKE_ERROR',
          { type: 'mcp-tool', id: name },
          {
            error: outcome.error.message,
          },
        );
        void publishMcpEvent(ctx.tenant.accountId, {
          tool: name,
          status: 'error',
          error: outcome.error.message,
          parameters: args,
        });
        throw new McpError(toMcpErrorCode(outcome.error.code), outcome.error.message, outcome.error.data);
      }

      void auditService.record(
        ctx.tenant.accountId,
        'MCP_INVOKE',
        { type: 'mcp-tool', id: name },
        {
          latencyMs,
          toolParametersKeys: Object.keys(args),
        },
      );
      void publishMcpEvent(ctx.tenant.accountId, {
        tool: name,
        latencyMs,
        status: 'ok',
        parameters: args,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(outcome.data, null, 2) }],
      };
    } catch (error) {
      if (error instanceof McpError) throw error;

      const message = error instanceof Error ? error.message : 'Internal error';
      console.error(`[MCP] Tool "${name}" error:`, error);
      void auditService.record(
        ctx.tenant.accountId,
        'MCP_INVOKE_ERROR',
        { type: 'mcp-tool', id: name },
        {
          error: message,
        },
      );
      void publishMcpEvent(ctx.tenant.accountId, { tool: name, status: 'error', error: message });
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  return server;
}
