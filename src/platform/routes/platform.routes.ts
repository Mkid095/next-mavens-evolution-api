import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import { KNOWN_SCOPES } from '../mcp/tool-registry';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { appService } from '../services/app.service';
import { AuditService } from '../services/audit.service';
import { callerRoleService } from '../services/caller-role.service';
import { PlatformAuthService } from '../services/platform-auth.service';
import { settingsService } from '../services/settings.service';
import { SubscriptionService } from '../services/subscription.service';
import { TenantService } from '../services/tenant.service';
import { PlatformTenant } from '../types/platform-tenant';

/** PBKDF2-based password hashing (no external dependency) */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
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
router.get(
  '/',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      // Return only the authenticated tenant's own account
      const account = await platformRepository.platformAccount.findUnique({
        where: { id: platformTenant.accountId },
        include: { subscriptions: { include: { plan: true } } },
      });
      if (!account) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      res.json([
        {
          id: account.id,
          publicId: account.publicId,
          status: account.status,
          plan: account.subscriptions?.[0]?.plan?.name ?? null,
          createdAt: account.createdAt,
        },
      ]);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Get account by publicId
 * GET /accounts/:publicId
 * Returns 403 if the authenticated tenant does not own this account.
 */
router.get(
  '/:publicId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
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
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create account + initial user + API key (admin only).
 * POST /accounts
 *
 * Body: { email, password, name }
 * Response: { accountId, userId, apiKey }
 *
 * ADMIN ONLY. This route provisions a brand-new account, an OWNER user and a
 * wildcard ('*') API key, so it must never be reachable by a plain member.
 * The caller's role is resolved from the request credential
 * (see CallerRoleService):
 *   - a dashboard session resolves to the PlatformUser role (OWNER / ADMIN /
 *     MEMBER) — only OWNER and ADMIN pass;
 *   - an API key has no per-person role: only a wildcard-scoped key
 *     (the account's administrative credential) passes;
 *   - anything that cannot be resolved fails closed with 403.
 */
router.post(
  '/',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }

      const caller = await callerRoleService.resolve(req, platformTenant);
      if (!caller.isAdmin) {
        res.status(403).json({ error: 'FORBIDDEN', message: caller.reason });
        return;
      }

      const { email, password, name } = req.body ?? {};

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

      // Create initial API key — there is no tenant yet, so the account's
      // default app is resolved explicitly (it is created lazily on demand).
      const defaultApp = await appService.resolveDefault(account.id);
      const { plaintextKey } = await authService.createApiKey(
        account.id,
        'Initial Key',
        ['*'],
        undefined,
        defaultApp.id,
      );

      await auditService.record(account.id, 'ACCOUNT_CREATE', { type: 'account', id: account.publicId });

      res.status(201).json({
        accountId: account.publicId,
        userId: user.publicId,
        apiKey: plaintextKey,
      });
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * Suspend account (admin only).
 * POST /accounts/:id/suspend
 *
 * Body: { reason?, companyPassword? }
 *
 * `:id` names the account that gets suspended — its public id (`acct_xxx`)
 * or its internal account id. It is NEVER silently replaced by the caller's
 * own account: the id is resolved and the named account is the one that is
 * suspended.
 *
 * Who may do it:
 *  - Suspending your OWN account: requires an admin role (OWNER/ADMIN) —
 *    the self-service "close my workspace" path.
 *  - Suspending a DIFFERENT account: requires an admin role AND the company
 *    gate password (`companyPassword` in the body). There is no platform
 *    super-admin role in the data model, so cross-account suspension is
 *    gated by the company-wide secret (the same one that guards
 *    /platform/signup and /platform/onboard).
 */
router.post(
  '/:id/suspend',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }

      const { reason, companyPassword } = req.body ?? {};

      // Resolve the account named by :id — the account that will be suspended.
      const target = await platformRepository.platformAccount.findFirst({
        where: { OR: [{ publicId: req.params.id }, { id: req.params.id }] },
        select: { id: true, publicId: true },
      });

      if (!target) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      const caller = await callerRoleService.resolve(req, platformTenant);
      if (!caller.isAdmin) {
        res.status(403).json({ error: 'FORBIDDEN', message: caller.reason });
        return;
      }

      if (target.id !== platformTenant.accountId) {
        // Cross-account suspension — gated by the company password.
        const gatePassword = await settingsService.getCompanyGatePassword();
        if (!gatePassword || companyPassword !== gatePassword) {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Suspending another account requires the company password',
          });
          return;
        }
      }

      await tenantService.suspendAccount(target.id, reason ?? 'Admin action');
      await auditService.record(
        target.id,
        'ACCOUNT_SUSPEND',
        { type: 'account', id: target.publicId },
        { actorAccountId: platformTenant.accountId, reason: reason ?? 'Admin action' },
      );
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'UPDATE_ERROR' });
    }
  },
);

