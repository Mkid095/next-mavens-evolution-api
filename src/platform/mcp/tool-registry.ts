/**
 * MCP tool registry — the single source of truth for the tools the
 * Viventure platform exposes to AI agents.
 *
 * Both entry points read from this file:
 *   - the legacy JSON-RPC-ish endpoint  POST /api/v1/platform/mcp/invoke
 *   - the standard MCP transport       POST /api/v1/platform/mcp
 *
 * Keeping the registry here (instead of inside the route file) is what
 * lets the MCP server advertise exactly the same tools, with exactly the
 * same schemas, as the legacy endpoint.
 */

export interface McpTool {
  name: string;
  category: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpCategory {
  id: string;
  label: string;
  description: string;
  /** lucide-react icon name — mapped by the dashboard's ICON_MAP. */
  icon: string;
}

// ─── Categories ───────────────────────────────────────────────────────────────

export const CATEGORIES: McpCategory[] = [
  { id: 'instances', label: 'Instances', description: 'Manage WhatsApp instances', icon: 'smartphone' },
  { id: 'messages', label: 'Messages', description: 'Send WhatsApp messages', icon: 'message-square' },
  { id: 'webhooks', label: 'Webhooks', description: 'Configure webhook endpoints', icon: 'webhook' },
  { id: 'api_keys', label: 'API Keys', description: 'Manage API access tokens', icon: 'key' },
  { id: 'account', label: 'Account', description: 'Account, billing and subscriptions', icon: 'user' },
  { id: 'health', label: 'Health', description: 'Monitoring and diagnostics', icon: 'activity' },
  { id: 'contacts', label: 'Contacts', description: 'Fetch contacts and groups', icon: 'users' },
  { id: 'documentation', label: 'Documentation', description: 'Read the platform API documentation', icon: 'book' },
];

// ─── Scope map: tool → required scopes ───────────────────────────────────────

export const TOOL_SCOPES: Record<string, string[]> = {
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
  // Documentation
  get_documentation: ['docs:read'],
};

// ─── Tool registry (SINGLE SOURCE OF TRUTH) ───────────────────────────────────

export const MCP_TOOLS: McpTool[] = [
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
    description:
      'Send a media message (image, video, document, audio). The media URL is delivered as part of the message body.',
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

  // ── Documentation ──────────────────────────────────────────────────────────
  {
    name: 'get_documentation',
    category: 'documentation',
    description:
      'Read the Viventure API documentation. Pass a page id (slug) to get one page, a query to search the docs, or nothing to list every page.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page slug, e.g. "quickstart", "mcp-tools", "authentication"' },
        query: { type: 'string', description: 'Free-text search across page titles, descriptions and topics' },
      },
      required: [],
    },
  },
];

/**
 * Number of tools per category — used by the dashboard's category list.
 */
export function toolCountByCategory(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tool of MCP_TOOLS) {
    counts[tool.category] = (counts[tool.category] ?? 0) + 1;
  }
  return counts;
}

/** Look up a tool definition by name. */
export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/**
 * Every scope string the platform recognises, plus the `*` wildcard.
 *
 * This is the single source of truth: the API validates a requested
 * scope against it when an API key is created, and the dashboard's
 * scope picker and the CLI's `--scope` flag list the same set.
 */
export const KNOWN_SCOPES: string[] = [...new Set(Object.values(TOOL_SCOPES).flat()), '*'].sort();
