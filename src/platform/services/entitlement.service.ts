import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

/**
 * Entitlement Service
 * Checks whether an account is allowed to perform operations based on their plan.
 */
export class EntitlementService {
  private readonly logger = new Logger('EntitlementService');

  /**
   * Check if an account has a specific feature enabled on their plan.
   */
  public async hasFeature(accountId: string, feature: string): Promise<boolean> {
    const subscription = await platformRepository.platformSubscription.findFirst({
      where: { accountId, status: { in: ['active', 'trial'] } },
      include: { plan: true },
    });
    if (!subscription) return false;
    const features = (subscription.plan as Record<string, boolean>) ?? {};
    return features[feature] === true;
  }

  /**
   * Check if the account is within their monthly message limit.
   */
  public async checkMessageLimit(accountId: string): Promise<{ allowed: boolean; current: number; limit: number }> {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const usage = await platformRepository.platformUsageRecord.findFirst({
      where: {
        accountId,
        operation: 'messages',
        periodStart: { lte: now },
      },
      orderBy: { periodStart: 'desc' },
    });

    const subscription = await platformRepository.platformSubscription.findFirst({
      where: { accountId, status: { in: ['active', 'trial'] } },
      include: { plan: true },
    });

    if (!subscription) return { allowed: false, current: 0, limit: 0 };

    const monthlyLimit = (subscription.plan as { monthlyMessageLimit?: number })?.monthlyMessageLimit ?? 0;
    const current = usage?.quantity ?? 0;
    return { allowed: current < monthlyLimit, current, limit: monthlyLimit };
  }

  /**
   * Get all plan limits for an account.
   */
  public async getPlanLimits(accountId: string): Promise<Record<string, number | string>> {
    const subscription = await platformRepository.platformSubscription.findFirst({
      where: { accountId, status: { in: ['active', 'trial'] } },
      include: { plan: true },
    });
    if (!subscription) return {};
    const plan = subscription.plan as { monthlyMessageLimit?: number };
    return { monthlyMessageLimit: plan.monthlyMessageLimit ?? 0 };
  }
}
