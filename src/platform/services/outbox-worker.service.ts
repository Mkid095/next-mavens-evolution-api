import { configService, Platform } from '@config/env.config';
import { Logger } from '@config/logger.config';

import { OutgoingMessage } from '../adapters/whatsapp.adapter';
import { PlatformRepository, platformRepository } from '../repository/platform.repository';
import { describeError } from './describe-error';
import { OutboxPacer } from './outbox-pacer';
import { classifyBlock } from './outbox-policy';

/**
 * Minimal structural view of the anti-ban guard used by the worker.
 * `AntiBanService` (src/api/services/anti-ban.service.ts) satisfies it.
 */
export interface OutboxAntiBanGuard {
  canSendMessage(
    instanceId: string,
    phoneNumber: string,
    templateName?: string,
  ): Promise<{
    allowed: boolean;
    reason?: string;
    retryAfterMs?: number;
    checks?: { blockStatus?: { suppressed?: boolean } };
  }>;
  recordSend(instanceId: string, phoneNumber: string): Promise<void>;
  recordDeliveryFailure(instanceId: string, phoneNumber: string, errorCode: string, messageId?: string): Promise<void>;
}

/**
 * Minimal structural view of the transport used to deliver a message.
 * `EvolutionAdapter` (src/platform/adapters/evolution.adapter.ts) satisfies it.
 */
export interface OutboxSender {
  sendMessage(
    instanceId: string,
    message: { to: string; type: string; content: Record<string, unknown> },
  ): Promise<{ messageId: string; engineRef: string | null }>;
}

export interface OutboxWorkerOptions {
  /**
   * Anti-ban guard.
   *
   * Injected on purpose: the guard lives in the API module
   * (`AntiBanService`), and importing it statically from here would create
   * an api <-> platform import cycle that breaks the module bootstrap
   * (the platform module constructs this worker at import time).
   */
  antiBan: OutboxAntiBanGuard;
  /** Pacer (defaults to one built from the PLATFORM_OUTBOX_* config). */
  pacer?: OutboxPacer;
  /** Repository (defaults to the shared platform repository). */
  repository?: PlatformRepository;
  /** Transport (defaults to the Evolution adapter). */
  sender?: OutboxSender;
}

/** Shape of the rows we read from PlatformMessageCommand. */
interface MessageCommandRow {
  id: string;
  accountId: string;
  projectId: string;
  instanceId: string;
  messageId: string;
  type: string;
  recipient: string;
  content: unknown;
  attempts: number;
}

/**
 * Outbox Worker Service
 * Polls PlatformMessageCommand for queued records and sends them ONE AT A
 * TIME, at controlled intervals, per instance.
 *
 * Lifecycle: queued → processing → sent | failed | skipped
 *   - `failed`  — the engine rejected the message (or retries were exhausted)
 *   - `skipped` — the anti-ban guard refused the recipient permanently
 *                 (suppressed contact / high block rate). Terminal: never
 *                 retried, because retrying a suppressed contact is exactly
 *                 what gets a number banned.
 *   - `queued`  — the anti-ban guard refused the recipient temporarily
 *                 (rate limit). The command stays queued and is retried once
 *                 the limiter window has passed.
 *
 * Pacing (per instance, never global):
 *   - at least PLATFORM_OUTBOX_SEND_INTERVAL_MS between two sends,
 *   - plus a random jitter of up to PLATFORM_OUTBOX_JITTER_MS,
 *   - and never more than PLATFORM_OUTBOX_MAX_PER_MINUTE sends per minute.
 *
 * On restart, any 'processing' commands are recovered back to 'queued'
 * so no message is ever permanently lost.
 */
/** One instance's send lane. */
interface InstanceLane {
  /** Set when the instance has nothing queued and the lane should stop. */
  idle: boolean;
  /**
   * False once the lane has finished its round.
   *
   * A lane removes ITSELF from the map when it stops, rather than being
   * removed from the outside — so a second lane can never be started for
   * an instance that still has one running. Two lanes for one instance
   * would mean two sends at once, which is the burst the pacing exists
   * to prevent.
   */
  active: boolean;
}

