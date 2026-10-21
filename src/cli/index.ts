#!/usr/bin/env node
/**
 * Entry point of the Viventure developer CLI.
 *
 *   node dist/cli/index.js <command>
 *   viventure <command>          (once the package is installed)
 */

import { CliError } from './context';
import { buildProgram } from './program';

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
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
