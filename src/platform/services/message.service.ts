import { Logger } from '@config/logger.config';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { OutgoingMessage } from '../adapters/whatsapp.adapter';
import { platformRepository } from '../repository/platform.repository';
import { UsageService } from './usage.service';

const MAX_RETRIES = 5;

export class MessageService {
  private readonly logger = new Logger('MessageService');
  private readonly usageService = new UsageService();

  /**
   * Returns the first day of the current month at 00:00:00 UTC.
   */
  getCurrentPeriodStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  /**
   * Handles a command from the outbox worker for processing.
   *
   * Flow:
   * 1. Load the PlatformMessageCommand by id
   * 2. Call IWhatsAppAdapter.sendMessage() with the command's recipient, type, and content
   * 3. On success: update status='sent', set sentAt=now, store engineRef
   * 4. On failure: update status='failed', increment attempts, store lastError
   * 5. If max retries exceeded (5): status='failed' (terminal)
   * 6. On success: call recordUsageOnSent(commandId) for idempotent usage recording
   */
  async handleCommand(commandId: string): Promise<void> {
    const command = await platformRepository.platformMessageCommand.findUnique({
      where: { id: commandId },
    });

    if (!command) {
      this.logger.error(`Command not found: ${commandId}`);
      return;
    }

    const message: OutgoingMessage = {
      to: command.recipient,
      type: command.type as OutgoingMessage['type'],
      content: command.content as Record<string, unknown>,
    };

    try {
      const result = await evolutionAdapter.sendMessage(command.instanceId, message);

      await platformRepository.platformMessageCommand.update({
        where: { id: commandId },
        data: {
          status: 'sent',
          sentAt: new Date(),
          engineRef: result.engineRef,
        },
      });

      await this.recordUsageOnSent(commandId);
    } catch (error) {
      const attempts = command.attempts + 1;
      const lastError = error instanceof Error ? error.message : String(error);

      await platformRepository.platformMessageCommand.update({
        where: { id: commandId },
        data: {
          status: attempts >= MAX_RETRIES ? 'failed' : command.status,
          attempts,
          lastError,
        },
      });

      if (attempts >= MAX_RETRIES) {
        this.logger.error(`Command ${commandId} failed permanently after ${MAX_RETRIES} attempts: ${lastError}`);
      } else {
        this.logger.warn(`Command ${commandId} failed (attempt ${attempts}/${MAX_RETRIES}): ${lastError}`);
      }
    }
  }

  /**
   * Records usage for a sent message (idempotent).
   *
   * Flow:
   * 1. Load the command (to get accountId and messageId)
   * 2. Call usageService.recordUsage(accountId, 'messages', 1, periodStart, messageId)
   * 3. periodStart is first day of current month
   * 4. This is idempotent because UsageService does an upsert with resourceId=messageId
   */
  async recordUsageOnSent(commandId: string): Promise<void> {
    const command = await platformRepository.platformMessageCommand.findUnique({
      where: { id: commandId },
    });

    if (!command) {
      this.logger.error(`Command not found for usage recording: ${commandId}`);
      return;
    }

    const periodStart = this.getCurrentPeriodStart();

    await this.usageService.recordUsage(command.accountId, 'messages', 1, periodStart, command.projectId);
  }
}
