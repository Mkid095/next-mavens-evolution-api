/**
 * The `viventure` command tree.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { registerAuthCommands } from './commands/auth';
import { registerDocsCommand } from './commands/docs';
import { registerInstancesCommand } from './commands/instances';
import { registerKeysCommand, registerProjectKeysCommand } from './commands/keys';
import { registerMcpCommand } from './commands/mcp';
import { registerMessagesCommand } from './commands/messages';
import { registerProjectsCommand } from './commands/projects';
import { registerWebhooksCommand } from './commands/webhooks';
import { addCommonOptions } from './options';

/** Fallback version — the real one is read from package.json at runtime. */
export const FALLBACK_VERSION = '1.0.0';

/**
 * Read the CLI version from the package manifest.
 *
 * The manifest is not in the same place in every layout the CLI runs in:
 *
 *   - in the repository, the bundle is `dist/cli/index.js` and the
 *     manifest is two levels up;
 *   - in the published `@viventure/cli` package, the bundle is
 *     `bin/viventure.js` and the manifest is one level up.
 *
 * So every candidate is tried and the first manifest that carries a
 * version wins.
 */
export function readVersion(): string {
  if (typeof __dirname === 'undefined') return FALLBACK_VERSION;

  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'), // dist/cli/index.js
    path.join(__dirname, '..', 'package.json'), // bin/viventure.js
    path.join(__dirname, 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (manifest?.version) return String(manifest.version);
    } catch {
      /* try the next one */
    }
  }
  return FALLBACK_VERSION;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('viventure')
    .description('Developer CLI for the Viventure WhatsApp platform')
    .version(readVersion(), '-v, --version', 'print the CLI version')
    .showHelpAfterError('(run `viventure --help` to see the available commands)')
    .addHelpText(
      'after',
      `
Examples:
  $ viventure login <api-key>
  $ viventure instances list --json | jq '.[].publicId'
  $ viventure instances create support-bot
  $ viventure instances connect inst_1a2b3c4d
  $ viventure messages send --instance inst_1a2b3c4d --to +5511999999999 --text "hi"
  $ viventure keys create --name "CI" --scope instances:read --scope messages:send
  $ viventure keys default
  $ viventure project keys list --project marketing-site
  $ viventure instances list --project marketing-site
  $ viventure mcp config
  $ viventure docs webhooks

Configuration:
  flags  →  VIVENTURE_API_URL / VIVENTURE_API_KEY  →  ~/.viventure/config.json
`,
    );

  addCommonOptions(program);
  program.option('--json', 'Print raw JSON where the command supports it');

  registerAuthCommands(program);
  registerProjectsCommand(program);
  registerInstancesCommand(program);
  registerMessagesCommand(program);
  registerKeysCommand(program);
  registerProjectKeysCommand(program);
  registerWebhooksCommand(program);
  registerMcpCommand(program);
  registerDocsCommand(program);

  return program;
}
