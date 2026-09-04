import { RateLimiterService, RateLimitResult } from './rate-limiter.service';
import { QualityMonitorService, QualityScore } from './quality-monitor.service';
import { BlockTrackerService } from './block-tracker.service';
import { CacheService } from '@api/services/cache.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';

export interface AntiBanCheckResult {
  allowed: boolean;
  reason?: string;
  checks: {
    rateLimit: RateLimitResult;
    templateQuality: { allowed: boolean; reason?: string };
    blockStatus: { allowed: boolean; suppressed?: boolean; reason?: string };
  };
  retryAfterMs?: number;
}

export interface AccountHealth {
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  issues: string[];
  rateLimitStatus: {
    messagesPerSecond: number;
    limit: number;
    available: number;
  };
  qualityAlerts: number;
  suppressedContacts: number;
  lastChecked: Date;
}

export class AntiBanService {
  private readonly logger = new Logger('AntiBanService');

  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly qualityMonitor: QualityMonitorService,
    private readonly blockTracker: BlockTrackerService,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Comprehensive anti-ban check before sending any message
   * This is the main entry point for the anti-ban system
   */
  async canSendMessage(
    instanceId: string,
    phoneNumber: string,
    templateName?: string
  ): Promise<AntiBanCheckResult> {
    const checks = {
      rateLimit: { allowed: true } as RateLimitResult,
      templateQuality: { allowed: true },
      blockStatus: { allowed: true },
    };

    // 1. Check rate limits
    const rateLimitResult = await this.rateLimiter.canSendMessage(instanceId, phoneNumber);
    checks.rateLimit = rateLimitResult;

    if (!rateLimitResult.allowed) {
      return {
        allowed: false,
        reason: rateLimitResult.reason,
        checks,
        retryAfterMs: rateLimitResult.retryAfterMs,
      };
    }

    // 2. Check block status
    const blockResult = await this.blockTracker.canMessage(instanceId, phoneNumber);
    checks.blockStatus = blockResult;

    if (!blockResult.allowed) {
      return {
        allowed: false,
        reason: blockResult.reason,
        checks,
      };
    }

    // 3. Check template quality (if template is specified)
    if (templateName) {
      const qualityResult = await this.qualityMonitor.canUseTemplate(templateName);
      checks.templateQuality = qualityResult;

      if (!qualityResult.allowed) {
        return {
          allowed: false,
          reason: qualityResult.reason,
          checks,
        };
      }
    }

    return {
      allowed: true,
      reason: 'ALL_CHECKS_PASSED',
      checks,
    };
  }

  /**
   * Record that a message was sent successfully
   */
  async recordSend(instanceId: string, phoneNumber: string): Promise<void> {
    await this.rateLimiter.recordSend(instanceId, phoneNumber);
  }

  /**
   * Record a message delivery failure
   */
  async recordDeliveryFailure(
    instanceId: string,
    phoneNumber: string,
    errorCode: string,
    messageId?: string
  ): Promise<void> {
    // Let block tracker analyze the error
    await this.blockTracker.recordMessageFailure(instanceId, phoneNumber, errorCode, messageId);
  }

  /**
   * Handle incoming webhook for template quality updates
   */
  async handleQualityWebhook(payload: {
    templateName: string;
    previousScore: QualityScore;
    newScore: QualityScore;
    templateId: number;
    language: string;
  }): Promise<void> {
    await this.qualityMonitor.handleQualityUpdate({
      ...payload,
      timestamp: new Date(),
    });
  }

