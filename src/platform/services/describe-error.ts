/**
 * Turn a thrown value into a sentence a person can act on.
 *
 * The engine throws more shapes than `Error`: a Boom object from
 * `@hapi/boom`, a plain response body, sometimes a string. The old
 * handling — `error instanceof Error ? error.message : String(error)` —
 * rendered every one of those as `[object Object]`, which is what a
 * developer saw in `lastError` when a send failed and had nowhere to go
 * from there.
 */

/** A Boom error, the shape `@hapi/boom` produces. */
interface BoomLike {
  output?: { statusCode?: number; payload?: { message?: string; error?: string } };
  data?: unknown;
  isBoom?: boolean;
}

/**
 * Describe an error in one line.
 *
 * Never returns `[object Object]`. When there is genuinely nothing to
 * say about the value, it says what kind of value it was instead.
 */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) return 'no error detail';

  if (typeof error === 'string') return error.trim() || 'empty error message';

  if (typeof error !== 'object') return String(error);

  // Boom — an HTTP-shaped error with a payload.
  const boom = error as BoomLike;
  if (boom.isBoom || boom.output?.payload) {
    const payload = boom.output?.payload ?? {};
    const code = boom.output?.statusCode;
    const text = payload.message ?? payload.error;

    /*
     * A Boom's message is often the generic "Internal Server Error" —
     * the real cause is in `data`, which is where the engine puts the
     * error it caught. "Internal Server Error" tells a developer
     * nothing; "Request failed with status code 403" tells them the
     * media URL was refused.
     */
    const cause = describeCause(boom.data);
    if (cause && (!text || /internal server error/i.test(text))) {
      return code ? `${cause} (HTTP ${code})` : cause;
    }
    if (cause && text && !/internal server error/i.test(text)) {
      return `${text} — ${cause}`;
    }

    if (text && code) return `${text} (HTTP ${code})`;
    if (text) return text;
    if (code) return `HTTP ${code}`;
  }

  // Anything with a message — an Error, or an engine response body.
  const asMessage = (error as { message?: unknown }).message;
  if (typeof asMessage === 'string' && asMessage.trim()) {
    const nested = (error as { error?: unknown }).error;
    if (typeof nested === 'string' && nested.trim() && nested.trim() !== asMessage.trim()) {
      return `${asMessage.trim()} — ${nested.trim()}`;
    }
    return asMessage.trim();
  }

  // Baileys and friends often throw the response body itself.
  for (const key of ['error', 'reason', 'status', 'code'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return `${key} ${value}`;
  }

  // A thrown object we have nothing to say about — say what shape it is
  // rather than `[object Object]`.
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json.slice(0, 300);
  } catch {
    /* not serialisable */
  }

  return `${(error as { constructor?: { name?: string } }).constructor?.name ?? 'unknown error'}`;
}

/**
 * The cause behind an error, if there is one worth reporting.
 *
 * The engine catches what it was given and wraps it, so the interesting
 * part is often a layer down: an Axios error with the status code, a
 * TypeError with the property that was missing.
 */
function describeCause(data: unknown): string | null {
  if (!data) return null;
  if (typeof data === 'string') return data.trim() || null;

  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;

    // An Axios error — the status code is the useful part.
    const status = record.status ?? (record.response as { status?: number } | undefined)?.status;
    const axiosMessage = typeof record.message === 'string' ? record.message : null;
    if (axiosMessage && status) return `${axiosMessage} (HTTP ${status})`;
    if (axiosMessage) return axiosMessage;

    // A wrapped error.
    const inner = record.error ?? record.cause ?? record.originalError;
    if (inner && inner !== data) return describeCause(inner);

    if (status) return `HTTP ${status}`;

    try {
      const json = JSON.stringify(data);
      if (json && json !== '{}') return json.slice(0, 200);
    } catch {
      /* not serialisable */
    }
  }

  return null;
}
