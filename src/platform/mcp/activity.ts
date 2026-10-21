import { createClient, RedisClientType } from 'redis';

/**
 * Lazily-initialized Redis publisher used to push MCP invocation
 * events to any subscribed SSE consumers (e.g. the dashboard's
 * live activity panel). We use a per-account channel so the SSE
 * endpoint can subscribe to just one tenant's stream.
 */
let redisPublisher: RedisClientType | null = null;

async function getRedisPublisher(): Promise<RedisClientType | null> {
  if (redisPublisher) return redisPublisher;
  try {
    const url = process.env.CACHE_REDIS_URI || 'redis://platform-redis:6379/6';
    const client = createClient({ url });
    client.on('error', (err) => {
      // Suppress noisy errors — the dashboard will fall back to polling
      // if Redis pub/sub is unavailable.
      console.warn('[MCP] Redis publisher error:', err);
    });
    await client.connect();
    redisPublisher = client as RedisClientType;
    return redisPublisher;
  } catch (err) {
    console.warn('[MCP] Could not connect Redis publisher:', err);
    return null;
  }
}

/** The Redis channel a tenant's MCP activity is published on. */
export function mcpEventChannel(accountId: string): string {
  return `fidscript:whatsapp:mcp:${accountId}`;
}

/**
 * Publish one MCP invocation event.
 *
 * Used by both entry points (the legacy /invoke endpoint and the standard
 * MCP transport) so the dashboard's activity feed shows every tool call,
 * whichever way it arrived.
 */
export async function publishMcpEvent(
  accountId: string,
  event: {
    tool: string;
    status: 'ok' | 'error';
    latencyMs?: number;
    error?: string;
    parameters?: Record<string, unknown>;
  },
): Promise<void> {
  const publisher = await getRedisPublisher();
  if (!publisher) return;
  try {
    await publisher.publish(mcpEventChannel(accountId), JSON.stringify({ ...event, ts: Date.now() }));
  } catch {
    /* swallow — never fail a request just because the event bus hiccupped */
  }
}
