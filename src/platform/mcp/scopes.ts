import { Request } from 'express';

import { TOOL_SCOPES } from './tool-registry';

/**
 * Check if the request's platformKey grants the required scopes for a tool.
 * Returns true if access is allowed, false otherwise.
 *
 * A dashboard session is a full, authenticated login for the account owner,
 * so it is not scope-limited the way a personal access token is. Session
 * requests carry no `scopes` on `platformKey` (see hybrid-auth.middleware),
 * so without this branch every MCP tool would reject them with a 403.
 */
export function checkToolScopes(req: Request, tool: string): boolean {
  const platformSession = (req as Request & { platformSession?: { sessionId: string } }).platformSession;
  if (platformSession) return true;

  const platformKey = (req as Request & { platformKey?: { scopes?: string[] } }).platformKey;
  const grantedScopes: string[] = platformKey?.scopes ?? [];
  // Wildcard = full access
  if (grantedScopes.includes('*')) return true;
  const required = TOOL_SCOPES[tool] ?? [];
  if (required.length === 0) return true;
  return required.some((s) => grantedScopes.includes(s));
}

/** The scopes granted to the request (empty for session-authenticated calls). */
export function grantedScopes(req: Request): string[] {
  const platformKey = (req as Request & { platformKey?: { scopes?: string[] } }).platformKey;
  return platformKey?.scopes ?? [];
}
