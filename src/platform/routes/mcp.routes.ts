/**
 * MCP (Model Context Protocol) routes for Viventure WhatsApp API.
 *
 * JSON-RPC 2.0 interface for AI agents.
 * Auth: session cookie OR X-API-Key header (hybrid auth).
 *
 * Path: /api/v1/platform/mcp
 *
 * Architecture:
 *   GET  /tools           → categories only (id, label, description, icon, toolCount)
 *   GET  /tools/:category → tool schemas for that category
 *   POST /invoke          → execute a tool
 */

import { Request, Response, Router } from 'express';
import { createClient, RedisClientType } from 'redis';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { InstanceService } from '../services/instance.service';
import { PlatformAuthService } from '../services/platform-auth.service';
import { SubscriptionService } from '../services/subscription.service';
import { UsageService } from '../services/usage.service';
import { WebhookService } from '../services/webhook.service';
import { getSessionService } from './auth.routes';

// ─── Public API base ───────────────────────────────────────────────────────────

const PUBLIC_API_BASE = process.env.PUBLIC_API_BASE || 'https://whatsapp.nextmavens.com/api/v1';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlatformTenant {
  accountId: string;
  publicId: string;
  status: string;
  plan: { planId: string; name: string; monthlyMessageLimit: number | null };
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface McpTool {
  name: string;
  category: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// JSON-RPC 2.0 + custom platform error codes
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonRpcError(res: Response, code: number, message: string, data?: unknown) {
  res.status(200).json({ error: { code, message, data } } as { error: JsonRpcError });
}

function jsonRpcResult(res: Response, result: unknown) {
  res.status(200).json({ result });
}

async function resolveInstance(instanceId: string, accountId: string) {
  return platformRepository.platformInstance.findFirst({
    where: { publicId: instanceId, accountId },
  });
}

// ─── Categories ───────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: 'instances', label: 'Instances', description: 'Manage WhatsApp instances', icon: 'smartphone' },
  { id: 'messages', label: 'Messages', description: 'Send WhatsApp messages', icon: 'message-square' },
  { id: 'webhooks', label: 'Webhooks', description: 'Configure webhook endpoints', icon: 'webhook' },
  { id: 'api_keys', label: 'API Keys', description: 'Manage API access tokens', icon: 'key' },
  { id: 'account', label: 'Account', description: 'Account, billing and subscriptions', icon: 'user' },
  { id: 'health', label: 'Health', description: 'Monitoring and diagnostics', icon: 'activity' },
  { id: 'contacts', label: 'Contacts', description: 'Fetch contacts and groups', icon: 'users' },
];

// ─── Scope map: tool → required scopes ───────────────────────────────────────

const TOOL_SCOPES: Record<string, string[]> = {
  // Instances
  list_instances: ['instances:read'],
  get_instance: ['instances:read'],
  instance_status: ['instances:read'],
  list_instances_summary: ['instances:read'],
  create_instance: ['instances:write'],
  delete_instance: ['instances:write'],
  whatsapp_connect: ['instances:write'],
  whatsapp_disconnect: ['instances:write'],
  whatsapp_restart: ['instances:write'],
  // Messages
  send_message: ['messages:send'],
  send_media: ['messages:send'],
  // Webhooks
  list_webhooks: ['webhooks:read'],
  get_webhook: ['webhooks:read'],
  create_webhook: ['webhooks:write'],
  update_webhook: ['webhooks:write'],
  delete_webhook: ['webhooks:write'],
  test_webhook: ['webhooks:write'],
  rotate_webhook_secret: ['webhooks:write'],
  // API Keys
  list_api_keys: ['api_keys:read'],
  create_api_key: ['api_keys:write'],
  revoke_api_key: ['api_keys:write'],
  bind_api_key_instance: ['api_keys:write'],
  // Account
  get_account: ['account:read'],
  get_usage: ['account:read'],
  get_plans: ['account:read'],
  list_subscriptions: ['account:read'],
  // Health
  health_check: ['health:read'],
  get_instance_logs: ['health:read'],
  // Contacts
  list_contacts: ['contacts:read'],
  list_groups: ['contacts:read'],
};

// ─── Tool registry (SINGLE SOURCE OF TRUTH) ───────────────────────────────────

const MCP_TOOLS: McpTool[] = [
  // ── Instances ──────────────────────────────────────────────────────────────
  {
    name: 'list_instances',
    category: 'instances',
    description: 'List all WhatsApp instances for the account',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_instance',
    category: 'instances',
    description: 'Get details of a specific WhatsApp instance',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance (inst_xxx)' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'instance_status',
    category: 'instances',
    description: 'Get the current connection status of a WhatsApp instance',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'list_instances_summary',
    category: 'instances',
    description: 'Get a summary of all instances with status counts',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_instance',
    category: 'instances',
    description: 'Create a new WhatsApp instance',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for the instance' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_instance',
    category: 'instances',
    description: 'Delete a WhatsApp instance (disconnects first)',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'whatsapp_connect',
    category: 'instances',
    description: 'Initiate QR code connection for an instance. Subscribe to SSE for QR code delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'whatsapp_disconnect',
    category: 'instances',
    description: 'Disconnect an instance from WhatsApp',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'whatsapp_restart',
    category: 'instances',
    description: 'Restart an instance (disconnect then reconnect)',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance' },
      },
      required: ['instanceId'],
    },
  },

  // ── Messages ───────────────────────────────────────────────────────────────
  {
    name: 'send_message',
    category: 'messages',
    description: 'Send a WhatsApp text message to a recipient',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the connected instance' },
        recipient: { type: 'string', description: 'Phone number in E.164 format (e.g. +1234567890)' },
        text: { type: 'string', description: 'Message text content' },
      },
      required: ['instanceId', 'recipient', 'text'],
    },
  },
  {
    name: 'send_media',
    category: 'messages',
    description: 'Send a media message (image, video, document, audio)',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the connected instance' },
        recipient: { type: 'string', description: 'Phone number in E.164 format' },
        type: { type: 'string', description: 'Media type: image, video, document, audio' },
        url: { type: 'string', description: 'Public URL of the media file' },
        caption: { type: 'string', description: 'Optional caption text' },
      },
      required: ['instanceId', 'recipient', 'type', 'url'],
    },
  },

  // ── Webhooks ──────────────────────────────────────────────────────────────
  {
    name: 'list_webhooks',
    category: 'webhooks',
    description: 'List all webhooks configured for the account',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_webhook',
    category: 'webhooks',
    description: 'Get details of a specific webhook by ID',
    inputSchema: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'The public ID of the webhook (wh_xxx)' },
      },
      required: ['webhookId'],
    },
  },
  {
    name: 'create_webhook',
    category: 'webhooks',
    description: 'Create a new webhook endpoint',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance to bind' },
        url: { type: 'string', description: 'HTTPS URL to receive webhook payloads' },
        events: { type: 'array', items: { type: 'string' }, description: 'Event types to subscribe to' },
      },
      required: ['instanceId', 'url', 'events'],
    },
  },
  {
    name: 'update_webhook',
    category: 'webhooks',
    description: 'Update a webhook URL, events, or enabled state',
    inputSchema: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'The public ID of the webhook' },
        url: { type: 'string', description: 'New HTTPS URL (optional)' },
        events: { type: 'array', items: { type: 'string' }, description: 'New event list (optional)' },
        enabled: { type: 'boolean', description: 'Enable or disable the webhook (optional)' },
      },
      required: ['webhookId'],
    },
  },
  {
    name: 'delete_webhook',
    category: 'webhooks',
    description: 'Delete a webhook by ID',
    inputSchema: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'The public ID of the webhook (wh_xxx)' },
      },
      required: ['webhookId'],
    },
  },
  {
    name: 'test_webhook',
    category: 'webhooks',
    description: 'Send a test payload to a webhook and report delivery status',
    inputSchema: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'The public ID of the webhook' },
      },
      required: ['webhookId'],
    },
  },
  {
    name: 'rotate_webhook_secret',
    category: 'webhooks',
    description: 'Rotate a webhook secret and return the new plaintext secret',
    inputSchema: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'The public ID of the webhook' },
      },
      required: ['webhookId'],
    },
  },

  // ── API Keys ──────────────────────────────────────────────────────────────
  {
    name: 'list_api_keys',
    category: 'api_keys',
    description: 'List all API keys for the account (plaintext never returned)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_api_key',
    category: 'api_keys',
    description: 'Create a new API key — plaintext returned only once at creation',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Descriptive name for the key' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Permission scopes (default: ["*"])' },
        expiresAt: { type: 'string', description: 'Optional ISO8601 expiry date' },
      },
      required: ['name'],
    },
  },
  {
    name: 'revoke_api_key',
    category: 'api_keys',
    description: 'Revoke (delete) an API key — immediately prevents all access',
    inputSchema: {
      type: 'object',
      properties: {
        keyId: { type: 'string', description: 'The public ID of the API key' },
      },
      required: ['keyId'],
    },
  },
  {
    name: 'bind_api_key_instance',
    category: 'api_keys',
    description: 'Bind an API key to a specific instance for scoped access',
    inputSchema: {
      type: 'object',
      properties: {
        keyId: { type: 'string', description: 'The public ID of the API key' },
        instanceId: { type: 'string', description: 'The public ID of the instance' },
      },
      required: ['keyId', 'instanceId'],
    },
  },

  // ── Account ────────────────────────────────────────────────────────────────
  {
    name: 'get_account',
    category: 'account',
    description: 'Get account details, plan, and subscription status',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_usage',
    category: 'account',
    description: 'Get current month API usage broken down by operation',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_plans',
    category: 'account',
    description: 'List available subscription plans',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_subscriptions',
    category: 'account',
    description: 'List all subscriptions for the account',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ── Health ─────────────────────────────────────────────────────────────────
  {
    name: 'health_check',
    category: 'health',
    description: 'Check API health and database connectivity',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_instance_logs',
    category: 'health',
    description: 'Get recent event logs for an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of the instance' },
        limit: { type: 'number', description: 'Max logs to return (default: 50, max: 200)' },
      },
      required: ['instanceId'],
    },
  },

  // ── Contacts ──────────────────────────────────────────────────────────────
  {
    name: 'list_contacts',
    category: 'contacts',
    description: 'List all contacts from a connected WhatsApp instance',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of a CONNECTED instance' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'list_groups',
    category: 'contacts',
    description: 'List all group chats from a connected WhatsApp instance',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'The public ID of a CONNECTED instance' },
      },
      required: ['instanceId'],
    },
  },
];

