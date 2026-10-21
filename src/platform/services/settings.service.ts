import { Logger } from '@config/logger.config';
import crypto from 'crypto';

import { platformRepository } from '../repository/platform.repository';

/**
 * Settings Service
 *
 * Stores application-level settings that must survive a redeploy but must
 * never live in source control. Values are encrypted at rest with
 * AES-256-GCM using `PLATFORM_ENCRYPTION_KEY`.
 *
 * Ciphertext format: `v1:<iv>:<authTag>:<ciphertext>` (all hex except the
 * separators). The `v1` prefix leaves room to rotate the algorithm later
 * without ambiguity.
 */

/** Setting key for the password that gates account creation. */
export const COMPANY_GATE_PASSWORD_KEY = 'company_gate_password';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

export class SettingsService {
  private readonly logger = new Logger('SettingsService');
  private readonly encryptionKey: Buffer;

  /**
   * Short-lived cache so a busy request path does not hit the database on
   * every read. Writes invalidate it.
   */
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly cacheTtlMs = 60_000;

  constructor() {
    const keyHex = process.env.PLATFORM_ENCRYPTION_KEY;
    if (!keyHex) {
      throw new Error('PLATFORM_ENCRYPTION_KEY env var is required');
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');
  }

  /**
   * Encrypt a plaintext value for storage.
   */
  public encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt a stored value. Returns null when the payload is not in the
   * expected format or fails authentication.
   */
  public decrypt(payload: string): string | null {
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    const [, ivHex, authTagHex, ciphertext] = parts;
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return null;
    }
  }

  /**
   * Read a setting. Returns null when it is absent or cannot be decrypted.
   */
  public async get(key: string): Promise<string | null> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await platformRepository.platformSetting.findUnique({ where: { key } });
    if (!row) return null;

    const plaintext = this.decrypt(row.value);
    if (plaintext === null) {
      this.logger.error(`Setting "${key}" could not be decrypted — the encryption key may have changed`);
      return null;
    }

    this.cache.set(key, { value: plaintext, expiresAt: Date.now() + this.cacheTtlMs });
    return plaintext;
  }

  /**
   * Write a setting, encrypting the value.
   */
  public async set(key: string, plaintext: string, description?: string): Promise<void> {
    await platformRepository.platformSetting.upsert({
      where: { key },
      create: { key, value: this.encrypt(plaintext), description },
      update: { value: this.encrypt(plaintext), description },
    });
    this.cache.set(key, { value: plaintext, expiresAt: Date.now() + this.cacheTtlMs });
    this.logger.log(`Setting "${key}" stored`);
  }

  /**
   * The password that gates account creation.
   *
   * The database is the source of truth. `COMPANY_GATE_PASSWORD` is only a
   * bootstrap seed: it is used to seed the row on a fresh database and is
   * never consulted again once the row exists. There is deliberately no
   * hard-coded fallback — a deployment that has neither is locked out of
   * creating accounts, which is the safe failure mode.
   */
  public async getCompanyGatePassword(): Promise<string | null> {
    const stored = await this.get(COMPANY_GATE_PASSWORD_KEY);
    if (stored) return stored;

    const seed = process.env.COMPANY_GATE_PASSWORD;
    if (seed) {
      await this.set(COMPANY_GATE_PASSWORD_KEY, seed, 'Password required to create an account (signup / onboarding)');
      this.logger.log('Seeded company gate password from the environment');
      return seed;
    }

    this.logger.error(
      'Company gate password is not configured: no database value and no COMPANY_GATE_PASSWORD env var',
    );
    return null;
  }

  /**
   * Seed the gate password from the environment if the database has no value
   * yet. Called on boot so a fresh deployment is usable without a manual
   * database write.
   */
  public async seedDefaults(): Promise<void> {
    try {
      await this.getCompanyGatePassword();
    } catch (error) {
      this.logger.error(`Failed to seed settings defaults: ${error}`);
    }
  }
}

export const settingsService = new SettingsService();
