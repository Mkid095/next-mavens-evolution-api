#!/usr/bin/env -S npx tsx
/**
 * Deterministic check of the outbox pacing rules.
 *
 * The pacing arithmetic is exercised with a fake clock and fake
 * collaborators, so nothing touches the database, Redis or the network.
 *
 * Usage:
 *   npx tsx scripts/check-outbox-pacing.ts
 *
 * Exit code 0 = every rule holds, 1 = a rule was violated.
 *
 * Note: without a reachable database the worker logs a "record usage" error
 * (the usage recorder is fire-and-forget) — that warning is expected here and
 * does not affect the checks below.
 */

import { OutboxPacer, PacerClock } from '../src/platform/services/outbox-pacer';
import { classifyBlock } from '../src/platform/services/outbox-policy';
import { OutboxWorkerService } from '../src/platform/services/outbox-worker.service';

class FakeClock implements PacerClock {
  public current = 0;
  public readonly sleeps: number[] = [];

  public now(): number {
    return this.current;
  }

  public random(): number {
    return 0.5;
  }

  public async sleep(ms: number): Promise<boolean> {
    this.sleeps.push(ms);
    this.current += ms;
    return true;
  }
}

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function row(id: string, instanceId: string, recipient: string) {
  return {
    id,
    instanceId,
    recipient,
    status: 'queued',
    attempts: 0,
    type: 'text',
    content: { text: `hello ${id}` },
    messageId: `msg_${id}`,
    accountId: 'acc',
    appId: 'app',
  };
}

async function main(): Promise<void> {
  console.log('Outbox pacing rules');

  // ── 1. per instance spacing ─────────────────────────────────────────────
  {
    const clock = new FakeClock();
    const pacer = new OutboxPacer({
      sendIntervalMs: 1500,
      jitterMs: 750,
      maxPerMinute: 60,
      clock,
    });

    await pacer.waitForSlot('inst-a');
    await pacer.waitForSlot('inst-a');

    check(
      'second send of an instance waits at least the send interval',
      clock.sleeps.length === 1 && clock.sleeps[0] >= 1500,
      `sleeps=${JSON.stringify(clock.sleeps)}`,
    );
  }

  // ── 2. two instances do not throttle each other ─────────────────────────
  {
    const clock = new FakeClock();
    const pacer = new OutboxPacer({
      sendIntervalMs: 1500,
      jitterMs: 750,
      maxPerMinute: 60,
      clock,
    });

    await pacer.waitForSlot('inst-a');
    await pacer.waitForSlot('inst-b');

    check('a second instance is not delayed by the first one', clock.sleeps.length === 0);
  }

  // ── 3. per minute ceiling ───────────────────────────────────────────────
  {
    const clock = new FakeClock();
    const pacer = new OutboxPacer({
      sendIntervalMs: 0,
      jitterMs: 0,
      maxPerMinute: 2,
      clock,
    });

    await pacer.waitForSlot('inst-a');
    await pacer.waitForSlot('inst-a');
    await pacer.waitForSlot('inst-a');

    check(
      'the per minute ceiling is enforced',
      clock.sleeps.length === 1 && clock.sleeps[0] === 60_000,
      `sleeps=${JSON.stringify(clock.sleeps)}`,
    );
  }

  // ── 4. the worker paces, skips and defers ────────────────────────────────
  {
    const clock = new FakeClock();
    const rows = [row('c1', 'i1', '111'), row('c2', 'i1', '222'), row('c3', 'i1', '333'), row('c4', 'i1', '444')];
    const updates: { id: string; data: Record<string, unknown> }[] = [];

    const repository = {
      platformMessageCommand: {
        findMany: async ({ where }: any) => (where?.status === 'processing' ? [] : rows),
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
        update: async ({ where, data }: any) => {
          updates.push({ id: where.id, data });
          Object.assign(rows.find((r) => r.id === where.id) ?? {}, data);
          return null;
        },
      },
      platformInstance: {
        findUnique: async ({ where }: any) => ({ id: where.id, name: `engine-${where.id}` }),
      },
    } as any;

    const sent: string[] = [];
    const sender = {
      sendMessage: async (_instanceId: string, message: { to: string }) => {
        sent.push(message.to);
        return { messageId: 'msg_x', engineRef: null };
      },
    };

    const antiBan = {
      canSendMessage: async (_instanceId: string, phone: string) =>
        phone === '333'
          ? {
              allowed: false,
              reason: 'CONTACT_SUPPRESSED',
              checks: { blockStatus: { allowed: false, suppressed: true } },
            }
          : phone === '444'
            ? { allowed: false, reason: 'RATE_LIMIT_CONTACT', retryAfterMs: 3000 }
            : { allowed: true },
      recordSend: async () => {},
      recordDeliveryFailure: async () => {},
    };

    const worker = new OutboxWorkerService({
      antiBan,
      repository,
      sender,
      pacer: new OutboxPacer({
        sendIntervalMs: 1500,
        jitterMs: 750,
        maxPerMinute: 60,
        clock,
      }),
    });

    await worker.runOnce();

    check('the suppressed recipient is never messaged', !sent.includes('333'), `sent=${sent.join(',')}`);
    check(
      'the suppressed command is parked as skipped',
      updates.some((u) => u.id === 'c3' && u.data.status === 'skipped'),
    );
    check(
      'the rate limited command stays queued',
      updates.some((u) => u.id === 'c4' && u.data.status === 'queued'),
    );
    check(
      'the worker waits between two sends of the same instance',
      clock.sleeps.length === 1 && clock.sleeps[0] >= 1500,
      `sleeps=${JSON.stringify(clock.sleeps)}`,
    );
  }

  // ── 5. anti-ban policy ──────────────────────────────────────────────────
  {
    check(
      'a suppressed contact is skipped',
      classifyBlock('CONTACT_SUPPRESSED', true, undefined, 5000).disposition === 'skip',
    );
    check(
      'a rate limited contact is deferred',
      classifyBlock('RATE_LIMIT_CONTACT', false, 3000, 5000).disposition === 'defer',
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} rule(s) violated`);
    process.exit(1);
  }

  console.log('\nAll pacing rules hold');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
