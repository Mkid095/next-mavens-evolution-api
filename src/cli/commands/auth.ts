/**
 * `viventure login | logout | config` — manage the local CLI configuration.
 *
 * The key is stored in ~/.viventure/config.json with 0600 permissions and is
 * never printed in full.
 */

import fs from 'node:fs';

import { Command } from 'commander';

import { ApiClient, describeError } from '../client';
import { clearStoredApiKey, configPath, readStoredConfig, writeStoredConfig } from '../config';
import { CliContext, CliError, GlobalOptions } from '../context';
import { addCommonOptions, addJsonOption, globalOptions, resolveOption } from '../options';
import { bold, dim, maskSecret, renderKeyValue } from '../output';

const KEY_PREFIX = 'fidscript_sk_';

/** Ask the user for a secret without echoing it to the terminal. */
async function promptSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  process.stderr.write(question);
  if (stdin.setRawMode) stdin.setRawMode(true);

  return new Promise<string>((resolve) => {
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      if (stdin.setRawMode && !wasRaw) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

/** Cheap sanity check on the key shape — the API remains the source of truth. */
function looksLikeApiKey(key: string): boolean {
  if (!key.startsWith(KEY_PREFIX)) return false;
  const suffix = key.slice(KEY_PREFIX.length);
  return /^[0-9a-f]{64}$/i.test(suffix);
}

export function registerAuthCommands(program: Command): void {
  // ── login ─────────────────────────────────────────────────────────────────
  const login = program
    .command('login')
    .description('Store an API key (and optionally the API URL) in ~/.viventure/config.json')
    .argument('[key]', 'The API key — prompt for it when omitted')
    .option('--url <url>', 'The Viventure API base URL')
    .action(async (keyArg: string | undefined, options: { url?: string }, command: Command) => {
      const globals = globalOptions(command);
      const apiUrl = options.url ?? globals.apiUrl;
      const ctx = new CliContext({ ...globals, apiUrl, apiKey: undefined } as GlobalOptions);

      let key = keyArg ?? resolveOption<string>(command, 'apiKey');
      if (!key) {
        if (!process.stdin.isTTY) {
          throw new CliError('No API key given.', [
            'Pass it as an argument: `viventure login <key>`',
            'or set VIVENTURE_API_KEY.',
          ]);
        }
        key = (await promptSecret('API key (input is hidden): ')).trim();
      }
      key = key.trim();

      if (!looksLikeApiKey(key)) {
        throw new CliError(`"${maskSecret(key)}" does not look like a Viventure API key.`, [
          `Keys look like ${KEY_PREFIX}<64 hex characters>.`,
          'You can find one in the dashboard under Settings → API keys.',
        ]);
      }

      const client = new ApiClient({ baseUrl: ctx.config.apiUrl, apiKey: key });
      let account: { publicId: string; status: string; plan?: { name: string } | null };
      try {
        account = await client.me();
      } catch (error) {
        const described = describeError(error, ctx.config.apiUrl);
        throw new CliError(`The API key was rejected by ${ctx.config.apiUrl}. ${described.message}`, described.hints);
      }

      const stored = readStoredConfig();
      stored.apiKey = key;
      stored.apiUrl = ctx.config.apiUrl;
      writeStoredConfig(stored);

      const plan = account.plan?.name ? ` on the ${account.plan.name} plan` : '';
      ctx.printer.success(`Logged in to ${ctx.config.apiUrl} as ${bold(account.publicId)}${plan}.`);
      ctx.printer.info(dim(`Key stored in ${configPath()} (masked: ${maskSecret(key)}).`));
    });
  addCommonOptions(login);

  // ── logout ────────────────────────────────────────────────────────────────
  const logout = program
    .command('logout')
    .description('Remove the stored API key')
    .option('--all', 'Also remove the stored API URL and the whole config file')
    .action(async (options: { all?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      if (options.all) {
        try {
          fs.rmSync(configPath());
        } catch {
          /* nothing to remove */
        }
        ctx.printer.success('Removed the stored configuration.');
        return;
      }
      clearStoredApiKey();
      ctx.printer.success('Removed the stored API key.');
      ctx.printer.info(dim('The API URL was kept — run `viventure logout --all` to remove it too.'));
    });
  addCommonOptions(logout);

  // ── config ────────────────────────────────────────────────────────────────
  const config = program
    .command('config')
    .description('Show the current configuration (the API key is masked)')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      const payload = {
        apiUrl: ctx.config.apiUrl,
        apiUrlSource: ctx.config.sources.apiUrl,
        apiKey: maskSecret(ctx.config.apiKey),
        apiKeySource: ctx.config.apiKey ? ctx.config.sources.apiKey : 'unset',
        docsUrl: ctx.config.docsUrl,
        docsUrlSource: ctx.config.sources.docsUrl,
        configFile: configPath(),
      };

      ctx.printer.result(payload, () =>
        [
          renderKeyValue([
            ['API URL', ctx.config.apiUrl],
            ['API key', maskSecret(ctx.config.apiKey)],
            ['Docs URL', ctx.config.docsUrl],
            ['Config file', configPath()],
          ]),
          '',
          dim(
            `sources — api url: ${ctx.config.sources.apiUrl}, api key: ${ctx.config.apiKey ? ctx.config.sources.apiKey : 'unset'}, docs url: ${ctx.config.sources.docsUrl}`,
          ),
        ].join('\n'),
      );
    });
  addCommonOptions(config);
  addJsonOption(config);
}
