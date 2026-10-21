/**
 * Shared AES-256-GCM encryption for the platform's secrets at rest.
 *
 * Two things need it today:
 *   - the webhook signing secrets (`PlatformWebhook.secret`)
 *   - the project default token (`PlatformProject.defaultTokenEncrypted`)
 *
 * They MUST use the same key and the same wire format, otherwise a
 * secret written by one cannot be read by the other. The format is
 *
 *     iv : authTag : ciphertext        (all hex)
 *
 * and it is deliberately the format the webhook service already used,
 * so the existing webhook rows stay readable after the extraction.
 *
 * The key comes from `PLATFORM_ENCRYPTION_KEY` (hex-encoded 32 bytes).
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 16;

export class PlatformCrypto {
  private readonly encryptionKey: Buffer;

  constructor() {
    const keyHex = process.env.PLATFORM_ENCRYPTION_KEY;
    if (!keyHex) {
      throw new Error('PLATFORM_ENCRYPTION_KEY env var is required');
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');
  }

  /**
   * Encrypt plaintext using AES-256-GCM.
   * Output format: iv:authTag:ciphertext (all hex).
   */
  public encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt an AES-256-GCM payload produced by `encrypt`.
   * Throws when the payload is malformed or the auth tag does not match.
   */
  public decrypt(encrypted: string): string {
    const [ivHex, authTagHex, ciphertext] = encrypted.split(':');
    if (!ivHex || !authTagHex || !ciphertext) {
      throw new Error('Malformed encrypted payload — expected iv:authTag:ciphertext');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

let instance: PlatformCrypto | null = null;

/**
 * The shared crypto helper. Created on first use so that merely
 * importing a module that needs encryption does not require the
 * environment variable to be set at import time.
 */
export function getPlatformCrypto(): PlatformCrypto {
  if (!instance) {
    instance = new PlatformCrypto();
  }
  return instance;
}
