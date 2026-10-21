/**
 * Terminal output helpers for the Viventure CLI.
 *
 * Rules enforced here:
 *  - Colour is only emitted on a TTY, and never when NO_COLOR is set.
 *  - Diagnostics (warnings, errors) always go to stderr, results to stdout,
 *    so `viventure ... --json | jq` never mixes the two.
 *  - API keys are always masked before they reach a terminal.
 */

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const;

export type ColorName = keyof typeof ANSI;

/** Colour state — disabled by `--no-color` or by a non-TTY stdout. */
let colorEnabled = detectColorSupport();

function detectColorSupport(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

/** Wrap `text` in an ANSI colour. Returns the text untouched when colour is off. */
export function color(text: string, name: ColorName): string {
  if (!colorEnabled) return text;
  return `${ANSI[name]}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  return color(text, 'bold');
}

export function dim(text: string): string {
  return color(text, 'dim');
}

/**
 * Mask a secret so it can be shown without leaking it.
 * `fidscript_sk_0123456789abcdef…` keeps the recognisable prefix plus the
 * last four characters, which is enough to tell two keys apart.
 */
export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return '(not set)';
  if (secret.length <= 12) return '***';
  return `${secret.slice(0, 16)}…${secret.slice(-4)}`;
}

/** Colour an instance/connection status the way a developer expects to read it. */
export function colorStatus(status: string): string {
  switch ((status || '').toUpperCase()) {
    case 'CONNECTED':
    case 'ACTIVE':
    case 'OK':
    case 'ENABLED':
      return color(status, 'green');
    case 'CONNECTING':
    case 'PENDING':
    case 'CREATED':
    case 'TRIAL':
      return color(status, 'yellow');
    case 'DISCONNECTED':
    case 'SUSPENDED':
    case 'ERROR':
    case 'FAILED':
    case 'DISABLED':
      return color(status, 'red');
    default:
      return status;
  }
}

/** A single column of a table cell: plain text plus an optional colour. */
export interface Cell {
  text: string;
  color?: ColorName;
}

export const cell = (text: string, colorName?: ColorName): Cell => ({ text, color: colorName });

// Built from a char code so the source stays free of literal escape bytes.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Visible width of a string, ignoring ANSI escape sequences. */
function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (visibleWidth(text) <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render a table with aligned columns.
 * Cells may be plain strings or {@link Cell} objects (which carry a colour).
 */
export function renderTable(headers: string[], rows: (string | Cell)[][]): string {
  const all: Cell[][] = [
    headers.map((h) => ({ text: h })),
    ...rows.map((r) => r.map((c) => (typeof c === 'string' ? { text: c } : c))),
  ];
  const columnCount = all.reduce((max, row) => Math.max(max, row.length), 0);
  const widths: number[] = [];
  for (let i = 0; i < columnCount; i++) {
    let width = 0;
    for (const row of all) {
      width = Math.max(width, visibleWidth(row[i]?.text ?? ''));
    }
    widths.push(width);
  }

  const lines: string[] = [];
  const renderRow = (row: Cell[], isHeader: boolean): string => {
    const parts: string[] = [];
    for (let i = 0; i < columnCount; i++) {
      const value = row[i]?.text ?? '';
      const padded = value.padEnd(widths[i]);
      parts.push(isHeader ? bold(padded) : row[i]?.color ? color(padded, row[i].color) : padded);
    }
    return parts.join('  ').replace(/\s+$/, '');
  };

  lines.push(renderRow(all[0], true));
  lines.push(color(widths.map((w) => '─'.repeat(w)).join('  '), 'gray'));
  for (const row of all.slice(1)) {
    lines.push(renderRow(row, false));
  }
  return lines.join('\n');
}

/** Render a two-column "key: value" block. */
export function renderKeyValue(pairs: [string, string | undefined | null][]): string {
  const visible = pairs.filter(([, value]) => value !== undefined && value !== null && value !== '');
  const width = visible.reduce((max, [key]) => Math.max(max, key.length), 0);
  return visible.map(([key, value]) => `${bold(`${key}:`.padEnd(width + 1))} ${value}`).join('\n');
}

/** Human-friendly rendering of an ISO timestamp / Date. */
export function formatDate(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

/** Shorten a long value for table cells (URLs, ids, …). */
export function shorten(value: unknown, max = 48): string {
  if (value === undefined || value === null) return '';
  return truncate(String(value), max);
}
