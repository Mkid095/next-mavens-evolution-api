/**
 * What the platform will actually transmit.
 *
 * For a long time the API accepted a `type` and stored it, and then sent
 * a text message regardless. A media message was accepted, queued and
 * delivered as an empty text body — the sender had no way to know.
 *
 * These are the types that go out. Anything else is rejected at the
 * boundary with a message that says what is supported, rather than
 * accepted and quietly dropped.
 */

import { MEDIA_TYPES, OUTGOING_MESSAGE_TYPES, OutgoingMessageType } from '../adapters/whatsapp.adapter';

/**
 * The largest media payload accepted inline, in bytes of decoded data.
 *
 * A base64 string of N characters is 3N/4 bytes, so the string is
 * capped at 4/3 of this. WhatsApp itself caps images at 5 MB and
 * documents at 100 MB; 16 MB is a generous ceiling that still keeps a
 * broadcast queue from carrying a gigabyte per row.
 *
 * A URL has no such limit — the engine fetches it — but it is still
 * subject to the engine's own download timeout.
 */
export const MAX_INLINE_MEDIA_BYTES = 16 * 1024 * 1024;

/** The same ceiling expressed on the base64 string. */
const MAX_INLINE_MEDIA_BASE64 = Math.ceil(MAX_INLINE_MEDIA_BYTES * (4 / 3));

/** Types the API accepts but the platform does not transmit. */
const NOT_TRANSMITTED = ['location', 'reaction', 'poll', 'template', 'interactive', 'button', 'ptv', 'contact'];

export type OutgoingDraft =
  | { type: 'text'; content: { text: string } }
  | {
      type: 'image' | 'video' | 'document' | 'audio';
      content: { media: string; caption?: string; fileName?: string; mimeType?: string };
    };

export type DraftResult = { ok: true; message: OutgoingDraft } | { ok: false; error: string; message: string };

/**
 * Validate a request body into something the outbox can send.
 *
 * Never throws: the caller gets an error string and turns it into a 400.
 */
export function buildOutgoing(body: Record<string, unknown>): DraftResult {
  const rawType = typeof body.type === 'string' && body.type.trim() ? body.type.trim().toLowerCase() : 'text';
  const text = typeof body.text === 'string' ? body.text : '';
  const media = typeof body.media === 'string' ? body.media.trim() : '';

  // A type we name but do not transmit — say so, and say what we do.
  if (NOT_TRANSMITTED.includes(rawType)) {
    return {
      ok: false,
      error: 'UNSUPPORTED_TYPE',
      message:
        `"${rawType}" is accepted but not transmitted — the platform sends text, image, video, document and audio. ` +
        `Send one of those, or set type to "text".`,
    };
  }

  if (!OUTGOING_MESSAGE_TYPES.includes(rawType as OutgoingMessageType)) {
    return {
      ok: false,
      error: 'UNSUPPORTED_TYPE',
      message: `Unknown message type "${rawType}". The platform sends: ${OUTGOING_MESSAGE_TYPES.join(', ')}.`,
    };
  }

  if (rawType === 'text') {
    if (!text.trim()) {
      return { ok: false, error: 'MISSING_FIELDS', message: 'text is required for a text message' };
    }
    return { ok: true, message: { type: 'text', content: { text } } };
  }

  // ── Media ───────────────────────────────────────────────────────────────
  if (!media) {
    return {
      ok: false,
      error: 'MISSING_FIELDS',
      message: `media is required for a ${rawType} message — a URL, or base64 of the file`,
    };
  }

  const isUrl = /^https?:\/\//i.test(media);
  const isDataUri = /^data:[^;,]+;base64,/i.test(media);

  if (!isUrl && !isDataUri && !isProbablyBase64(media)) {
    return {
      ok: false,
      error: 'INVALID_MEDIA',
      message:
        'media must be an http(s) URL, a data:…;base64, URL, or base64 of the file. ' +
        'Pass a URL when you can — the platform fetches it at send time.',
    };
  }

  const base64Part = isDataUri ? media.slice(media.indexOf(',') + 1) : isUrl ? '' : media;
  if (base64Part.length > MAX_INLINE_MEDIA_BASE64) {
    return {
      ok: false,
      error: 'MEDIA_TOO_LARGE',
      message:
        `Inline media is capped at ${Math.round(MAX_INLINE_MEDIA_BYTES / 1024 / 1024)} MB. ` +
        'Host the file and send its URL instead.',
    };
  }

  const caption = typeof body.caption === 'string' ? body.caption : undefined;
  const fileName = typeof body.fileName === 'string' ? body.fileName : undefined;
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : undefined;

  return {
    ok: true,
    message: {
      type: rawType as 'image' | 'video' | 'document' | 'audio',
      content: {
        media: isDataUri ? base64Part : media,
        ...(caption ? { caption } : {}),
        ...(fileName ? { fileName } : {}),
        ...(mimeType ? { mimeType } : {}),
      },
    },
  };
}

/**
 * Is this plausibly base64 of a file?
 *
 * A strict check would require decoding, which for a broadcast's worth of
 * payloads is work for no benefit: a string that is not base64 simply
 * fails in the engine and is reported as a failed send. This catches the
 * plain mistakes — a raw path, a bare filename.
 */
function isProbablyBase64(value: string): boolean {
  if (value.length < 32) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(value);
}

/** The mediatype the engine is asked for, for a message type. */
export function engineMediaType(type: OutgoingMessageType): string {
  return MEDIA_TYPES[type] ?? type;
}
