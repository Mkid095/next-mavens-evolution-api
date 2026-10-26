/**
 * OAuth discovery for the MCP gateway.
 *
 * The gateway does not run an OAuth authorization server: it
 * authenticates with an API key the operator issues. The client sends
 * that key in a header. There is no login dance, no client registration
 * and no token endpoint.
 *
 * A client that probes for OAuth metadata used to get back an HTML page
 * and report it as a failed Dynamic Client Registration:
 *
 *   Dynamic Client Registration rejected (HTTP 404): <!DOCTYPE html>…
 *
 * It gets this instead — a machine-readable answer about what the
 * resource accepts. There is deliberately NO `authorization_servers`
 * entry: claiming one would send the client looking for endpoints that
 * do not exist.
 *
 * The dashboard serves the same document at the host root
 * (`/.well-known/…`), which is where a client looks first. Keep the two
 * in step — see `src/lib/oauthDiscovery.ts` in whatsapp-nextmavens.
 */

import { Request } from 'express';

/** The scopes the platform understands. */
const SCOPES = [
  'instances:read',
  'instances:write',
  'messages:send',
  'webhooks:read',
  'webhooks:write',
  'api_keys:read',
  'api_keys:write',
  'contacts:read',
  'docs:read',
  'health:read',
  'account:read',
];

const PUBLIC_BASE = 'https://whatsapp.nextmavens.com';

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata(resource: string) {
  return {
    resource,
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES,
    resource_documentation: `${PUBLIC_BASE}/docs/mcp-tokens`,
    // No `authorization_servers`: there is no authorization server to
    // discover. The operator issues the token and the client sends it.
  };
}

/** The answer to a request for an authorization server — there is none. */
export function noAuthorizationServer() {
  return {
    error: 'no_authorization_server',
    error_description:
      'This platform does not run an OAuth authorization server. It authenticates with an API key the operator issues.',
    how_to_authenticate: 'Send the key in a header: "Authorization: Bearer <key>" or "X-API-Key: <key>".',
    token_url: `${PUBLIC_BASE}/dashboard/settings/tokens`,
    documentation: `${PUBLIC_BASE}/docs/mcp-tokens`,
  };
}

/**
 * The gateway URL a request is asking about.
 *
 * A client probes relative to the MCP URL it was given, so the metadata
 * should name that URL rather than a hard-coded one. The path is taken
 * from the request; the host from the request's own headers.
 */
export function gatewayUrlFor(req: Request): string {
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host ?? '';
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? 'https';
  const base = host ? `${proto}://${host}` : PUBLIC_BASE;
  return `${base.replace(/\/+$/, '')}/api/v1/platform/mcp`;
}

/**
 * Serve an OAuth discovery request.
 *
 * `pathname` is the path the client asked for — the path-scoped form
 * (`/.well-known/oauth-authorization-server/api/v1/platform/mcp`) and
 * the bare one are both recognised.
 */
export function discoveryResponse(req: Request, pathname: string): { status: number; body: unknown } {
  const lower = pathname.toLowerCase();
  const gateway = gatewayUrlFor(req);

  if (lower.includes('/.well-known/oauth-protected-resource') || lower.endsWith('/oauth-protected-resource')) {
    return { status: 200, body: protectedResourceMetadata(gateway) };
  }

  if (
    lower.includes('/.well-known/oauth-authorization-server') ||
    lower.includes('/.well-known/openid-configuration') ||
    lower.endsWith('/oauth-authorization-server') ||
    lower.endsWith('/openid-configuration')
  ) {
    return { status: 404, body: noAuthorizationServer() };
  }

  return {
    status: 404,
    body: {
      error: 'not_found',
      error_description: `No OAuth metadata at ${pathname}.`,
      documentation: `${PUBLIC_BASE}/docs/mcp-tokens`,
    },
  };
}
