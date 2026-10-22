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

/** The npm executable, for the platform. */
function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function registerUpdateCommand(program: Command): void {
  const update = program
    .command('update')
    .description('Update the viventure CLI to the latest version')
    .option('--check', 'Only report whether an update is available')
    .option('--version <version>', 'Update to this version instead of the latest')
    .option('--registry <url>', 'The registry to update from')
    .addHelpText(
      'after',
      `
Examples:
  $ viventure update              update to the latest version
  $ viventure update --check      report whether an update is available
  $ viventure update --version 1.0.1

The registry is the one the package was published to, so the reader
never has to name it.`,
    )
    .action(async (options: { check?: boolean; version?: string; registry?: string }, command: Command) => {
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

      const target = options.version ?? latest;
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
            `Or install the published CLI: npm install -g ${PACKAGE_NAME} --registry ${registry}`,
          ],
        );
      }

      // ── Install it ───────────────────────────────────────────────────────
      ctx.printer.info(dim(`Updating ${name} ${installed.version} → ${target} from ${registry}…`));

      const result = spawnSync(npmCommand(), ['install', '-g', `${name}@${target}`, '--registry', registry], {
        stdio: 'inherit',
        encoding: 'utf8',
      });

      if (result.error) {
        throw toCliError(new Error(`Could not run npm: ${result.error.message}`), ctx.config.apiUrl, [
          'Install Node.js and npm, or update by hand: npm install -g ' + name,
        ]);
      }

      if (result.status !== 0) {
        throw toCliError(new Error(`npm exited with code ${result.status}.`), ctx.config.apiUrl, [
          'A global install may need elevated permissions:',
          `  sudo npm install -g ${name}@${target} --registry ${registry}`,
        ]);
      }

      ctx.printer.result({ installed: installed.version, latest: target, updated: true }, () =>
        color(`Updated viventure to ${target}.`, 'green'),
      );
    });

  addCommonOptions(update);
  addJsonOption(update);
}
