/**
 * `viventure messages …` — send WhatsApp messages, and read how they went.
 *
 * Endpoints used:
 *   POST /api/v1/messages/send
 *   GET  /api/v1/messages/:messageId
 *   GET  /api/v1/messages
 *   GET  /api/v1/messages/summary
 *   POST /api/v1/messages/check-numbers
 */

import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { CliContext, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, color, dim, renderKeyValue, renderTable, shorten } from '../output';

/** The message types the platform transmits as media. */
const MEDIA_TYPES = ['image', 'video', 'document', 'audio'];

/** How a message is described in a table. */
interface MessageStatus {
  id: string;
  state: string;
  delivery: string | null;
  type: string;
  to: string;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  lastError: string | null;
  instancePublicId: string | null;
}

/**
 * Read the media for a send.
 *
 * A URL is passed straight through — the platform fetches it when the
 * message goes out, which is the better shape: the file is not carried
 * through the queue. A local path is read and sent as base64.
 */
function readMedia(media: string): { payload: string; fileName?: string; mimeType?: string } {
  if (/^https?:\/\//i.test(media)) {
    return { payload: media };
  }

  const absolute = path.resolve(media);
  if (!fs.existsSync(absolute)) {
    throw new Error(`No such file: ${absolute}`);
  }
  return {
    payload: fs.readFileSync(absolute).toString('base64'),
    fileName: path.basename(absolute),
    mimeType: mimeTypeFor(absolute),
  };
}

/** Guess a content type from a file name. */
function mimeTypeFor(file: string): string | undefined {
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.3gp': 'video/3gpp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  return types[ext];
}

