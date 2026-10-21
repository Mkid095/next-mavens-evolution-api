import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Request, Response } from 'express';

import { createMcpServer } from './mcp-server';
import { ToolContext } from './tool-executor';

/**
 * Streamable HTTP transport for the MCP server.
 *
 * The server runs in *stateless* mode: every HTTP request gets its own
 * MCP server + transport pair, and the tenant resolved by the auth
 * middleware is baked into the tool handlers. That keeps two things true:
 *
 *   - a request authenticated with account A can never reach account B's
 *     tools, even inside the same process, and
 *   - no session state has to be kept (or invalidated) between requests.
 *
 * Stateless mode is what the MCP specification allows for servers that do
 * not need server-initiated notifications, and every mainstream client
 * (Claude Desktop, Claude Code, Cursor, the MCP SDKs) supports it.
 */
export async function handleMcpHttpRequest(req: Request, res: Response, ctx: ToolContext): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    // undefined sessionIdGenerator → stateless mode
    sessionIdGenerator: undefined,
    // Answer POSTs with a plain JSON-RPC response instead of an SSE stream.
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
