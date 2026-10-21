/**
 * Outbox anti-ban policy
 *
 * Decides what the outbox worker does when the anti-ban guard refuses to
 * let a queued message through.
 *
 * Two dispositions exist:
 *   - `skip`  → terminal. The recipient is suppressed (opted out) or has a
 *                high block rate. The command is parked with status 'skipped'
 *                and is NEVER retried — retrying a suppressed contact is
 *                exactly the behaviour that gets a number banned.
 *   - `defer` → temporary. The recipient is merely rate limited (per-contact
 *                spacing, hourly cap, burst cap, global throughput). The
 *                command stays 'queued' and is retried once the limiter
 *                window has passed.
 *
 * This module is intentionally dependency-free so it can be unit tested.
 */

/** Reasons produced by AntiBanService that are terminal for the command. */
export const TERMINAL_BLOCK_REASONS = ['CONTACT_SUPPRESSED', 'HIGH_BLOCK_RATE'] as const;

export type BlockDisposition = 'skip' | 'defer';

export interface BlockDecision {
  disposition: BlockDisposition;
  /** Human readable reason stored in `lastError`. */
  reason: string;
  /** How long to wait before retrying (only meaningful for `defer`). */
  retryAfterMs: number;
}

/**
 * Classify an anti-ban refusal.
 *
 * @param reason        reason reported by the anti-ban guard
 * @param suppressed    true when the contact is explicitly suppressed
 * @param retryAfterMs  hint from the guard; falls back to `fallbackDelayMs`
 */
export function classifyBlock(
  reason: string | undefined,
  suppressed: boolean,
  retryAfterMs: number | undefined,
  fallbackDelayMs: number,
): BlockDecision {
  const effectiveReason = reason ?? 'BLOCKED_BY_ANTIBAN';
  const terminal = suppressed || (TERMINAL_BLOCK_REASONS as readonly string[]).includes(effectiveReason);

  if (terminal) {
    return {
      disposition: 'skip',
      reason: effectiveReason,
      retryAfterMs: 0,
    };
  }

  const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : Math.max(0, fallbackDelayMs);

  return {
    disposition: 'defer',
    reason: effectiveReason,
    retryAfterMs: wait,
  };
}
