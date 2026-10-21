/**
 * MCP (Model Context Protocol) routes for the Viventure WhatsApp API.
 *
 * Two ways in:
 *
 *   1. The STANDARD MCP transport (Streamable HTTP)
 *        POST   /api/v1/platform/mcp          → initialize / tools/list / tools/call
 *        GET    /api/v1/platform/mcp          → server → client notification stream
 *        DELETE /api/v1/platform/mcp          → session teardown (stateless → 405)
 *      A stock MCP client (Claude Desktop, Claude Code, Cursor, any MCP SDK)
 *      talks to this endpoint.
 *
 *   2. The LEGACY custom tool API (kept for the dashboard and the CLI)
 *        GET    /api/v1/platform/mcp/tools           → categories
 *        GET    /api/v1/platform/mcp/tools/:category → tool schemas
 *        POST   /api/v1/platform/mcp/invoke          → execute a tool
 *        GET    /api/v1/platform/mcp/events          → SSE activity feed
 *        GET    /api/v1/platform/mcp/events/history  → recent activity
 *
 * Both paths dispatch into the SAME tool implementations
 * (src/platform/mcp/tool-executor.ts) and the SAME tool registry
 * (src/platform/mcp/tool-registry.ts) — there is exactly one definition of
 * every tool.
 *
 * Auth: session cookie OR X-API-Key header (hybrid auth).
 */

import { Request, Response, Router } from 'express';
import { createClient, RedisClientType } from 'redis';

import { mcpEventChannel, publishMcpEvent } from '../mcp/activity';
import { checkToolScopes, grantedScopes } from '../mcp/scopes';
import {
  auditService as toolAuditService,
  executeTool,
  isToolError,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
} from '../mcp/tool-executor';
import { CATEGORIES, MCP_TOOLS, TOOL_SCOPES, toolCountByCategory } from '../mcp/tool-registry';
import { handleMcpHttpRequest } from '../mcp/transport';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { resolveRequestProject } from '../services/request-project';
import { PlatformTenant } from '../types/platform-tenant';
import { getSessionService } from './auth.routes';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// JSON-RPC 2.0 + custom platform error codes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonRpcError(res: Response, code: number, message: string, data?: unknown) {
  res.status(200).json({ error: { code, message, data } } as { error: JsonRpcError });
}

function jsonRpcResult(res: Response, result: unknown) {
  res.status(200).json({ result });
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = Router();

/**
 * POST /api/v1/platform/mcp — the standard MCP transport (Streamable HTTP).
 *
 * This is the endpoint a stock MCP client connects to. It speaks the real
 * protocol: `initialize` → `notifications/initialized` → `tools/list` →
 * `tools/call`, over JSON-RPC 2.0.
 */
router.post(
  '/',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing credentials' });
      return;
    }

    try {
      await handleMcpHttpRequest(req, res, { tenant: platformTenant, req });
    } catch (error) {
      console.error('[MCP] transport error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: JSONRPC_INTERNAL_ERROR, message: 'Internal server error' },
          id: null,
        });
      }
    }
  },
);

/**
 * GET /api/v1/platform/mcp — the server → client notification stream.
 *
 * The MCP server is stateless and never initiates notifications, so this is
 * an idle SSE stream. It is kept so clients that open it (and reconnect to
 * it) behave exactly as the specification describes.
 */
router.get(
  '/',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing credentials' });
      return;
    }

    try {
      await handleMcpHttpRequest(req, res, { tenant: platformTenant, req });
    } catch (error) {
      console.error('[MCP] transport error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: JSONRPC_INTERNAL_ERROR, message: 'Internal server error' },
          id: null,
        });
      }
    }
  },
);

/**
 * DELETE /api/v1/platform/mcp — session teardown.
 *
 * The server runs statelessly, so there is no session to terminate. The
 * specification allows a server to answer 405 here.
 */
router.delete(
  '/',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed — the MCP server is stateless.' },
      id: null,
    });
  },
);

// GET /tools → categories only
router.get(
  '/tools',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (_req: Request, res: Response) => {
    const counts = toolCountByCategory();
    const categories = CATEGORIES.map((cat) => ({
      ...cat,
      toolCount: counts[cat.id] ?? 0,
    }));
    res.json({ categories });
  },
);

// GET /tools/:category → tool schemas for that category
router.get(
  '/tools/:category',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const { category } = req.params;
    const validIds = CATEGORIES.map((c) => c.id);
    if (!validIds.includes(category)) {
      return jsonRpcError(res, -32001, `Unknown category: ${category}`, {
        available: validIds,
      });
    }
    const tools = MCP_TOOLS.filter((t) => t.category === category);
    res.json({ category, tools });
  },
);

