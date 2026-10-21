/**
 * `viventure keys …` — manage the account's personal access tokens.
 *
 * A personal access token is NOT scoped to a project: it can act on every
 * project of the account. The project-scoped keys live under
 * `viventure project keys …`.
 *
 * Endpoints used (all under /api/v1):
 *   GET    /accounts/:accountId/api-keys
 *   POST   /accounts/:accountId/api-keys
 *   DELETE /accounts/:accountId/api-keys/:keyId
 *   GET    /accounts/:accountId/api-keys/default
 *   POST   /accounts/:accountId/api-keys/default/rotate
 */

import { Command } from 'commander';

import { KNOWN_SCOPES as MCP_KNOWN_SCOPES } from '../../platform/mcp/tool-registry';
import { ApiKeyDto, DefaultTokenDto } from '../client';
import { CliContext, confirm, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, color, dim, formatDate, renderKeyValue, renderTable } from '../output';

/** Scopes the platform understands — shown in the command help. */
const KNOWN_SCOPES = MCP_KNOWN_SCOPES;

export function registerKeysCommand(program: Command): void {
  const keys = program.command('keys').description('Manage personal access tokens (they can act on every project)');

  // ── keys list ───────────────────────────────────────────────────────────
  const list = keys
    .command('list')
    .description('List the personal access tokens of the account')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const apiKeys = await client.get<ApiKeyDto[]>(`/accounts/${accountId}/api-keys`);

        ctx.printer.result(apiKeys, () => {
          if (!apiKeys.length) {
            return 'No personal access tokens yet — create one with `viventure keys create --name <name>`.';
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

  // ── keys create ─────────────────────────────────────────────────────────
  const create = keys
    .command('create')
    .description('Create a new personal access token')
    .requiredOption('--name <name>', 'A label for the token, e.g. "CI pipeline"')
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
            color('Personal access token created', 'green'),
            renderKeyValue([
              ['Id', response.id],
              ['Name', response.name ?? options.name],
              ['Scopes', granted.join(', ') || dim('(none)')],
            ]),
            '',
            color('Your new token (shown once — it is not recoverable):', 'yellow'),
            `  ${response.apiKey ?? dim('(the API did not return a token — check the platform logs)')}`,
            '',
            dim('Store it now. `viventure keys list` will only ever show its prefix.'),
          ];
          if (!granted.length) {
            lines.push(
              '',
              color('warning: this token has no scopes, so MCP tool calls will be rejected.', 'yellow'),
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

  // ── keys revoke ─────────────────────────────────────────────────────────
  const revoke = keys
    .command('revoke')
    .description('Revoke a personal access token (destructive)')
    .argument('<keyId>', 'Token public id (key_…)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (keyId: string, options: { yes?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();

        const ok = await confirm(
          `Revoke personal access token ${keyId}? Anything using it stops working.`,
          Boolean(options.yes),
        );
        if (!ok) {
          ctx.printer.info('Aborted.');
          return;
        }

        const result = await client.delete<{ success: boolean }>(`/accounts/${accountId}/api-keys/${keyId}`);
        ctx.printer.result(result, `Personal access token ${keyId} revoked.`);
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(revoke);
  addJsonOption(revoke);

  // ── keys default ────────────────────────────────────────────────────────
  // The account's personal access token. It is generated on first read and
  // its plaintext is returned, because the MCP and CLI install guides need
  // to show a configuration that actually works.
  const showDefault = keys
    .command('default')
    .description("Show the account's personal access token")
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const token = await client.get<DefaultTokenDto>(`/accounts/${accountId}/api-keys/default`);

        ctx.printer.result(token, () => {
          const table = renderKeyValue([
            ['ID', token.id],
            ['Name', token.name],
            ['Prefix', token.keyPrefix],
            ['Scopes', token.scopes.join(', ')],
            ['Created', formatDate(token.createdAt)],
            ['Key', token.key],
          ]);
          return `${table}\n\nTreat the key above as a secret — it authenticates every request.`;
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(showDefault);
  addJsonOption(showDefault);

  // ── keys rotate ─────────────────────────────────────────────────────────
  // Issues a new personal access token and revokes the old one immediately.
  const rotate = keys
    .command('rotate')
    .description('Issue a new personal access token and revoke the old one')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (options: { yes?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();

        const ok = await confirm(
          'Rotate the personal access token? Anything using the current one stops working immediately.',
          Boolean(options.yes),
        );
        if (!ok) {
          ctx.printer.info('Aborted.');
          return;
        }

        const token = await client.post<DefaultTokenDto>(`/accounts/${accountId}/api-keys/default/rotate`, {});
        ctx.printer.result(token, () =>
          renderKeyValue([
            ['ID', token.id],
            ['Prefix', token.keyPrefix],
            ['Key', token.key],
          ]),
        );
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(rotate);
  addJsonOption(rotate);
}

/**
 * `viventure project keys …` — manage the keys of ONE project.
 *
 * A project key can only act inside its own project. Use
 * `viventure keys …` for the account-wide personal access token.
 */
export function registerProjectKeysCommand(program: Command): void {
  const project = program.command('project').description('Work with one project (its instances, keys and webhooks)');
  const keys = project.command('keys').description("Manage a project's API keys");

  // ── project keys list ───────────────────────────────────────────────────
  const list = keys
    .command('list')
    .description('List the API keys of the project')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const projectId = await ctx.projectId();
        const client = ctx.client();
        const apiKeys = await client.get<ApiKeyDto[]>(`/accounts/${accountId}/projects/${projectId}/api-keys`);

        ctx.printer.result(apiKeys, () => {
          if (!apiKeys.length) {
            return 'No API keys for this project yet — create one with `viventure project keys create --name <name>`.';
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

  // ── project keys create ─────────────────────────────────────────────────
  const create = keys
    .command('create')
    .description('Create a new API key for the project')
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
        const projectId = await ctx.projectId();
        const client = ctx.client();
        const scopes = options.scope ?? [];
        const response = await client.post<{ id: string; name: string; scopes: string[]; apiKey: string }>(
          `/accounts/${accountId}/projects/${projectId}/api-keys`,
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
            dim('Store it now. `viventure project keys list` will only ever show its prefix.'),
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

  // ── project keys revoke ─────────────────────────────────────────────────
  const revoke = keys
    .command('revoke')
    .description('Revoke one of the project API keys (destructive)')
    .argument('<keyId>', 'Key public id (key_…)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (keyId: string, options: { yes?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const projectId = await ctx.projectId();
        const client = ctx.client();

        const ok = await confirm(`Revoke API key ${keyId}? Anything using it stops working.`, Boolean(options.yes));
        if (!ok) {
          ctx.printer.info('Aborted.');
          return;
        }

        const result = await client.delete<{ success: boolean }>(
          `/accounts/${accountId}/projects/${projectId}/api-keys/${keyId}`,
        );
        ctx.printer.result(result, `API key ${keyId} revoked.`);
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(revoke);
  addJsonOption(revoke);

  // ── project keys default ────────────────────────────────────────────────
  const showDefault = keys
    .command('default')
    .description("Show the project's default API token")
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const projectId = await ctx.projectId();
        const client = ctx.client();
        const token = await client.get<DefaultTokenDto>(
          `/accounts/${accountId}/projects/${projectId}/api-keys/default`,
        );

        ctx.printer.result(token, () => {
          const table = renderKeyValue([
            ['ID', token.id],
            ['Name', token.name],
            ['Prefix', token.keyPrefix],
            ['Scopes', token.scopes.join(', ')],
            ['Created', formatDate(token.createdAt)],
            ['Key', token.key],
          ]);
          return `${table}\n\nTreat the key above as a secret — it authenticates every request.`;
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(showDefault);
  addJsonOption(showDefault);

  // ── project keys rotate ─────────────────────────────────────────────────
  const rotate = keys
    .command('rotate')
    .description('Issue a new default API token for the project and revoke the old one')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (options: { yes?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const projectId = await ctx.projectId();
        const client = ctx.client();

        const ok = await confirm(
          'Rotate the default API token? Anything using the current one stops working immediately.',
          Boolean(options.yes),
        );
        if (!ok) {
          ctx.printer.info('Aborted.');
          return;
        }

        const token = await client.post<DefaultTokenDto>(
          `/accounts/${accountId}/projects/${projectId}/api-keys/default/rotate`,
          {},
        );
        ctx.printer.result(token, () =>
          renderKeyValue([
            ['ID', token.id],
            ['Prefix', token.keyPrefix],
            ['Key', token.key],
          ]),
        );
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(rotate);
  addJsonOption(rotate);
}

/** Collect a repeatable `--scope` option. */
function collectScope(value: string, previous: string[]): string[] {
  return previous.concat(value);
}
