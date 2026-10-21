/**
 * Embedded index of the Viventure documentation pages.
 *
 * Generated from the frontend documentation source
 * (whatsapp-nextmavens/src/lib/docsContent.ts) by
 * scripts/generate-cli-docs-index.ts. The frontend repo is NOT modified
 * by the CLI — this file is a read-only snapshot of the page slugs, titles and
 * descriptions so `viventure docs` can search them offline.
 */
export interface DocIndexEntry {
  slug: string;
  section: string;
  title: string;
  description: string;
  /** Subsection and step headings — used as extra search keywords. */
  topics: string[];
}

export interface DocIndexSection {
  id: string;
  title: string;
}

export const DOC_INDEX_SECTIONS: DocIndexSection[] = [
  { id: 'getting-started', title: 'Getting Started' },
  { id: 'api-reference', title: 'API Reference' },
  { id: 'mcp', title: 'MCP' },
  { id: 'sdks', title: 'SDKs' },
  { id: 'cli', title: 'CLI' },
  { id: 'guides', title: 'Guides' },
  { id: 'reference', title: 'Reference' },
];

export const DOC_INDEX: DocIndexEntry[] = [
  {
    slug: 'introduction',
    section: 'getting-started',
    title: 'Introduction',
    description: 'What the platform is, the four ways to drive it, and an honest list of what it does not do yet.',
    topics: [
      'The hierarchy',
      'Four ways to drive it',
      'Outbound messages are queued and paced on purpose',
      'What it does not do today',
      'Identifier prefixes',
    ],
  },
  {
    slug: 'quickstart',
    section: 'getting-started',
    title: 'Quickstart',
    description: 'Create a key, pair a number, send your first text message.',
    topics: [
      '1. Create an API key',
      '2. Create an instance',
      '3. Connect it',
      '4. Read the pairing QR code',
      '5. Send a message',
    ],
  },
  {
    slug: 'setup-guide',
    section: 'getting-started',
    title: 'Setup Guide',
    description: 'From an empty account to a live WhatsApp conversation driven from a terminal.',
    topics: [
      'Create your account',
      'Create a project',
      'Create an app',
      'Create an instance',
      'Pair your WhatsApp number',
      'Send your first message',
      'Install the CLI and work from a terminal',
    ],
  },
  {
    slug: 'authentication',
    section: 'getting-started',
    title: 'Authentication',
    description: 'The X-API-Key header, the dashboard session cookie, and which routes accept which.',
    topics: [
      'The API key header',
      'The dashboard session',
      'Which routes accept which',
      'Listing your keys',
      'Idempotency and API keys',
    ],
  },
  {
    slug: 'instances',
    section: 'api-reference',
    title: 'Instances API',
    description: 'Create, pair, inspect, cycle and delete WhatsApp sessions.',
    topics: [
      'List instances',
      'Create instance',
      'Get instance (and its QR code)',
      'Connect, disconnect, restart',
      'Instance state',
      'Delete instance',
      'Bind an API key to an instance',
    ],
  },
  {
    slug: 'messages',
    section: 'api-reference',
    title: 'Messages API',
    description: 'Send text messages, with idempotency, against a paced queue.',
    topics: ['Send a message', 'Only text is delivered', 'Idempotency', 'The instance-scoped route'],
  },
  {
    slug: 'message-lifecycle',
    section: 'api-reference',
    title: 'Message lifecycle',
    description: 'How a 202 becomes a delivered message, and why the platform paces its sends.',
    topics: [
      'The states a message goes through',
      'Why the sends are paced',
      'The numbers',
      'The anti-ban guard',
      'Retries and crash recovery',
      'What this means for your integration',
    ],
  },
  {
    slug: 'webhooks',
    section: 'api-reference',
    title: 'Webhooks API',
    description: 'Register endpoints, sign payloads, verify deliveries, rotate secrets.',
    topics: [
      'List webhooks',
      'Create a webhook',
      'The creation response',
      'Update and delete',
      'Rotate the secret',
      'Delivery headers',
      'The signature',
      'Retries',
      'The payload',
      'Event types',
    ],
  },
  {
    slug: 'contacts-groups',
    section: 'api-reference',
    title: 'Contacts & Groups API',
    description: 'Read the address book of an instance and the groups it belongs to.',
    topics: ['List contacts', 'Sync contacts', 'List groups', 'Sync groups', 'JID and LID'],
  },
  {
    slug: 'projects-apps',
    section: 'api-reference',
    title: 'Projects & Apps API',
    description: 'Group your work, scope your writes, and archive what you no longer need.',
    topics: [
      'List and create projects',
      'Read and rename a project',
      'Archive a project',
      'List and create apps',
      'Read, rename and archive an app',
      'Scoping a request to an app',
      'Writes are scoped, listings are not',
    ],
  },
  {
    slug: 'api-keys',
    section: 'api-reference',
    title: 'API keys',
    description: 'Create, list and revoke the credentials your services authenticate with.',
    topics: [
      'Create a key',
      'List keys',
      'Revoke a key',
      'There is no rotate route',
      'Scopes are not enforced on the REST layer',
    ],
  },
  {
    slug: 'platform',
    section: 'api-reference',
    title: 'Account & platform',
    description: 'Onboarding, sessions, the current tenant, plans and health.',
    topics: ['Onboard an account', 'Sign up', 'Session routes', 'Passwords', 'The current tenant', 'Plans', 'Health'],
  },
  {
    slug: 'activity',
    section: 'api-reference',
    title: 'Activity & real-time',
    description: 'The audit feed, the activity stream and the per-instance event stream.',
    topics: [
      'Activity history',
      'The activity stream',
      'The instance stream',
      'The instance stream needs a session',
      'MCP tool events',
    ],
  },
  {
    slug: 'mcp-overview',
    section: 'mcp',
    title: 'MCP — Overview',
    description: 'Three ways to connect an AI tool to the platform, and which one to use.',
    topics: ['The standard MCP transport', 'The stdio bridge', 'The HTTP tool API', 'Why categorical discovery'],
  },
  {
    slug: 'mcp-discovery',
    section: 'mcp',
    title: 'MCP — Categorical discovery',
    description: 'Two calls: list the categories, then list the tools of one category.',
    topics: ['Step 1 — the categories', 'Step 2 — the tools of one category', 'Calling a tool', 'Live tool events'],
  },
  {
    slug: 'mcp-tokens',
    section: 'mcp',
    title: 'MCP — API keys for MCP',
    description: 'How to give an AI tool exactly the access it needs.',
    topics: ['Create a key for the agent', 'A dashboard session is not scope limited', 'Binding to an instance'],
  },
  {
    slug: 'mcp-tools',
    section: 'mcp',
    title: 'MCP — Tools',
    description: 'The complete catalogue: eight categories and thirty-one tools.',
    topics: ['Tool names that do not exist', 'get_documentation', 'send_media does not deliver media'],
  },
  {
    slug: 'mcp-scopes',
    section: 'mcp',
    title: 'MCP — Scope enforcement',
    description: 'What the platform returns when an agent asks for something its key cannot do.',
    topics: ['The refusal over the HTTP tool API', 'The refusal over the MCP transport', 'Wildcards and sessions'],
  },
  {
    slug: 'curl',
    section: 'sdks',
    title: 'cURL Reference',
    description: 'Shell examples for scripts, pipelines and CI.',
    topics: ['Send a text message', 'List the instances and read the JSON', 'Fail loudly on errors'],
  },
  {
    slug: 'python',
    section: 'sdks',
    title: 'Python',
    description: 'A small client over requests or httpx.',
    topics: ['A minimal client', 'Listing the instances'],
  },
  {
    slug: 'node',
    section: 'sdks',
    title: 'Node.js & TypeScript',
    description: 'Native fetch, no SDK required.',
    topics: ['A typed sender', 'Listing the instances'],
  },
  {
    slug: 'cli',
    section: 'cli',
    title: 'The viventure CLI',
    description: 'The same platform from a terminal: instances, messages, keys, webhooks, MCP config, docs.',
    topics: [
      'Install',
      'Log in',
      'Configuration',
      'Instances',
      'Messages',
      'API keys',
      'Webhooks',
      'MCP',
      'Docs',
      'Common flags',
    ],
  },
  {
    slug: 'first-message',
    section: 'guides',
    title: 'Send your first message',
    description: 'Number formatting, the 202 response, and what happens next.',
    topics: [
      'Number formatting',
      'The instance has to be connected',
      '202 does not mean delivered',
      'Send yourself first',
    ],
  },
  {
    slug: 'mcp-client',
    section: 'guides',
    title: 'Set up an MCP client',
    description: 'Point Claude Desktop, Cursor or any MCP client at the platform.',
    topics: ['Over HTTP (recommended)', 'Over stdio', 'Check that it works', 'Give the agent a scoped key'],
  },
  {
    slug: 'webhook-verify',
    section: 'guides',
    title: 'Webhook signature verification',
    description: 'Verify the HMAC, reject replays, in Node.js and Python.',
    topics: ['The rules', 'Node.js', 'Python', 'Using it in an Express handler'],
  },
  {
    slug: 'errors-limits',
    section: 'reference',
    title: 'Errors, limits & headers',
    description: 'The error envelope, the error codes, the rate limit headers and the message quota.',
    topics: ['The error envelope', 'Rate limits', 'The message quota', 'Other headers you may see'],
  },
];
