import { CacheEngine } from '@cache/cacheengine';
import { configService } from '@config/env.config';
import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';
import crypto from 'crypto';

/**
 * Idempotency Service
 * PostgreSQL is authoritative; Redis accelerates fast-path lookups.
 * Scope: accountId + apiKeyId + idempotencyKey
 *
 * Three-party isolation:
 *   - accountId: prevents cross-account collision
 *   - apiKeyId:  prevents cross-API-key collision within same account
 *   - idempotencyKey: client-supplied deduplication key
 */
export class IdempotencyService {
  private readonly logger = new Logger('IdempotencyService');
  private readonly redis: CacheEngine;

  constructor() {
    this.redis = new CacheEngine(configService, 'idempotency');
  }

  /**
   * Hash the canonical representation of a request for comparison.
   */
  public hashRequest(method: string, path: string, body: unknown): string {
    return crypto
      .createHash('sha256')
      .update(`${method}:${path}:${JSON.stringify(body ?? {})}`)
      .digest('hex');
  }

  /**
   * Build the scoped Redis cache key.
   */
  private scopedRedisKey(accountId: string, apiKeyId: string, idempotencyKey: string): string {
    return `idempotency:${accountId}:${apiKeyId}:${idempotencyKey}`;
  }

  /**
   * Check idempotency for a given scoped key + request hash.
   *
   * Returns:
   *   COMPLETED + cachedResponse  — same key+hash, return cached response (replay)
   *   CONFLICT                 — same key but DIFFERENT hash
   *   PROCESSING               — another request with same key is in flight
   *   NOT_FOUND                — no record for this scope
   */
  public async checkIdempotency(
    accountId: string,
    apiKeyId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{
    status: 'PROCESSING' | 'COMPLETED' | 'CONFLICT' | 'NOT_FOUND';
    cachedResponse?: unknown;
    resourceId?: string;
  }> {
    const redisKey = this.scopedRedisKey(accountId, apiKeyId, idempotencyKey);

    // Check Redis cache first (fast path)
    try {
      const engine = this.redis.getEngine();
      const cached = await engine.get(redisKey);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (parsed.status === 'COMPLETED' && parsed.requestHash === requestHash) {
          return { status: 'COMPLETED', cachedResponse: parsed.response, resourceId: parsed.resourceId };
        }
        if (parsed.status === 'COMPLETED' && parsed.requestHash !== requestHash) {
          return { status: 'CONFLICT' };
        }
        if (parsed.status === 'PROCESSING') {
          return { status: 'PROCESSING' };
        }
      }
    } catch (error) {
      this.logger.warn(`Redis cache read error for ${redisKey}: ${error}`);
      // Fall through to PostgreSQL
    }

    // Check PostgreSQL authoritative record (scoped by accountId + apiKeyId + idempotencyKey)
    const record = await platformRepository.platformIdempotencyRecord.findFirst({
      where: { accountId, apiKeyId, idempotencyKey },
    });

    if (record) {
      if (record.status === 'COMPLETED' && record.requestHash === requestHash) {
        // Re-cache in Redis for fast subsequent lookups
        try {
          const engine = this.redis.getEngine();
          engine.set(redisKey, JSON.stringify({ status: 'COMPLETED', requestHash, response: record.response, resourceId: record.resourceId }), 3600);
        } catch { /* ignore */ }
        return { status: 'COMPLETED', cachedResponse: record.response, resourceId: record.resourceId ?? undefined };
      }
      if (record.status === 'COMPLETED' && record.requestHash !== requestHash) {
        return { status: 'CONFLICT' };
      }
      if (record.status === 'PROCESSING') {
        return { status: 'PROCESSING' };
      }
    }

    return { status: 'NOT_FOUND' };
  }

  /**
   * Mark an idempotency key as PROCESSING.
   * Called before the actual operation executes.
   */
  public async markProcessing(
    accountId: string,
    apiKeyId: string,
    idempotencyKey: string,
    requestHash: string,
    method: string,
    path: string,
  ): Promise<void> {
    const redisKey = this.scopedRedisKey(accountId, apiKeyId, idempotencyKey);

    try {
      const engine = this.redis.getEngine();
      engine.set(redisKey, JSON.stringify({ status: 'PROCESSING', requestHash }), 300);
    } catch { /* ignore */ }

    // PostgreSQL: upsert with full scope (accountId + apiKeyId + idempotencyKey)
    // Uses the unique constraint to ensure atomic insert/update
    await platformRepository.platformIdempotencyRecord.upsert({
      where: { accountId_apiKeyId_idempotencyKey: { accountId, apiKeyId, idempotencyKey } },
      create: {
        accountId,
        apiKeyId,
        idempotencyKey,
        requestHash,
        method,
        path,
        status: 'PROCESSING',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      update: {
        status: 'PROCESSING',
        requestHash,
        method,
        path,
      },
    });
  }

  /**
   * Mark an idempotency key as COMPLETED with the response.
   */
  public async markCompleted(
    accountId: string,
    apiKeyId: string,
    idempotencyKey: string,
    responseBody: unknown,
    resourceId?: string,
  ): Promise<void> {
    const redisKey = this.scopedRedisKey(accountId, apiKeyId, idempotencyKey);

    try {
      const engine = this.redis.getEngine();
      engine.set(redisKey, JSON.stringify({ status: 'COMPLETED', response: responseBody, resourceId }), 3600);
    } catch { /* ignore */ }

    await platformRepository.platformIdempotencyRecord.update({
      where: { accountId_apiKeyId_idempotencyKey: { accountId, apiKeyId, idempotencyKey } },
      data: { status: 'COMPLETED', response: responseBody as object, resourceId },
    });
  }

  /**
   * Clean up stale PROCESSING records older than 1 hour.
   */
  public async cleanupStaleRecords(): Promise<void> {
    const staleThreshold = new Date(Date.now() - 60 * 60 * 1000);
    await platformRepository.platformIdempotencyRecord.updateMany({
      where: { status: 'PROCESSING', createdAt: { lt: staleThreshold } },
      data: { status: 'EXPIRED' },
    });
  }
}
