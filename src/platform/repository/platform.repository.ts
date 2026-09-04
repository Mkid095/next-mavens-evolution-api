import { PrismaClient } from '@prisma/client';
import { Logger } from '@config/logger.config';

/**
 * Platform Repository
 * Shared Prisma client for platform models (Phase 1 infrastructure).
 * Uses the same PrismaClient pool as Evolution - single database connection.
 */
export class PlatformRepository extends PrismaClient {
  constructor() {
    super();
  }

  private readonly logger = new Logger('PlatformRepository');

  public async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.info('PlatformRepository: Prisma - ON');
  }

  public async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.warn('PlatformRepository: Prisma - OFF');
  }
}

export const platformRepository = new PlatformRepository();
