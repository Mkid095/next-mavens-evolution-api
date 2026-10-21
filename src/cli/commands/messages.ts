/**
 * `viventure messages …` — send WhatsApp messages through the public API.
 *
 * Endpoint used: POST /api/v1/messages/send
 * Body: { instancePublicId, number, text, type? }
 */

import { Command } from 'commander';

import { CliContext, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { color, renderKeyValue } from '../output';

export function registerMessagesCommand(program: Command): void {
  const messages = program.command('messages').description('Send WhatsApp messages');

  const send = messages
    .command('send')
    .description('Send a text message from an instance')
    .requiredOption('--instance <publicId>', 'Instance public id (inst_…) to send from')
    .requiredOption('--to <number>', 'Recipient number in international format, e.g. +5511999999999')
    .requiredOption('--text <text>', 'Message body')
    .option('--type <type>', 'Message type', 'text')
    .option('--idempotency-key <key>', 'Idempotency key, so a retry never sends twice')
    .action(
      async (
        options: { instance: string; to: string; text: string; type: string; idempotencyKey?: string },
        command: Command,
      ) => {
        const ctx = new CliContext(globalOptions(command));
        try {
          const client = ctx.client();
          const response = await client.post<{ messageId: string }>(
            '/messages/send',
            {
              instancePublicId: options.instance,
              number: options.to,
              text: options.text,
              type: options.type,
            },
            options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {},
          );

          ctx.printer.result(response, () =>
            [
              color('Message queued', 'green'),
              renderKeyValue([
                ['Message id', response?.messageId ?? '—'],
                ['Instance', options.instance],
                ['To', options.to],
              ]),
            ].join('\n'),
          );
        } catch (error) {
          throw toCliError(error, ctx.config.apiUrl);
        }
      },
    );

  addCommonOptions(send);
  addJsonOption(send);
}