/**
 * List users for the authenticated tenant.
 * GET /accounts/:accountId/users
 * accountId in URL must match the authenticated tenant's publicId.
 * The query always uses the authenticated tenant's INTERNAL accountId.
 */
router.get(
  '/:accountId/users',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
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
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create user for the authenticated tenant.
 * POST /accounts/:accountId/users
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.post(
  '/:accountId/users',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const { email, name, role } = req.body;
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
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
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * List API keys for the authenticated tenant.
 * GET /accounts/:accountId/api-keys
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.get(
  '/:accountId/api-keys',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (platformTenant.publicId !== req.params.accountId) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      const keys = await authService.listApiKeys(platformTenant.accountId);
      // Never return keyHash or plaintext — only public metadata
      res.json(
        keys.map((k) => ({
          id: k.publicId,
          name: k.name,
          scopes: k.scopes,
          // Safe to expose: the prefix is the first 16 chars of the key
          // ("fidscript_sk_" + 4 hex). The hash and plaintext never leave the server.
          keyPrefix: k.keyPrefix,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt,
          revokedAt: k.revokedAt,
          lastUsedAt: k.lastUsedAt,
        })),
      );
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create API key for the authenticated tenant.
 * POST /accounts/:accountId/api-keys
 * accountId in URL must match the authenticated tenant's publicId.
 *
 * A wildcard-scoped key ('*') is the account's ADMINISTRATIVE credential — it
 * is one of the credentials the admin-only account routes accept — so only an
 * account admin (OWNER/ADMIN) may create one. Members may still create
 * scoped keys.
 */
router.post(
  '/:accountId/api-keys',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (platformTenant.publicId !== req.params.accountId) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      const { name, scopes } = req.body ?? {};
      const requestedScopes: string[] = Array.isArray(scopes) ? scopes : [];

      // Reject a scope the platform does not recognise. A key carrying a
      // misspelled scope is silently useless — it grants nothing and the
      // holder has no way to tell.
      const unknownScopes = requestedScopes.filter((s) => !KNOWN_SCOPES.includes(s));
      if (unknownScopes.length > 0) {
        res.status(400).json({
          error: 'UNKNOWN_SCOPE',
          message: `Unknown scope${unknownScopes.length > 1 ? 's' : ''}: ${unknownScopes.join(', ')}`,
          knownScopes: KNOWN_SCOPES,
        });
        return;
      }

      if (requestedScopes.includes('*')) {
        const caller = await callerRoleService.resolve(req, platformTenant);
        if (!caller.isAdmin) {
          res.status(403).json({ error: 'FORBIDDEN', message: caller.reason });
          return;
        }
      }

      const { publicId, plaintextKey } = await authService.createApiKey(
        platformTenant.accountId,
        name ?? 'Unnamed Key',
        requestedScopes,
        undefined,
        platformTenant.defaultApp.id,
      );
      idempotencyMiddleware.complete(
        req,
        res,
        { id: publicId, name, scopes: requestedScopes, apiKey: plaintextKey },
        publicId,
      );
      res.status(201).json({ id: publicId, name, scopes: requestedScopes, apiKey: plaintextKey });
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * Revoke an API key (sets revokedAt to now).
 * DELETE /accounts/:accountId/api-keys/:keyId
 * keyId is the public ID (key_xxx).
 */
router.delete(
  '/:accountId/api-keys/:keyId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (platformTenant.publicId !== req.params.accountId) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      const ok = await authService.revokeApiKey(req.params.keyId, platformTenant.accountId);
      if (!ok) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'REVOKE_ERROR' });
    }
  },
);

/**
 * Get subscription for the authenticated tenant.
 * GET /accounts/:accountId/subscription
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.get(
  '/:accountId/subscription',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (platformTenant.publicId !== req.params.accountId) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      const subscription = await subscriptionService.getActiveSubscription(platformTenant.accountId);
      if (!subscription) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      res.json(subscription);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

export { router as platformRoutes };
