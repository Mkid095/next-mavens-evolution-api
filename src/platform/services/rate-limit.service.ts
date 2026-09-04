import { CacheEngine } from '@cache/cacheengine';
import { configService } from '@config/env.config';
import { Logger } from '@config/logger.config';

/**
 * Rate Limit Service
 * Uses Redis sorted sets for sliding window rate limiting.
 * Key: ratelimit:{accountId}
 * Score: timestamp of each request
 * Member: {timestamp}:{random}
 */
export class RateLimitService {
  private readonly logger = new Logger('RateLimitService');
  private readonly cache: CacheEngine;

  constructor() {
    this.cache = new CacheEngine(configService, 'platform-ratelimit');
  }

  /**
   * Check if a request is within the rate limit.
   * Uses sliding window: removes old entries outside the window, counts remaining.
   */
  public async checkLimit(
    accountId: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const key = `ratelimit:${accountId}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      const redis = this.cache.getRawRedis();
      if (!redis) {
        // Redis unavailable — fail open
        return { allowed: true, remaining: limit, resetAt: now + windowMs };
      }

      // Remove entries outside the sliding window
      await redis.zRemRangeByScore(key, '0', windowStart.toString());

      // Count entries in window
      const count = await redis.zCard(key);

      if (count >= limit) {
        // Get oldest entry to calculate reset time
        const oldest = await redis.zRangeWithScores(key, '0', '0');
        const resetAt =
          oldest.length > 0
            ? Number(oldest[0].score) + windowMs
            : now + windowMs;
        return { allowed: false, remaining: 0, resetAt };
      }

      // Add new entry with current timestamp as score
      await redis.zAdd(key, { score: now, value: `${now}:${Math.random()}` });
      await redis.expire(key, Math.ceil(windowMs / 1000));

      return { allowed: true, remaining: limit - count - 1, resetAt: now + windowMs };
    } catch (error) {
      this.logger.error(`Rate limit check failed: ${error}`);
      // Fail open: allow request if Redis is unavailable
      return { allowed: true, remaining: limit, resetAt: now + windowMs };
    }
  }

  /**
   * Get current usage count for an account within the window.
   */
  public async getCurrentUsage(accountId: string, windowMs: number): Promise<number> {
    const key = `ratelimit:${accountId}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      const redis = this.cache.getRawRedis();
      if (!redis) return 0;

      await redis.zRemRangeByScore(key, '0', windowStart.toString());
      return await redis.zCard(key);
    } catch {
      return 0;
    }
  }
}
