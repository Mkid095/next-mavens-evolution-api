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

  constructor(options: GlobalOptions = {}) {
    this.config = resolveConfig({
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      docsUrl: options.docsUrl,
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
      });
    }
    return this.clientInstance;
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