// ─── Service singletons ────────────────────────────────────────────────────────

const instanceService = new InstanceService();
const auditService = new AuditService();
let webhookService: WebhookService;
let authService: PlatformAuthService;
let usageService: UsageService;
let subscriptionService: SubscriptionService;

function getWebhookService(): WebhookService {
  if (!webhookService) webhookService = new WebhookService();
  return webhookService;
}
function getAuthService(): PlatformAuthService {
  if (!authService) authService = new PlatformAuthService();
  return authService;
}
function getUsageService(): UsageService {
  if (!usageService) usageService = new UsageService();
  return usageService;
}
function getSubscriptionService(): SubscriptionService {
  if (!subscriptionService) subscriptionService = new SubscriptionService();
  return subscriptionService;
}

// ─── Scope enforcement ─────────────────────────────────────────────────────────

/**
 * Check if the request's platformKey grants the required scopes for a tool.
 * Returns true if access is allowed, false otherwise.
 */
function checkScopes(req: Request, tool: string): boolean {
  const platformKey = (req as Request & { platformKey?: { scopes?: string[] } }).platformKey;
  const grantedScopes: string[] = platformKey?.scopes ?? [];
  // Wildcard = full access
  if (grantedScopes.includes('*')) return true;
  const required = TOOL_SCOPES[tool] ?? [];
  if (required.length === 0) return true;
  return required.some((s) => grantedScopes.includes(s));
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = Router();

// GET /tools → categories only
router.get(
  '/tools',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const categories = CATEGORIES.map((cat) => {
      const toolCount = MCP_TOOLS.filter((t) => t.category === cat.id).length;
      return { ...cat, toolCount };
    });
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
    if (!checkScopes(req, tool)) {
      return jsonRpcError(res, -32007, 'Forbidden: insufficient scopes', {
        tool,
        required: TOOL_SCOPES[tool] ?? [],
        granted: (req as Request & { platformKey?: { scopes?: string[] } }).platformKey?.scopes ?? [],
      });
    }

    try {
      const startedAt = Date.now();
      await handleTool(tool, parameters ?? {}, platformTenant, req, res);
      const latencyMs = Date.now() - startedAt;
      // Fire-and-forget audit + SSE publish so the dashboard can show a
      // live activity feed. We do not block the response on these.
      void auditService.record(platformTenant.accountId, 'MCP_INVOKE', { type: 'mcp-tool', id: tool }, {
        latencyMs,
        toolParametersKeys: Object.keys(parameters ?? {}),
      });
      void publishMcpEvent(platformTenant.accountId, {
        tool,
        latencyMs,
        status: 'ok',
        parameters: parameters ?? {},
      });
    } catch (error) {
      console.error(`[MCP] Tool "${tool}" error:`, error);
      const message = error instanceof Error ? error.message : 'Internal error';
      void auditService.record(platformTenant.accountId, 'MCP_INVOKE_ERROR', { type: 'mcp-tool', id: tool }, {
        error: message,
      });
      void publishMcpEvent(platformTenant.accountId, {
        tool,
        status: 'error',
        error: message,
      });
      jsonRpcError(res, JSONRPC_INTERNAL_ERROR, message);
    }
  },
);

