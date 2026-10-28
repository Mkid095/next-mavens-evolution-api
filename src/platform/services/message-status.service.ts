/**
 * Reading the state of a message.
 *
 * The outbox has always tracked a command through
 * queued → processing → sent | failed | skipped. Nothing exposed it: the
 * only sign of life was the activity feed, and a shop owner opening the
 * app to see whether a broadcast has gone out could not ask — they had
 * to wait for an event and hope they were listening.
 *
 * This is the read side. The states are the ones the outbox writes; this
 * does not invent new ones.
 */

import { Prisma } from '@prisma/client';

import { platformRepository } from '../repository/platform.repository';

/** The states an outbox command can be in. */
export const MESSAGE_STATES = ['queued', 'processing', 'sent', 'failed', 'skipped'] as const;

export type MessageState = (typeof MESSAGE_STATES)[number];

/**
 * How far a message got on WhatsApp's side.
 *
 * The engine records the receipt on the message row: PENDING while
 * WhatsApp has it, SERVER_ACK once its servers accept it, DELIVERY_ACK
 * when it reaches the recipient's device, READ when they open it.
 *
 * `unknown` means the engine has not reported a receipt — which for a
 * number that has no WhatsApp account is the permanent answer, because
 * WhatsApp accepts such a message and never delivers it.
 */
export const DELIVERY_STATES = ['pending', 'accepted', 'delivered', 'read', 'unknown'] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** The receipt ranks, furthest along last. */
const DELIVERY_BY_RANK: Record<number, DeliveryState> = {
  1: 'pending',
  2: 'accepted',
  3: 'delivered',
  4: 'read',
};

/** Map the engine's receipt name onto ours. */
export function deliveryFromEngine(status: string | null | undefined): DeliveryState {
  switch ((status ?? '').toUpperCase()) {
    case 'PENDING':
      return 'pending';
    case 'SERVER_ACK':
      return 'accepted';
    case 'DELIVERY_ACK':
      return 'delivered';
    case 'READ':
      return 'read';
    default:
      return 'unknown';
  }
}

/** One message, as the API reports it. */
export interface MessageStatus {
  /** The public message id — the `messageId` the send route returned. */
  id: string;
  state: MessageState;
  type: string;
  /** The recipient, in the form it was given. */
  to: string;
  /** How many times the outbox has tried. */
  attempts: number;
  /** When the message was accepted. */
  createdAt: string;
  /** When it was handed to WhatsApp, if it was. */
  sentAt: string | null;
  /** Why the last attempt failed, if it did. */
  lastError: string | null;
  /** The instance it goes out through. */
  instancePublicId: string | null;
  /** How far it got on WhatsApp's side. Null when the engine has said nothing. */
  delivery: DeliveryState | null;
  /** When the row last changed state. */
  updatedAt: string;
}

/** A page of messages. */
export interface MessagePage {
  messages: MessageStatus[];
  nextCursor: string | null;
}

/** A failure, grouped by what went wrong. */
export interface FailureGroup {
  reason: string;
  count: number;
}

/**
 * How a batch of messages is doing.
 *
 * The counts a broadcast needs: how many went out, how many are still
 * waiting, how many failed and why, and how many reached the recipient
 * as opposed to merely leaving the platform.
 */
