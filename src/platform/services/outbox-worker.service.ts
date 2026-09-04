import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

/**
 * Outbox Worker Service
 * Polls PlatformMessageCommand for queued/processing records.
 *
 * Phase 1 lifecycle: queued → processing → deferred
 * (Engine/Evolution call happens in Phase 2)
 *
 * On restart, any 'processing' commands are recovered back to 'queued'
 * so no message is ever permanently lost.
 *
 * Phase 1 NEVER uses: sent, completed, delivered, read, failed.
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

        // Increment attempts; if max reached, mark as deferred (Phase 1 has no engine to declare permanent failure)
        const updated = await platformRepository.platformMessageCommand.findUnique({ where: { id: cmd.id } });
        if (updated && updated.attempts >= this.maxAttempts) {
          await platformRepository.platformMessageCommand.update({
            where: { id: cmd.id },
            data: { status: 'deferred', lastError: String(error) },
          });
        }
      }
    }
  }

  /**
   * Process a single MessageCommand.
   * Phase 1: queued → processing → deferred (engine not connected).
   */
  private async processCommand(id: string): Promise<void> {
    // Mark as processing
    await platformRepository.platformMessageCommand.update({
      where: { id },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
      },
    });

    // Phase 1: defer — no engine call
    // Phase 2 would call: await evolutionAdapter.sendMessage(cmd)
    await platformRepository.platformMessageCommand.update({
      where: { id },
      data: { status: 'deferred' },
    });

    this.logger.debug(`MessageCommand ${id} deferred (Phase 1 — no engine)`);
  }
}