// ─── Tool handler ────────────────────────────────────────────────────────────

async function handleTool(
  tool: string,
  params: Record<string, unknown>,
  tenant: PlatformTenant,
  req: Request,
  res: Response,
) {
  switch (tool) {
    // ══════════════════════════════════════════════════════
    // INSTANCES
    // ══════════════════════════════════════════════════════

    case 'list_instances': {
      const instances = await platformRepository.platformInstance.findMany({
        where: { accountId: tenant.accountId },
        select: {
          publicId: true,
          name: true,
          status: true,
          phoneNumber: true,
          capabilities: true,
          lastConnectedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      return jsonRpcResult(res, {
        instances: instances.map((i) => ({
          id: i.publicId,
          name: i.name,
          status: i.status,
          phoneNumber: i.phoneNumber,
          capabilities: i.capabilities ?? {},
          connectedAt: i.lastConnectedAt?.toISOString() ?? null,
          createdAt: i.createdAt.toISOString(),
        })),
        total: instances.length,
      });
    }

    case 'get_instance': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      return jsonRpcResult(res, {
        id: instance.publicId,
        name: instance.name,
        status: instance.status,
        phoneNumber: instance.phoneNumber,
        capabilities: instance.capabilities ?? {},
        connectedAt: instance.lastConnectedAt?.toISOString() ?? null,
        createdAt: instance.createdAt.toISOString(),
      });
    }

    case 'instance_status': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      return jsonRpcResult(res, {
        id: instance.publicId,
        name: instance.name,
        status: instance.status,
        phoneNumber: instance.phoneNumber,
      });
    }

    case 'list_instances_summary': {
      const instances = await platformRepository.platformInstance.findMany({
        where: { accountId: tenant.accountId },
        select: { status: true },
      });
      const summary = {
        CONNECTED: 0,
        CONNECTING: 0,
        CREATED: 0,
        DISCONNECTED: 0,
        SUSPENDED: 0,
        total: instances.length,
      };
      for (const inst of instances) {
        const s = inst.status as keyof typeof summary;
        if (s in summary) (summary as Record<string, number>)[s]++;
      }
      return jsonRpcResult(res, summary);
    }

    case 'create_instance': {
      const { name } = params as { name?: string };
      if (!name) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'name is required');
      const existing = await platformRepository.platformInstance.findFirst({
        where: { accountId: tenant.accountId, name },
      });
      if (existing) return jsonRpcError(res, -32002, 'Instance with this name already exists', { name });
      const domain = await instanceService.create(tenant.accountId, name);
      await auditService.record(tenant.accountId, 'INSTANCE_CREATED', { type: 'instance', id: domain.publicId });
      return jsonRpcResult(res, {
        id: domain.publicId,
        name: domain.name,
        status: domain.status,
        createdAt: domain.createdAt.toISOString(),
      });
    }

    case 'delete_instance': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcResult(res, { deleted: false, reason: 'not_found' }); // Idempotent
      await instanceService.delete(instance.id, tenant.accountId);
      await auditService.record(tenant.accountId, 'INSTANCE_DELETED', { type: 'instance', id: instanceId });
      return jsonRpcResult(res, { deleted: true });
    }

    case 'whatsapp_connect': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      if (instance.status === 'CONNECTED')
        return jsonRpcResult(res, { status: 'CONNECTED', message: 'Instance already connected' });
      await instanceService.connect(instance.id);
      await auditService.record(tenant.accountId, 'INSTANCE_CONNECT_INITIATED', { type: 'instance', id: instanceId });
      return jsonRpcResult(res, {
        status: 'CONNECTING',
        message: 'Connection initiated. Subscribe to SSE stream for QR code and status updates.',
        instanceId,
      });
    }

    case 'whatsapp_disconnect': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      await instanceService.disconnect(instance.id);
      await auditService.record(tenant.accountId, 'INSTANCE_DISCONNECTED', { type: 'instance', id: instanceId });
      return jsonRpcResult(res, { status: 'DISCONNECTED', instanceId });
    }

    case 'whatsapp_restart': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      await instanceService.restart(instance.id);
      await auditService.record(tenant.accountId, 'INSTANCE_RESTARTED', { type: 'instance', id: instanceId });
      return jsonRpcResult(res, { status: 'CONNECTING', instanceId, message: 'Restart initiated' });
    }

    // ══════════════════════════════════════════════════════
    // MESSAGES
    // ══════════════════════════════════════════════════════

    case 'send_message': {
      const { instanceId, recipient, text } = params as { instanceId?: string; recipient?: string; text?: string };
      if (!instanceId || !recipient || !text)
        return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId, recipient, and text are required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      if (instance.status !== 'CONNECTED')
        return jsonRpcError(res, -32009, 'Instance not connected', { instanceId, status: instance.status });
      const internalInstance = await platformRepository.instance.findFirst({ where: { name: instance.name } });
      if (!internalInstance) return jsonRpcError(res, -32005, 'Internal instance not found');

      const fetch = (await import('node-fetch')).default;
      const apiRes = await fetch(`${PUBLIC_API_BASE}/instances/${internalInstance.id}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': (req.headers['x-api-key'] as string) || '' },
        body: JSON.stringify({ number: recipient, text, type: 'text' }),
      });
      const body = (await apiRes.json()) as { messageId?: string; error?: string };
      if (!apiRes.ok) return jsonRpcError(res, -32006, body.error || 'Send failed', { statusCode: apiRes.status });

      const msgId = body.messageId ?? `msg_${Date.now()}`;
      await auditService.record(tenant.accountId, 'MESSAGE_SENT', { type: 'message', id: msgId });
      return jsonRpcResult(res, { messageId: msgId, status: 'queued' });
    }

    case 'send_media': {
      const { instanceId, recipient, type, url, caption } = params as {
        instanceId?: string;
        recipient?: string;
        type?: string;
        url?: string;
        caption?: string;
      };
      if (!instanceId || !recipient || !type || !url)
        return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId, recipient, type, and url are required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      if (instance.status !== 'CONNECTED')
        return jsonRpcError(res, -32009, 'Instance not connected', { instanceId, status: instance.status });
      const internalInstance = await platformRepository.instance.findFirst({ where: { name: instance.name } });
      if (!internalInstance) return jsonRpcError(res, -32005, 'Internal instance not found');

      const fetch = (await import('node-fetch')).default;
      const apiRes = await fetch(`${PUBLIC_API_BASE}/instances/${internalInstance.id}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': (req.headers['x-api-key'] as string) || '' },
        body: JSON.stringify({ number: recipient, type, url, caption }),
      });
      const body = (await apiRes.json()) as { messageId?: string; error?: string };
      if (!apiRes.ok) return jsonRpcError(res, -32006, body.error || 'Send failed', { statusCode: apiRes.status });

      const msgId = body.messageId ?? `msg_media_${Date.now()}`;
      await auditService.record(tenant.accountId, 'MESSAGE_SENT', { type: 'message', id: msgId });
      return jsonRpcResult(res, { messageId: msgId, status: 'queued' });
    }

    // ══════════════════════════════════════════════════════
    // WEBHOOKS
    // ══════════════════════════════════════════════════════

    case 'list_webhooks': {
      const ws = getWebhookService();
      const webhooks = await ws.listWebhooks(tenant.accountId);
      const instanceIds = [...new Set(webhooks.map((w: any) => w.instanceId))];
      const instances = await platformRepository.platformInstance.findMany({
        where: { id: { in: instanceIds } },
        select: { id: true, publicId: true },
      });
      const instanceMap: Record<string, string> = {};
      for (const inst of instances) instanceMap[inst.id] = inst.publicId;
      return jsonRpcResult(res, {
        webhooks: webhooks.map((w: any) => ({
          id: w.publicId,
          instanceId: instanceMap[w.instanceId] ?? w.instanceId,
          url: w.url,
          events: w.events,
          enabled: w.enabled,
          createdAt: w.createdAt.toISOString(),
        })),
      });
    }

    case 'get_webhook': {
      const { webhookId } = params as { webhookId?: string };
      if (!webhookId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'webhookId is required');
      const webhook = await platformRepository.platformWebhook.findFirst({
        where: { publicId: webhookId, accountId: tenant.accountId },
      });
      if (!webhook) return jsonRpcError(res, -32004, 'Webhook not found', { webhookId });
      return jsonRpcResult(res, {
        id: webhook.publicId,
        instanceId: webhook.instanceId,
        url: webhook.url,
        events: webhook.events,
        enabled: webhook.enabled,
        createdAt: webhook.createdAt.toISOString(),
      });
    }

    case 'create_webhook': {
      const { instanceId, url, events } = params as { instanceId?: string; url?: string; events?: string[] };
      if (!instanceId || !url || !events)
        return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId, url, and events are required');
      if (!Array.isArray(events) || events.length === 0)
        return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'events must be a non-empty array');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      const ws = getWebhookService();
      const result = await ws.createWebhook(tenant.accountId, instance.id, url, events);
      await auditService.record(tenant.accountId, 'WEBHOOK_CREATED', { type: 'webhook', id: result.publicId });
      return jsonRpcResult(res, {
        id: result.publicId,
        secret: result.secret,
        url: result.url,
        events: result.events,
        instanceId,
      });
    }

    case 'update_webhook': {
      const { webhookId, url, events, enabled } = params as {
        webhookId?: string;
        url?: string;
        events?: string[];
        enabled?: boolean;
      };
      if (!webhookId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'webhookId is required');
      const webhook = await platformRepository.platformWebhook.findFirst({
        where: { publicId: webhookId, accountId: tenant.accountId },
      });
      if (!webhook) return jsonRpcError(res, -32004, 'Webhook not found', { webhookId });
      const updateData: { url?: string; events?: string[]; enabled?: boolean } = {};
      if (url !== undefined) updateData.url = url;
      if (events !== undefined) updateData.events = events;
      if (enabled !== undefined) updateData.enabled = enabled;
      const ws = getWebhookService();
      await ws.updateWebhook(webhook.id, updateData);
      await auditService.record(tenant.accountId, 'WEBHOOK_UPDATED', { type: 'webhook', id: webhookId });
      return jsonRpcResult(res, { updated: true, webhookId });
    }

    case 'delete_webhook': {
      const { webhookId } = params as { webhookId?: string };
      if (!webhookId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'webhookId is required');
      const webhook = await platformRepository.platformWebhook.findFirst({
        where: { publicId: webhookId, accountId: tenant.accountId },
      });
      if (!webhook) return jsonRpcResult(res, { deleted: false, reason: 'not_found' }); // Idempotent
      const ws = getWebhookService();
      await ws.deleteWebhook(webhook.id);
      await auditService.record(tenant.accountId, 'WEBHOOK_DELETED', { type: 'webhook', id: webhookId });
      return jsonRpcResult(res, { deleted: true });
    }

    case 'test_webhook': {
      const { webhookId } = params as { webhookId?: string };
      if (!webhookId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'webhookId is required');
      const webhook = await platformRepository.platformWebhook.findFirst({
        where: { publicId: webhookId, accountId: tenant.accountId },
      });
      if (!webhook) return jsonRpcError(res, -32004, 'Webhook not found', { webhookId });
      const ws = getWebhookService();
      const testPayload = {
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'Test payload from Viventure MCP' },
      };
      const timestamp = Math.floor(Date.now() / 1000);
      const plaintextSecret = ws.decrypt(webhook.secret);
      const signature = ws.signPayload(JSON.stringify(testPayload), timestamp, plaintextSecret);
      try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Viventure-Timestamp': String(timestamp),
            'X-Viventure-Signature': signature,
          },
          body: JSON.stringify(testPayload),
        });
        return jsonRpcResult(res, { delivered: response.ok, statusCode: response.status, webhookId });
      } catch (err) {
        return jsonRpcResult(res, { delivered: false, error: String(err), webhookId });
      }
    }

    case 'rotate_webhook_secret': {
      const { webhookId } = params as { webhookId?: string };
      if (!webhookId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'webhookId is required');
      const webhook = await platformRepository.platformWebhook.findFirst({
        where: { publicId: webhookId, accountId: tenant.accountId },
      });
      if (!webhook) return jsonRpcError(res, -32004, 'Webhook not found', { webhookId });
      const ws = getWebhookService();
      const { secret } = await ws.rotateSecret(webhook.id);
      await auditService.record(tenant.accountId, 'WEBHOOK_SECRET_ROTATED', { type: 'webhook', id: webhookId });
      return jsonRpcResult(res, { webhookId, secret });
    }

    // ══════════════════════════════════════════════════════
    // API KEYS
    // ══════════════════════════════════════════════════════

    case 'list_api_keys': {
      const as = getAuthService();
      const keys = await as.listApiKeys(tenant.accountId);
      return jsonRpcResult(res, {
        apiKeys: keys.map((k: any) => ({
          id: k.publicId,
          name: k.name,
          scopes: k.scopes ?? [],
          createdAt: k.createdAt.toISOString(),
          expiresAt: k.expiresAt?.toISOString() ?? null,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        })),
      });
    }

    case 'create_api_key': {
      const { name, scopes, expiresAt } = params as { name?: string; scopes?: string[]; expiresAt?: string };
      if (!name) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'name is required');
      const as = getAuthService();
      const { plaintextKey, publicId } = await as.createApiKey(
        tenant.accountId,
        name,
        scopes ?? ['*'],
        expiresAt ? new Date(expiresAt) : undefined,
      );
      await auditService.record(tenant.accountId, 'API_KEY_CREATED', { type: 'api_key', id: publicId });
      return jsonRpcResult(res, {
        id: publicId,
        name,
        key: plaintextKey,
        scopes: scopes ?? ['*'],
        expiresAt: expiresAt ?? null,
        message: 'Store this key securely — it will not be shown again.',
      });
    }

    case 'revoke_api_key': {
      const { keyId } = params as { keyId?: string };
      if (!keyId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'keyId is required');
      const as = getAuthService();
      const revoked = await as.revokeApiKey(keyId);
      if (!revoked) return jsonRpcError(res, -32004, 'API key not found', { keyId });
      await auditService.record(tenant.accountId, 'API_KEY_REVOKED', { type: 'api_key', id: keyId });
      return jsonRpcResult(res, { revoked: true, keyId });
    }

    case 'bind_api_key_instance': {
      const { keyId, instanceId } = params as { keyId?: string; instanceId?: string };
      if (!keyId || !instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'keyId and instanceId are required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      const as = getAuthService();
      await as.bindInstance(keyId, instance.id);
      await auditService.record(tenant.accountId, 'API_KEY_INSTANCE_BINDING', { type: 'api_key', id: keyId });
      return jsonRpcResult(res, { bound: true, keyId, instanceId });
    }

    // ══════════════════════════════════════════════════════
    // ACCOUNT
    // ══════════════════════════════════════════════════════

    case 'get_account': {
      const account = await platformRepository.platformAccount.findUnique({ where: { id: tenant.accountId } });
      if (!account) return jsonRpcError(res, -32001, 'Account not found');
      const subService = getSubscriptionService();
      const subscription = await subService.getActiveSubscription(tenant.accountId);
      return jsonRpcResult(res, {
        id: account.publicId,
        name: account.name,
        status: account.status,
        plan: subscription?.plan?.name ?? 'unknown',
        subscriptionStatus: subscription?.status ?? 'unknown',
        trialEndsAt: subscription?.endsAt?.toISOString() ?? null,
        createdAt: account.createdAt.toISOString(),
      });
    }

    case 'get_usage': {
      const usageService = getUsageService();
      const breakdown = await usageService.getUsageBreakdown(tenant.accountId);
      return jsonRpcResult(res, {
        period: {
          start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
          end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
        },
        usage: breakdown,
      });
    }

    case 'get_plans': {
      const subService = getSubscriptionService();
      const plans = await subService.listPlans();
      return jsonRpcResult(res, { plans });
    }

    case 'list_subscriptions': {
      const subscriptions = await platformRepository.platformSubscription.findMany({
        where: { accountId: tenant.accountId },
        include: { plan: true },
        orderBy: { startedAt: 'desc' },
      });
      return jsonRpcResult(res, {
        subscriptions: subscriptions.map((s: any) => ({
          id: s.publicId,
          planId: s.plan?.publicId,
          planName: s.plan?.name,
          status: s.status,
          startedAt: s.startedAt.toISOString(),
          endsAt: s.endsAt?.toISOString() ?? null,
        })),
      });
    }

    // ══════════════════════════════════════════════════════
    // HEALTH
    // ══════════════════════════════════════════════════════

    case 'health_check': {
      try {
        await platformRepository.$queryRaw`SELECT 1`;
        return jsonRpcResult(res, { status: 'healthy', database: 'connected', timestamp: new Date().toISOString() });
      } catch {
        return jsonRpcError(res, -32003, 'Service degraded', { database: 'disconnected' });
      }
    }

    case 'get_instance_logs': {
      const { instanceId, limit } = params as { instanceId?: string; limit?: number };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      const logs = await platformRepository.instanceEventLog.findMany({
        where: { instanceId: instance.id },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit ?? 50, 200),
        select: { publicId: true, eventType: true, payload: true, createdAt: true },
      });
      return jsonRpcResult(res, {
        logs: logs.map((l) => ({
          id: l.publicId,
          eventType: l.eventType,
          payload: l.payload,
          timestamp: l.createdAt.toISOString(),
        })),
        total: logs.length,
      });
    }

    // ══════════════════════════════════════════════════════
    // CONTACTS
    // ══════════════════════════════════════════════════════

    case 'list_contacts': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      if (instance.status !== 'CONNECTED')
        return jsonRpcError(res, -32009, 'Instance not connected', { instanceId, status: instance.status });
      const contacts = await evolutionAdapter.fetchContacts(instance.id);
      return jsonRpcResult(res, { contacts, total: contacts.length });
    }

    case 'list_groups': {
      const { instanceId } = params as { instanceId?: string };
      if (!instanceId) return jsonRpcError(res, JSONRPC_INVALID_PARAMS, 'instanceId is required');
      const instance = await resolveInstance(instanceId, tenant.accountId);
      if (!instance) return jsonRpcError(res, -32004, 'Instance not found', { instanceId });
      if (instance.status !== 'CONNECTED')
        return jsonRpcError(res, -32009, 'Instance not connected', { instanceId, status: instance.status });
      const groups = await evolutionAdapter.fetchGroups(instance.id);
      return jsonRpcResult(res, { groups, total: groups.length });
    }

    // No default — unknown tools are caught by the pre-check above
  }
}

