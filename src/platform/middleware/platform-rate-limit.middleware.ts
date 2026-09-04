import { Request, Response, NextFunction } from 'express';
import { RateLimitService } from '../services/rate-limit.service';
import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

/**
 * Platform Rate Limit Middleware
 * Loads rate limit policy via: account -> active subscription -> plan -> rateLimitPolicy.
 * Policy is loaded via the account's active subscription -> plan -> rateLimitPolicy.
 */
export class PlatformRateLimitMiddleware {
  private readonly logger = new Logger('PlatformRateLimitMiddleware');
  private readonly rateLimitService: RateLimitService;

  constructor() {
    this.rateLimitService = new RateLimitService();
  }

  public apply = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const platformTenant = (req as Request & { platformTenant?: { accountId: string } }).platformTenant;

    if (!platformTenant?.accountId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    try {
      const subscription = await platformRepository.platformSubscription.findFirst({
        where: { accountId: platformTenant.accountId, status: { in: ['active', 'trial'] } },
        include: { plan: { include: { rateLimitPolicy: true } } },
      });

      const policy = subscription?.plan.rateLimitPolicy;
      if (!policy) {
        next();
        return;
      }

      const result = await this.rateLimitService.checkLimit(
        platformTenant.accountId,
        policy.requestsPerMinute,
        60_000,
      );

      res.setHeader('X-RateLimit-Limit', policy.requestsPerMinute);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.floor(result.resetAt / 1000));

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
        res.setHeader('Retry-After', retryAfter);
        res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests',
          retryAfter,
        });
        return;
      }

      next();
    } catch (error) {
      this.logger.error(`Rate limit middleware error: ${error}`);
      next();
    }
  };
}

export const platformRateLimitMiddleware = new PlatformRateLimitMiddleware();
