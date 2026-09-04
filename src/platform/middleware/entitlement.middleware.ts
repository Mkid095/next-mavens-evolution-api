import { Request, Response, NextFunction } from 'express';
import { EntitlementService } from '../services/entitlement.service';
import { Logger } from '@config/logger.config';

/**
 * Entitlement Middleware
 * Checks plan limits and feature flags.
 * Returns 402 if over message limit.
 */
export class EntitlementMiddleware {
  private readonly logger = new Logger('EntitlementMiddleware');
  private readonly entitlementService: EntitlementService;

  constructor() {
    this.entitlementService = new EntitlementService();
  }

  /**
   * Check message limit entitlement.
   * Must be used AFTER tenantResolve middleware.
   */
  public checkMessageLimit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const platformTenant = (req as Request & { platformTenant?: { accountId: string } }).platformTenant;

    if (!platformTenant?.accountId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    try {
      const result = await this.entitlementService.checkMessageLimit(platformTenant.accountId);

      res.setHeader('X-Message-Limit', result.limit);
      res.setHeader('X-Message-Current', result.current);
      res.setHeader('X-Message-Remaining', Math.max(0, result.limit - result.current));

      if (!result.allowed) {
        res.status(402).json({
          error: 'LIMIT_EXCEEDED',
          message: 'Monthly message limit exceeded',
          current: result.current,
          limit: result.limit,
        });
        return;
      }

      next();
    } catch (error) {
      this.logger.error(`Entitlement middleware error: ${error}`);
      // Fail open - allow request if entitlement check fails
      next();
    }
  };

  /**
   * Check if account has a specific feature.
   */
  public requireFeature = (feature: string) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const platformTenant = (req as Request & { platformTenant?: { accountId: string } }).platformTenant;

      if (!platformTenant?.accountId) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
      }

      try {
        const hasFeature = await this.entitlementService.hasFeature(platformTenant.accountId, feature);

        if (!hasFeature) {
          res.status(403).json({
            error: 'FEATURE_NOT_ENABLED',
            message: `Feature '${feature}' is not enabled on your plan`,
          });
          return;
        }

        next();
      } catch (error) {
        this.logger.error(`Entitlement check error: ${error}`);
        res.status(500).json({ error: 'ENTITLEMENT_ERROR', message: 'Failed to check feature entitlement' });
      }
    };
  };
}

export const entitlementMiddleware = new EntitlementMiddleware();
