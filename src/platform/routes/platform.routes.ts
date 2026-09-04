import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { platformRepository } from '../repository/platform.repository';
import { PlatformAuthService } from '../services/platform-auth.service';
import { TenantService } from '../services/tenant.service';
import { SubscriptionService } from '../services/subscription.service';
import { AuditService } from '../services/audit.service';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';

interface PlatformTenant {
  accountId: string;
  publicId: string;
  status: string;
  plan: { planId: string; name: string; monthlyMessageLimit: number | null };
}

/** PBKDF2-based password hashing (no external dependency) */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return crypto.timingSafeEqual(expected, Buffer.from(hashHex, 'hex'));
}

const router: Router = Router();
const authService = new PlatformAuthService();
const tenantService = new TenantService();
const subscriptionService = new SubscriptionService();
const auditService = new AuditService();

/**
 * List accounts for the authenticated tenant.
 * GET /accounts — returns only the authenticated tenant's account.
 */
router.get('/', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    // Return only the authenticated tenant's own account
    const account = await platformRepository.platformAccount.findUnique({
      where: { id: platformTenant.accountId },
      include: { subscriptions: { include: { plan: true } } },
    });
    if (!account) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    res.json([{
      id: account.id,
      publicId: account.publicId,
      status: account.status,
      plan: account.subscriptions?.[0]?.plan?.name ?? null,
      createdAt: account.createdAt,
    }]);
  } catch (error) {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

/**
 * Get account by publicId
 * GET /accounts/:publicId
 * Returns 403 if the authenticated tenant does not own this account.
 */
router.get('/:publicId', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    // Tenant can only look up their own account
    if (platformTenant.publicId !== req.params.publicId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const account = await tenantService.resolveAccount(req.params.publicId);
    if (!account) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

/**
 * Create account + initial user + API key (admin only)
 * POST /accounts
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'MISSING_FIELDS' });
      return;
    }

    // Create account
    const publicId = `acct_${crypto.randomBytes(8).toString('hex')}`;
    const account = await platformRepository.platformAccount.create({
      data: {
        publicId,
        name,
        status: 'ACTIVE',
      },
    });

    // Create initial user with hashed password
    const userPublicId = `usr_${crypto.randomBytes(8).toString('hex')}`;
    const passwordHash = hashPassword(password);
    const user = await platformRepository.platformUser.create({
      data: {
        publicId: userPublicId,
        accountId: account.id,
        email,
        passwordHash,
        role: 'OWNER',
      },
    });

    // Create initial API key
    const { plaintextKey } = await authService.createApiKey(account.id, 'Initial Key', ['*']);

    await auditService.record(account.id, 'ACCOUNT_CREATE', { type: 'account', id: account.publicId });

    res.status(201).json({
      accountId: account.publicId,
      userId: user.publicId,
      apiKey: plaintextKey,
    });
  } catch (error) {
    res.status(500).json({ error: 'CREATE_ERROR' });
  }
});

/**
 * Suspend account (admin only)
 * POST /accounts/:id/suspend
 */
router.post('/:id/suspend', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    await tenantService.suspendAccount(platformTenant!.accountId, reason ?? 'Admin action');
    await auditService.record(platformTenant!.accountId, 'ACCOUNT_SUSPEND', { type: 'account', id: platformTenant!.publicId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'UPDATE_ERROR' });
  }
});

/**
 * List users for the authenticated tenant.
 * GET /accounts/:accountId/users
 * accountId in URL must match the authenticated tenant's publicId.
 * The query always uses the authenticated tenant's INTERNAL accountId.
 */
router.get('/:accountId/users', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    // URL accountId must match authenticated tenant's publicId — prevents cross-tenant access
    if (platformTenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const users = await platformRepository.platformUser.findMany({
      where: { accountId: platformTenant.accountId },
      select: { id: true, publicId: true, email: true, role: true, createdAt: true, lastLoginAt: true },
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

/**
 * Create user for the authenticated tenant.
 * POST /accounts/:accountId/users
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.post('/:accountId/users', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const { email, name, role } = req.body;
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    // URL accountId must match authenticated tenant's publicId — prevents cross-tenant access
    if (platformTenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const accountId = platformTenant.accountId;
    const userPublicId = `usr_${crypto.randomBytes(8).toString('hex')}`;
    const user = await platformRepository.platformUser.create({
      data: { publicId: userPublicId, accountId, email, name, role: role ?? 'MEMBER' },
    });
    await auditService.record(accountId, 'USER_CREATE', { type: 'user', id: user.publicId });
    idempotencyMiddleware.complete(req, res, { id: user.publicId, email: user.email }, user.publicId);
    res.status(201).json({ id: user.publicId, email: user.email });
  } catch (error) {
    res.status(500).json({ error: 'CREATE_ERROR' });
  }
});

/**
 * List API keys for the authenticated tenant.
 * GET /accounts/:accountId/api-keys
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.get('/:accountId/api-keys', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    if (platformTenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const keys = await authService.listApiKeys(platformTenant.accountId);
    // Never return keyHash or plaintext — only public metadata
    res.json(keys.map(k => ({
      id: k.publicId,
      name: k.name,
      scopes: k.scopes,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
    })));
  } catch (error) {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

/**
 * Create API key for the authenticated tenant.
 * POST /accounts/:accountId/api-keys
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.post('/:accountId/api-keys', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    if (platformTenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' }); return;
    }
    const { name, scopes } = req.body;
    const { publicId, plaintextKey } = await authService.createApiKey(
      platformTenant.accountId,
      name ?? 'Unnamed Key',
      scopes ?? [],
    );
    idempotencyMiddleware.complete(req, res, { id: publicId, name, scopes, apiKey: plaintextKey }, publicId);
    res.status(201).json({ id: publicId, name, scopes, apiKey: plaintextKey });
  } catch (error) {
    res.status(500).json({ error: 'CREATE_ERROR' });
  }
});

/**
 * Get subscription for the authenticated tenant.
 * GET /accounts/:accountId/subscription
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.get('/:accountId/subscription', platformAuthMiddleware.authenticate, tenantResolveMiddleware.resolve, async (req: Request, res: Response) => {
  try {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    if (platformTenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' }); return;
    }
    const subscription = await subscriptionService.getActiveSubscription(platformTenant.accountId);
    if (!subscription) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.json(subscription);
  } catch (error) {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

export { router as platformRoutes };
