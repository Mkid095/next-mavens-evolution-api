import { CacheService } from '@api/services/cache.service';
import { PrismaRepository } from '@api/repository/repository.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
  currentCount?: number;
  limit?: number;
}

export interface RateLimitConfig {
  contactLimitMs: number;
  contactHourlyLimit: number;
  burstLimit: number;
  globalThroughput: number;
}

export class RateLimiterService {
  private readonly logger = new Logger('RateLimiterService');
  private readonly config: RateLimitConfig;

  constructor(
    private readonly cacheService: CacheService,
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {
    this.config = this.loadConfig();
  }

  private loadConfig(): RateLimitConfig {
    const antiBan = this.configService.get('ANTI_BAN');
    return {
      contactLimitMs: antiBan?.RATE_LIMIT_CONTACT_MS || 6000, // WhatsApp's 6-second rule
      contactHourlyLimit: antiBan?.RATE_LIMIT_CONTACT_HOURLY || 600, // Max 600 messages per contact per hour
      burstLimit: antiBan?.RATE_LIMIT_BURST || 45, // Max 45 messages in burst window
      globalThroughput: antiBan?.RATE_LIMIT_GLOBAL_THROUGHPUT || 100, // Messages per second
    };
  }

  /**
   * Check if a message can be sent to a specific contact
   * Enforces WhatsApp's 6-second rule per contact
   */
  async canSendToContact(instanceId: string, phoneNumber: string): Promise<RateLimitResult> {
    const key = `ratelimit:contact:${instanceId}:${phoneNumber}`;

    try {
      const lastSend = await this.cacheService.get(key);
      const countKey = `ratelimit:count:${instanceId}:${phoneNumber}`;

      if (lastSend) {
        const timeSinceLastSend = Date.now() - parseInt(lastSend, 10);

        if (timeSinceLastSend < this.config.contactLimitMs) {
          return {
            allowed: false,
            reason: 'RATE_LIMIT_CONTACT',
            retryAfterMs: this.config.contactLimitMs - timeSinceLastSend,
          };
        }
      }

      // Check hourly limit
      const hourlyCount = await this.cacheService.get(countKey);
      if (hourlyCount && parseInt(hourlyCount, 10) >= this.config.contactHourlyLimit) {
        return {
          allowed: false,
          reason: 'RATE_LIMIT_HOURLY_EXCEEDED',
          retryAfterMs: 3600000, // Wait for hour window to reset
        };
      }

      return {
        allowed: true,
        currentCount: hourlyCount ? parseInt(hourlyCount, 10) : 0,
        limit: this.config.contactHourlyLimit,
      };
    } catch (error) {
      this.logger.error(`Error checking contact rate limit: ${error}`);
      // On error, allow the message (fail open)
      return { allowed: true };
    }
  }

  /**
   * Record a message send for rate limiting purposes
   */
  async recordSend(instanceId: string, phoneNumber: string): Promise<void> {
    const key = `ratelimit:contact:${instanceId}:${phoneNumber}`;
    const countKey = `ratelimit:count:${instanceId}:${phoneNumber}`;

    try {
      // Record exact send time
      await this.cacheService.set(key, Date.now().toString(), 60); // TTL 60 seconds

      // Increment hourly counter
      const currentCount = await this.cacheService.get(countKey);
      const newCount = currentCount ? parseInt(currentCount, 10) + 1 : 1;
      await this.cacheService.set(countKey, newCount.toString(), 3600); // TTL 1 hour
    } catch (error) {
      this.logger.error(`Error recording send: ${error}`);
    }
  }

  /**
   * Check global throughput limit for an instance
   * Enforces messages-per-second limit
   */
  async checkGlobalThroughput(instanceId: string): Promise<RateLimitResult> {
    const key = `ratelimit:global:${instanceId}`;

    try {
      const current = await this.cacheService.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= this.config.globalThroughput) {
        return {
          allowed: false,
          reason: 'RATE_LIMIT_GLOBAL_THROUGHPUT',
          retryAfterMs: 1000,
        };
      }

      // Increment counter
      await this.cacheService.set(key, (count + 1).toString(), 1); // TTL 1 second

      return {
        allowed: true,
        currentCount: count + 1,
        limit: this.config.globalThroughput,
      };
    } catch (error) {
      this.logger.error(`Error checking global throughput: ${error}`);
      return { allowed: true };
    }
  }

