import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import { apiAuditMiddleware } from './middleware/api-audit.middleware';
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
import { apiKeyRoutes } from './routes/api-key.routes';
import { authRouter, getCompanyGatePassword, getSessionService } from './routes/auth.routes';
import { contactRoutes } from './routes/contact.routes';
import { docsRoutes } from './routes/docs.routes';
import { groupRoutes } from './routes/group.routes';
import { instanceRoutes } from './routes/instance.routes';
import { logRoutes } from './routes/log.routes';
import { mcpRouter } from './routes/mcp.routes';
import { messageRoutes } from './routes/message.routes';
import { messagePublicRoutes } from './routes/message-public.routes';
import { platformRoutes } from './routes/platform.routes';
import { projectRoutes } from './routes/project.routes';
import { createSseRouter } from './routes/sse.routes';
import { webhookRoutes } from './routes/webhook.routes';
import { AuditService } from './services/audit.service';
import { discoveryResponse } from './services/oauth-discovery';
import { projectService } from './services/project.service';
import { resolveRequestProject } from './services/request-project';
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
 * Record every tenant-scoped REST call in the audit log.
 *
 * Mounted FIRST so it sees every request that enters the platform
 * router. It only writes rows for `/api/v1/accounts/...` paths and it
 * writes them AFTER the response was flushed, so it never delays the
 * caller.
 */
router.use(apiAuditMiddleware.track);

/**
 * Full middleware chain for authenticated platform routes.
 * Order: platformAuth → tenantResolve → idempotency → scopeEnforce → rateLimit
 *
 * The message quota is NOT checked here. This chain serves the account,
 * user, API-key, project, contact, group and webhook routes — none of
 * which send a WhatsApp message. Gating them on the quota meant that once
 * an account spent its monthly allowance every *read* answered 402, and an
 * account with no plan at all was locked out of reading anything.
 */
const middlewareChain = [
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  platformRateLimitMiddleware.apply,
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
    // project is resolved explicitly (created lazily on demand).
    const { PlatformAuthService } = await import('./services/platform-auth.service');
    const authService = new PlatformAuthService();
    const defaultProject = await projectService.resolveDefault(account.id);
    const { plaintextKey } = await authService.createApiKey(
      account.id,
      defaultProject.id,
      'Default Key',
      ['*'],
      undefined,
    );

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

// The platform documentation. It is public — the same pages are on the
// public docs site — so the CLI and any integrator can pull the full
// reference without a credential.
router.use('/platform/docs', docsRoutes);

/*
 * OAuth discovery.
 *
 * A client that is not sure how to authenticate looks for this before it
 * gives up. It must be reachable WITHOUT a credential — asking how to
 * authenticate is what you do before you have a token.
 *
 * It is served under the platform mount and under the MCP path, because
 * a client may probe either the host root (the dashboard serves that
 * one) or the path-scoped form relative to the MCP URL it was given.
 */
router.use((req, _res, next) => {
  const path = req.path.toLowerCase();
  if (
    path.includes('/.well-known/') ||
    /\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)\/?$/.test(path)
  ) {
    const { status, body } = discoveryResponse(req, req.path);
    _res.status(status).set('Cache-Control', 'no-store').json(body);
    return;
  }
  next();
});

/**
 * Web console routes — session auth + API key auth.
 * Mounted BEFORE the API-key-only chain so more-specific paths are matched first.
 * hybridAuth accepts EITHER X-API-Key OR sessionId cookie.
 *
 * All the account-scoped sub-routers are mounted under ONE chain so the
 * credential is validated once per request, not once per router.
 */
const hybridChain = [hybridAuth(getSessionService()), tenantResolveMiddleware.resolve];
router.use(
  '/accounts',
  hybridChain,
  instanceRoutes,
  apiKeyRoutes,
  webhookRoutes,
  contactRoutes,
  groupRoutes,
  logRoutes,
);

/**
 * Mount account/user routes (API-key auth only).
 */
router.use('/accounts', middlewareChain, platformRoutes, projectRoutes);

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
 *
 * The response carries the project the credential is scoped to: an API
 * key names its own project, a dashboard session falls back to the
 * account's default project. The CLI uses this to discover the project
 * it should call the project-scoped routes with.
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

    const project = await resolveRequestProject(req, platformTenant.accountId);

    res.json({
      accountId: platformTenant.accountId,
      publicId: platformTenant.publicId,
      status: platformTenant.status,
      plan: platformTenant.plan,
      projectId: project?.publicId ?? null,
      project: project ? { id: project.publicId } : null,
    });
  },
);

export { router as platformRouter };
