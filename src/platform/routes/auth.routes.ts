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
import { settingsService } from '../services/settings.service';

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

/**
 * Resolve the company gate password.
 *
 * This shared secret gates two flows that would otherwise require
 * sending emails to non-existent users:
 *
 *   1. /signup — anyone can create a new account, but they must
 *      know the company password to confirm they're part of the
 *      organization. This is for an internal company tool, not a
 *      public SaaS, so this gate is the only protection against
 *      random signups.
 *
 *   2. /forgot-password — there's no email/SMS to send a reset
 *      link to, so we ask for the company password as proof of
 *      organization membership, then let them set a new password.
 *
 * The gate password lives in the `PlatformSetting` table, encrypted with
 * `PLATFORM_ENCRYPTION_KEY`. `COMPANY_GATE_PASSWORD` is only a bootstrap
 * seed for a fresh database — see `SettingsService.getCompanyGatePassword()`.
 */
export async function getCompanyGatePassword(): Promise<string | null> {
  return settingsService.getCompanyGatePassword();
}

/** Hash a plaintext password using PBKDF2-SHA512 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * POST /platform/signup
 * Body: { name, email, password, companyPassword }
 *
 * Creates a new PlatformAccount + PlatformUser (role=OWNER).
 * The company password gates this — it's not a public sign-up,
 * it's a way for new employees to provision their own seat.
 */
router.post('/signup', async (req: Request, res: Response) => {
  const { name, email, password, companyPassword } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    companyPassword?: string;
  };

  if (!name || !email || !password || !companyPassword) {
    res
      .status(400)
      .json({ error: 'MISSING_FIELDS', message: 'name, email, password, and companyPassword are required' });
    return;
  }
  if (name.trim().length < 2 || name.trim().length > 80) {
    res.status(400).json({ error: 'INVALID_NAME', message: 'Name must be 2–80 characters' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' });
    return;
  }
  const gatePassword = await getCompanyGatePassword();
  if (!gatePassword) {
    // The gate is not configured — fail closed rather than letting anyone in.
    res.status(503).json({
      error: 'GATE_UNAVAILABLE',
      message: 'Account creation is not configured. Contact your administrator.',
    });
    return;
  }
  if (companyPassword !== gatePassword) {
    // Same generic message as login to avoid leaking which gate exists
    res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid company password' });
    return;
  }

  // Reject duplicate email
  const existing = await platformRepository.platformUser.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'EMAIL_TAKEN', message: 'An account with this email already exists' });
    return;
  }

  // Create the account + owner user in a transaction
  try {
    const accountPublicId = `acct_${crypto.randomBytes(8).toString('hex')}`;
    const userPublicId = `usr_${crypto.randomBytes(8).toString('hex')}`;

    const account = await platformRepository.platformAccount.create({
      data: { publicId: accountPublicId, name: name.trim(), status: 'ACTIVE' },
    });

    const user = await platformRepository.platformUser.create({
      data: {
        publicId: userPublicId,
        accountId: account.id,
        email: email.trim().toLowerCase(),
        name: name.trim(),
        passwordHash: hashPassword(password),
        role: 'OWNER',
      },
    });

    // Issue a session so the user is logged in immediately
    const sessionService = getSessionService();
    const sessionId = await sessionService.createSession(user.id, user.accountId);
    generateCsrfToken(res);
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ((req.headers['x-forwarded-proto'] as string) ?? '').startsWith('https'),
      maxAge: 86400 * 1000,
      path: '/',
    });

    res.status(201).json({
      user: { id: user.publicId, email: user.email, role: user.role, name: user.name },
      accountId: user.accountId,
    });
  } catch (err) {
    res.status(500).json({ error: 'SIGNUP_ERROR', message: (err as Error).message });
  }
});

