import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { SessionService } from '../services/session.service';

export interface PlatformSession {
  sessionId: string;
  userId: string;
  accountId: string;
}

/** Parse sessionId from raw cookie header — no cookie-parser needed. */
function getSessionId(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|;\s*)sessionId=([^;]+)/);
  return match ? match[1] : undefined;
}

/** Parse csrf_token from raw cookie header. */
function getCsrfToken(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? match[1] : undefined;
}

/**
 * Session authentication middleware.
 * Reads sessionId from HttpOnly cookie, validates against SessionService,
 * attaches req.platformSession.
 *
 * Does NOT enforce CSRF — that is done per-route with csrfValidate().
 */
export function sessionAuthMiddleware(sessionService: SessionService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const sessionId = getSessionId(req);

    if (!sessionId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'No session cookie' });
      return;
    }

    const session = await sessionService.validateSession(sessionId);
    if (!session) {
      res.status(401).json({ error: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
      return;
    }

    (req as Request & { platformSession?: PlatformSession }).platformSession = {
      sessionId,
      userId: session.userId,
      accountId: session.accountId,
    };

    next();
  };
}

/**
 * CSRF double-submit cookie validation.
 * Must be called AFTER sessionAuthMiddleware on routes that modify state.
 *
 * Receives token via x-csrf-token header (or X-CSRF-Token).
 * Cookie value is the stored double-submit value.
 */
export function csrfValidate(req: Request, res: Response, next: NextFunction): void {
  const token = (req.headers['x-csrf-token'] || req.headers['x-xsrf-token']) as string | undefined;
  const cookieToken = getCsrfToken(req);

  if (!token || !cookieToken || token !== cookieToken) {
    res.status(403).json({ error: 'CSRF_INVALID', message: 'CSRF token mismatch' });
    return;
  }

  next();
}

/**
 * Generate a new CSRF token and set it as a cookie.
 * Call this on GET /login (or any page that renders a form).
 */
export function generateCsrfToken(res: Response): string {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('csrf_token', token, {
    httpOnly: false, // Must be readable by JS to send as header
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 86400 * 1000, // 24h
  });
  return token;
}
