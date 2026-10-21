import { Logger } from '@config/logger.config';
import { NextFunction, Request, Response } from 'express';

import { TenantService } from '../services/tenant.service';
import { PlatformTenant } from '../types/platform-tenant';

/**
 * Express request with the platform context attached by the auth and
 * tenant middlewares.
 *
 * `__vvResolvedTenant` memoises the resolved tenant for the lifetime of
 * the request: `platform.router.ts` mounts the middleware chain on
 * `/accounts` once per route group, so `resolve` runs several times for
 * a single request. Without the memo the account would be loaded from
 * the database once per mount.
 */
type RequestWithTenant = Request & {
  platformTenant?: PlatformTenant;
  __vvResolvedTenant?: PlatformTenant;
};

/**
 * Tenant Resolve Middleware
 * Loads PlatformAccount from platformKey.accountId (internal CUID) on request.
 * Must be used AFTER platformAuth middleware.
 *
 * The tenant carries the account and the plan. It no longer resolves an
 * app: the `X-App-Id` header is gone and the project a request works on
 * is named explicitly in the route.
 */
export class TenantResolveMiddleware {
  private readonly logger = new Logger('TenantResolveMiddleware');
  private readonly tenantService: TenantService;

  constructor() {
    this.tenantService = new TenantService();
  }

  /**
   * Resolve tenant from platformKey.accountId (internal CUID).
   * Tries resolveAccount with publicId first, then falls back to getAccountById with internal ID.
   */
  public resolve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const typedReq = req as RequestWithTenant;
    const platformKey = (req as Request & { platformKey?: { accountId: string } }).platformKey;

    if (!platformKey?.accountId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    try {
      // Already resolved for this request (the chain is mounted once per
      // route group) — reuse it instead of hitting the database again.
      const memoised = typedReq.__vvResolvedTenant;
      if (memoised) {
        typedReq.platformTenant = memoised;
        next();
        return;
      }

      // First try by internal ID directly
      const byId = await this.tenantService.getAccountById(platformKey.accountId);

      if (!byId) {
        res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Account not found' });
        return;
      }

      // Find active or trial subscription
      const subscription =
        byId.subscriptions?.find((s) => s.status === 'active') || byId.subscriptions?.find((s) => s.status === 'trial');

      const plan = subscription?.plan;

      if (byId.status === 'SUSPENDED') {
        res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' });
        return;
      }

      if (byId.status !== 'ACTIVE') {
        res.status(403).json({ error: 'ACCOUNT_INACTIVE', message: `Account status is ${byId.status}` });
        return;
      }

      const account: PlatformTenant = {
        accountId: byId.id,
        publicId: byId.publicId,
        status: byId.status,
        plan: {
          planId: plan?.id ?? '',
          name: plan?.name ?? '',
          monthlyMessageLimit: (plan as { monthlyMessageLimit?: number })?.monthlyMessageLimit ?? null,
        },
      };

      typedReq.platformTenant = account;
      typedReq.__vvResolvedTenant = account;
      next();
    } catch (error) {
      this.logger.error(`Tenant resolve error: ${error}`);
      res.status(500).json({ error: 'TENANT_ERROR', message: 'Failed to resolve tenant' });
    }
  };
}

export const tenantResolveMiddleware = new TenantResolveMiddleware();