export class OutboxWorkerService {
  private readonly logger = new Logger('OutboxWorkerService');
  private readonly repository: PlatformRepository;
  private readonly antiBan: OutboxAntiBanGuard;
  private readonly pacer: OutboxPacer;
  private readonly sender: OutboxSender;

  private running = false;
  /** Set by stop() — breaks an in-flight cycle immediately. */
  private stopped = false;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly candidateWindow: number;
  private readonly sendIntervalMs: number;
  private readonly jitterMs: number;
  private readonly maxPerMinute: number;

  private abortController: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  /** PlatformInstance.id → engine instance name (anti-ban is keyed by name). */
  private readonly instanceNames = new Map<string, string>();
  /** commandId → epoch ms before which the command must not be retried. */
  private readonly deferredUntil = new Map<string, number>();
  /** PlatformInstance.id → its send lane. One lane runs per instance. */
  private readonly lanes = new Map<string, InstanceLane>();

  constructor(options: OutboxWorkerOptions) {
    const platform = configService.get<Platform>('PLATFORM');

    this.pollIntervalMs = platform?.OUTBOX_POLL_INTERVAL_MS ?? 5000;
    this.maxAttempts = platform?.OUTBOX_MAX_RETRIES ?? 5;
    this.batchSize = Math.max(1, platform?.OUTBOX_BATCH_SIZE ?? 20);
    // Look at more rows than we send per cycle: rate-limited commands stay
    // at the head of the queue (createdAt ASC) and must not block the ones
    // behind them.
    this.candidateWindow = Math.max(this.batchSize * 5, this.batchSize);
    this.sendIntervalMs = platform?.OUTBOX_SEND_INTERVAL_MS ?? 1500;
    this.jitterMs = platform?.OUTBOX_JITTER_MS ?? 750;
    this.maxPerMinute = platform?.OUTBOX_MAX_PER_MINUTE ?? 60;

    this.repository = options.repository ?? platformRepository;
    this.antiBan = options.antiBan;
    this.pacer =
      options.pacer ??
      new OutboxPacer({
        sendIntervalMs: this.sendIntervalMs,
        jitterMs: this.jitterMs,
        maxPerMinute: this.maxPerMinute,
      });
    this.sender = options.sender ?? {
      sendMessage: async (instanceId, message) => {
        // Imported lazily: the adapter pulls in the API module (waMonitor),
        // and a static import here would close an api <-> platform cycle
        // that breaks the module bootstrap.
        const { evolutionAdapter } = await import('../adapters/evolution.adapter');
        return evolutionAdapter.sendMessage(instanceId, {
          to: message.to,
          type: message.type as OutgoingMessage['type'],
          content: message.content,
        });
      },
    };
  }

