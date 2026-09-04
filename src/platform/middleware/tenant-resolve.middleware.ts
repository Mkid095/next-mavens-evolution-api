import { Request, Response, NextFunction } from 'express';
import { TenantService } from '../services/tenant.service';
import { Logger } from '@config/logger.config';

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
   * Resolve tenant from platformKey.accountId (internal CUID).
   * Tries resolveAccount with publicId first, then falls back to getAccountById with internal ID.
   */
  public resolve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        byId.subscriptions?.find(s => s.status === 'active') ||
        byId.subscriptions?.find(s => s.status === 'trial');

      const plan = subscription?.plan;

      const account = {
        accountId: byId.id,
        publicId: byId.publicId,
        status: byId.status,
        plan: {
          planId: plan?.id ?? '',
          name: plan?.name ?? '',
          monthlyMessageLimit: (plan as { monthlyMessageLimit?: number })?.monthlyMessageLimit ?? null,
        },
      };

      if (account.status === 'SUSPENDED') {
        res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' });
        return;
      }

      if (account.status !== 'ACTIVE') {
        res.status(403).json({ error: 'ACCOUNT_INACTIVE', message: `Account status is ${account.status}` });
        return;
      }

      (req as Request & { platformTenant?: typeof account }).platformTenant = account;
      next();
    } catch (error) {
      this.logger.error(`Tenant resolve error: ${error}`);
      res.status(500).json({ error: 'TENANT_ERROR', message: 'Failed to resolve tenant' });
    }
  };
}

export const tenantResolveMiddleware = new TenantResolveMiddleware();