export { router as mcpRouter };

// ─── Activity event stream ───────────────────────────────────────────────────

/**
 * Lazily-initialized Redis publisher used to push MCP invocation
 * events to any subscribed SSE consumers (e.g. the dashboard's
 * live activity panel). We use a per-account channel so the SSE
 * endpoint can subscribe to just one tenant's stream.
 */
let redisPublisher: RedisClientType | null = null;
async function getRedisPublisher(): Promise<RedisClientType | null> {
  if (redisPublisher) return redisPublisher;
  try {
    const url = process.env.CACHE_REDIS_URI || 'redis://platform-redis:6379/6';
    const client = createClient({ url });
    client.on('error', (err) => {
      // Suppress noisy errors — the dashboard will fall back to polling
      // if Redis pub/sub is unavailable.
      console.warn('[MCP] Redis publisher error:', err);
    });
    await client.connect();
    redisPublisher = client as RedisClientType;
    return redisPublisher;
  } catch (err) {
    console.warn('[MCP] Could not connect Redis publisher:', err);
    return null;
  }
}

async function publishMcpEvent(
  accountId: string,
  event: {
    tool: string;
    status: 'ok' | 'error';
    latencyMs?: number;
    error?: string;
    parameters?: Record<string, unknown>;
  },
): Promise<void> {
  const publisher = await getRedisPublisher();
  if (!publisher) return;
  try {
    const channel = `fidscript:whatsapp:mcp:${accountId}`;
    await publisher.publish(channel, JSON.stringify({ ...event, ts: Date.now() }));
  } catch {
    /* swallow — never fail a request just because the event bus hiccupped */
  }
}

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
      const channel = `fidscript:whatsapp:mcp:${platformTenant.accountId}`;
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
    const rows = await platformRepository.platformAuditLog.findMany({
      where: {
        accountId: platformTenant.accountId,
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
