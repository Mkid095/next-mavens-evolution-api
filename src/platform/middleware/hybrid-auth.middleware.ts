import { NextFunction, Request, Response } from 'express';

import { SessionService } from '../services/session.service';
import { platformAuthMiddleware } from './platform-auth.middleware';

/**
 * Hybrid authentication middleware.
 *
 * Accepts EITHER:
 *   1. Valid X-API-Key header (existing platform API key auth)
 *   2. Valid sessionId cookie (new web console session auth)
 *
 * For API key auth: attaches req.platformKey as normal.
 * For session auth: attaches req.platformKey = { accountId, ... } AND req.platformSession.
 *
 * This allows downstream middleware (tenantResolve, scopeEnforce) to work with both auth types.
 */
export function hybridAuth(sessionService: SessionService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const sessionId = (() => {
      const h = req.headers.cookie;
      if (!h) return undefined;
      return h.match(/(?:^|;\s*)sessionId=([^;]+)/)?.[1];
    })();

    if (apiKey) {
      // Use existing API key auth
      return platformAuthMiddleware.authenticate(req, res, next as NextFunction);
    }

    if (sessionId) {
      // Use session auth — resolve session and set req.platformKey equivalent
      const session = await sessionService.validateSession(sessionId);
      if (!session) {
        res.status(401).json({ error: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
        return;
      }

      // Set platformKey equivalent so downstream chain works (tenantResolve uses it)
      (
        req as Request & {
          platformKey?: { accountId: string; apiKeyId?: string; scopes?: string[] };
          platformSession?: { sessionId: string; userId: string; accountId: string };
        }
      ).platformKey = {
        accountId: session.accountId,
      };
      (
        req as Request & {
          platformKey?: { accountId: string; apiKeyId?: string; scopes?: string[] };
          platformSession?: { sessionId: string; userId: string; accountId: string };
        }
      ).platformSession = {
        sessionId,
        userId: session.userId,
        accountId: session.accountId,
      };
      return next();
    }

    res.status(401).json({ error: 'UNAUTHORIZED', message: 'X-API-Key or session cookie required' });
  };
}
