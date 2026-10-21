import { Logger } from '@config/logger.config';

import { platformRepository } from '../repository/platform.repository';

/**
 * Usage Service
 * Records and retrieves resource usage per account.
 */
export class UsageService {
  private readonly logger = new Logger('UsageService');

  /**
   * Record usage of a resource operation.
   *
   * `projectId` is the internal PlatformProject id (cuid) the usage is
   * scoped to — the `projectId` column is NOT NULL in the database, as
   * are the `resource` and `unit` columns.
   */
  public async recordUsage(
    accountId: string,
    operation: string,
    quantity: number,
    periodStart: Date,
    projectId: string,
  ): Promise<void> {
    const existing = await platformRepository.platformUsageRecord.findFirst({
      where: { accountId, operation, periodStart },
    });

    if (existing) {
      await platformRepository.platformUsageRecord.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + quantity },
      });
    } else {
      await platformRepository.platformUsageRecord.create({
        data: {
          accountId,
          projectId,
          operation,
          resource: 'message',
          unit: 'message',
          quantity,
          periodStart,
        },
      });
    }
  }

  /**
   * Get current usage and limit for an account/operation.
   */
  public async getCurrentUsage(accountId: string, operation: string): Promise<{ current: number; limit: number }> {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const records = await platformRepository.platformUsageRecord.findMany({
      where: { accountId, operation, periodStart: { gte: periodStart } },
    });

    const current = records.reduce((sum, r) => sum + r.quantity, 0);

    const subscription = await platformRepository.platformSubscription.findFirst({
      where: { accountId, status: { in: ['active', 'trial'] } },
      include: { plan: true },
    });

    const monthlyLimit = (subscription?.plan as { monthlyMessageLimit?: number })?.monthlyMessageLimit ?? 0;
    return { current, limit: monthlyLimit };
  }

  /**
   * Get usage breakdown by operation type for an account.
   */
  public async getUsageBreakdown(accountId: string): Promise<Record<string, { current: number; limit: number }>> {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const records = await platformRepository.platformUsageRecord.findMany({
      where: { accountId, periodStart: { gte: periodStart } },
    });

    const subscription = await platformRepository.platformSubscription.findFirst({
      where: { accountId, status: { in: ['active', 'trial'] } },
      include: { plan: true },
    });

    const monthlyLimit = (subscription?.plan as { monthlyMessageLimit?: number })?.monthlyMessageLimit ?? 0;
    const result: Record<string, { current: number; limit: number }> = {};

    for (const record of records) {
      result[record.operation] = { current: record.quantity, limit: monthlyLimit };
    }

    return result;
  }
}
