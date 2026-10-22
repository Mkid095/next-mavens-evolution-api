#!/usr/bin/env node
/**
 * Entry point for the Viventure developer CLI.
 *
 *   node dist/cli/index.js <command>
 *   viventure <command>          (once the package is installed)
 */

import { CliError } from './context';
import { buildProgram } from './program';

/** How to get the newest CLI, for the reader of an error. */
const UPDATE_HINT = 'update: npm install -g @viventure/cli@latest --registry https://registry.nextmavens.com';

async function main(): Promise<void> {
  const program = buildProgram();

  // Commander handles an unknown command itself — it prints the error and
  // exits, so the handler below never sees it. `exitOverride` makes it
  // throw instead, which is what lets the CLI add its own advice: a
  // command this version does not have is usually one a NEWER version
  // has.
  program.exitOverride();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (isCommanderExit(error)) {
      // --help and --version are a successful exit, not a failure.
      if (error.code === 'commander.unknownCommand') {
        process.stderr.write('  → this version of the CLI does not have that command\n');
        process.stderr.write(`  → ${UPDATE_HINT}\n`);
      }
      process.exit(error.exitCode === 0 ? 0 : 1);
    }
    throw error;
  }
}

/** Is this one of commander's own exits (help, version, unknown command)? */
function isCommanderExit(error: unknown): error is { exitCode: number; code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { exitCode?: unknown }).exitCode === 'number' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('commander.')
  );
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    process.stderr.write(`error: ${error.message}\n`);
    for (const hint of error.hints) {
      process.stderr.write(`  → ${hint}\n`);
    }
    process.exit(error.exitCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.stderr.write('  → run `viventure --help` for usage\n');
  process.exit(1);
});
