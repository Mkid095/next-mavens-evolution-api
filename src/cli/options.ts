/**
 * Option helpers shared by every Viventure CLI command.
 */

import { Command } from 'commander';

import { GlobalOptions } from './context';

/**
 * Add the options that are accepted everywhere.
 * They are declared on the root program *and* on every leaf command so that
 * `viventure --api-url X instances list` and `viventure instances list --api-url X`
 * both work.
 */
export function addCommonOptions(command: Command): Command {
  return command
    .option('--api-url <url>', 'Override the Viventure API base URL')
    .option('--api-key <key>', 'Use this API key instead of the configured one')
    .option('--timeout <seconds>', 'HTTP request timeout in seconds', '30')
    .option('--no-color', 'Disable coloured output');
}

/** Add the `--json` switch used by list-style commands. */
export function addJsonOption(command: Command): Command {
  return command.option('--json', 'Print the raw API response as JSON');
}

/**
 * Read an option, honouring the nearest command that actually received it.
 * Commander stores the value on the command that declared *and* parsed it,
 * so walking up the chain (leaf → root) finds the right one.
 */
export function resolveOption<T>(command: Command, name: string): T | undefined {
  let current: Command | null = command;
  while (current) {
    const source = current.getOptionValueSource(name);
    if (source && source !== 'default') {
      const value = current.getOptionValue(name);
      if (value !== undefined) return value as T;
    }
    current = current.parent;
  }
  return undefined;
}

/** Collect the effective global options for a command invocation. */
export function globalOptions(command: Command): GlobalOptions {
  const timeoutRaw = resolveOption<string>(command, 'timeout');
  const timeout = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  return {
    apiUrl: resolveOption<string>(command, 'apiUrl'),
    apiKey: resolveOption<string>(command, 'apiKey'),
    json: resolveOption<boolean>(command, 'json'),
    color: resolveOption<boolean>(command, 'color'),
    timeout: Number.isFinite(timeout as number) ? (timeout as number) : undefined,
  };
}
