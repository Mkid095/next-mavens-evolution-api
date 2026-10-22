/**
 * Shared plumbing for the Viventure CLI commands: the printer, the global
 * option handling and the helpers every command needs.
 */

import readline from 'node:readline';

import { ApiClient, describeError } from './client';
import { resolveConfig, ResolvedConfig } from './config';
import { bold, color, dim, maskSecret, setColorEnabled } from './output';

/** An error that should be reported to the user without a stack trace. */
export class CliError extends Error {
  public readonly hints: string[];
  public readonly exitCode: number;

  constructor(message: string, hints: string[] = [], exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.hints = hints;
    this.exitCode = exitCode;
  }
}

/** Global options available on every command. */
export interface GlobalOptions {
  apiUrl?: string;
  apiKey?: string;
  docsUrl?: string;
  json?: boolean;
  color?: boolean;
  timeout?: number;
  /**
   * The project to act on, by slug or public id.
   *
   * A project-scoped key already knows its project. An account-level
   * personal access token can act on any of them, and this is how it
   * says which one.
   */
  project?: string;
}

/**
 * Writes command output. Results go to stdout, diagnostics to stderr, so
 * `--json` output can always be piped into `jq` untouched.
 */
export class Printer {
  private readonly useJson: boolean;

  constructor(useJson = false) {
    this.useJson = useJson;
  }

  public get json(): boolean {
    return this.useJson;
  }

  /**
   * Print a result value — raw JSON in `--json` mode, otherwise `text`.
   * `text` may be a thunk so the human-readable rendering is only built
   * when it is actually going to be printed.
   */
  public result(value: unknown, text: string | (() => string)): void {
    if (this.useJson) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    const rendered = typeof text === 'function' ? text() : text;
    process.stdout.write(`${rendered}\n`);
  }

  /** Print raw text to stdout (already formatted). */
  public write(text: string): void {
    process.stdout.write(`${text}\n`);
  }

  public line(text = ''): void {
    process.stdout.write(`${text}\n`);
  }

  /** Informational message — stderr, so it never pollutes piped output. */
  public info(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  public warn(message: string): void {
    process.stderr.write(`${color('warning:', 'yellow')} ${message}\n`);
  }

  public success(message: string): void {
    process.stderr.write(`${color('✔', 'green')} ${message}\n`);
  }

  public error(message: string, hints: string[] = []): void {
    process.stderr.write(`${color('error:', 'red')} ${message}\n`);
    for (const hint of hints) {
      process.stderr.write(`  ${dim('→')} ${hint}\n`);
    }
  }
}

/**
 * Resolve the configuration for a command and expose a ready-to-use client.
 */
export class CliContext {
  public readonly config: ResolvedConfig;
  public readonly printer: Printer;
  private clientInstance?: ApiClient;
  private publicClientInstance?: ApiClient;

  constructor(options: GlobalOptions = {}) {
    this.config = resolveConfig({
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      docsUrl: options.docsUrl,
      project: options.project,
    });
    if (options.color === false) {
      setColorEnabled(false);
    }
    this.printer = new Printer(Boolean(options.json));
  }

  /** The API client for the resolved configuration. Throws when unauthenticated. */
  public client(): ApiClient {
    if (!this.config.apiKey) {
      throw new CliError('Not authenticated — no API key configured.', [
        'Run `viventure login` to store a key, or set VIVENTURE_API_KEY.',
        'You can also pass --api-key on the command line.',
      ]);
    }
    if (!this.clientInstance) {
      this.clientInstance = new ApiClient({
        baseUrl: this.config.apiUrl,
        apiKey: this.config.apiKey,
        headers: this.config.project ? { 'X-Viventure-Project': this.config.project } : undefined,
      });
    }
    return this.clientInstance;
  }

  /**
   * A client for the PUBLIC endpoints — the ones that need no key.
   *
   * The documentation is public: the same pages are on the docs site.
   * A reader who has not logged in yet can still read the reference.
   */
  public publicClient(): ApiClient {
    if (!this.publicClientInstance) {
      this.publicClientInstance = new ApiClient({ baseUrl: this.config.apiUrl });
    }
    return this.publicClientInstance;
  }

  /** The account public id (acct_…) for the authenticated key. */
  public async accountId(): Promise<string> {
    const client = this.client();
    try {
      const me = await client.me();
      return me.publicId;
    } catch (error) {
      throw toCliError(error, this.config.apiUrl);
    }
  }

  /**
   * The project public id (proj_…) the request acts on.
   *
   * A project-scoped key belongs to exactly one project, and `/me`
   * reports which. An account-level personal access token belongs to no
   * project: it acts on the one named with `--project`, or on the
   * account's default project when none is named.
   *
   * When `--project` names a project the credential cannot reach, the
   * command fails loudly. Silently acting on a different project than
   * the one that was asked for is worse than an error.
   */
  public async projectId(): Promise<string> {
    const client = this.client();
    try {
      const me = await client.me();
      if (!me.projectId) {
        throw new CliError('This API key is not scoped to a project.', [
          'Name the project to act on with --project <slug>.',
        ]);
      }

      const wanted = this.config.project;
      if (wanted) {
        const resolved = await this.resolveProject(wanted);
        if (!resolved) {
          throw new CliError(`No project named "${wanted}" on this account.`, [
            'Run `viventure projects list` to see the available projects.',
          ]);
        }
        if (resolved.id !== me.projectId) {
          throw new CliError(`This credential is scoped to a different project than "${wanted}".`, [
            `It can only act on ${me.projectId}.`,
            'Use a personal access token to act on every project — see `viventure keys default`.',
          ]);
        }
      }

      return me.projectId;
    } catch (error) {
      throw toCliError(error, this.config.apiUrl);
    }
  }

  /**
   * Find a project of the account by slug or public id.
   * Returns null when the account has no such project.
   */
  private async resolveProject(nameOrSlug: string): Promise<{ id: string; name: string } | null> {
    const accountId = await this.accountId();
    const projects = await this.client().get<{ id: string; name: string; slug: string }[]>(
      `/accounts/${accountId}/projects`,
    );
    const wanted = nameOrSlug.trim();
    const found = projects.find((p) => p.slug === wanted || p.id === wanted);
    return found ? { id: found.id, name: found.name } : null;
  }
}

/** Convert any thrown value into a user-facing CliError. */
export function toCliError(error: unknown, baseUrl: string, hints: string[] = []): CliError {
  if (error instanceof CliError) return error;
  const described = describeError(error, baseUrl);
  return new CliError(described.message, [...described.hints, ...hints]);
}

/**
 * Ask for confirmation. When stdin is not a TTY the answer is "no" —
 * callers must pass an explicit `--yes` in non-interactive environments.
 */
export async function confirm(question: string, assumeYes = false): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    throw new CliError('Refusing to continue without confirmation.', [
      'Re-run with --yes to skip the confirmation prompt.',
    ]);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Mask a key for display. */
export const masked = maskSecret;

/** Bold text (re-exported for convenience in command modules). */
export const strong = bold;
