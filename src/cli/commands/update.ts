/**
 * `viventure update` — update the CLI itself.
 *
 * The CLI is published to the Next Mavens registry, so the update is the
 * same one npm would do — except that the CLI knows which registry it
 * came from, and does not need the reader to remember it.
 *
 * The installed package's own manifest is the source of truth: it names
 * the package, the version that is running, and the registry it was
 * published to.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { CliContext, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { color, dim } from '../output';

/** The package this CLI is published as. */
const PACKAGE_NAME = '@viventure/cli';

/** The default registry — the same one the package is published to. */
const DEFAULT_REGISTRY = 'https://registry.nextmavens.com';

interface InstalledPackage {
  name: string;
  version: string;
  registry: string;
  /** Where the manifest was found. */
  manifestPath: string;
}

/**
 * Find the manifest of the installed package.
 *
 * The manifest is not in the same place in every layout: in the
 * repository the bundle is `dist/cli/index.js` and the manifest is two
 * levels up; in the published package the bundle is `bin/viventure.js`
 * and the manifest is one level up. Every candidate is tried.
 */
function findInstalledPackage(): InstalledPackage | null {
  if (typeof __dirname === 'undefined') return null;

  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'), // dist/cli/index.js
    path.join(__dirname, '..', 'package.json'), // bin/viventure.js
    path.join(__dirname, 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!manifest?.name || !manifest?.version) continue;
      return {
        name: manifest.name,
        version: String(manifest.version),
        registry: manifest.publishConfig?.registry ?? DEFAULT_REGISTRY,
        manifestPath: candidate,
      };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Compare two versions.
 *
 * `-1` when a is older than b, `0` when they are the same, `1` when a is
 * newer. A pre-release is older than the release it leads to, which is
 * what npm does.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core, pre] = String(version).trim().replace(/^v/, '').split('-', 2);
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { parts, pre: pre ?? null };
  };

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i++) {
    const l = left.parts[i] ?? 0;
    const r = right.parts[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  // Same core version: a pre-release is older than the release.
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  if (left.pre && right.pre) {
    if (left.pre === right.pre) return 0;
    return left.pre < right.pre ? -1 : 1;
  }
  return 0;
}

/** The latest version of a package on a registry. */
async function fetchLatestVersion(registry: string, name: string): Promise<string | null> {
  const url = `${registry.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const packument = (await response.json()) as { 'dist-tags'?: { latest?: string } };
  return packument?.['dist-tags']?.latest ?? null;
}

/**
 * Quote a value for a Windows command line.
 *
 * The Windows spawn path runs through cmd.exe, so the values have to be
 * quoted there. Doubling the embedded double quotes is the cmd
 * convention for a literal quote.
 */
function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Install the package globally with npm.
 *
 * Windows is the hard case. Since the CVE-2024-27980 hardening
 * (Node 18.20.2 / 20.12.2 / 21.7.3 and everything on 22 and later) a
 * process cannot spawn a `.cmd` or `.bat` file without a shell:
 * `spawnSync('npm.cmd', args)` throws EINVAL on every currently
 * supported Node. It worked on macOS and Linux, which is how a self-updater
 * that only ever got tested on a Mac could ship broken on Windows.
 *
 * So on Windows the command line is run through cmd.exe as a single
 * string. An args array with `shell: true` would work too, but Node
 * warns about it (DEP0190) because it re-parses the command, and the
 * warning is noise in a command that is supposed to look clean.
 *
 * Everywhere else the array form is used, with no shell — so nothing is
 * re-parsed and the arguments reach npm exactly as given.
 */
function npmInstallGlobal(pkg: string, version: string, registry: string) {
  const args = ['install', '-g', `${pkg}@${version}`, '--registry', registry];

  if (process.platform === 'win32') {
    const line = `npm.cmd install -g ${quoteForCmd(`${pkg}@${version}`)} --registry ${quoteForCmd(registry)}`;
    return spawnSync(line, { stdio: 'inherit', encoding: 'utf8', shell: true });
  }

  return spawnSync('npm', args, { stdio: 'inherit', encoding: 'utf8' });
}

export function registerUpdateCommand(program: Command): void {
  const update = program
    .command('update')
    .description('Update the viventure CLI to the latest version')
    .option('--check', 'Only report whether an update is available')
    // `--to`, not `--version`: the root's `-v, --version` is a global flag
    // and commander routes it there, so a subcommand option of the same
    // name would silently print the version and exit instead of updating.
    .option('--to <version>', 'Update to this version instead of the latest')
    .option('--registry <url>', 'The registry to update from')
    .addHelpText(
      'after',
      `
Examples:
  $ viventure update              update to the latest version
  $ viventure update --check      report whether an update is available
  $ viventure update --to 1.0.1   update to a particular version

The registry is the one the package was published to, so the reader
never has to name it. To install by hand:
  npm install -g @viventure/cli@latest --registry https://registry.nextmavens.com`,
    )
    .action(async (options: { check?: boolean; to?: string; registry?: string }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      const installed = findInstalledPackage();

      if (!installed) {
        throw toCliError(new Error('Could not find the installed package manifest.'), ctx.config.apiUrl, [
          'Run `viventure --version` to check the installation.',
        ]);
      }

      const registry = (options.registry ?? installed.registry).replace(/\/+$/, '');
      const name = installed.name === PACKAGE_NAME ? installed.name : PACKAGE_NAME;

      let latest: string | null = null;
      try {
        latest = await fetchLatestVersion(registry, name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw toCliError(new Error(`Could not reach the registry at ${registry}: ${reason}`), ctx.config.apiUrl, [
          'Check the network, or pass --registry with the right URL.',
        ]);
      }

      if (!latest) {
        throw toCliError(
          new Error(`The registry at ${registry} did not report a version for ${name}.`),
          ctx.config.apiUrl,
        );
      }

      const target = options.to ?? latest;
      const comparison = compareVersions(installed.version, target);

      // ── Only report ──────────────────────────────────────────────────────
      if (options.check) {
        const upToDate = comparison >= 0;
        ctx.printer.result({ installed: installed.version, latest, upToDate, registry }, () =>
          [
            upToDate
              ? color(`viventure ${installed.version} is up to date.`, 'green')
              : color(`viventure ${installed.version} → ${target} is available.`, 'yellow'),
            dim(`registry: ${registry}`),
          ].join('\n'),
        );
        return;
      }

      // ── Already on the target ────────────────────────────────────────────
      if (comparison === 0) {
        ctx.printer.result({ installed: installed.version, latest, updated: false }, () =>
          color(`viventure ${installed.version} is already the latest.`, 'green'),
        );
        return;
      }

      // A checkout is not something npm can update in place — there is no
      // global copy of it. Say what to do instead of failing obscurely.
      if (installed.name !== PACKAGE_NAME) {
        throw toCliError(
          new Error(`This is a ${installed.name} checkout, not an installed ${PACKAGE_NAME}.`),
          ctx.config.apiUrl,
          [
            `The latest published version is ${target}.`,
            'Update the checkout: git pull && npm run build',
            'Or install the published CLI:',
            `  npm install -g ${PACKAGE_NAME}@${target} --registry ${registry}`,
          ],
        );
      }

      // ── Install it ───────────────────────────────────────────────────────
      ctx.printer.info(dim(`Updating ${name} ${installed.version} → ${target} from ${registry}…`));

      const result = npmInstallGlobal(name, target, registry);

      if (result.error) {
        throw toCliError(new Error(`Could not run npm: ${result.error.message}`), ctx.config.apiUrl, [
          'Install Node.js and npm, or update by hand:',
          `  npm install -g ${name}@${target} --registry ${registry}`,
        ]);
      }

      if (result.status !== 0) {
        throw toCliError(new Error(`npm exited with code ${result.status}.`), ctx.config.apiUrl, [
          'A global install may need elevated permissions:',
          `  npm install -g ${name}@${target} --registry ${registry}`,
          '(On Windows, run that in an elevated PowerShell.)',
        ]);
      }

      ctx.printer.result({ installed: installed.version, latest: target, updated: true }, () =>
        color(`Updated viventure to ${target}.`, 'green'),
      );
    });

  addCommonOptions(update);
  addJsonOption(update);
}