  /**
   * Check burst limit - WhatsApp allows burst of up to 45 messages in 6 seconds
   */
  async checkBurstLimit(instanceId: string, phoneNumber: string): Promise<RateLimitResult> {
    const key = `ratelimit:burst:${instanceId}:${phoneNumber}`;

    try {
      const current = await this.cacheService.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= this.config.burstLimit) {
        const ttl = await this.cacheService.getTtl(key);
        return {
          allowed: false,
          reason: 'RATE_LIMIT_BURST_EXCEEDED',
          retryAfterMs: ttl ? ttl * 1000 : 6000,
        };
      }

      // Increment burst counter
      const newCount = count + 1;
      if (newCount === 1) {
        await this.cacheService.set(key, newCount.toString(), 6); // TTL 6 seconds
      } else {
        // Update existing key
        const existingTtl = await this.cacheService.getTtl(key);
        if (existingTtl && existingTtl > 0) {
          await this.cacheService.set(key, newCount.toString(), existingTtl);
        }
      }

      return {
        allowed: true,
        currentCount: newCount,
        limit: this.config.burstLimit,
      };
    } catch (error) {
      this.logger.error(`Error checking burst limit: ${error}`);
      return { allowed: true };
    }
  }

  /**
   * Comprehensive rate limit check before sending a message
   */
  async canSendMessage(instanceId: string, phoneNumber: string): Promise<RateLimitResult> {
    // Check all rate limit rules
    const contactCheck = await this.canSendToContact(instanceId, phoneNumber);
    if (!contactCheck.allowed) {
      return contactCheck;
    }

    const burstCheck = await this.checkBurstLimit(instanceId, phoneNumber);
    if (!burstCheck.allowed) {
      return burstCheck;
    }

    const globalCheck = await this.checkGlobalThroughput(instanceId);
    if (!globalCheck.allowed) {
      return globalCheck;
    }

    return {
      allowed: true,
      reason: 'ALL_CHECKS_PASSED',
    };
  }

  /**
   * Get current rate limit status for a contact
   */
  async getContactStatus(instanceId: string, phoneNumber: string): Promise<{
    lastSendAt: number | null;
    messagesInLastHour: number;
    canSend: boolean;
    nextSendIn: number | null;
  }> {
    const key = `ratelimit:contact:${instanceId}:${phoneNumber}`;
    const countKey = `ratelimit:count:${instanceId}:${phoneNumber}`;

    const lastSend = await this.cacheService.get(key);
    const count = await this.cacheService.get(countKey);

    const lastSendAt = lastSend ? parseInt(lastSend, 10) : null;
    const messagesInLastHour = count ? parseInt(count, 10) : 0;

    let nextSendIn: number | null = null;
    if (lastSendAt) {
      const timeSinceLastSend = Date.now() - lastSendAt;
      if (timeSinceLastSend < this.config.contactLimitMs) {
        nextSendIn = this.config.contactLimitMs - timeSinceLastSend;
      }
    }

    return {
      lastSendAt,
      messagesInLastHour,
      canSend: messagesInLastHour < this.config.contactHourlyLimit && (nextSendIn === null || nextSendIn === 0),
      nextSendIn,
    };
  }

  /**
   * Reset rate limits for a contact (e.g., after cooling off period)
   */
  async resetContactLimits(instanceId: string, phoneNumber: string): Promise<void> {
    const key = `ratelimit:contact:${instanceId}:${phoneNumber}`;
    const countKey = `ratelimit:count:${instanceId}:${phoneNumber}`;
    const burstKey = `ratelimit:burst:${instanceId}:${phoneNumber}`;

    await this.cacheService.del(key);
    await this.cacheService.del(countKey);
    await this.cacheService.del(burstKey);

    this.logger.log(`Reset rate limits for ${phoneNumber} on instance ${instanceId}`);
  }

  /**
   * Get global rate limit configuration
   */
  getConfig(): RateLimitConfig {
    return { ...this.config };
  }
}
