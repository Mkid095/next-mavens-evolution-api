import { Logger } from '@config/logger.config';

import { platformRepository } from '../repository/platform.repository';

/**
 * Sentinel for "no cap". A plan's `monthlyMessageLimit` is a ceiling, and
 * a ceiling of zero is not a real ceiling — an account with no plan, or a
 * plan without a limit, can send without restriction.
 */
export const UNLIMITED = -1;

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
    const features = (subscription.plan as unknown as Record<string, boolean>) ?? {};
    return features[feature] === true;
  }

  /**
   * Check if the account is within their monthly message limit.
   */
  public async checkMessageLimit(accountId: string): Promise<{ allowed: boolean; current: number; limit: number }> {
    const now = new Date();

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

    if (!subscription) {
      // No plan means no cap. The platform is an internal, free service —
      // a plan is a safety valve, not a billing gate, so an account
      // without one must not be locked out.
      return { allowed: true, current: usage?.quantity ?? 0, limit: UNLIMITED };
    }

    const monthlyLimit = (subscription.plan as { monthlyMessageLimit?: number })?.monthlyMessageLimit ?? 0;
    const current = usage?.quantity ?? 0;

    // A plan with no explicit limit is also uncapped. `monthlyLimit` of 0
    // here would otherwise mean "no messages at all".
    if (monthlyLimit <= 0) {
      return { allowed: true, current, limit: UNLIMITED };
    }

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
