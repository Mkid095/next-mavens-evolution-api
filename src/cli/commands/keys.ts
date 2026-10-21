/**
 * `viventure keys …` — manage the account's personal access tokens.
 *
 * Endpoints used (all under /api/v1):
 *   GET    /accounts/:accountId/api-keys
 *   POST   /accounts/:accountId/api-keys
 *   DELETE /accounts/:accountId/api-keys/:keyId
 */

import { Command } from 'commander';

import { KNOWN_SCOPES as MCP_KNOWN_SCOPES } from '../../platform/mcp/tool-registry';
import { ApiKeyDto } from '../client';
import { CliContext, confirm, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, color, dim, formatDate, renderKeyValue, renderTable } from '../output';

/** Scopes the platform understands — shown in the command help. */
const KNOWN_SCOPES = MCP_KNOWN_SCOPES;

export function registerKeysCommand(program: Command): void {
  const keys = program.command('keys').description('Manage API keys (personal access tokens)');

  const list = keys
    .command('list')
    .description('List the API keys of the account')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const apiKeys = await client.get<ApiKeyDto[]>(`/accounts/${accountId}/api-keys`);

        ctx.printer.result(apiKeys, () => {
          if (!apiKeys.length) {
            return 'No API keys yet — create one with `viventure keys create --name <name>`.';
          }
          const rows = apiKeys.map((key) => [
            cell(key.id),
            cell(key.name ?? ''),
            cell((key.scopes ?? []).join(', ') || dim('(none)')),
            cell(key.keyPrefix ?? ''),
            cell(formatDate(key.createdAt)),
            cell(formatDate(key.lastUsedAt) || '—'),
            cell(key.revokedAt ? 'revoked' : 'active', key.revokedAt ? 'red' : 'green'),
          ]);
          return renderTable(['ID', 'NAME', 'SCOPES', 'PREFIX', 'CREATED', 'LAST USED', 'STATUS'], rows);
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(list);
  addJsonOption(list);

  const create = keys
    .command('create')
    .description('Create a new API key')
    .requiredOption('--name <name>', 'A label for the key, e.g. "CI pipeline"')
    .option(
      '--scope <scope>',
      `Scope to grant — repeatable. Known scopes: ${KNOWN_SCOPES.join(', ')}`,
      collectScope,
      [],
    )
    .action(async (options: { name: string; scope: string[] }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const scopes = options.scope ?? [];
        const response = await client.post<{ id: string; name: string; scopes: string[]; apiKey: string }>(
          `/accounts/${accountId}/api-keys`,
          { name: options.name, scopes },
        );

        ctx.printer.result(response, () => {
          const granted = response.scopes ?? scopes;
          const lines = [
            color('API key created', 'green'),
            renderKeyValue([
              ['Id', response.id],
              ['Name', response.name ?? options.name],
              ['Scopes', granted.join(', ') || dim('(none)')],
            ]),
            '',
            color('Your new key (shown once — it is not recoverable):', 'yellow'),
            `  ${response.apiKey ?? dim('(the API did not return a key — check the platform logs)')}`,
            '',
            dim('Store it now. `viventure keys list` will only ever show its prefix.'),
          ];
          if (!granted.length) {
            lines.push(
              '',
              color('warning: this key has no scopes, so MCP tool calls will be rejected.', 'yellow'),
              dim(`  grant scopes with --scope ${KNOWN_SCOPES.slice(0, 3).join(' --scope ')}`),
            );
          }
          return lines.join('\n');
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(create);
  addJsonOption(create);

  const revoke = keys
    .command('revoke')
    .description('Revoke an API key (destructive)')
    .argument('<keyId>', 'Key public id (key_…)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (keyId: string, options: { yes?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();

        const ok = await confirm(`Revoke API key ${keyId}? Anything using it stops working.`, Boolean(options.yes));
        if (!ok) {
          ctx.printer.info('Aborted.');
          return;
        }

        const result = await client.delete<{ success: boolean }>(`/accounts/${accountId}/api-keys/${keyId}`);
        ctx.printer.result(result, `API key ${keyId} revoked.`);
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(revoke);
  addJsonOption(revoke);
}

/** Collect a repeatable `--scope` option. */
function collectScope(value: string, previous: string[]): string[] {
  return previous.concat(value);
}
