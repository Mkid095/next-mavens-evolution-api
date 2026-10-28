/**
 * Reading the routes the platform actually mounts.
 *
 * The documentation is written by hand, but the LIST of routes is read
 * from the live Express router. That is the only way to be sure the
 * reference is complete: a route that exists is a route the reference
 * can be checked against, and anything the reference misses is named
 * out loud at boot instead of being discovered by a user.
 */

import { Router } from 'express';

export interface MountedRoute {
  method: string;
  path: string;
}

/**
 * The mount prefix of a layer, read off its regular expression.
 *
 * Express encodes a mount path as a regexp — '/platform/sse' becomes
 * `^\\/platform\\/sse\\/?(?=\\/|$)`. The mount path is the part
 * before the optional trailing slash and the lookahead; the slashes
 * inside it are escaped, so they have to be unescaped on the way out.
 */
function mountPrefix(layer: any): string {
  if (!layer?.regexp?.source) return '';

  const source: string = layer.regexp.source;

  // Strip the anchor and the leading escaped slash.
  const rest = source.replace(/^\^/, '').replace(/^\\\//, '');

  // The mount path ends where the optional trailing slash and the
  // lookahead begin.
  const cut = rest.search(/\\\/\?|\(\?=/);
  const literal = cut === -1 ? rest : rest.slice(0, cut);
  if (!literal || literal === '$') return '';

  return `/${literal.replace(/\\\//g, '/').replace(/\/$/, '')}`;
}

/**
 * Every route a router mounts, with its full path.
 *
 * Walks the router's stack, descending into the sub-routers that were
 * mounted on it.
 */
export function collectRoutes(router: Router, prefix = ''): MountedRoute[] {
  const out: MountedRoute[] = [];
  const stack: any[] = (router as any).stack ?? [];

  for (const layer of stack) {
    if (layer?.route) {
      const methods = Object.keys(layer.route.methods ?? {}).filter((m) => m !== '_all');
      for (const method of methods) {
        out.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
      }
      continue;
    }

    // A mounted sub-router: its own stack lives on the handler.
    const handle = layer?.handle;
    if (handle?.stack) {
      out.push(...collectRoutes(handle, `${prefix}${mountPrefix(layer)}`));
    }
  }

  return out;
}

/**
 * Compare the mounted routes with the documented ones.
 *
 * Returns the routes that exist but are not in the reference, and the
 * reference entries with no route behind them. Both are gaps: the first
 * is an undocumented endpoint, the second is a page describing
 * something that is not there.
 */
export function findGaps(
  mounted: MountedRoute[],
  documented: { method: string; path: string }[],
): { undocumented: string[]; stale: string[] } {
  const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

  // Only the entries that are actually there. A hole in either list would
  // otherwise reach the Set as `undefined` and be reported as a route
  // called "undefined" — which is a confusing way to say "the list is
  // malformed".
  const mountedKeys = new Set(mounted.filter((r) => r && r.method && r.path).map((r) => key(r.method, r.path)));
  const documentedKeys = new Set(documented.filter((r) => r && r.method && r.path).map((r) => key(r.method, r.path)));

  return {
    undocumented: [...mountedKeys].filter((k) => !documentedKeys.has(k)).sort(),
    stale: [...documentedKeys].filter((k) => !mountedKeys.has(k)).sort(),
  };
}
