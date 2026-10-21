import { Logger } from '@config/logger.config';
import { NextFunction, Request, Response } from 'express';

import { appService } from '../services/app.service';
import { TenantService } from '../services/tenant.service';
import { PlatformTenant, PlatformTenantApp } from '../types/platform-tenant';

/**
 * Express request with the platform context attached by the auth and
 * tenant middlewares.
 *
 * `__vvResolvedApp` memoises the resolved app for the lifetime of the
 * request: `platform.router.ts` mounts the middleware chain on `/accounts`
 * AND the individual route files re-declare `platformAuth` +
 * `tenantResolve` on their own routes, so `resolve` runs TWICE for some
 * paths (`/webhooks`, `/accounts/:id/contacts`, `/accounts/:id/groups`,
 * `/accounts/:id/users`, `/accounts/:id/api-keys`). Without the memo the
 * DB would be hit twice per request.
 */
type RequestWithApp = Request & {
  __vvResolvedApp?: PlatformTenantApp;
  platformTenant?: PlatformTenant;
};

/**
 * Tenant Resolve Middleware
 * Loads PlatformAccount from platformKey.accountId (internal CUID) on request.
 * Must be used AFTER platformAuth middleware.
 */
export class TenantResolveMiddleware {
  private readonly logger = new Logger('TenantResolveMiddleware');
  private readonly tenantService: TenantService;

  constructor() {
    this.tenantService = new TenantService();
  }

  /**
   * Resolve the app this request is scoped to.
   *
   * Priority: `X-App-Id` header → `?appPublicId=` query → `body.appPublicId`
   * → the account's default app. A supplied app id must belong to the
   * tenant's account, otherwise the request is rejected with 404.
   */
  private async resolveApp(req: Request, accountId: string): Promise<PlatformTenantApp | null> {
    const headerAppId = req.headers['x-app-id'];
    const headerValue = Array.isArray(headerAppId) ? headerAppId[0] : headerAppId;

    const queryAppId = typeof req.query?.appPublicId === 'string' ? req.query.appPublicId : undefined;

    const bodyAppId =
      typeof (req.body as { appPublicId?: unknown } | undefined)?.appPublicId === 'string'
        ? (req.body as { appPublicId: string }).appPublicId
        : undefined;

    const requestedAppPublicId = headerValue?.trim() || queryAppId?.trim() || bodyAppId?.trim();

    if (requestedAppPublicId) {
      const app = await appService.get(accountId, requestedAppPublicId);
      if (!app) return null;
      return { id: app.id, publicId: app.publicId, projectId: app.projectId };
    }

    const defaultApp = await appService.resolveDefault(accountId);
    return { id: defaultApp.id, publicId: defaultApp.publicId, projectId: defaultApp.projectId };
  }

  /**
   * Resolve tenant from platformKey.accountId (internal CUID).
   * Tries resolveAccount with publicId first, then falls back to getAccountById with internal ID.
   */
  public resolve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const typedReq = req as RequestWithApp;
    const platformKey = (req as Request & { platformKey?: { accountId: string } }).platformKey;

    if (!platformKey?.accountId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    try {
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

      // Resolve the app this request is scoped to. Memoised per request so
      // the double-mounted middleware only hits the DB once.
      let defaultApp = typedReq.__vvResolvedApp;

      if (!defaultApp) {
        const resolved = await this.resolveApp(req, byId.id);
        if (!resolved) {
          res.status(404).json({ error: 'APP_NOT_FOUND', message: 'App not found' });
          return;
        }
        defaultApp = resolved;
        typedReq.__vvResolvedApp = resolved;
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
        defaultApp,
      };

      typedReq.platformTenant = account;
      next();
    } catch (error) {
      this.logger.error(`Tenant resolve error: ${error}`);
      res.status(500).json({ error: 'TENANT_ERROR', message: 'Failed to resolve tenant' });
    }
  };
}

export const tenantResolveMiddleware = new TenantResolveMiddleware();
