/**
 * Lifecycle Event Worker
 * Bridges InstanceEventLog → WebhookDeliveryWorker.
 *
 * Phase 2: reads newly persisted InstanceEventLog rows, finds all webhooks
 * subscribed to that eventType, and enqueues one delivery row per
 * (webhook, eventId) pair. The delivery row carries the stable evt_xxx
 * eventId so retries reuse the same eventId across attempts.
 */

import { Logger } from '@config/logger.config';

import { platformRepository } from '../repository/platform.repository';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';

export class LifecycleEventWorker {
  private readonly logger = new Logger('LifecycleEventWorker');
  private readonly deliveryWorker: WebhookDeliveryWorker;
  private running = false;
  private pollIntervalMs = 3000;
  /** Last event timestamp seen — only events after this are processed. */
  private lastProcessedAt: Date = new Date(0);

  constructor() {
    this.deliveryWorker = new WebhookDeliveryWorker();
  }

  // ──────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
    this.logger.info('Lifecycle event worker started');
  }

  public stop(): void {
    this.running = false;
    this.logger.info('Lifecycle event worker stopped');
  }

  // ──────────────────────────────────────────────
  // Polling
  // ──────────────────────────────────────────────

  private poll(): void {
    if (!this.running) return;
    try {
      void this.processNewEvents();
    } catch (error) {
      this.logger.error(`Lifecycle event poll error: ${error}`);
    }
    setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Fetch events newer than lastProcessedAt, update cursor, enqueue deliveries.
   */
  private async processNewEvents(): Promise<void> {
    const events = await platformRepository.instanceEventLog.findMany({
      where: {
        createdAt: { gt: this.lastProcessedAt },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    if (events.length === 0) return;

    for (const event of events) {
      await this.enqueueDeliveriesForEvent(event);
    }

    // Advance cursor to the last event processed
    this.lastProcessedAt = events[events.length - 1].createdAt;
  }

  /**
   * Find all webhooks subscribed to this eventType and enqueue a delivery for each.
   * Webhook is selected if:
   *   - enabled = true
   *   - webhook.instanceId matches the event's instanceId (instance-scoped)
   *   - webhook.events array contains the eventType
   */
  private async enqueueDeliveriesForEvent(event: {
    id: string;
    publicId: string;
    instanceId: string;
    eventType: string;
  }): Promise<void> {
    // Find all webhooks for this instance
    const webhooks = await platformRepository.platformWebhook.findMany({
      where: {
        enabled: true,
        instanceId: event.instanceId,
      },
    });

    // Filter to those subscribed to this event type
    const subscribed = webhooks.filter((wh) => {
      const events = (wh.events as string[]) ?? [];
      return events.includes(event.eventType);
    });

    if (subscribed.length === 0) return;

    for (const webhook of subscribed) {
      try {
        // Stable eventId (evt_xxx) reused across all delivery attempts for this logical event.
        // enqueueDelivery creates a new delivery row with attempt=1.
        await this.deliveryWorker.enqueueDelivery(webhook.id, event.publicId);
        this.logger.debug(
          `Enqueued delivery: webhook=${webhook.publicId} event=${event.publicId} type=${event.eventType}`,
        );
      } catch (error) {
        this.logger.error(`Failed to enqueue delivery for webhook ${webhook.id} event ${event.publicId}: ${error}`);
      }
    }
  }
}