  /**
   * Get overall account health status
   */
  async getAccountHealth(instanceId?: string): Promise<AccountHealth> {
    const issues: string[] = [];
    let status: AccountHealth['status'] = 'HEALTHY';

    // Get rate limit configuration
    const rateLimitConfig = this.rateLimiter.getConfig();

    // Check for quality alerts (would query database in production)
    const qualityAlerts = 0; // Would come from database

    if (qualityAlerts > 0) {
      issues.push(`${qualityAlerts} template(s) with quality warnings`);
      status = 'WARNING';
    }

    // Check suppressed contacts count
    const suppressedCount = instanceId
      ? (await this.blockTracker.getSuppressedContacts(instanceId)).length
      : 0;

    if (suppressedCount > 10) {
      issues.push(`${suppressedCount} suppressed contacts`);
      status = 'WARNING';
    }

    if (suppressedCount > 50) {
      issues.push(`High suppression rate: ${suppressedCount} contacts`);
      status = 'CRITICAL';
    }

    return {
      status,
      issues,
      rateLimitStatus: {
        messagesPerSecond: rateLimitConfig.globalThroughput,
        limit: rateLimitConfig.globalThroughput,
        available: rateLimitConfig.globalThroughput,
      },
      qualityAlerts,
      suppressedContacts: suppressedCount,
      lastChecked: new Date(),
    };
  }

  /**
   * Get rate limit information for API response
   */
  async getRateLimitInfo(instanceId: string, phoneNumber: string): Promise<{
    contactStatus: {
      lastSendAt: number | null;
      messagesInLastHour: number;
      canSend: boolean;
      nextSendIn: number | null;
    };
    config: {
      contactLimitMs: number;
      contactHourlyLimit: number;
      burstLimit: number;
    };
  }> {
    const contactStatus = await this.rateLimiter.getContactStatus(instanceId, phoneNumber);
    const config = this.rateLimiter.getConfig();

    return {
      contactStatus,
      config: {
        contactLimitMs: config.contactLimitMs,
        contactHourlyLimit: config.contactHourlyLimit,
        burstLimit: config.burstLimit,
      },
    };
  }

  /**
   * Manually pause a template
   */
  async pauseTemplate(templateName: string, reason?: string): Promise<void> {
    await this.qualityMonitor.pauseTemplate(templateName, reason);
  }

  /**
   * Manually resume a template
   */
  async resumeTemplate(templateName: string): Promise<void> {
    await this.qualityMonitor.resumeTemplate(templateName);
  }

  /**
   * Unsubscribe a contact (honoring opt-out)
   */
  async unsubscribeContact(instanceId: string, phoneNumber: string): Promise<void> {
    // Suppress the contact to prevent further messages
    await this.blockTracker.suppressContact(
      instanceId,
      phoneNumber,
      'User unsubscribe/opt-out'
    );

    // Also reset rate limits
    await this.rateLimiter.resetContactLimits(instanceId, phoneNumber);

    this.logger.log(`Contact ${phoneNumber} unsubscribed on ${instanceId}`);
  }

  /**
   * Re-subscribe a contact (if they opt back in)
   */
  async resubscribeContact(instanceId: string, phoneNumber: string): Promise<void> {
    await this.blockTracker.unsuppressContact(instanceId, phoneNumber);
    await this.rateLimiter.resetContactLimits(instanceId, phoneNumber);

    this.logger.log(`Contact ${phoneNumber} re-subscribed on ${instanceId}`);
  }

  /**
   * Get template status
   */
  async getTemplateStatus(templateName: string) {
    return this.qualityMonitor.getTemplateStatus(templateName);
  }

  /**
   * Get block statistics for a contact
   */
  async getContactBlockStats(instanceId: string, phoneNumber: string) {
    return this.blockTracker.getContactStats(instanceId, phoneNumber);
  }

  /**
   * Health check endpoint for monitoring
   */
  async healthCheck(): Promise<{ healthy: boolean; services: string[] }> {
    const services: string[] = [];

    try {
      // Check if rate limiter is working
      const rateLimitConfig = this.rateLimiter.getConfig();
      services.push(`RateLimiter:OK`);

      // Check cache connectivity
      await this.cacheService.get('health:check');
      services.push(`Cache:OK`);

      return { healthy: true, services };
    } catch (error) {
      this.logger.error(`Health check failed: ${error}`);
      return { healthy: false, services };
    }
  }
}
