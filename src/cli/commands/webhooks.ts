/**
 * `viventure webhooks …` — inspect the account's webhook subscriptions.
 *
 * Endpoint used: GET /api/v1/webhooks
 */

import { Command } from 'commander';

import { WebhookDto } from '../client';
import { CliContext, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, formatDate, renderTable, shorten } from '../output';

export function registerWebhooksCommand(program: Command): void {
  const webhooks = program.command('webhooks').description('Manage webhook subscriptions');

  const list = webhooks
    .command('list')
    .description('List the webhooks registered for the account')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const client = ctx.client();
        const hooks = await client.get<WebhookDto[]>('/webhooks');

        ctx.printer.result(hooks, () => {
          if (!hooks.length) {
            return 'No webhooks registered yet.';
          }
          const rows = hooks.map((hook) => [
            cell(hook.publicId),
            cell(shorten(hook.url, 44)),
            cell((hook.events ?? []).join(', ') || '—'),
            cell(hook.enabled ? 'enabled' : 'disabled', hook.enabled ? 'green' : 'red'),
            cell(formatDate(hook.createdAt)),
          ]);
          return renderTable(['ID', 'URL', 'EVENTS', 'STATUS', 'CREATED'], rows);
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(list);
  addJsonOption(list);
}