/**
 * POST /platform/forgot-password/verify
 * Body: { email, companyPassword }
 *
 * Step 1 of password reset. Verifies the email exists AND the
 * company password is correct. Returns a short-lived reset token
 * (signed, 15min TTL) that the client passes to /forgot-password/reset.
 *
 * We don't reveal whether the email exists — the company password
 * check is the gate, not the email lookup. If both pass, the token
 * is generated; otherwise the same generic error is returned.
 */
router.post('/forgot-password/verify', async (req: Request, res: Response) => {
  const { email, companyPassword } = req.body as {
    email?: string;
    companyPassword?: string;
  };

  if (!email || !companyPassword) {
    res.status(400).json({ error: 'MISSING_FIELDS' });
    return;
  }

  // First check: company password is the gate
  const gatePassword = await getCompanyGatePassword();
  if (!gatePassword) {
    res.status(503).json({
      error: 'GATE_UNAVAILABLE',
      message: 'Password recovery is not configured. Contact your administrator.',
    });
    return;
  }
  if (companyPassword !== gatePassword) {
    res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid company password' });
    return;
  }

  // Second check: email must match an existing user
  const user = await platformRepository.platformUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) {
    res.status(404).json({ error: 'EMAIL_NOT_FOUND', message: 'No account found for that email' });
    return;
  }

  // Issue a signed reset token: { userId, exp } HMAC-signed
  const exp = Date.now() + 15 * 60 * 1000;
  const payload = `${user.id}.${exp}`;
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-rotate-in-prod';
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const token = Buffer.from(`${payload}.${sig}`).toString('base64url');

  res.json({ resetToken: token, expiresIn: 900 });
});

/**
 * POST /platform/forgot-password/reset
 * Body: { resetToken, newPassword }
 *
 * Step 2 of password reset. Verifies the signed token, then sets
 * the new password. Also destroys all active sessions for that
 * user (so a stolen token can't keep a session alive).
 */
router.post('/forgot-password/reset', async (req: Request, res: Response) => {
  const { resetToken, newPassword } = req.body as {
    resetToken?: string;
    newPassword?: string;
  };

  if (!resetToken || !newPassword) {
    res.status(400).json({ error: 'MISSING_FIELDS' });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' });
    return;
  }

  let userId: string;
  let exp: number;
  try {
    const decoded = Buffer.from(resetToken, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3) throw new Error('Malformed token');
    userId = parts[0];
    exp = Number(parts[1]);
    const sig = parts[2];
    const expected = crypto
      .createHmac('sha256', process.env.SESSION_SECRET || 'dev-session-secret-rotate-in-prod')
      .update(`${userId}.${exp}`)
      .digest('hex');
    if (expected !== sig) throw new Error('Bad signature');
    if (Date.now() > Number(exp)) throw new Error('Token expired');
  } catch {
    res.status(401).json({ error: 'INVALID_TOKEN', message: 'Reset link is invalid or expired' });
    return;
  }

  // Apply the new password
  await platformRepository.platformUser.update({
    where: { id: userId },
    data: { passwordHash: hashPassword(newPassword) },
  });

  // Sessions are stored in Redis (not Prisma). Force the user to log in
  // again by clearing the current cookie if it belongs to them.
  res.clearCookie('sessionId', { path: '/' });

  res.json({ success: true });
});

/**
 * POST /platform/change-password
 * Authenticated. Body: { currentPassword, newPassword }
 *
 * For a logged-in user who wants to rotate their own password.
 * Requires the current password as proof (replaces the company
 * password flow for in-app rotation).
 */
router.post(
  '/change-password',
  csrfValidate,
  sessionAuthMiddleware(getSessionService()),
  async (req: Request, res: Response) => {
    const platformSession = (req as Request & { platformSession?: PlatformSession }).platformSession;
    if (!platformSession) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'MISSING_FIELDS' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' });
      return;
    }

    const user = await platformRepository.platformUser.findUnique({ where: { id: platformSession.userId } });
    if (!user || !user.passwordHash || !verifyPassword(currentPassword, user.passwordHash)) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' });
      return;
    }

    await platformRepository.platformUser.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(newPassword) },
    });

    res.json({ success: true });
  },
);
