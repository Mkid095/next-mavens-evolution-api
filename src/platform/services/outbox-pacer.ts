/**
 * Outbox Pacer
 *
 * Enforces the platform's core compliance promise: outbound messages are
 * queued and sent ONE AT A TIME at controlled, non-metronomic intervals,
 * so WhatsApp never sees a burst that looks like blasting.
 *
 * The pacer keeps its state PER INSTANCE:
 *   - `lastSendAt`  → the minimum gap between two sends of the same instance
 *   - `recentSends` → a sliding window used to enforce the per-minute ceiling
 *
 * Two different instances never throttle each other.
 *
 * This module is intentionally dependency-free (no imports) so it can be
 * unit tested with a fake clock without booting the API.
 */

/** Time window used by the per-minute ceiling (60_000 ms = 1 minute). */
export const PER_MINUTE_WINDOW_MS = 60_000;

/**
 * Injectable clock. The default implementation uses the real system clock;
 * tests inject a deterministic fake.
 */
export interface PacerClock {
  /** Current epoch milliseconds. */
  now(): number;
  /** Pseudo-random float in [0, 1). */
  random(): number;
  /**
   * Sleep for `ms` milliseconds.
   * Resolves `true` when the full delay elapsed, `false` when the wait was
   * aborted (shutdown) — the caller must then stop working immediately.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<boolean>;
}

export interface OutboxPacerOptions {
  /** Minimum gap between two sends on the same instance. */
  sendIntervalMs: number;
  /** Random extra delay added to every gap (0 .. jitterMs). */
  jitterMs: number;
  /** Maximum number of sends per instance per minute. */
  maxPerMinute: number;
  /** Sliding window of the per-minute ceiling. Defaults to 60s. */
  windowMs?: number;
  /** Injectable clock (tests). */
  clock?: PacerClock;
}

interface InstanceState {
  /** Timestamp of the last send attempt on this instance. */
  lastSendAt: number | null;
  /** Timestamps of the sends still inside the sliding window. */
  recentSends: number[];
}

/**
 * Real clock: Date.now + Math.random + an interruptible setTimeout sleep.
 */
export class SystemPacerClock implements PacerClock {
  public now(): number {
    return Date.now();
  }

  public random(): number {
    return Math.random();
  }

  public sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        cleanup();
        resolve(false);
      };

      timer = setTimeout(() => {
        cleanup();
        resolve(true);
      }, ms);

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export class OutboxPacer {
  private readonly clock: PacerClock;
  private readonly sendIntervalMs: number;
  private readonly jitterMs: number;
  private readonly maxPerMinute: number;
  private readonly windowMs: number;
  private readonly states = new Map<string, InstanceState>();

  constructor(options: OutboxPacerOptions) {
    this.clock = options.clock ?? new SystemPacerClock();
    this.sendIntervalMs = Math.max(0, options.sendIntervalMs);
    this.jitterMs = Math.max(0, options.jitterMs);
    // A ceiling of 0 would deadlock the queue — treat it as "one per window".
    this.maxPerMinute = Math.max(1, Math.floor(options.maxPerMinute));
    this.windowMs = options.windowMs ?? PER_MINUTE_WINDOW_MS;
  }

  /**
   * Compute how long the worker must wait before the next send on `instanceId`.
   *
   * The delay is the MAXIMUM of:
   *   - the per-instance spacing rule (interval + random jitter), and
   *   - the per-minute ceiling (wait until the oldest send leaves the window).
   */
  public computeDelayMs(instanceId: string, now: number = this.clock.now()): number {
    const state = this.getState(instanceId);

    // ── Per-instance spacing ────────────────────────────────────────────
    let delay = 0;
    if (state.lastSendAt !== null) {
      const gap = this.sendIntervalMs + this.clock.random() * this.jitterMs;
      delay = Math.max(0, state.lastSendAt + gap - now);
    }

    // ── Per-minute ceiling ──────────────────────────────────────────────
    state.recentSends = state.recentSends.filter((ts) => now - ts < this.windowMs);

    if (state.recentSends.length >= this.maxPerMinute) {
      const oldest = state.recentSends[0];
      delay = Math.max(delay, Math.max(0, oldest + this.windowMs - now));
    }

    return Math.ceil(delay);
  }

  /**
   * Wait until `instanceId` is allowed to send again.
   *
   * Returns `true` when the slot was acquired (the caller may send now) and
   * `false` when the wait was aborted — the worker is shutting down.
   */
  public async waitForSlot(instanceId: string, signal?: AbortSignal): Promise<boolean> {
    // Already shutting down — do not start a new send.
    if (signal?.aborted) {
      return false;
    }

    const delay = this.computeDelayMs(instanceId);

    if (delay > 0) {
      const completed = await this.clock.sleep(delay, signal);
      if (!completed) {
        return false;
      }
    }

    this.recordSend(instanceId);
    return true;
  }

  /**
   * Register a send attempt on `instanceId`.
   * Called right after a slot was acquired — a failed attempt still consumes
   * the slot, otherwise a failing instance would hammer the engine.
   */
  public recordSend(instanceId: string): void {
    const now = this.clock.now();
    const state = this.getState(instanceId);

    state.lastSendAt = now;
    state.recentSends.push(now);
    state.recentSends = state.recentSends.filter((ts) => now - ts < this.windowMs);
  }

  /**
   * Drop all pacing state (used on shutdown/tests).
   */
  public reset(): void {
    this.states.clear();
  }

  private getState(instanceId: string): InstanceState {
    let state = this.states.get(instanceId);
    if (!state) {
      state = { lastSendAt: null, recentSends: [] };
      this.states.set(instanceId, state);
    }
    return state;
  }
}
