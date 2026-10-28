/**
 * The OpenAPI document for the platform.
 *
 * It is built from the API catalogue, so the reference and the code
 * cannot drift: a route that is not in the catalogue is not in the
 * document, and `undocumentedRoutes()` says so out loud rather than
 * letting the gap sit there quietly.
 */

import { API_CATALOGUE, API_PREFIX, ApiEndpoint } from './api-catalogue';

const PUBLIC_BASE = 'https://whatsapp.nextmavens.com';

/** The OpenAPI version this document is written against. */
const OPENAPI_VERSION = '3.1.0';

interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: unknown[];
  requestBody?: unknown;
  responses: Record<string, { description: string; content?: unknown }>;
  'x-docs-page'?: string;
  /** How this endpoint is authenticated, in the catalogue's words. */
  'x-auth'?: string;
}

/** A stable, readable operation id — `get_accounts_projects`. */
function operationId(endpoint: ApiEndpoint): string {
  const slug = endpoint.path
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `${endpoint.method.toLowerCase()}_${slug}`;
}

/** The tag an endpoint is grouped under — the resource it belongs to. */
function tagFor(endpoint: ApiEndpoint): string {
  const path = endpoint.path;
  if (path.startsWith('/platform/auth')) return 'Authentication';
  if (path.startsWith('/platform/mcp')) return 'MCP';
  if (path.startsWith('/platform/docs')) return 'Documentation';
  if (path.startsWith('/platform/activity')) return 'Activity';
  if (path.startsWith('/platform/sse')) return 'Activity';
  if (path.startsWith('/messages')) return 'Messages';
  if (path.startsWith('/instances')) return 'Messages';
  if (path.includes('/api-keys')) return 'API keys';
  if (path.includes('/instances')) return 'Instances';
  if (path.includes('/webhooks')) return 'Webhooks';
  if (path.includes('/logs')) return 'Logs';
  if (path.includes('/contacts') || path.includes('/groups')) return 'Contacts & groups';
  if (path.includes('/projects')) return 'Projects';
  if (path.startsWith('/accounts')) return 'Account';
  return 'Platform';
}

/** A parameter object. */
function parameter(parameter: { name: string; in: string; type: string; required: boolean; description: string }) {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.in === 'path' ? true : parameter.required,
    description: parameter.description,
    schema: { type: parameter.type },
  };
}

/** A request body object. */
function requestBody(endpoint: ApiEndpoint) {
  if (!endpoint.body?.length) return undefined;
  const required = endpoint.body.filter((f) => f.required).map((f) => f.name);
  return {
    required: required.length > 0,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: required.length ? required : undefined,
          properties: Object.fromEntries(
            endpoint.body.map((field) => [
              field.name,
              {
                type: field.type,
                description: field.description,
              },
            ]),
          ),
        },
      },
    },
  };
}

/** The responses object. */
function responses(endpoint: ApiEndpoint) {
  const out: Record<string, { description: string; content?: unknown }> = {};
  for (const response of endpoint.responses ?? [{ status: '200', description: 'OK' }]) {
    out[response.status] = { description: response.description };
  }
  return out;
}

/**
 * The whole document.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const endpoint of API_CATALOGUE) {
    const path = `${API_PREFIX}${endpoint.path === '/' ? '' : endpoint.path}`;

    const operation: OpenApiOperation = {
      operationId: operationId(endpoint),
      summary: endpoint.summary,
      description: endpoint.description,
      tags: [tagFor(endpoint)],
      parameters: (endpoint.parameters ?? []).map(parameter),
      responses: responses(endpoint),
    };

    const body = requestBody(endpoint);
    if (body) operation.requestBody = body;
    if (endpoint.docs) operation['x-docs-page'] = endpoint.docs;
    operation['x-auth'] = endpoint.auth;

    paths[path] = paths[path] ?? {};
    paths[path][endpoint.method.toLowerCase()] = operation;
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Viventure WhatsApp platform',
      version: '1.0.0',
      description:
        'The Viventure WhatsApp platform. A project owns instances, API keys, webhooks and a log; ' +
        'a message is queued and sent one at a time at a controlled interval, and its state and ' +
        'the receipt WhatsApp sends back can both be read.',
      license: { name: 'UNLICENSED' },
    },
    servers: [{ url: `${PUBLIC_BASE}${API_PREFIX}`, description: 'The platform API' }],
    tags: [...new Set(API_CATALOGUE.map(tagFor))].map((name) => ({ name })),
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        bearer: { type: 'http', scheme: 'bearer' },
        session: { type: 'apiKey', in: 'cookie', name: 'sessionId' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['error'],
        },
      },
    },
    security: [{ apiKey: [] }, { bearer: [] }],
    paths,
  };
}

/**
 * A flat list of every endpoint, for the CLI and the MCP tool.
 */
export function endpointSummary(): {
  method: string;
  path: string;
  summary: string;
  auth: string;
  docs: string | null;
  tag: string;
}[] {
  return API_CATALOGUE.map((endpoint) => ({
    method: endpoint.method,
    path: `${API_PREFIX}${endpoint.path === '/' ? '' : endpoint.path}`,
    summary: endpoint.summary,
    auth: endpoint.auth,
    docs: endpoint.docs ?? null,
    tag: tagFor(endpoint),
  }));
}

/** One endpoint by method and path, in full. */
export function findEndpoint(method: string, path: string): ApiEndpoint | undefined {
  const wanted = method.toUpperCase();
  return API_CATALOGUE.find(
    (endpoint) => endpoint.method === wanted && `${API_PREFIX}${endpoint.path === '/' ? '' : endpoint.path}` === path,
  );
}
