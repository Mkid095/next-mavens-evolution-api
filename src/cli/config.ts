/**
 * Configuration resolution for the Viventure CLI.
 *
 * Precedence (highest first):
 *   1. explicit command-line flags (--api-url / --api-key)
 *   2. environment variables (VIVENTURE_API_URL / VIVENTURE_API_KEY)
 *   3. the config file at ~/.viventure/config.json
 *   4. built-in defaults (the public Viventure API)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_URL = 'https://whatsapp.nextmavens.com/api/v1';
export const DEFAULT_DOCS_URL = 'https://whatsapp.nextmavens.com';

/** Shape of ~/.viventure/config.json. */
export interface StoredConfig {
  apiUrl?: string;
  apiKey?: string;
  docsUrl?: string;
}

/** Where each resolved value came from — shown by `viventure config`. */
export type ConfigSource = 'flag' | 'env' | 'file' | 'default';

export interface ResolvedConfig {
  apiUrl: string;
  apiKey?: string;
  docsUrl: string;
  /**
   * The project to act on, by slug or public id. Only an account-level
   * personal access token needs it — a project key already knows.
   */
  project?: string;
  sources: {
    apiUrl: ConfigSource;
    apiKey: ConfigSource;
    docsUrl: ConfigSource;
  };
}

export function configDir(): string {
  return path.join(os.homedir(), '.viventure');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/** Read the stored config. A missing or corrupt file is treated as "no config". */
export function readStoredConfig(): StoredConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as StoredConfig;
  } catch {
    return {};
  }
}

/**
 * Persist the config file with 0600 permissions — it holds a live API key.
 */
export function writeStoredConfig(config: StoredConfig): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const target = configPath();
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best effort — some filesystems do not support chmod */
  }
}

/** Remove the stored API key, keeping the rest of the configuration. */
export function clearStoredApiKey(): void {
  const stored = readStoredConfig();
  delete stored.apiKey;
  if (!fs.existsSync(configPath())) return;
  writeStoredConfig(stored);
}

/**
 * Normalise a base URL:
 *  - a missing scheme becomes https://
 *  - a bare host (no path) gets the /api/v1 prefix the platform is mounted on
 *  - trailing slashes are removed
 */
export function normalizeApiUrl(raw: string): string {
  let value = String(raw ?? '').trim();
  if (!value) return DEFAULT_API_URL;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid API URL: ${raw}`);
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (!path) {
    parsed.pathname = '/api/v1';
  } else {
    parsed.pathname = path;
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeDocsUrl(raw: string): string {
  let value = String(raw ?? '').trim();
  if (!value) return DEFAULT_DOCS_URL;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, '');
}

/**
 * Resolve the effective configuration from flags, environment and file.
 */
export function resolveConfig(
  flags: { apiUrl?: string; apiKey?: string; docsUrl?: string; project?: string } = {},
): ResolvedConfig {
  const stored = readStoredConfig();

  const envApiUrl = process.env.VIVENTURE_API_URL;
  const envApiKey = process.env.VIVENTURE_API_KEY;
  const envDocsUrl = process.env.VIVENTURE_DOCS_URL;

  const apiUrlRaw = flags.apiUrl ?? envApiUrl ?? stored.apiUrl ?? DEFAULT_API_URL;
  const apiUrlSource: ConfigSource = flags.apiUrl ? 'flag' : envApiUrl ? 'env' : stored.apiUrl ? 'file' : 'default';

  const apiKey = flags.apiKey ?? envApiKey ?? stored.apiKey;
  const apiKeySource: ConfigSource = flags.apiKey ? 'flag' : envApiKey ? 'env' : stored.apiKey ? 'file' : 'default';

  const docsUrlRaw = flags.docsUrl ?? envDocsUrl ?? stored.docsUrl ?? DEFAULT_DOCS_URL;
  const docsUrlSource: ConfigSource = flags.docsUrl ? 'flag' : envDocsUrl ? 'env' : stored.docsUrl ? 'file' : 'default';

  return {
    apiUrl: normalizeApiUrl(apiUrlRaw),
    apiKey,
    docsUrl: normalizeDocsUrl(docsUrlRaw),
    project: flags.project,
    sources: {
      apiUrl: apiUrlSource,
      apiKey: apiKeySource,
      docsUrl: docsUrlSource,
    },
  };
}
