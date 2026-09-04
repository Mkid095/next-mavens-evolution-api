import crypto from 'crypto';
import { platformRepository } from '../repository/platform.repository';
import { WebhookService } from '../services/webhook.service';
import { Logger } from '@config/logger.config';

/**
 * Webhook Delivery Worker
 * Processes pending webhook deliveries with HTTP POST + retry + backoff.
 * Uses synthetic test events in Phase 1.
 */
export class WebhookDeliveryWorker {
  private readonly logger = new Logger('WebhookDeliveryWorker');
  private readonly webhookService: WebhookService;
  private running = false;
  private pollIntervalMs = 5000;
  private maxRetries = 5;
  private baseDelayMs = 1000;

  constructor() {
    this.webhookService = new WebhookService();
  }

  /**
   * Start the delivery worker.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
    this.logger.info('Webhook delivery worker started');
  }

  /**
   * Stop the delivery worker.
   */
  public stop(): void {
    this.running = false;
    this.logger.info('Webhook delivery worker stopped');
  }

  /**
   * Poll for pending deliveries.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this.processPending();
    } catch (error) {
      this.logger.error(`Webhook delivery poll error: ${error}`);
    }

    setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Process pending deliveries.
   */
  private async processPending(): Promise<void> {
    const pending = await platformRepository.platformWebhookDelivery.findMany({
      where: { status: { in: ['queued', 'failed'] } },
      include: { platformWebhook: true },
      take: 20,
      orderBy: { createdAt: 'asc' },
    });

    for (const delivery of pending) {
      if (!this.running) break;

      // Skip if max retries exceeded — leave as deferred (Phase 1 has no engine to declare permanent failure)
      if (delivery.attempt >= this.maxRetries) {
        await platformRepository.platformWebhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'deferred' },
        });
        continue;
      }

      try {
        await this.deliver(delivery.id);
      } catch (error) {
        this.logger.error(`Webhook delivery failed for ${delivery.id}: ${error}`);
      }
    }
  }

  /**
   * Deliver a single webhook.
   */
  private async deliver(deliveryId: string): Promise<void> {
    // Fetch full delivery record with webhook
    const delivery = await platformRepository.platformWebhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { platformWebhook: true },
    });

    if (!delivery) return;

    // Mark as processing
    await platformRepository.platformWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'processing',
        attempt: { increment: 1 },
      },
    });

    // Decrypt secret
    let secret: string;
    try {
      secret = this.webhookService.decrypt(delivery.platformWebhook.secret);
    } catch (error) {
      this.logger.error(`Failed to decrypt webhook secret: ${error}`);
      await platformRepository.platformWebhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'failed', lastError: 'Decryption failed' },
      });
      return;
    }

    // Build payload
    const payload = { eventId: delivery.eventId, deliveryId: delivery.deliveryId };
    const payloadStr = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.webhookService.signPayload(payloadStr, timestamp, secret);

    // Build headers matching what the WebhookService produces
    const headers = {
      'Content-Type': 'application/json',
      'X-Fidscript-Signature': `sha256=${signature}`,
      'X-Fidscript-Timestamp': String(timestamp),
      'X-Fidscript-Webhook-Id': delivery.eventId,
      'X-Fidscript-Delivery-Id': delivery.deliveryId,
      'User-Agent': 'Platform-Webhook/1.0',
    };

    try {
      const response = await fetch(delivery.platformWebhook.url, {
        method: 'POST',
        headers,
        body: payloadStr,
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        await platformRepository.platformWebhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'delivered',
            responseStatus: response.status,
            deliveredAt: new Date(),
          },
        });
        this.logger.debug(`Webhook delivered: ${deliveryId}`);
      } else {
        await this.handleRetry(deliveryId, `HTTP ${response.status}`);
      }
    } catch (error) {
      await this.handleRetry(deliveryId, String(error));
    }
  }

  /**
   * Handle delivery retry with exponential backoff.
   */
  private async handleRetry(
    deliveryId: string,
    error: string,
  ): Promise<void> {
    const record = await platformRepository.platformWebhookDelivery.findUnique({
      where: { id: deliveryId },
    });

    if (!record) return;

    // Calculate backoff: baseDelay * 2^attempt (capped at 5 min)
    const delayMs = Math.min(this.baseDelayMs * Math.pow(2, record.attempt - 1), 300000);

    // Schedule retry if not exhausted
    if (record.attempt < this.maxRetries) {
      await platformRepository.platformWebhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'queued',
          lastError: error,
          nextRetryAt: new Date(Date.now() + delayMs),
        },
      });
    } else {
      // Phase 1: mark as deferred (no engine to declare permanent failure)
      await platformRepository.platformWebhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'deferred', lastError: error },
      });
    }
  }

  /**
   * Enqueue a webhook delivery (Phase 1 synthetic events).
   */
  public async enqueueDelivery(
    webhookId: string,
    eventId: string,
  ): Promise<void> {
    const publicId = `del_${crypto.randomBytes(12).toString('hex')}`;
    await platformRepository.platformWebhookDelivery.create({
      data: {
        webhookId,
        eventId,
        deliveryId: publicId,
        status: 'queued',
      },
    });
  }

  /**
   * Send a synthetic test event (Phase 1).
   * The eventId is stable — the same logical event reuses the same eventId
   * across all delivery attempts, as required by the contract.
   */
  public async sendTestEvent(webhookId: string): Promise<void> {
    // Stable eventId: generated once per logical test event, reused for all delivery attempts
    const eventId = `evt_test_${Date.now()}`;
    await this.enqueueDelivery(webhookId, eventId);
  }

  /**
   * Enqueue a retry for an existing logical event.
   * Reuses the same eventId so the delivery is recognized as a retry of the same event.
   */
  public async enqueueRetry(webhookId: string, eventId: string): Promise<void> {
    await this.enqueueDelivery(webhookId, eventId);
  }
}
