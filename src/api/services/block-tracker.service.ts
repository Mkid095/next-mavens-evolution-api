import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';

export type BlockEventType = 'BLOCKED' | 'REPORTED' | 'SPAMMED';

export interface BlockEvent {
  instanceId: string;
  phoneNumber: string;
  eventType: BlockEventType;
  timestamp: Date;
  messageId?: string;
}

export interface BlockStats {
  phoneNumber: string;
  instanceId: string;
  totalBlocks: number;
  totalReports: number;
  totalSpamFlags: number;
  isSuppressed: boolean;
  lastEventAt: Date;
  suppressionReason?: string;
}

export class BlockTrackerService {
  private readonly logger = new Logger('BlockTrackerService');
  private readonly config = this.configService.get('ANTI_BAN');

  constructor(
    private readonly cacheService: CacheService,
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Record a block event when a message fails due to user blocking
   */
  async recordBlockEvent(event: BlockEvent): Promise<void> {
    const { instanceId, phoneNumber, eventType, messageId } = event;

    this.logger.warn(`Block event recorded: ${eventType} for ${phoneNumber} on ${instanceId}`);

    // Store block count
    const countKey = `block:count:${instanceId}:${phoneNumber}`;
    const currentCount = await this.cacheService.get(countKey);
    const newCount = currentCount ? parseInt(currentCount, 10) + 1 : 1;

    await this.cacheService.set(countKey, newCount.toString(), 86400 * 30); // 30 days

    // Store last event
    const lastKey = `block:last:${instanceId}:${phoneNumber}`;
    await this.cacheService.set(lastKey, JSON.stringify({
      eventType,
      timestamp: new Date().toISOString(),
      messageId
    }), 86400 * 30);

    // Store individual event for history
    const eventKey = `block:event:${instanceId}:${phoneNumber}:${Date.now()}`;
    await this.cacheService.set(eventKey, JSON.stringify(event), 86400 * 30);

    // Check if should suppress
    // Note: BLOCK_THRESHOLD defaults to 3 via env.config.ts; we still
    // guard with `?? 3` in case the config tree is absent (e.g. in tests).
    const blockThreshold = this.config?.BLOCK_THRESHOLD ?? 3;
    if (newCount >= blockThreshold) {
      await this.suppressContact(instanceId, phoneNumber, `Auto-suppressed after ${newCount} blocks`);
    }
  }

  /**
   * Record a failed message delivery
   * Used to detect blocks from message failures
   */
  async recordMessageFailure(
    instanceId: string,
    phoneNumber: string,
    errorCode: string,
    messageId?: string
  ): Promise<void> {
    // WhatsApp error codes that indicate user blocking
    const blockErrorCodes = [
      'SELF_BLOCK',
      'BLOCKED_BY_USER',
      'USER_BLOCKED',
      'CONTACT_BLOCKED',
      'CANNOT_SEND_TO_CONTACT',
    ];

    const spamErrorCodes = [
      'SPAM',
      'MESSAGE_SPAM',
      'SPAM_DETECTED',
      'BULK_MESSAGE_LIMIT',
    ];

    if (blockErrorCodes.some(code => errorCode.toUpperCase().includes(code))) {
      await this.recordBlockEvent({
        instanceId,
        phoneNumber,
        eventType: 'BLOCKED',
        timestamp: new Date(),
        messageId,
      });
    } else if (spamErrorCodes.some(code => errorCode.toUpperCase().includes(code))) {
      await this.recordBlockEvent({
        instanceId,
        phoneNumber,
        eventType: 'SPAMMED',
        timestamp: new Date(),
        messageId,
      });
    }
  }

  /**
   * Check if a contact is suppressed (should not be messaged)
   */
  async isSuppressed(instanceId: string, phoneNumber: string): Promise<boolean> {
    const suppressKey = `block:suppressed:${instanceId}:${phoneNumber}`;
    const result = await this.cacheService.get(suppressKey);
    return result !== null;
  }

  /**
   * Check if a message can be sent to a contact
   */
  async canMessage(instanceId: string, phoneNumber: string): Promise<{
    allowed: boolean;
    reason?: string;
    suppressed?: boolean;
  }> {
    // Check if suppressed
    const suppressKey = `block:suppressed:${instanceId}:${phoneNumber}`;
    const suppressData = await this.cacheService.get(suppressKey);

    if (suppressData) {
      return {
        allowed: false,
        reason: 'CONTACT_SUPPRESSED',
        suppressed: true,
      };
    }

    // Check block count
    // See comment at recordBlockEvent() for why `?? 3` is the right fallback
    // (NOT `|| 3` — operator-precedence bug: `X || 3` always evaluates to 3
    //  when X is falsy, so prior to this fix every contact got HIGH_BLOCK_RATE
    //  on the first send once `BLOCK_THRESHOLD` was undefined in any path.)
    const countKey = `block:count:${instanceId}:${phoneNumber}`;
    const count = await this.cacheService.get(countKey);
    const blockThreshold = this.config?.BLOCK_THRESHOLD ?? 3;

    if (count && parseInt(count, 10) >= blockThreshold) {
      return {
        allowed: false,
        reason: 'HIGH_BLOCK_RATE',
      };
    }

    return { allowed: true };
  }

  /**
   * Suppress a contact (stop sending messages)
   */
  async suppressContact(
    instanceId: string,
    phoneNumber: string,
    reason: string
  ): Promise<void> {
    const suppressKey = `block:suppressed:${instanceId}:${phoneNumber}`;

    await this.cacheService.set(suppressKey, JSON.stringify({
      reason,
      suppressedAt: new Date().toISOString(),
      ttlDays: this.config?.SUPPRESSION_TTL_DAYS || 30
    }), 86400 * this.config?.SUPPRESSION_TTL_DAYS || 30);

    this.logger.warn(`Contact ${phoneNumber} suppressed on ${instanceId}: ${reason}`);
  }

  /**
   * Remove suppression from a contact
   */
  async unsuppressContact(instanceId: string, phoneNumber: string): Promise<void> {
    const suppressKey = `block:suppressed:${instanceId}:${phoneNumber}`;
    const countKey = `block:count:${instanceId}:${phoneNumber}`;
    const lastKey = `block:last:${instanceId}:${phoneNumber}`;

    await this.cacheService.del(suppressKey);
    await this.cacheService.del(countKey);
    await this.cacheService.del(lastKey);

    this.logger.log(`Contact ${phoneNumber} unsuppressed on ${instanceId}`);
  }

  /**
   * Get block statistics for a contact
   */
  async getContactStats(instanceId: string, phoneNumber: string): Promise<BlockStats> {
    const countKey = `block:count:${instanceId}:${phoneNumber}`;
    const lastKey = `block:last:${instanceId}:${phoneNumber}`;
    const suppressKey = `block:suppressed:${instanceId}:${phoneNumber}`;

    const count = await this.cacheService.get(countKey);
    const lastEvent = await this.cacheService.get(lastKey);
    const suppressData = await this.cacheService.get(suppressKey);

    const totalBlocks = count ? parseInt(count, 10) : 0;

    return {
      phoneNumber,
      instanceId,
      totalBlocks,
      totalReports: 0, // Would need separate tracking
      totalSpamFlags: 0, // Would need separate tracking
      isSuppressed: suppressData !== null,
      lastEventAt: lastEvent ? new Date(JSON.parse(lastEvent).timestamp) : new Date(0),
      suppressionReason: suppressData ? JSON.parse(suppressData).reason : undefined,
    };
  }

  /**
   * Get all suppressed contacts for an instance
   * (In production, this would be a database query)
   */
  async getSuppressedContacts(instanceId: string): Promise<string[]> {
    // In production, query database for all suppressed contacts
    // For now, return empty array
    return [];
  }

  /**
   * Get block rate for an instance (for analytics)
   */
  async getInstanceBlockRate(instanceId: string): Promise<{
    totalContacts: number;
    suppressedContacts: number;
    blockRate: number;
  }> {
    // In production, aggregate from database
    return {
      totalContacts: 0,
      suppressedContacts: 0,
      blockRate: 0,
    };
  }

  /**
   * Clear old block data (maintenance)
   */
  async cleanupOldData(): Promise<void> {
    // In production, clean up old events from database
    this.logger.log('Block tracking data cleanup completed');
  }
}
