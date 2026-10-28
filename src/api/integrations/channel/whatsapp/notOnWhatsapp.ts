/**
 * The sentence for a number WhatsApp does not know.
 *
 * The number is not on WhatsApp, so the message cannot be delivered —
 * but the reason has to say so, in words, because that is the answer
 * the sender is looking for.
 *
 * It used to throw the raw lookup result — an object with a jid, an
 * `exists` flag and a name. The exception could not render an object,
 * so the message became "Bad Request", and a developer reading the
 * failed message had no idea what was wrong with it.
 */
export function notOnWhatsapp(number: string): string {
  const clean = String(number ?? '').replace(/[^0-9+]/g, '');
  return clean
    ? `The number ${clean} is not on WhatsApp, so the message cannot be delivered to it.`
    : 'That number is not on WhatsApp, so the message cannot be delivered to it.';
}
