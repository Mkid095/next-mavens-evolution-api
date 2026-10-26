/**
 * Read the caller's API key.
 *
 * Two forms are accepted, and both mean the same thing:
 *
 *   X-API-Key: fidscript_sk_…        the platform's own header
 *   Authorization: Bearer fidscript_sk_…   the standard one
 *
 * The second is what every MCP client sends. A platform that only reads
 * its own header cannot be used by one: the client's token is configured,
 * the call is well-formed, and it is refused — which is worse than a
 * client that had not been given a token at all, because the reader has
 * no way to see why it failed.
 */

import { Request } from 'express';

/**
 * The API key on the request, if there is one.
 *
 * `X-API-Key` wins when both are present — it is the more specific of
 * the two, and an explicit platform header should not be silently
 * overridden by a proxy that adds an `Authorization` of its own.
 */
export function readApiKey(req: Request): string | undefined {
  const explicit = req.headers['x-api-key'];
  const key = Array.isArray(explicit) ? explicit[0] : explicit;
  if (key && key.trim()) return key.trim();

  const authorization = req.headers.authorization;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return undefined;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Where the resource's OAuth metadata lives.
 *
 * It is served by the dashboard, not by the API, because a client looks
 * at the host root (`/.well-known/…`) and Caddy sends that to the
 * dashboard. The document says what this resource accepts — a bearer
 * token in a header — and that there is no authorization server to
 * discover.
 */
const RESOURCE_METADATA_URL = 'https://whatsapp.nextmavens.com/.well-known/oauth-protected-resource';

/**
 * The `WWW-Authenticate` challenge for a 401.
 *
 * A client that gets a 401 with no challenge has to guess what the
 * server wants. Some guess OAuth and go looking for a discovery
 * document that does not exist. Naming the scheme, and pointing at the
 * metadata that describes the resource, gives it the answer instead of
 * making it search.
 */
export function bearerChallenge(realm = 'viventure'): string {
  return `Bearer realm="${realm}", charset="UTF-8", resource_metadata="${RESOURCE_METADATA_URL}"`;
}
