/**
 * `viventure instances …` — provision, inspect and pair WhatsApp instances.
 *
 * Endpoints used (all under /api/v1):
 *   GET    /accounts/:accountId/instances
 *   POST   /accounts/:accountId/instances
 *   GET    /accounts/:accountId/instances/:instId
 *   POST   /accounts/:accountId/instances/:instId/connect
 *   POST   /accounts/:accountId/instances/:instId/disconnect
 *   DELETE /accounts/:accountId/instances/:instId
 */

import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { InstanceDto } from '../client';
import { configDir } from '../config';
import { CliContext, CliError, confirm, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, color, colorStatus, formatDate, renderKeyValue, renderTable, shorten } from '../output';

const TERMINAL_STATUSES = ['DISCONNECTED', 'SUSPENDED', 'ERROR', 'FAILED'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist the pairing QR image returned by the API and return its path.
 * The API exposes the QR as a base64 PNG data URL — there is no plain-text
 * QR payload to render as ASCII art.
 */
function saveQrImage(publicId: string, dataUrl: string): string | null {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl.trim());
  if (!match) return null;
  try {
    const dir = path.join(configDir(), 'qr');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${publicId}.png`);
    fs.writeFileSync(file, Buffer.from(match[1], 'base64'));
    return file;
  } catch {
    return null;
  }
}

function instanceSummary(instance: InstanceDto): [string, string, string, string, string] {
  return [
    instance.publicId ?? instance.id,
    instance.name ?? '',
    instance.status ?? '',
    instance.phoneNumber ?? '—',
    formatDate(instance.createdAt),
  ];
}

export function registerInstancesCommand(program: Command): void {
  const instances = program.command('instances').description('Manage WhatsApp instances');

  // ── instances list ────────────────────────────────────────────────────────
  const list = instances
    .command('list')
    .description('List the instances that belong to the account')
    .option('--limit <n>', 'Maximum number of instances to show')
    .action(async (options: { limit?: string }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const instances = await client.get<InstanceDto[]>(`/accounts/${accountId}/instances`);
        const limited = options.limit ? instances.slice(0, Number(options.limit)) : instances;

        ctx.printer.result(limited, () => {
          if (!limited.length) {
            return 'No instances yet — create one with `viventure instances create <name>`.';
          }
          const rows = limited.map((instance) => {
            const [id, name, status, phone, created] = instanceSummary(instance);
            return [cell(id), cell(shorten(name, 28)), cell(status, statusColor(status)), cell(phone), cell(created)];
          });
          return renderTable(['ID', 'NAME', 'STATUS', 'PHONE', 'CREATED'], rows);
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(list);
  addJsonOption(list);

  // ── instances create ──────────────────────────────────────────────────────
  const create = instances
    .command('create')
    .description('Create a new instance')
    .argument('<name>', 'Human readable instance name')
    .action(async (name: string, options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const instance = await client.post<InstanceDto>(`/accounts/${accountId}/instances`, { name });

        ctx.printer.result(instance, () =>
          [
            color('Instance created', 'green'),
            renderKeyValue([
              ['ID', instance.publicId ?? instance.id],
              ['Name', instance.name],
              ['Status', colorStatus(instance.status)],
              ['Phone', instance.phoneNumber ?? '—'],
              ['Created', formatDate(instance.createdAt)],
            ]),
            '',
            `Next: ${color(`viventure instances connect ${instance.publicId ?? instance.id}`, 'cyan')}`,
          ].join('\n'),
        );
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(create);
  addJsonOption(create);

  // ── instances get ─────────────────────────────────────────────────────────
  const get = instances
    .command('get')
    .description('Show a single instance')
    .argument('<publicId>', 'Instance public id (inst_…)')
    .action(async (publicId: string, options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const instance = await client.get<InstanceDto>(`/accounts/${accountId}/instances/${publicId}`);

        ctx.printer.result(instance, () => {
          const lines = [
            renderKeyValue([
              ['ID', instance.publicId ?? instance.id],
              ['Name', instance.name],
              ['Status', colorStatus(instance.status)],
              ['Phone', instance.phoneNumber ?? '—'],
              ['Connected at', formatDate(instance.connectedAt ?? instance.lastConnectedAt)],
              ['Created', formatDate(instance.createdAt)],
            ]),
          ];
          const qr = instance.qrCode;
          if (qr?.base64) {
            const file = saveQrImage(publicId, qr.base64);
            lines.push('', color('Pairing QR code', 'bold'));
            if (file) {
              lines.push(`  image:  ${file}`);
            }
            if (qr.pairingCode) {
              lines.push(`  code:   ${qr.pairingCode}   ${color('(pair with phone number → Linked devices)', 'dim')}`);
            }
          }
          return lines.join('\n');
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(get);
  addJsonOption(get);

  // ── instances connect ─────────────────────────────────────────────────────
  const connect = instances
    .command('connect')
    .description('Connect an instance and wait for the pairing QR code')
    .argument('<publicId>', 'Instance public id (inst_…)')
    .option('--wait <seconds>', 'How long to wait for the connection', '120')
    .option('--poll <milliseconds>', 'Polling interval', '2000')
    .action(async (publicId: string, options: { wait: string; poll: string }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      const waitMs = Math.max(0, Number(options.wait) * 1000);
      const pollMs = Math.max(250, Number(options.poll));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();

        const start = await client.post<{ success: boolean; status: string }>(
          `/accounts/${accountId}/instances/${publicId}/connect`,
        );
        ctx.printer.info(`Connect requested — status ${start?.status ?? 'CONNECTING'}.`);

        const deadline = Date.now() + waitMs;
        let lastStatus = '';
        let lastQr = '';
        let connected = false;

        while (Date.now() < deadline) {
          const instance = await client.get<InstanceDto>(`/accounts/${accountId}/instances/${publicId}`);

          if (instance.status !== lastStatus) {
            lastStatus = instance.status;
            ctx.printer.info(`status: ${colorStatus(instance.status)}`);
          }

          const qr = instance.qrCode;
          if (qr?.base64 && qr.base64 !== lastQr) {
            lastQr = qr.base64;
            const file = saveQrImage(publicId, qr.base64);
            ctx.printer.info(color('A pairing QR code is available:', 'bold'));
            if (file) {
              ctx.printer.info(`  image:  ${file}`);
            }
            if (qr.pairingCode) {
              ctx.printer.info(`  code:   ${qr.pairingCode}   (WhatsApp → Linked devices → Link with phone number)`);
            }
            ctx.printer.info('  scan it with WhatsApp on the phone you want to connect.');
          }

          if (instance.status === 'CONNECTED') {
            connected = true;
            ctx.printer.result(
              { ...instance, connected: true },
              [
                color('Instance connected', 'green'),
                renderKeyValue([
                  ['ID', instance.publicId ?? instance.id],
                  ['Name', instance.name],
                  ['Phone', instance.phoneNumber ?? '—'],
                ]),
              ].join('\n'),
            );
            break;
          }

          if (TERMINAL_STATUSES.includes((instance.status ?? '').toUpperCase())) {
            throw new CliError(`The instance could not be connected — status is ${instance.status}.`, [
              'Check the platform logs, then retry with `viventure instances connect <id>`.',
            ]);
          }

          await sleep(pollMs);
        }

        if (!connected) {
          throw toCliError(
            new Error(`Timed out after ${Math.round(waitMs / 1000)}s waiting for the instance to connect.`),
            ctx.config.apiUrl,
            [
              'The pairing QR code may still be waiting — run `viventure instances get <id>` to fetch it again.',
              'Increase the wait with --wait <seconds>.',
            ],
          );
        }
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(connect);
  addJsonOption(connect);

  // ── instances disconnect ──────────────────────────────────────────────────
  const disconnect = instances
    .command('disconnect')
    .description('Disconnect an instance')
    .argument('<publicId>', 'Instance public id (inst_…)')
    .action(async (publicId: string, options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const result = await client.post<{ success: boolean; status: string }>(
          `/accounts/${accountId}/instances/${publicId}/disconnect`,
        );
        ctx.printer.result(result, `Instance ${publicId} disconnected (${result?.status ?? 'DISCONNECTED'}).`);
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(disconnect);
  addJsonOption(disconnect);

  // ── instances delete ──────────────────────────────────────────────────────
  const remove = instances
    .command('delete')
    .description('Delete an instance (destructive)')
    .argument('<publicId>', 'Instance public id (inst_…)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (publicId: string, options: { yes?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();

        const ok = await confirm(`Delete instance ${publicId}? This cannot be undone.`, Boolean(options.yes));
        if (!ok) {
          ctx.printer.info('Aborted.');
          return;
        }

        const result = await client.delete<{ success: boolean }>(`/accounts/${accountId}/instances/${publicId}`);
        ctx.printer.result(result, `Instance ${publicId} deleted.`);
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(remove);
  addJsonOption(remove);
}

function statusColor(status: string): 'green' | 'yellow' | 'red' | undefined {
  switch ((status ?? '').toUpperCase()) {
    case 'CONNECTED':
      return 'green';
    case 'CONNECTING':
    case 'CREATED':
      return 'yellow';
    case 'DISCONNECTED':
    case 'SUSPENDED':
    case 'ERROR':
      return 'red';
    default:
      return undefined;
  }
}
