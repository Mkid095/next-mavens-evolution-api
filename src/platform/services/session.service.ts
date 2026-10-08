import { Logger } from '@config/logger.config';
import * as crypto from 'crypto';
import { createClient, RedisClientType } from 'redis';

/**
 * Session data stored in Redis.
 */
export interface SessionData {
  userId: string;
  accountId: string;
  expiresAt: number; // Unix ms timestamp
}

/**
 * SessionService — Redis-backed session store with in-memory Map fallback.
 *
 * Redis key format:  fidscript:session:<sessionId>
 * TTL: 24 hours (86400 seconds)
 *
 * If Redis is unavailable, falls back to an in-memory Map.
 * Sessions are never persisted across restarts when using the fallback.
 */
export class SessionService {
  private readonly logger = new Logger('SessionService');
  private redis: RedisClientType | null = null;
  private memoryStore = new Map<string, SessionData>();
  private useMemory = false;
  private sessionTTL = 86400; // 24h in seconds

  constructor() {
    this.initRedis();
  }

  private async initRedis(): Promise<void> {
    try {
      // Use the same Redis instance that platform-api uses
      const redisUrl = process.env.CACHE_REDIS_URI || 'redis://fidscript_redis:6379/6';
      this.redis = createClient({ url: redisUrl });
      this.redis.on('error', (err) => {
        this.logger.warn(`Redis session client error: ${err.message}`);
      });
      this.redis.on('connect', () => {
        this.logger.debug('Redis session client connected');
      });
      await this.redis.connect();
      this.useMemory = false;
      this.logger.info('Session service: using Redis backend');
    } catch (err) {
      this.logger.warn(`Redis session unavailable, falling back to in-memory store: ${err}`);
      this.useMemory = true;
    }
  }

  /**
   * Create a new session for a user.
   * Returns the session ID (32 hex chars).
   */
  public async createSession(userId: string, accountId: string): Promise<string> {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + this.sessionTTL * 1000;
    const data: SessionData = { userId, accountId, expiresAt };

    if (this.useMemory) {
      this.memoryStore.set(sessionId, data);
    } else {
      await this.redis!.setEx(`fidscript:session:${sessionId}`, this.sessionTTL, JSON.stringify(data));
    }

    this.logger.debug(`Session created for user ${userId}, expires ${new Date(expiresAt).toISOString()}`);
    return sessionId;
  }

  /**
   * Validate a session ID.
   * Returns SessionData if valid and not expired, null otherwise.
   */
  public async validateSession(sessionId: string): Promise<SessionData | null> {
    if (!sessionId || sessionId.length !== 32) {
      return null;
    }

    if (this.useMemory) {
      const data = this.memoryStore.get(sessionId);
      if (!data) return null;
      if (Date.now() > data.expiresAt) {
        this.memoryStore.delete(sessionId);
        return null;
      }
      return data;
    }

    try {
      const raw = await this.redis!.get(`fidscript:session:${sessionId}`);
      if (!raw) return null;
      const data = JSON.parse(raw) as SessionData;
      if (Date.now() > data.expiresAt) {
        await this.redis!.del(`fidscript:session:${sessionId}`);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Destroy a session (logout).
   */
  public async destroySession(sessionId: string): Promise<void> {
    if (this.useMemory) {
      this.memoryStore.delete(sessionId);
    } else {
      await this.redis!.del(`fidscript:session:${sessionId}`);
    }
    this.logger.debug(`Session destroyed: ${sessionId.substring(0, 8)}...`);
  }

  /**
   * Extend a session's expiry by another full TTL.
   */
  public async refreshSession(sessionId: string): Promise<boolean> {
    const data = await this.validateSession(sessionId);
    if (!data) return false;

    data.expiresAt = Date.now() + this.sessionTTL * 1000;

    if (this.useMemory) {
      this.memoryStore.set(sessionId, data);
    } else {
      await this.redis!.setEx(`fidscript:session:${sessionId}`, this.sessionTTL, JSON.stringify(data));
    }
    return true;
  }
}
