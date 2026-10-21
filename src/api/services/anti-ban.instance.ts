import { CacheEngine } from '@cache/cacheengine';
import { configService } from '@config/env.config';

import { PrismaRepository } from '../repository/repository.service';
import { AntiBanService } from './anti-ban.service';
import { BlockTrackerService } from './block-tracker.service';
import { CacheService } from './cache.service';
import { QualityMonitorService } from './quality-monitor.service';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Shared anti-ban stack (rate limiter + quality monitor + block tracker).
 *
 * It lives in its own leaf module — NOT in `api/server.module` — so that the
 * platform module can use it without closing an import cycle:
 *
 *   api/server.module -> @exceptions -> api/routes/index.router -> platform.module
 *
 * The cache namespace is the same one the API module uses ('instance'), so the
 * platform worker and the legacy API path share the very same rate-limit,
 * burst and suppression state.
 */
const cache = new CacheService(new CacheEngine(configService, 'instance').getEngine());
const prismaRepository = new PrismaRepository(configService);

const rateLimiterService = new RateLimiterService(cache, prismaRepository, configService);
const qualityMonitorService = new QualityMonitorService(cache, prismaRepository, configService);
const blockTrackerService = new BlockTrackerService(cache, prismaRepository, configService);

export const antiBanService = new AntiBanService(
  rateLimiterService,
  qualityMonitorService,
  blockTrackerService,
  cache,
  configService,
);

export { blockTrackerService, qualityMonitorService, rateLimiterService };
