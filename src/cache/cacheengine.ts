import { ICache } from '@api/abstract/abstract.cache';
import { CacheConf, ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { RedisClientType } from 'redis';

import { LocalCache } from './localcache';
import { RedisCache } from './rediscache';
import { redisClient } from './rediscache.client';

const logger = new Logger('CacheEngine');

export class CacheEngine {
  private engine: ICache;

  constructor(
    private readonly configService: ConfigService,
    module: string,
  ) {
    const cacheConf = configService.get<CacheConf>('CACHE');

    if (cacheConf?.REDIS?.ENABLED && cacheConf?.REDIS?.URI !== '') {
      logger.verbose(`RedisCache initialized for ${module}`);
      this.engine = new RedisCache(configService, module);
    } else if (cacheConf?.LOCAL?.ENABLED) {
      logger.verbose(`LocalCache initialized for ${module}`);
      this.engine = new LocalCache(configService, module);
    }
  }

  public getEngine(): ICache {
    return this.engine;
  }

  /**
   * Access the raw Redis client for operations not in ICache
   * (e.g., sorted sets for sliding window rate limiting).
   */
  public getRawRedis(): RedisClientType | null {
    return redisClient.getConnection();
  }
}
