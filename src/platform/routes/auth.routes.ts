import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import {
  csrfValidate,
  generateCsrfToken,
  PlatformSession,
  sessionAuthMiddleware,
} from '../middleware/session-auth.middleware';
import { platformRepository } from '../repository/platform.repository';
import { SessionService } from '../services/session.service';

/** Verify a password against a stored hash */
function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return crypto.timingSafeEqual(expected, Buffer.from(hashHex, 'hex'));
}

let sessionServiceInstance: SessionService | null = null;

export function setSessionService(svc: SessionService): void {
  sessionServiceInstance = svc;
}

export function getSessionService(): SessionService {
  if (!sessionServiceInstance) {
    sessionServiceInstance = new SessionService();
  }
  return sessionServiceInstance;
}

const router: Router = Router();

export { router as authRouter };

/**
 * GET /platform/login → render login page (serves CSRF token)
 * GET /platform/csrf → returns CSRF token for AJAX clients
 */
router.get('/csrf', (req: Request, res: Response) => {
  const token = generateCsrfToken(res);
  res.json({ csrfToken: token });
});

/**
 * POST /platform/login
 * Body: { email: string, password: string }
 * Sets HttpOnly sessionId cookie on success.
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'email and password are required' });
    return;
  }

  // Find user by email
  const user = await platformRepository.platformUser.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    // Deliberately use generic message to avoid user enumeration
    res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    return;
  }

  // Verify password
  const valid = verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    return;
  }

  // Create session
  const sessionService = getSessionService();
  const sessionId = await sessionService.createSession(user.id, user.accountId);

  // Generate CSRF token for the session
  generateCsrfToken(res);

  // Set HttpOnly session cookie
  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: ((req.headers['x-forwarded-proto'] as string) ?? '').startsWith('https'),
    maxAge: 86400 * 1000, // 24h in milliseconds
    path: '/',
  });

  res.json({
    user: {
      id: user.publicId,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    accountId: user.accountId,
  });
});

/**
 * POST /platform/logout
 * Requires: valid session cookie + CSRF token in header.
 */
router.post(
  '/logout',
  csrfValidate,
  sessionAuthMiddleware(getSessionService()),
  async (req: Request, res: Response) => {
    const platformSession = (req as Request & { platformSession?: PlatformSession }).platformSession;
    if (!platformSession) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const sessionService = getSessionService();
    await sessionService.destroySession(platformSession.sessionId);

    // Clear session cookie
    res.cookie('sessionId', '', {
      httpOnly: true,
      sameSite: 'strict',
      secure: ((req.headers['x-forwarded-proto'] as string) ?? '').startsWith('https'),
      maxAge: 0,
      path: '/',
    });

    // Clear CSRF cookie too
    res.clearCookie('csrf_token', { path: '/' });

    res.json({ success: true });
  },
);

/**
 * GET /platform/me
 * Requires: valid session cookie.
 * Returns current user info.
 */
router.get('/me', sessionAuthMiddleware(getSessionService()), async (req: Request, res: Response) => {
  const platformSession = (req as Request & { platformSession?: PlatformSession }).platformSession;
  if (!platformSession) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const user = await platformRepository.platformUser.findUnique({
    where: { id: platformSession.userId },
    include: { account: { select: { publicId: true, name: true, status: true } } },
  });

  if (!user) {
    res.status(404).json({ error: 'USER_NOT_FOUND' });
    return;
  }

  res.json({
    user: {
      id: user.publicId,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    account: user.account ? { id: user.account.publicId, name: user.account.name, status: user.account.status } : null,
  });
});

/**
 * PATCH /platform/auth/account
 * Update the authenticated user's account (workspace name).
 * Body: { name: string }
 */
router.patch('/account', sessionAuthMiddleware(getSessionService()), async (req: Request, res: Response) => {
  const platformSession = (req as Request & { platformSession?: PlatformSession }).platformSession;
  if (!platformSession) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
    res.status(400).json({ error: 'INVALID_NAME', message: 'Name must be 2–80 characters' });
    return;
  }

  try {
    const updated = await platformRepository.platformAccount.update({
      where: { id: platformSession.accountId },
      data: { name: name.trim() },
      select: { name: true },
    });

    // Also update the user's display name to keep the dashboard's
    // header in sync (the user's name is what's shown in the topbar).
    const user = await platformRepository.platformUser.update({
      where: { id: platformSession.userId },
      data: { name: name.trim() },
      select: { email: true, name: true },
    });

    res.json({ name: updated.name, email: user.email });
  } catch (err) {
    res.status(500).json({ error: 'UPDATE_ERROR', message: (err as Error).message });
  }
});

/**
 * POST /platform/refresh-session
 * Extends the session TTL.
 */
router.post('/refresh-session', sessionAuthMiddleware(getSessionService()), async (req: Request, res: Response) => {
  const platformSession = (req as Request & { platformSession?: PlatformSession }).platformSession;
  if (!platformSession) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionService = getSessionService();
  const refreshed = await sessionService.refreshSession(platformSession.sessionId);
  if (!refreshed) {
    res.status(401).json({ error: 'SESSION_EXPIRED' });
    return;
  }

  res.json({ success: true, refreshedAt: new Date().toISOString() });
});