export function registerMessagesCommand(program: Command): void {
  const messages = program.command('messages').description('Send WhatsApp messages, and read how they went');

  // ── send ────────────────────────────────────────────────────────────────
  const send = messages
    .command('send')
    .description('Send a message from an instance')
    .requiredOption('--instance <publicId>', 'Instance public id (inst_…) to send from')
    .requiredOption('--to <number>', 'Recipient number in international format, e.g. +254700000000')
    .option('--text <text>', 'Message body — required for a text message')
    .option(
      '--media <url-or-path>',
      'A file to send: an http(s) URL, or a local path. The file is sent as media, not as a link in a text message',
    )
    .option('--type <type>', `Message type: text, ${MEDIA_TYPES.join(', ')}`, 'text')
    .option('--caption <text>', 'Caption for a media message')
    .option('--file-name <name>', 'File name, for a document')
    .option('--idempotency-key <key>', 'Idempotency key, so a retry never sends twice')
    .action(
      async (
        options: {
          instance: string;
          to: string;
          text?: string;
          media?: string;
          type: string;
          caption?: string;
          fileName?: string;
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const ctx = new CliContext(globalOptions(command));
        try {
          if (!options.text && !options.media) {
            throw new Error('Nothing to send — pass --text, or --media.');
          }

          const body: Record<string, unknown> = {
            instancePublicId: options.instance,
            number: options.to,
            type: options.type,
          };

          if (options.media) {
            const media = readMedia(options.media);
            body.media = media.payload;
            if (media.fileName) body.fileName = media.fileName;
            if (media.mimeType) body.mimeType = media.mimeType;
            if (options.caption) body.caption = options.caption;
            if (options.fileName) body.fileName = options.fileName;
          } else {
            body.text = options.text;
          }

          const client = ctx.client();
          const response = await client.post<{ messageId: string }>(
            '/messages/send',
            body,
            options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {},
          );

          ctx.printer.result(response, () =>
            [
              color('Message queued', 'green'),
              renderKeyValue([
                ['Message id', response?.messageId ?? '—'],
                ['Instance', options.instance],
                ['To', options.to],
                ['Type', options.media ? options.type : 'text'],
              ]),
              '',
              dim('It is queued, not delivered — `viventure messages status` tells you where it got to.'),
            ].join('\n'),
          );
        } catch (error) {
          throw toCliError(error, ctx.config.apiUrl);
        }
      },
    );

  addCommonOptions(send);
  addJsonOption(send);

  // ── status ──────────────────────────────────────────────────────────────
  const status = messages
    .command('status')
    .description('Read the state of one message')
    .argument('<messageId>', 'The message id (msg_…)')
    .action(async (messageId: string, _options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const message = await ctx.client().get<MessageStatus>(`/messages/${encodeURIComponent(messageId)}`);

        ctx.printer.result(message, () =>
          [
            renderKeyValue([
              ['Message id', message.id],
              ['State', message.state],
              ['Delivery', message.delivery ?? 'unknown'],
              ['Type', message.type],
              ['To', message.to],
              ['Instance', message.instancePublicId ?? '—'],
              ['Attempts', String(message.attempts)],
              ['Queued', message.createdAt],
              ['Sent', message.sentAt ?? '—'],
              ...(message.lastError ? [['Error', message.lastError] as [string, string]] : []),
            ]),
            '',
            dim(
              'The state is the platform’s; the delivery is the receipt WhatsApp sent back. ' +
                'A message that left the platform but was never delivered is sent with a delivery of pending or accepted.',
            ),
          ].join('\n'),
        );
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  addCommonOptions(status);
  addJsonOption(status);

  // ── list ────────────────────────────────────────────────────────────────
  const list = messages
    .command('list')
    .description('List the recent messages of an instance')
    .option('--instance <publicId>', 'Only messages sent through this instance')
    .option('--state <state>', 'Only messages in this state: queued, processing, sent, failed, skipped')
    .option('--since <iso>', 'Only messages queued at or after this time')
    .option('--limit <n>', 'How many to show', '20')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const params = new URLSearchParams();
        if (options.instance) params.set('instancePublicId', String(options.instance));
        if (options.state) params.set('state', String(options.state));
        if (options.since) params.set('since', String(options.since));
        if (options.limit) params.set('limit', String(options.limit));
        const qs = params.toString();

        const page = await ctx
          .client()
          .get<{ messages: MessageStatus[]; nextCursor?: string | null }>(`/messages${qs ? `?${qs}` : ''}`);

        ctx.printer.result(page, () => {
          if (!page.messages?.length) {
            return dim('No messages match.');
          }
          const rows = page.messages.map((m) => [
            cell(m.id),
            cell(m.state),
            cell(m.delivery ?? '—'),
            cell(m.type),
            cell(m.to),
            cell(m.sentAt ? m.sentAt.replace('T', ' ').slice(0, 19) : '—'),
            cell(shorten(m.lastError ?? '', 40)),
          ]);
          return renderTable(['MESSAGE', 'STATE', 'DELIVERY', 'TYPE', 'TO', 'SENT', 'ERROR'], rows);
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  addCommonOptions(list);
  addJsonOption(list);

  // ── summary ─────────────────────────────────────────────────────────────
  const summary = messages
    .command('summary')
    .description('How a batch of messages is doing')
    .option('--instance <publicId>', 'Only messages sent through this instance')
    .option('--since <iso>', 'Only messages queued at or after this time')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const params = new URLSearchParams();
        if (options.instance) params.set('instancePublicId', String(options.instance));
        if (options.since) params.set('since', String(options.since));
        const qs = params.toString();

        const data = await ctx.client().get<{
          total: number;
          byState: Record<string, number>;
          byDelivery: Record<string, number>;
          failures: { reason: string; count: number }[];
          sentButNotDelivered: number;
          neverSent: number;
        }>(`/messages/summary${qs ? `?${qs}` : ''}`);

        ctx.printer.result(data, () => {
          const lines = [
            renderKeyValue([
              ['Total', String(data.total)],
              ['Sent', String(data.byState.sent ?? 0)],
              ['Queued', String(data.byState.queued ?? 0)],
              ['Failed', String(data.byState.failed ?? 0)],
              ['Skipped', String(data.byState.skipped ?? 0)],
              ['Delivered', String((data.byDelivery.delivered ?? 0) + (data.byDelivery.read ?? 0))],
              ['Never delivered', String(data.sentButNotDelivered)],
              ['Never sent', String(data.neverSent)],
            ]),
          ];

          const failures = data.failures ?? [];
          if (failures.length) {
            lines.push('', 'Failures:', '');
            for (const failure of failures) {
              lines.push(`  ${String(failure.count).padStart(5)}  ${failure.reason}`);
            }
          }

          lines.push(
            '',
            dim('A broadcast is not done when the last message is sent — it is done when the last recipient has it.'),
          );
          return lines.join('\n');
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  addCommonOptions(summary);
  addJsonOption(summary);

  // ── check-numbers ───────────────────────────────────────────────────────
  const check = messages
    .command('check-numbers')
    .description('Check whether numbers are on WhatsApp')
    .requiredOption('--instance <publicId>', 'Instance public id (inst_…) to check through')
    .argument('<numbers...>', 'The numbers to check')
    .action(async (numbers: string[], options: { instance: string }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const data = await ctx.client().post<{
          total: number;
          onWhatsapp: number;
          notOnWhatsapp: number;
          results: { number: string; onWhatsapp: boolean; name?: string }[];
        }>('/messages/check-numbers', {
          instancePublicId: options.instance,
          numbers,
        });

        ctx.printer.result(data, () =>
          [
            renderKeyValue([
              ['Checked', String(data.total)],
              ['On WhatsApp', String(data.onWhatsapp)],
              ['Not on WhatsApp', String(data.notOnWhatsapp)],
            ]),
            '',
            ...data.results.map(
              (r) =>
                `  ${r.onWhatsapp ? color('✓', 'green') : color('✗', 'red')} ${r.number}${r.name ? dim(` (${r.name})`) : ''}`,
            ),
            '',
            dim(
              'WhatsApp accepts a message to a number with no account and never delivers it — ' +
                'a send that succeeds is not proof of delivery.',
            ),
          ].join('\n'),
        );
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  addCommonOptions(check);
  addJsonOption(check);
}
