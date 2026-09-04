import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

/**
 * Tenant Service
 * Platform account resolution and status checks.
 */
export class TenantService {
  private readonly logger = new Logger('TenantService');

  /**
   * Load a platform account by publicId and check status.
   * Returns null if not found or not active.
   */
  public async resolveAccount(
    publicId: string,
  ): Promise<{
    accountId: string;
    publicId: string;
    status: string;
    plan: { planId: string; name: string; monthlyMessageLimit: number | null };
  } | null> {
    const account = await platformRepository.platformAccount.findUnique({
      where: { publicId },
    });

    if (!account) {
      return null;
    }

    // Get active subscription with plan (trial also counts as active for Phase 1)
    const subscription = await platformRepository.platformSubscription.findFirst({
      where: { accountId: account.id, status: { in: ['active', 'trial'] } },
      include: { plan: true },
    });

    return {
      accountId: account.id,
      publicId: account.publicId,
      status: account.status,
      plan: {
        planId: subscription?.plan.id ?? '',
        name: subscription?.plan.name ?? '',
        monthlyMessageLimit: subscription?.plan.monthlyMessageLimit ?? null,
      },
    };
  }

  /**
   * Get account by internal ID.
   */
  public async getAccountById(accountId: string) {
    return platformRepository.platformAccount.findUnique({
      where: { id: accountId },
      include: { subscriptions: { include: { plan: true } } },
    });
  }

  /**
   * Check if account is in good standing (active, not suspended).
   */
  public async isAccountActive(accountId: string): Promise<boolean> {
    const account = await platformRepository.platformAccount.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    return account?.status === 'ACTIVE' || account?.status === 'active';
  }

  /**
   * Suspend an account (admin action).
   */
  public async suspendAccount(accountId: string, reason: string): Promise<void> {
    await platformRepository.platformAccount.update({
      where: { id: accountId },
      data: { status: 'SUSPENDED' },
    });
    this.logger.warn(`Account suspended: ${accountId}, reason: ${reason}`);
  }

  /**
   * Reactivate a suspended account.
   */
  public async activateAccount(accountId: string): Promise<void> {
    await platformRepository.platformAccount.update({
      where: { id: accountId },
      data: { status: 'ACTIVE' },
    });
  }
}
