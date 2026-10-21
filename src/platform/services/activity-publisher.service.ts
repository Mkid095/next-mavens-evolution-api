import { Logger } from '@config/logger.config';
import { createClient, RedisClientType } from 'redis';

/**
 * Account-scoped activity event publisher.
 *
 * Every audit event is also pushed to a per-account Redis channel
 * so any dashboard page can subscribe via SSE and render a real-time
 * activity feed. This is the bridge from "write to DB" to "show the
 * user what just happened" without polling.
 *
 * Channel naming: fidscript:whatsapp:activity:<accountId>
 * (matches the existing fidscript:whatsapp:mcp:<accountId> convention)
 */
export interface ActivityEventPayload {
  id: string;
  kind: 'audit' | 'lifecycle' | 'system';
  action: string;
  /** The category the event belongs to (api | mcp | auth | message). */
  category?: string;
  resourceType?: string;
  resourceId?: string;
  projectId?: string;
  instancePublicId?: string;
  message: string;
  metadata?: Record<string, unknown>;
  ts: number;
}

let redisPublisher: RedisClientType | null = null;
let publisherFailed = false;

async function getRedisPublisher(): Promise<RedisClientType | null> {
  if (redisPublisher) return redisPublisher;
  if (publisherFailed) return null;
  try {
    const url = process.env.CACHE_REDIS_URI || 'redis://platform-redis:6379/6';
    const client = createClient({ url });
    client.on('error', (err) => {
      const logger = new Logger('ActivityPublisher');
      logger.warn(`Redis publisher error: ${err}`);
    });
    await client.connect();
    redisPublisher = client as RedisClientType;
    return redisPublisher;
  } catch (err) {
    publisherFailed = true;
    const logger = new Logger('ActivityPublisher');
    logger.warn(`Could not connect Redis publisher: ${err}`);
    return null;
  }
}

/**
 * Fire-and-forget event publication. Errors are logged but never
 * thrown — a Redis hiccup must not fail the originating request.
 */
export async function publishAccountEvent(accountId: string, event: ActivityEventPayload): Promise<void> {
  const publisher = await getRedisPublisher();
  if (!publisher) return;
  try {
    const channel = `fidscript:whatsapp:activity:${accountId}`;
    await publisher.publish(channel, JSON.stringify(event));
  } catch (err) {
    const logger = new Logger('ActivityPublisher');
    logger.warn(`Failed to publish activity event: ${err}`);
  }
}
