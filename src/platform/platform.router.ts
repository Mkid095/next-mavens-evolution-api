import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import { entitlementMiddleware } from './middleware/entitlement.middleware';
import { hybridAuth } from './middleware/hybrid-auth.middleware';
import { idempotencyMiddleware } from './middleware/idempotency.middleware';
import { platformAuthMiddleware } from './middleware/platform-auth.middleware';
import { platformRateLimitMiddleware } from './middleware/platform-rate-limit.middleware';
import { scopeEnforceMiddleware } from './middleware/scope-enforce.middleware';
import { tenantResolveMiddleware } from './middleware/tenant-resolve.middleware';
import { platformRepository } from './repository/platform.repository';
/**
 * Global activity feed — every audit event streams to the
 * authenticated account's topbar. SSE-only, no scope-enforce
 * (this is a read channel, not a write).
 */
import { activityRoutes } from './routes/activity.routes';
import { authRouter, getCompanyGatePassword, getSessionService } from './routes/auth.routes';
import { contactRoutes } from './routes/contact.routes';
import { groupRoutes } from './routes/group.routes';
import { instanceRoutes } from './routes/instance.routes';
import { mcpRouter } from './routes/mcp.routes';
import { messageRoutes } from './routes/message.routes';
import { messagePublicRoutes } from './routes/message-public.routes';
import { platformRoutes } from './routes/platform.routes';
import { projectRoutes } from './routes/project.routes';
import { createSseRouter } from './routes/sse.routes';
import { webhookRoutes } from './routes/webhook.routes';
import { appService } from './services/app.service';
import { AuditService } from './services/audit.service';
import { PlatformTenant } from './types/platform-tenant';

/** PBKDF2-based password hashing (no external dependency) */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

const router: Router = Router();
const auditService = new AuditService();

/**
 * Full middleware chain for authenticated platform routes.
 * Order: platformAuth → tenantResolve → idempotency → scopeEnforce → rateLimit → entitlement
 */
const middlewareChain = [
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  platformRateLimitMiddleware.apply,
  entitlementMiddleware.checkMessageLimit,
];

/**
 * Platform onboarding endpoint.
 *
 * Gated by the company password, exactly like `/platform/auth/signup`:
 * this endpoint provisions a brand-new account, an OWNER user and a
 * wildcard API key, so it must not be reachable anonymously.
 *
 * Body: { email, name, password, companyPassword, planId? }
 */
router.post('/platform/onboard', async (req: Request, res: Response) => {
  try {
    const { email, name, password, companyPassword, planId } = req.body ?? {};

    if (!email || !name || !password || !companyPassword) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'email, name, password, and companyPassword are required',
      });
      return;
    }
    if (typeof password !== 'string' || password.length < 8) {
      res.status(400).json({
        error: 'WEAK_PASSWORD',
        message: 'Password must be at least 8 characters',
      });
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

    // Create account
    const publicId = `acct_${crypto.randomBytes(8).toString('hex')}`;
    const account = await platformRepository.platformAccount.create({
      data: {
        publicId,
        name,
        status: 'ACTIVE',
      },
    });

    // Create initial user
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

    // Get plan
    const plan = planId
      ? await platformRepository.platformPlan.findUnique({ where: { id: planId } })
      : await platformRepository.platformPlan.findFirst();

    // Create API key — there is no tenant yet, so the account's default
    // app is resolved explicitly (created lazily on demand).
    const { PlatformAuthService } = await import('./services/platform-auth.service');
    const authService = new PlatformAuthService();
    const defaultApp = await appService.resolveDefault(account.id);
    const { plaintextKey } = await authService.createApiKey(account.id, 'Default Key', ['*'], undefined, defaultApp.id);

    // Create default subscription
    await platformRepository.platformSubscription.create({
      data: {
        publicId: `sub_${crypto.randomBytes(8).toString('hex')}`,
        accountId: account.id,
        planId: plan?.id ?? '',
        status: 'trial',
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });

    await auditService.record(account.id, 'ACCOUNT_ONBOARD', { type: 'account', id: account.publicId });

    res.status(201).json({
      accountId: account.publicId,
      userId: user.publicId,
      account: { id: account.publicId, name: account.name },
      user: { id: user.publicId, email: user.email },
      apiKey: plaintextKey,
    });
  } catch {
    res.status(500).json({ error: 'ONBOARD_ERROR', message: 'Failed to create account' });
  }
});

/**
 * Auth routes (unauthenticated + session-authenticated).
 * Session service must be initialised at startup.
 */
router.use('/platform/auth', authRouter);

/**
 * SSE real-time event stream for instance QR/connection state.
 * Authenticated via session cookie.
 */
router.use('/platform/sse', createSseRouter(getSessionService()));

/**
 * MCP (Model Context Protocol) endpoint for AI agent integration.
 * Auth: API key (X-API-Key header)
 */
router.use('/platform/mcp', mcpRouter);
router.use('/platform/activity', hybridAuth(getSessionService()), tenantResolveMiddleware.resolve, activityRoutes);

/**
 * Web console instance routes — session auth + API key auth.
 * Mount BEFORE platformRoutes so more-specific instance paths are matched first.
 * hybridAuth accepts EITHER X-API-Key OR sessionId cookie.
 */
const hybridChain = [hybridAuth(getSessionService()), tenantResolveMiddleware.resolve];
router.use('/accounts', hybridChain, instanceRoutes);

/**
 * Mount account/user routes (API-key auth only).
 */
router.use('/accounts', middlewareChain, platformRoutes);
router.use('/accounts', middlewareChain, projectRoutes);
router.use('/accounts', middlewareChain, contactRoutes);
router.use('/accounts', middlewareChain, groupRoutes);

/**
 * Mount instance-scoped message command route.
 * Uses hybrid auth (session cookie or API key).
 */
const hybridInstanceChain = [
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  platformRateLimitMiddleware.apply,
  entitlementMiddleware.checkMessageLimit,
];
router.use('/instances', hybridInstanceChain, messageRoutes);

/**
 * Mount instance-scoped message command route.
 * Uses base platform chain (no scopeEnforce — instance ownership verified in handler).
 */
const instanceChain = [
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  platformRateLimitMiddleware.apply,
  entitlementMiddleware.checkMessageLimit,
];
router.use('/instances', instanceChain, messageRoutes);

/**
 * Mount publicId-based message route.
 * POST /api/v1/messages/send  — body: { instancePublicId, number, text, type? }
 */
router.use('/messages', messagePublicRoutes);

/**
 * Mount webhook routes
 */
router.use('/webhooks', middlewareChain, webhookRoutes);

/**
 * List available plans
 * GET /api/v1/platform/plans
 */
router.get('/plans', async (req: Request, res: Response) => {
  try {
    const { SubscriptionService } = await import('./services/subscription.service');
    const subscriptionService = new SubscriptionService();
    const plans = await subscriptionService.listPlans();
    res.json(plans);
  } catch {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

/**
 * Health check for platform module
 */
router.get('/platform/health', async (req: Request, res: Response) => {
  try {
    await platformRepository.$queryRaw`SELECT 1`;
    res.json({ status: 'healthy', module: 'platform' });
  } catch {
    res.status(503).json({ status: 'unhealthy', module: 'platform' });
  }
});

/**
 * Get current tenant info — hybrid auth (session or API key)
 */
router.get(
  '/me',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    res.json({
      accountId: platformTenant.accountId,
      publicId: platformTenant.publicId,
      status: platformTenant.status,
      plan: platformTenant.plan,
    });
  },
);

export { router as platformRouter };
