import { Logger } from '@config/logger.config';
import crypto from 'crypto';

import { platformRepository } from '../repository/platform.repository';
import { PlatformCrypto } from './crypto';

/**
 * Webhook Service
 * CRUD for webhook configurations with HMAC-SHA256 signing.
 * Secret is encrypted at rest using AES-256-GCM and stored in the `secret` field.
 */
export class WebhookService {
  private readonly logger = new Logger('WebhookService');
  private readonly crypto: PlatformCrypto;

  constructor() {
    // Constructed eagerly so a missing PLATFORM_ENCRYPTION_KEY fails fast
    // at boot rather than on the first webhook write.
    this.crypto = new PlatformCrypto();
  }

  /**
   * Create a webhook configuration.
   * Generates and encrypts a secret using AES-256-GCM.
   * The encrypted secret is stored in the `secret` field.
   * Plaintext secret is returned ONLY at creation time.
   *
   * `projectId` is the internal PlatformProject id (cuid) the webhook is
   * scoped to — the `projectId` column is NOT NULL in the database.
   * `instanceId` is the PlatformInstance id (not the engine instance id):
   * the delivery worker matches webhooks on it.
   */
  public async createWebhook(
    accountId: string,
    projectId: string,
    instanceId: string,
    url: string,
    events: string[],
  ): Promise<{
    publicId: string; // wh_xxx — the only ID exposed to clients
    secret: string; // Plaintext secret (only time visible — must be saved by caller)
    url: string;
    events: string[];
    instanceId: string;
  }> {
    const publicId = `wh_${crypto.randomBytes(12).toString('hex')}`;
    const plaintextSecret = crypto.randomBytes(32).toString('hex');
    const encryptedSecret = this.crypto.encrypt(plaintextSecret);

    const webhook = await platformRepository.platformWebhook.create({
      data: {
        publicId,
        accountId,
        projectId,
        instanceId,
        url,
        events,
        secret: encryptedSecret, // AES-256-GCM encrypted, stored
        enabled: true,
      },
    });

    this.logger.info(`Webhook created: ${webhook.publicId} for account ${accountId}`);
    return {
      publicId: webhook.publicId,
      secret: plaintextSecret, // Return plaintext ONCE — caller's responsibility to save
      url,
      events,
      instanceId,
    };
  }

  /**
   * List webhooks for a project.
   * NEVER returns the internal CUID id or the secret.
   * Returns instanceId as the internal CUID; callers should join
   * with the instance registry to get the display name.
   */
  public async listWebhooks(projectId: string) {
    const webhooks = await platformRepository.platformWebhook.findMany({
      where: { projectId },
      select: {
        publicId: true,
        instanceId: true,
        url: true,
        events: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        // id (CUID) intentionally excluded — never returned to clients
        // secret intentionally excluded — never returned
      },
    });
    return webhooks;
  }

  /**
   * Update a webhook.
   */
  public async updateWebhook(
    webhookId: string,
    data: { url?: string; events?: string[]; enabled?: boolean },
  ): Promise<void> {
    await platformRepository.platformWebhook.update({
      where: { id: webhookId },
      data,
    });
  }

  /**
   * Delete a webhook.
   */
  public async deleteWebhook(webhookId: string): Promise<void> {
    await platformRepository.platformWebhook.delete({ where: { id: webhookId } });
  }

  /**
   * Rotate webhook secret.
   * Returns plaintext secret ONCE — caller must save it.
   */
  public async rotateSecret(webhookId: string): Promise<{ secret: string }> {
    const plaintextSecret = crypto.randomBytes(32).toString('hex');
    const encryptedSecret = this.crypto.encrypt(plaintextSecret);

    await platformRepository.platformWebhook.update({
      where: { id: webhookId },
      data: { secret: encryptedSecret },
    });

    this.logger.info(`Webhook secret rotated: ${webhookId}`);
    return { secret: plaintextSecret }; // Plaintext returned ONCE
  }

  /**
   * Decrypt an AES-256-GCM encrypted secret.
   * Delegates to the shared crypto helper so the webhook secrets and
   * the project default tokens share one key and one wire format.
   */
  public decrypt(encrypted: string): string {
    return this.crypto.decrypt(encrypted);
  }

  /**
   * Sign a webhook payload with HMAC-SHA256.
   * Used by WebhookDeliveryWorker to sign outgoing deliveries.
   */
  public signPayload(body: string, timestamp: number, secret: string): string {
    const payload = `${timestamp}.${body}`;
    return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  }

  /**
   * Validate timestamp and sign a webhook payload.
   * Rejects timestamps outside the configured replay window (default 5 minutes).
   */
  public signPayloadWithReplayProtection(
    body: string,
    timestamp: number,
    secret: string,
    windowSeconds = 300,
  ): { signature: string; valid: boolean } {
    const now = Math.floor(Date.now() / 1000);
    const age = Math.abs(now - timestamp);
    if (age > windowSeconds) {
      return { signature: '', valid: false };
    }
    return { signature: this.signPayload(body, timestamp, secret), valid: true };
  }
}
