/**
 * Redis Pub/Sub Event Controller for WhatsApp Events
 *
 * Publishes WhatsApp events to Redis Pub/Sub channels so the platform's
 * realtime gateway (fidscript-realtime) can broadcast them to connected
 * dashboard clients in real-time.
 *
 * Channel format: fidscript:whatsapp:<instanceName>.<event>
 * e.g. fidscript:whatsapp:my-instance.MESSAGES_UPSERT
 *
 * The platform's RedisEventBus subscribes to fidscript:* via pattern match,
 * so WhatsApp events flow through the same pub/sub infrastructure.
 */

import { createClient } from 'redis';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';

export class RedisEventController {
  private logger = new Logger('RedisEvent');
  private client: ReturnType<typeof createClient> | null = null;
  private prismaRepository: PrismaRepository;
  private waMonitor: WAMonitoringService;
  private redisUrl: string;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    this.prismaRepository = prismaRepository;
    this.waMonitor = waMonitor;
    const { configService } = require('@config/env.config');
    this.redisUrl = configService.get('CACHE')?.REDIS?.URI || process.env.CACHE_REDIS_URI || 'redis://localhost:6379';
  }

  public async init(): Promise<void> {
    try {
      this.client = createClient({ url: this.redisUrl });
      this.client.on('error', (err: Error) => {
        this.logger.error('Redis event client error', { error: err.message });
      });
      this.client.on('connect', () => {
        this.logger.verbose('Redis event publisher connected');
      });
      await this.client.connect();
      this.logger.info('Redis event publisher initialized', { url: this.redisUrl });
    } catch (err) {
      this.logger.error('Failed to init Redis event publisher', { error: (err as Error).message });
    }
  }

  public async emit(eventData: {
    instanceName: string;
    event: string;
    data: object;
    serverUrl: string;
    dateTime: string;
    sender: string;
    apiKey?: string;
  }): Promise<void> {
    if (!this.client || !this.client.isReady) {
      this.logger.warn('Redis client not ready, skipping publish');
      return;
    }

    try {
      // Publish to instance-specific channel and a wildcard channel for all WhatsApp events
      const channels = [
        `fidscript:whatsapp:${eventData.instanceName}.${eventData.event}`,
        'fidscript:whatsapp:*', // wildcard for future cross-instance subscribers
      ];

      // Emit as a normalized platform event structure
      const platformEvent = {
        id: `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: `whatsapp.${eventData.event.toLowerCase()}`,
        category: 'message',
        source: 'whatsapp',
        tenantId: eventData.instanceName, // WhatsApp instance as tenant context
        payload: {
          instanceName: eventData.instanceName,
          event: eventData.event,
          data: eventData.data,
          serverUrl: eventData.serverUrl,
          dateTime: eventData.dateTime,
          sender: eventData.sender,
        },
        metadata: {
          channel: 'whatsapp',
          instanceId: eventData.instanceName,
        },
        timestamp: new Date().toISOString(),
      };

      const message = JSON.stringify(platformEvent);

      // Publish to all channels in parallel
      await Promise.allSettled(
        channels.map((channel) => this.client!.publish(channel, message))
      );

      this.logger.debug('Published WhatsApp event to Redis', {
        channel: channels[0],
        event: eventData.event,
        instance: eventData.instanceName,
      });
    } catch (err) {
      this.logger.error('Failed to publish WhatsApp event to Redis', {
        error: (err as Error).message,
        event: eventData.event,
      });
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
