/**
 * Thin HTTP client for the Viventure public API.
 *
 * The CLI never touches the database — it talks to the same REST contract
 * any integrator would use, authenticated with `X-API-Key`.
 */

export interface ApiClientOptions {
  baseUrl: string;
  /** The key to authenticate with. Omitted for the public endpoints. */
  apiKey?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Headers sent with every request.
   *
   * `X-Viventure-Project` lives here: an account-level personal access
   * token can act on any project, and this is how it says which one.
   */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
  /** Extra headers (used by the login probe, which sets the key explicitly). */
  headers?: Record<string, string>;
}

/** An error returned by the platform (or by the network in between). */
export class ApiError extends Error {
  public readonly status: number;
  /** The platform's own error code, e.g. `INVALID_API_KEY`. */
  public readonly code?: string;
  /** The platform's own human-readable message, when it sent one. */
  public readonly apiMessage?: string;
  /** The raw parsed response body. */
  public readonly body?: unknown;

  constructor(params: { message: string; status: number; code?: string; apiMessage?: string; body?: unknown }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.apiMessage = params.apiMessage;
    this.body = params.body;
  }
}

/** Raised when the API could not be reached at all. */
export class NetworkError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

interface PlatformErrorBody {
  error?: string;
  message?: string;
}

export class ApiClient {
  public readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private accountPromise?: Promise<MeResponse>;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.defaultHeaders = options.headers ?? {};
  }

  /** The platform tenant behind the current key. Cached for the process. */
  public me(): Promise<MeResponse> {
    if (!this.accountPromise) {
      this.accountPromise = this.get<MeResponse>('/me');
    }
    return this.accountPromise;
  }

  public get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  public post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  public delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  public async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      // A client with no key talks to the public endpoints only.
      ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      ...this.defaultHeaders,
      ...(options.headers ?? {}),
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      // `fetch` wraps the underlying socket error in a TypeError — unwrap the
      // errno code so the message can say *why* the connection failed.
      const wrapper = error as { name?: string; code?: string; cause?: unknown };
      const code = wrapper?.name === 'AbortError' ? 'ETIMEDOUT' : findErrorCode(wrapper);
      throw new NetworkError(`Could not reach the Viventure API at ${this.baseUrl}.`, { code });
    }
    clearTimeout(timer);

    const raw = await response.text();
    const parsed = parseBody(raw);

    if (!response.ok) {
      const body = (parsed ?? {}) as PlatformErrorBody;
      const code = typeof body.error === 'string' ? body.error : undefined;
      const apiMessage = typeof body.message === 'string' ? body.message : undefined;
      throw new ApiError({
        message: apiMessage ?? code ?? `HTTP ${response.status}`,
        status: response.status,
        code,
        apiMessage,
        body: parsed,
      });
    }

    return parsed as T;
  }
}

function parseBody(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Walk the `cause` chain of a fetch failure looking for an errno code.
 * Node wraps socket errors several layers deep (`TypeError` → `Error` →
 * `AggregateError`), so the code is rarely on the outermost error.
 */
function findErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || depth > 4) return undefined;
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof candidate.code === 'string') return candidate.code;
  const found = findErrorCode(candidate.cause, depth + 1);
  if (found) return found;
  if (Array.isArray(candidate.errors)) {
    for (const nested of candidate.errors) {
      const nestedCode = findErrorCode(nested, depth + 1);
      if (nestedCode) return nestedCode;
    }
  }
  return undefined;
}

/** Response of `GET /api/v1/me`. */
export interface MeResponse {
  accountId: string;
  publicId: string;
  status: string;
  plan: { planId: string; name: string; monthlyMessageLimit: number | null } | null;
  /** The public id of the project the credential is scoped to. */
  projectId: string | null;
  project: { id: string } | null;
}

/** Project DTO returned by the project endpoints. */
export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** The project's default token — the plaintext is included. */
export interface DefaultTokenDto {
  id: string;
  name: string;
  keyPrefix: string;
  key: string;
  scopes: string[];
  createdAt: string;
}

/** One entry of the project log. */
export interface LogEventDto {
  id: string;
  category: string;
  action: string;
  summary: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  tool?: string;
  instancePublicId?: string;
  createdAt: string;
}

/** Instance DTO returned by the instance endpoints. */
export interface InstanceDto {
  id: string;
  internalId?: string;
  publicId: string;
  name: string;
  status: string;
  phoneNumber: string | null;
  capabilities?: unknown[];
  lastConnectedAt?: string | null;
  connectedAt?: string | null;
  createdAt: string;
  qrCode?: { base64: string | null; pairingCode: string | null } | null;
}

/** API key metadata (never contains the secret). */
export interface ApiKeyDto {
  id: string;
  name: string;
  scopes: string[];
  keyPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** Webhook metadata (never contains the signing secret). */
export interface WebhookDto {
  publicId: string;
  instanceId: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Turn an API/network failure into an actionable message.
 * Each failure mode gets its own wording — no stack traces.
 */
export function describeError(error: unknown, baseUrl: string): { message: string; hints: string[] } {
  if (error instanceof NetworkError) {
    const cause = error.cause as { code?: string } | undefined;
    const reason =
      cause?.code === 'ECONNREFUSED'
        ? 'The connection was refused.'
        : cause?.code === 'ENOTFOUND'
          ? 'The host could not be resolved.'
          : cause?.code === 'ETIMEDOUT' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
            ? 'The connection timed out.'
            : 'The request could not be completed.';
    return {
      message: `${error.message} ${reason}`,
      hints: [
        'Check your network connection.',
        `Verify the API URL (currently ${baseUrl}) — pass --api-url or set VIVENTURE_API_URL.`,
      ],
    };
  }

  if (error instanceof ApiError) {
    const code = error.code ? ` ${error.code}` : '';
    const detail = error.apiMessage && error.apiMessage !== error.code ? ` — ${error.apiMessage}` : '';

    switch (error.status) {
      case 400:
        return {
          message: `The API rejected the request (400${code})${detail}.`,
          hints: ['Check the arguments you passed; the API message above says what was missing.'],
        };
      case 401:
        return {
          message: `Authentication failed (401${code})${detail}.`,
          hints: [
            'The API key was rejected — it may be invalid, expired or revoked.',
            'Run `viventure login` to store a fresh key, or set VIVENTURE_API_KEY.',
          ],
        };
      case 403:
        return {
          message: `The API refused the request (403${code})${detail}.`,
          hints: [
            'The key may be missing a scope, the account may be suspended, or the key may not be bound to this instance.',
            'Check your key scopes with `viventure keys list`.',
          ],
        };
      case 404:
        return {
          message: `Not found (404${code})${detail}.`,
          hints: [
            'Check the identifier — public ids look like inst_…, key_…, wh_… or acct_….',
            'Run `viventure instances list` to see the ids you own.',
          ],
        };
      case 409:
        return {
          message: `Conflict (409${code})${detail}.`,
          hints: ['The resource already exists or is in a conflicting state.'],
        };
      case 422:
        return {
          message: `Validation failed (422${code})${detail}.`,
          hints: ['The payload did not pass validation — adjust the values and try again.'],
        };
      case 429:
        return {
          message: `Rate limited (429${code})${detail}.`,
          hints: ['Too many requests — slow down and retry in a moment.'],
        };
      default:
        if (error.status >= 500) {
          return {
            message: `The Viventure API failed (${error.status}${code})${detail}.`,
            hints: ['This is a server-side problem — retry shortly or check the platform status.'],
          };
        }
        return {
          message: `The request failed (${error.status}${code})${detail}.`,
          hints: [],
        };
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return { message, hints: [] };
}