  /**
   * Start the outbox polling loop.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.abortController = new AbortController();
    void this.recover();
    this.poll();
    this.logger.info(
      `Outbox worker started (poll=${this.pollIntervalMs}ms batch=${this.batchSize} ` +
        `interval=${this.sendIntervalMs}ms jitter=${this.jitterMs}ms maxPerMinute=${this.maxPerMinute})`,
    );
  }

  /**
   * Stop the outbox polling loop.
   * Interrupts a pending pacing delay so a shutdown never waits for it.
   */
  public stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Aborts a pending pacing delay so a shutdown never waits for it.
    this.abortController?.abort();
    for (const lane of this.lanes.values()) lane.idle = true;
    this.lanes.clear();
    this.logger.info('Outbox worker stopped');
  }

  /**
   * Poll for pending message commands.
   *
   * The cycle only STARTS the work — one lane per instance, each running
   * on its own. Two cycles can overlap, and so can two lanes, but never
   * two lanes for the same instance: that is what keeps the pacing
   * promise.
   */
  private poll(): void {
    if (!this.running) return;
    void this.runCycle();
  }

  private async runCycle(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Outbox poll error: ${error}`);
    }

    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Run a single outbox cycle: pick up queued commands, check them against
   * the anti-ban guard, pace them per instance and send them.
   *
   * Public so it can be triggered manually (and unit tested) without
   * running the polling loop.
   */
  public async runOnce(): Promise<void> {
    await this.processPending();
  }

  /**
   * On startup, recover any 'processing' commands that were interrupted
   * (e.g., by API restart) back to 'queued'.
   */
  private async recover(): Promise<void> {
    try {
      const stale = await this.repository.platformMessageCommand.findMany({
        where: { status: 'processing' },
        take: 100,
      });

      for (const cmd of stale) {
        await this.repository.platformMessageCommand.update({
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
   *
   * For every command:
   *   1. ask the anti-ban guard whether the recipient may be messaged,
   *   2. wait for the instance's pacing slot (interruptible),
   *   3. send through the Evolution adapter,
   *   4. record the send with the anti-ban guard.
   */
  /**
   * Find the instances that have something queued, and make sure each of
   * them has a lane running.
   *
   * A LANE PER INSTANCE, not one loop over every command.
   *
   * The loop this replaced walked the queue oldest-first across every
   * instance and awaited each send's pacing slot. That made the whole
   * worker serial: an instance with five hundred messages queued held the
   * loop for the better part of twenty minutes, and every other
   * instance's messages waited behind them — not because of any limit
   * that applied to them, but because they shared a loop.
   *
   * A lane per instance keeps the promise that matters (one message at a
   * time per instance, at a controlled interval) and stops the promise
   * that was never made (that a busy instance throttles the others).
   */
  private async processPending(): Promise<void> {
    this.pruneDeferred();

    const active = await this.repository.platformMessageCommand.findMany({
      where: { status: 'queued' },
      select: { instanceId: true },
      distinct: ['instanceId'],
      orderBy: { instanceId: 'asc' },
    });

    const wanted = new Set(active.map((row) => row.instanceId));

    // Ask the lanes whose instance has nothing left to send to stop.
    // They remove themselves; see `InstanceLane.active`.
    for (const [instanceId, lane] of this.lanes) {
      if (!wanted.has(instanceId)) {
        lane.idle = true;
      }
    }

    // Start a lane for each instance that has work and is not already
    // being served by one.
    for (const instanceId of wanted) {
      const existing = this.lanes.get(instanceId);
      if (existing?.active) continue;
      const lane: InstanceLane = { idle: false, active: true };
      this.lanes.set(instanceId, lane);
      void this.runLane(instanceId, lane);
    }
  }

  /**
   * One instance's send lane.
   *
   * It takes that instance's queued commands in order, checks each
   * against the anti-ban guard, waits for the instance's pacing slot and
   * sends. It runs on its own, so its waits are its own.
   */
  private async runLane(instanceId: string, lane: InstanceLane): Promise<void> {
    try {
      let examined = 0;

      while (!this.stopped && !lane.idle) {
        // At most `batchSize` anti-ban checks (and therefore sends) per
        // cycle for this instance. Commands the rate limiter deferred do
        // not consume the budget, so they cannot block the ones behind
        // them.
        if (examined >= this.batchSize) break;

        const pending = await this.repository.platformMessageCommand.findMany({
          where: { status: 'queued', instanceId },
          take: this.candidateWindow,
          orderBy: { createdAt: 'asc' },
        });

        if (pending.length === 0) {
          // Nothing left for this instance — the lane goes idle and the
          // next cycle starts it again if work arrives.
          lane.idle = true;
          return;
        }

        let sentThisRound = false;

        for (const cmd of pending) {
          if (this.stopped || lane.idle) break;
          if (examined >= this.batchSize) break;

          // Skip commands the rate limiter deferred in a previous cycle.
          const retryAt = this.deferredUntil.get(cmd.id);
          if (retryAt !== undefined) {
            if (Date.now() < retryAt) continue;
            this.deferredUntil.delete(cmd.id);
          }

          const instanceName = await this.resolveInstanceName(cmd.instanceId);

          // ── Anti-ban guard ──────────────────────────────────────────────
          examined++;
          const check = await this.antiBan.canSendMessage(instanceName, cmd.recipient);

          if (!check.allowed) {
            await this.handleBlocked(cmd, instanceName, check);
            sentThisRound = true;
            continue;
          }

          // ── Pacing ──────────────────────────────────────────────────────
          // This waits for THIS instance's slot. Another instance's lane
          // is waiting for its own at the same time.
          const slot = await this.pacer.waitForSlot(instanceName, this.abortController?.signal);
          if (!slot) {
            // The worker was stopped while waiting — leave the rest for
            // the next cycle.
            lane.idle = true;
            return;
          }

          // ── Send ────────────────────────────────────────────────────────
          const delivered = await this.processCommand(cmd as MessageCommandRow, instanceName);

          if (delivered) {
            await this.antiBan.recordSend(instanceName, cmd.recipient);
          }
          sentThisRound = true;
        }

        // Nothing in this round could be sent — the instance is waiting
        // on a rate limit. Leave the rest for the next cycle.
        if (!sentThisRound) break;
      }
    } catch (error) {
      this.logger.error(`Outbox lane for instance ${instanceId} failed: ${error}`);
    } finally {
      lane.active = false;
      // Only remove the lane if it is still this one — a newer lane for
      // the same instance must not be evicted by an older one stopping.
      if (this.lanes.get(instanceId) === lane) {
        this.lanes.delete(instanceId);
      }
    }
  }

  /**
   * Handle a command the anti-ban guard refused.
   *
   * Terminal refusals (suppressed contact / high block rate) park the
   * command with status 'skipped' so it is never retried.
   * Temporary refusals (rate limits) keep the command 'queued' and defer it
   * in memory until the limiter window has passed.
   */
  private async handleBlocked(
    cmd: { id: string; recipient: string },
    instanceName: string,
    check: { reason?: string; retryAfterMs?: number; checks?: { blockStatus?: { suppressed?: boolean } } },
  ): Promise<void> {
    const decision = classifyBlock(
      check.reason,
      check.checks?.blockStatus?.suppressed === true,
      check.retryAfterMs,
      this.pollIntervalMs,
    );

    if (decision.disposition === 'skip') {
      await this.repository.platformMessageCommand.update({
        where: { id: cmd.id },
        data: { status: 'skipped', lastError: `Anti-ban: ${decision.reason}` },
      });
      this.logger.warn(
        `MessageCommand ${cmd.id} skipped — recipient ${cmd.recipient} on ${instanceName}: ${decision.reason}`,
      );
      return;
    }

    this.deferredUntil.set(cmd.id, Date.now() + decision.retryAfterMs);
    await this.repository.platformMessageCommand.update({
      where: { id: cmd.id },
      data: { status: 'queued', lastError: `Anti-ban deferred: ${decision.reason}` },
    });
    this.logger.warn(
      `MessageCommand ${cmd.id} deferred for ${decision.retryAfterMs}ms — ${cmd.recipient} on ${instanceName}: ${decision.reason}`,
    );
  }

  /**
   * Drop deferral entries whose retry time has passed.
   * Keeps the in-memory map bounded on long running processes.
   */
  private pruneDeferred(): void {
    if (this.deferredUntil.size === 0) return;

    const now = Date.now();
    for (const [id, retryAt] of this.deferredUntil) {
      if (retryAt <= now) {
        this.deferredUntil.delete(id);
      }
    }
  }

  /**
   * Resolve the engine instance name for a PlatformInstance id.
   *
   * The anti-ban guard is keyed by the engine instance name (the same key
   * the legacy API path uses), so the PlatformInstance id must be translated.
   */
  private async resolveInstanceName(instanceId: string): Promise<string> {
    const cached = this.instanceNames.get(instanceId);
    if (cached) return cached;

    let name = instanceId;
    try {
      const platformInstance = await this.repository.platformInstance.findUnique({
        where: { id: instanceId },
      });
      if (platformInstance?.name) {
        name = platformInstance.name;
      }
    } catch (error) {
      this.logger.error(`Failed to resolve instance ${instanceId}: ${error}`);
    }

    this.instanceNames.set(instanceId, name);
    return name;
  }

  /**
   * Process a single MessageCommand.
   * Phase 2: calls EvolutionAdapter.sendMessage() for actual WhatsApp delivery.
   * Returns true when the message was handed over to the engine.
   */
  private async processCommand(cmd: MessageCommandRow, instanceName: string): Promise<boolean> {
    // Mark as processing
    await this.repository.platformMessageCommand.update({
      where: { id: cmd.id },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
      },
    });

    try {
      // Phase 2: call the transport
      const content =
        typeof cmd.content === 'object' && cmd.content !== null ? (cmd.content as Record<string, unknown>) : {};
      const result = await this.sender.sendMessage(cmd.instanceId, {
        to: cmd.recipient,
        type: cmd.type as 'text' | 'media' | 'audio' | 'button' | 'interactive' | 'template',
        content,
      });

      // Success — mark as sent
      // Canonical messageId is msg_xxx (returned to API caller via idempotency response)
      // Engine ref (Baileys JID) is stored internally for tracing
      //
      // The error is cleared: a message that was deferred by the rate
      // limiter and then went out has no error, and leaving the note
      // behind makes a delivered message look like a broken one.
      await this.repository.platformMessageCommand.update({
        where: { id: cmd.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          engineRef: result.engineRef,
          lastError: null,
        },
      });

      // Record usage idempotently
      await this.recordUsage(cmd);

      this.logger.debug(`MessageCommand ${cmd.id} sent: ${result.messageId}`);
      return true;
    } catch (error) {
      // The engine throws Boom objects and plain response bodies, not
      // only Errors. A bare String() renders those as [object Object],
      // which is what a developer saw in lastError and could do nothing
      // with.
      const errorMsg = describeError(error);

      // Check if max attempts reached
      const updated = await this.repository.platformMessageCommand.findUnique({
        where: { id: cmd.id },
      });
      if (updated && updated.attempts >= this.maxAttempts) {
        await this.repository.platformMessageCommand.update({
          where: { id: cmd.id },
          data: { status: 'failed', lastError: errorMsg },
        });
        this.logger.warn(`MessageCommand ${cmd.id} failed permanently after ${this.maxAttempts} attempts`);
      } else {
        // Return to 'queued' so it is retried on a later cycle. Leaving it
        // as 'processing' would strand the command until the next restart.
        await this.repository.platformMessageCommand.update({
          where: { id: cmd.id },
          data: { status: 'queued', lastError: errorMsg },
        });
        this.logger.warn(`MessageCommand ${cmd.id} deferred: ${errorMsg}`);
      }

      // Feed the block tracker so a blocked recipient is suppressed and
      // never messaged again.
      await this.reportDeliveryFailure(instanceName, cmd.recipient, errorMsg, cmd.messageId);

      return false;
    }
  }

  /**
   * Report a delivery failure to the anti-ban block tracker.
   * Only block/spam shaped errors are interesting to the tracker.
   */
  private async reportDeliveryFailure(
    instanceName: string,
    recipient: string,
    errorMsg: string,
    messageId?: string,
  ): Promise<void> {
    try {
      const lower = errorMsg.toLowerCase();

      if (lower.includes('spam')) {
        await this.antiBan.recordDeliveryFailure(instanceName, recipient, 'SPAM_DETECTED', messageId);
      } else if (lower.includes('block') || lower.includes('403') || lower.includes('forbidden')) {
        await this.antiBan.recordDeliveryFailure(instanceName, recipient, 'BLOCKED_BY_USER', messageId);
      }
    } catch (error) {
      this.logger.error(`Failed to record delivery failure for ${recipient}: ${error}`);
    }
  }

  /**
   * Record usage idempotently using the command's messageId as resourceId.
   * UsageService.recordUsage does an upsert keyed on (accountId, operation, periodStart, resourceId),
   * so duplicate calls with the same messageId do not double-count.
   */
  private async recordUsage(cmd: { accountId: string; projectId: string; messageId: string }): Promise<void> {
    try {
      const periodStart = new Date();
      periodStart.setDate(1);
      periodStart.setHours(0, 0, 0, 0);

      // Import UsageService here to avoid circular deps
      const { UsageService } = await import('./usage.service');
      const usageService = new UsageService();
      await usageService.recordUsage(cmd.accountId, 'messages', 1, periodStart, cmd.projectId);
    } catch (error) {
      this.logger.error(`Failed to record usage for MessageCommand ${cmd.messageId}: ${error}`);
    }
  }
}