export interface MessageSummary {
  total: number;
  byState: Record<string, number>;
  byDelivery: Record<string, number>;
  /** The failures, grouped by reason, most common first. */
  failures: FailureGroup[];
  /** How many were handed to WhatsApp but never delivered. */
  sentButNotDelivered: number;
  /** How many were never handed to WhatsApp at all. */
  neverSent: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class MessageStatusService {
  /**
   * One message by its public id.
   *
   * The message is looked up inside the caller's account, so an id from
   * another account is simply not found — the caller has no business
   * knowing it exists.
   */
  public async get(accountId: string, messageId: string): Promise<MessageStatus | null> {
    const row = await platformRepository.platformMessageCommand.findFirst({
      where: { messageId, accountId },
    });
    return row ? await this.toStatus(row) : null;
  }

  /**
   * Recent messages, newest first.
   *
   * `instancePublicId` narrows to one instance, `state` to one status,
   * `since` to anything created at or after a point in time.
   */
  public async list(
    accountId: string,
    opts: {
      instancePublicId?: string;
      state?: MessageState;
      since?: Date;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<MessagePage> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const where: Record<string, unknown> = { accountId };

    if (opts.instancePublicId) {
      const instance = await platformRepository.platformInstance.findFirst({
        where: { publicId: opts.instancePublicId, accountId },
        select: { id: true },
      });
      // An instance of another account is not an empty list — it is a
      // question the caller has no right to ask.
      if (!instance) return { messages: [], nextCursor: null };
      where.instanceId = instance.id;
    }

    if (opts.state) where.status = opts.state;
    if (opts.since) where.createdAt = { gte: opts.since };

    const cursor = this.decodeCursor(opts.cursor);
    if (cursor) {
      where.AND = [
        {
          OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
        },
      ];
    }

    const rows = await platformRepository.platformMessageCommand.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    return {
      messages: await Promise.all(page.map((row) => this.toStatus(row))),
      nextCursor: hasMore ? this.encodeCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * The receipt the engine recorded for a message.
   *
   * The engine writes the receipt on the message row, keyed by the
   * WhatsApp message id — the same id the platform stores as the
   * command's `engineRef`.
   */
  private async deliveryFor(engineRef: string | null): Promise<DeliveryState | null> {
    if (!engineRef) return null;
    try {
      const rows = await platformRepository.$queryRaw<{ rank: number | null }[]>`
        SELECT max(CASE mu."status"
                 WHEN 'READ' THEN 4
                 WHEN 'DELIVERY_ACK' THEN 3
                 WHEN 'SERVER_ACK' THEN 2
                 WHEN 'PENDING' THEN 1
                 ELSE 0 END) AS rank
        FROM "MessageUpdate" mu WHERE mu."keyId" = ${engineRef}
      `;
      const rank = Number(rows?.[0]?.rank ?? 0);
      return rank ? (DELIVERY_BY_RANK[rank] ?? 'unknown') : null;
    } catch {
      // The engine's store is not part of the platform's contract; a
      // missing receipt must not fail the read.
      return null;
    }
  }

  /**
   * How a batch of messages is doing.
   *
   * One query: the platform's own states, joined to the engine's
   * receipts, grouped by both. The failure breakdown is a second query
   * over the same window.
   */
  public async summary(
    accountId: string,
    opts: { instancePublicId?: string; since?: Date } = {},
  ): Promise<MessageSummary> {
    const instanceId = opts.instancePublicId
      ? (
          await platformRepository.platformInstance.findFirst({
            where: { publicId: opts.instancePublicId, accountId },
            select: { id: true },
          })
        )?.id
      : null;

    const since = opts.since ?? new Date(0);

    // The instance filter is composed, not interpolated: Prisma's tagged
    // template treats an interpolated string as a VALUE, so a raw
    // fragment put through it would be bound as a parameter — and the
    // query would fail with a syntax error at the placeholder.
    const instanceFilter = instanceId ? Prisma.sql`AND c."instanceId" = ${instanceId}` : Prisma.empty;

    const grouped = await platformRepository.$queryRaw<
      {
        state: string;
        delivery_rank: number | null;
        count: number;
      }[]
    >(Prisma.sql`
      SELECT c."status" AS state, r.rank AS delivery_rank, count(*)::int AS count
      FROM "PlatformMessageCommand" c
      LEFT JOIN LATERAL (
        SELECT max(CASE mu."status"
                 WHEN 'READ' THEN 4
                 WHEN 'DELIVERY_ACK' THEN 3
                 WHEN 'SERVER_ACK' THEN 2
                 WHEN 'PENDING' THEN 1
                 ELSE 0 END) AS rank
        FROM "MessageUpdate" mu WHERE mu."keyId" = c."engineRef"
      ) r ON TRUE
      WHERE c."accountId" = ${accountId}
        AND c."createdAt" >= ${since}
        ${instanceFilter}
      GROUP BY c."status", r.rank
    `);

    const byState: Record<string, number> = {};
    const byDelivery: Record<string, number> = {};
    let total = 0;

    for (const row of grouped) {
      const count = row.count;
      total += count;
      byState[row.state] = (byState[row.state] ?? 0) + count;

      // A message that never reached WhatsApp has no receipt, so it is
      // counted as never sent rather than as an unknown delivery.
      if (row.state === 'sent') {
        const delivery = DELIVERY_BY_RANK[Number(row.delivery_rank) || 0] ?? 'unknown';
        byDelivery[delivery] = (byDelivery[delivery] ?? 0) + count;
      }
    }

    const failureInstanceFilter = instanceId ? Prisma.sql`AND "instanceId" = ${instanceId}` : Prisma.empty;

    const failures = await platformRepository.$queryRaw<{ reason: string | null; count: number }[]>(Prisma.sql`
      SELECT "lastError" AS reason, count(*)::int AS count
      FROM "PlatformMessageCommand"
      WHERE "accountId" = ${accountId}
        AND "createdAt" >= ${since}
        AND "status" IN ('failed', 'skipped')
        AND "lastError" IS NOT NULL
        ${failureInstanceFilter}
      GROUP BY "lastError"
      ORDER BY count(*) DESC
      LIMIT 20
    `);

    const sent = byState.sent ?? 0;
    const delivered = (byDelivery.delivered ?? 0) + (byDelivery.read ?? 0);

    return {
      total,
      byState,
      byDelivery,
      failures: failures.map((row) => ({ reason: row.reason ?? 'unknown', count: row.count })),
      sentButNotDelivered: Math.max(0, sent - delivered),
      neverSent: (byState.queued ?? 0) + (byState.processing ?? 0),
    };
  }

  private async toStatus(row: {
    id: string;
    messageId: string;
    type: string;
    recipient: string;
    status: string;
    attempts: number;
    createdAt: Date;
    sentAt: Date | null;
    lastError: string | null;
    updatedAt: Date;
    instanceId: string;
    engineRef: string | null;
  }): Promise<MessageStatus> {
    const instance = await platformRepository.platformInstance.findFirst({
      where: { id: row.instanceId },
      select: { publicId: true },
    });

    return {
      id: row.messageId,
      state: (row.status as MessageState) ?? 'queued',
      type: row.type,
      to: row.recipient,
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      lastError: row.lastError,
      instancePublicId: instance?.publicId ?? null,
      delivery: await this.deliveryFor(row.engineRef),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** `createdAt|id`, base64url. */
  private encodeCursor(row: { createdAt: Date; id: string }): string {
    return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const separator = raw.indexOf('|');
      if (separator <= 0) return null;
      const createdAt = new Date(raw.slice(0, separator));
      if (Number.isNaN(createdAt.getTime())) return null;
      return { createdAt, id: raw.slice(separator + 1) };
    } catch {
      return null;
    }
  }
}

export const messageStatusService = new MessageStatusService();
