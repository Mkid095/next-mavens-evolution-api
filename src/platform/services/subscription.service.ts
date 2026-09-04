import crypto from 'crypto';
import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

/**
 * Subscription Service
 * Plan and subscription management.
 */
export class SubscriptionService {
  private readonly logger = new Logger('SubscriptionService');

  /**
   * Get the active subscription for an account (trial counts as active for Phase 1).
   */
  public async getActiveSubscription(accountId: string) {
    return platformRepository.platformSubscription.findFirst({
      where: { accountId, status: { in: ['active', 'trial'] } },
      include: { plan: true },
    });
  }

  /**
   * Get plan by ID.
   */
  public async getPlan(planId: string) {
    return platformRepository.platformPlan.findUnique({ where: { id: planId } });
  }

  /**
   * Get plan by name.
   */
  public async getPlanByName(name: string) {
    return platformRepository.platformPlan.findFirst({ where: { name } });
  }

  /**
   * List all available plans.
   */
  public async listPlans() {
    return platformRepository.platformPlan.findMany();
  }

  /**
   * Create a new subscription for an account.
   */
  public async createSubscription(
    accountId: string,
    planId: string,
    status: 'trial' | 'active' | 'past_due' = 'trial',
  ) {
    const endsAt = status === 'trial' ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) : null;

    return platformRepository.platformSubscription.create({
      data: {
        publicId: `sub_${crypto.randomBytes(8).toString('hex')}`,
        accountId,
        planId,
        status,
        startedAt: new Date(),
        endsAt,
      },
    });
  }

  /**
   * Cancel a subscription.
   */
  public async cancelSubscription(subscriptionId: string): Promise<void> {
    await platformRepository.platformSubscription.update({
      where: { id: subscriptionId },
      data: { status: 'canceled' },
    });
  }
}
