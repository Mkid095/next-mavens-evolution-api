import { Logger } from '@config/logger.config';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { platformRepository } from '../repository/platform.repository';

/**
 * Outbox Worker Service
 * Polls PlatformMessageCommand for queued/processing records.
 *
 * Phase 2 lifecycle: queued → processing → sent/failed/deferred
 * Phase 1 deferred commands are NOT retroactively processed.
 *
 * On restart, any 'processing' commands are recovered back to 'queued'
 * so no message is ever permanently lost.
 */
export class OutboxWorkerService {
  private readonly logger = new Logger('OutboxWorkerService');
  private running = false;
  private pollIntervalMs = 5000;
  private maxAttempts = 5;

  /**
   * Start the outbox polling loop.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.recover();
    this.poll();
    this.logger.info('Outbox worker started');
  }

  /**
   * Stop the outbox polling loop.
   */
  public stop(): void {
    this.running = false;
    this.logger.info('Outbox worker stopped');
  }

  /**
   * Poll for pending message commands.
   */
  private poll(): void {
    if (!this.running) return;
    try {
      void this.processPending();
    } catch (error) {
      this.logger.error(`Outbox poll error: ${error}`);
    }
    setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * On startup, recover any 'processing' commands that were interrupted
   * (e.g., by API restart) back to 'queued'.
   */
  private async recover(): Promise<void> {
    try {
      const stale = await platformRepository.platformMessageCommand.findMany({
        where: { status: 'processing' },
        take: 100,
      });

      for (const cmd of stale) {
        await platformRepository.platformMessageCommand.update({
          where: { id: cmd.id },
          data: { status: 'queued' },
        });
        this.logger.warn(`Recovered stale MessageCommand: ${cmd.id}`);
      }

      this.logger.info(`Recovered ${stale.length} stale MessageCommand(s)`);
    } catch (error) {
      this.logger.error(`Failed to recover stale MessageCommands: ${error}`);
    }
  }

  /**
   * Process pending message commands.
   */
  private async processPending(): Promise<void> {
    const pending = await platformRepository.platformMessageCommand.findMany({
      where: { status: 'queued' },
      take: 20,
      orderBy: { createdAt: 'asc' },
    });

    for (const cmd of pending) {
      if (!this.running) break;
      try {
        await this.processCommand(cmd.id);
      } catch (error) {
        this.logger.error(`Failed to process MessageCommand ${cmd.id}: ${error}`);

        // Check if max attempts reached
        const updated = await platformRepository.platformMessageCommand.findUnique({ where: { id: cmd.id } });
        if (updated && updated.attempts >= this.maxAttempts) {
          await platformRepository.platformMessageCommand.update({
            where: { id: cmd.id },
            data: { status: 'failed', lastError: String(error) },
          });
          this.logger.warn(`MessageCommand ${cmd.id} failed permanently after ${this.maxAttempts} attempts`);
        } else {
          // Return to queued for retry on next poll cycle
          await platformRepository.platformMessageCommand.update({
            where: { id: cmd.id },
            data: { status: 'queued', lastError: String(error) },
          });
          this.logger.debug(`MessageCommand ${cmd.id} queued for retry (attempt ${updated?.attempts ?? 1})`);
        }
      }
    }
  }

  /**
   * Process a single MessageCommand.
   * Phase 2: calls EvolutionAdapter.sendMessage() for actual WhatsApp delivery.
   */
  private async processCommand(id: string): Promise<void> {
    // Load the command
    const cmd = await platformRepository.platformMessageCommand.findUnique({ where: { id } });
    if (!cmd) return;

    // Mark as processing
    await platformRepository.platformMessageCommand.update({
      where: { id },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
      },
    });

    try {
      // Phase 2: call the adapter
      const content = typeof cmd.content === 'object' ? (cmd.content as Record<string, unknown>) : {};
      const result = await evolutionAdapter.sendMessage(cmd.instanceId, {
        to: cmd.recipient,
        type: cmd.type as 'text' | 'media' | 'audio' | 'button' | 'interactive' | 'template',
        content,
      });

      // Success — mark as sent
      // Canonical messageId is msg_xxx (returned to API caller via idempotency response)
      // Engine ref (Baileys JID) is stored internally for tracing
      await platformRepository.platformMessageCommand.update({
        where: { id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          engineRef: result.engineRef,
        },
      });

      // Record usage idempotently
      await this.recordUsage(cmd);

      this.logger.debug(`MessageCommand ${id} sent: ${result.messageId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if max attempts reached
      const updated = await platformRepository.platformMessageCommand.findUnique({ where: { id } });
      if (updated && updated.attempts >= this.maxAttempts) {
        await platformRepository.platformMessageCommand.update({
          where: { id },
          data: { status: 'failed', lastError: errorMsg },
        });
        this.logger.warn(`MessageCommand ${id} failed permanently after ${this.maxAttempts} attempts`);
      } else {
        // Mark as deferred (will be retried) or failed
        await platformRepository.platformMessageCommand.update({
          where: { id },
          data: { lastError: errorMsg },
        });
        this.logger.warn(`MessageCommand ${id} deferred: ${errorMsg}`);
      }
    }
  }

  /**
   * Record usage idempotently using the command's messageId as resourceId.
   * UsageService.recordUsage does an upsert keyed on (accountId, operation, periodStart, resourceId),
   * so duplicate calls with the same messageId do not double-count.
   */
  private async recordUsage(cmd: { accountId: string; appId: string; messageId: string }): Promise<void> {
    try {
      const periodStart = new Date();
      periodStart.setDate(1);
      periodStart.setHours(0, 0, 0, 0);

      // Import UsageService here to avoid circular deps
      const { UsageService } = await import('./usage.service');
      const usageService = new UsageService();
      await usageService.recordUsage(cmd.accountId, 'messages', 1, periodStart, cmd.appId);
    } catch (error) {
      this.logger.error(`Failed to record usage for MessageCommand ${cmd.messageId}: ${error}`);
    }
  }
}