// POST /invoke → execute a tool
router.post(
  '/invoke',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      return jsonRpcError(res, -32001, 'Unauthorized', { reason: 'Invalid or missing credentials' });
    }

    const { tool, parameters } = req.body as {
      tool?: string;
      parameters?: Record<string, unknown>;
    };

    if (!tool) return jsonRpcError(res, JSONRPC_INVALID_REQUEST, 'tool is required');
    if (typeof tool !== 'string') return jsonRpcError(res, JSONRPC_INVALID_REQUEST, 'tool must be a string');

    // Verify tool exists
    const toolDef = MCP_TOOLS.find((t) => t.name === tool);
    if (!toolDef) {
      return jsonRpcError(res, JSONRPC_METHOD_NOT_FOUND, `Unknown tool: ${tool}`, {
        available: MCP_TOOLS.map((t) => t.name),
      });
    }

    // Scope enforcement
    if (!checkToolScopes(req, tool)) {
      return jsonRpcError(res, -32007, 'Forbidden: insufficient scopes', {
        tool,
        required: TOOL_SCOPES[tool] ?? [],
        granted: grantedScopes(req),
      });
    }

    try {
      const startedAt = Date.now();
      const outcome = await executeTool(tool, parameters ?? {}, { tenant: platformTenant, req });
      const latencyMs = Date.now() - startedAt;

      // The invocation is filed under the project the caller's key names.
      const project = await resolveRequestProject(req, platformTenant.accountId);

      if (isToolError(outcome)) {
        // Fire-and-forget audit + SSE publish so the dashboard can show a
        // live activity feed. We do not block the response on these.
        void toolAuditService.record(
          platformTenant.accountId,
          'MCP_INVOKE_ERROR',
          { type: 'mcp-tool', id: tool },
          { error: outcome.error.message, tool },
          { projectId: project?.id ?? null },
        );
        void publishMcpEvent(platformTenant.accountId, {
          tool,
          status: 'error',
          error: outcome.error.message,
        });
        return jsonRpcError(res, outcome.error.code, outcome.error.message, outcome.error.data);
      }

      void toolAuditService.record(
        platformTenant.accountId,
        'MCP_INVOKE',
        { type: 'mcp-tool', id: tool },
        {
          latencyMs,
          tool,
          toolParametersKeys: Object.keys(parameters ?? {}),
        },
        { projectId: project?.id ?? null },
      );
      void publishMcpEvent(platformTenant.accountId, {
        tool,
        latencyMs,
        status: 'ok',
        parameters: parameters ?? {},
      });

      return jsonRpcResult(res, outcome.data);
    } catch (error) {
      console.error(`[MCP] Tool "${tool}" error:`, error);
      const message = error instanceof Error ? error.message : 'Internal error';
      void toolAuditService.record(
        platformTenant.accountId,
        'MCP_INVOKE_ERROR',
        { type: 'mcp-tool', id: tool },
        { error: message, tool },
        { projectId: null },
      );
      void publishMcpEvent(platformTenant.accountId, {
        tool,
        status: 'error',
        error: message,
      });
      jsonRpcError(res, JSONRPC_INTERNAL_ERROR, message);
    }
  },
);

// ─── Activity event stream ───────────────────────────────────────────────────

/**
 * GET /api/v1/platform/mcp/events
 *
 * SSE stream of MCP tool invocations for the authenticated account.
 * Each event is one line: `data: { tool, status, latencyMs, ... }\n\n`
 *
 * Falls back gracefully — if Redis is unreachable we send a
 * `: redis-unavailable` comment and keep the connection open with
 * heartbeats; the dashboard can fall back to polling the audit log.
 */
router.get(
  '/events',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`: connected to mcp event stream\n\n`);
    res.flush();

    const keepalive = setInterval(() => {
      res.write(`: heartbeat\n\n`);
      res.flush();
    }, 25000);

    let subscriber: RedisClientType | null = null;
    let cancelled = false;
    try {
      const url = process.env.CACHE_REDIS_URI || 'redis://platform-redis:6379/6';
      subscriber = createClient({ url });
      subscriber.on('error', (err) => {
        console.warn('[MCP SSE] subscriber error:', err);
        res.write(`: redis-error\n\n`);
        res.flush();
      });
      await subscriber.connect();
      const channel = mcpEventChannel(platformTenant.accountId);
      await subscriber.subscribe(channel, (message) => {
        if (cancelled) return;
        res.write(`event: mcp_invoke\ndata: ${message}\n\n`);
        res.flush();
      });
    } catch (err) {
      console.warn('[MCP SSE] could not subscribe to Redis:', err);
      res.write(`: redis-unavailable\n\n`);
      res.flush();
    }

    req.on('close', async () => {
      cancelled = true;
      clearInterval(keepalive);
      if (subscriber) {
        try {
          await subscriber.unsubscribe();
          await subscriber.disconnect();
        } catch {
          /* ignore */
        }
      }
    });
  },
);

/**
 * GET /api/v1/platform/mcp/events/history
 *
 * Recent MCP invocation history (last 50). Used as a fallback when
 * SSE is unavailable or to backfill on initial page load.
 */
router.get(
  '/events/history',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    const project = await resolveRequestProject(req, platformTenant.accountId);

    const rows = await platformRepository.platformAuditLog.findMany({
      where: {
        accountId: platformTenant.accountId,
        ...(project ? { projectId: project.id } : {}),
        action: { in: ['MCP_INVOKE', 'MCP_INVOKE_ERROR'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({
      events: rows.map((r) => ({
        id: r.id,
        tool: r.resourceId ?? '',
        status: r.action === 'MCP_INVOKE' ? 'ok' : 'error',
        latencyMs: (r.metadata as any)?.latencyMs,
        error: (r.metadata as any)?.error,
        createdAt: r.createdAt,
      })),
    });
  },
);

export { router as mcpRouter };
