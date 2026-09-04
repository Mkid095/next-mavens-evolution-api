import crypto from 'crypto';
import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

export class PlatformAuthService {
  private readonly logger = new Logger('PlatformAuthService');

  public async createApiKey(
    accountId: string,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ): Promise<{ publicId: string; plaintextKey: string }> {
    const publicId = `key_${crypto.randomBytes(12).toString('hex')}`;
    const plaintextKey = `fidscript_sk_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = this.hashKey(plaintextKey);
    const keyPrefix = plaintextKey.substring(0, 16);

    await platformRepository.platformApiKey.create({
      data: {
        publicId,
        accountId,
        name,
        keyHash,
        keyPrefix,
        scopes,
        expiresAt,
        createdAt: new Date(),
      },
    });

    this.logger.info(`API key created: ${publicId} for account ${accountId}`);
    return { publicId, plaintextKey };
  }

  /**
   * Validate a plaintext API key.
   * Returns the key record's internal id, publicId, accountId, scopes, and expiry.
   * Returns null if the key is invalid, revoked, or expired.
   */
  public async validateApiKey(
    plaintextKey: string,
  ): Promise<{
    id: string;
    publicId: string;
    accountId: string;
    scopes: string[];
    expiresAt: Date | null;
  } | null> {
    const keyHash = this.hashKey(plaintextKey);
    const now = new Date();

    const record = await platformRepository.platformApiKey.findFirst({
      where: {
        keyHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });

    if (!record) {
      return null;
    }

    return {
      id: record.id,
      publicId: record.publicId,
      accountId: record.accountId,
      scopes: record.scopes as string[],
      expiresAt: record.expiresAt,
    };
  }

  public async rotateApiKey(id: string): Promise<{ plaintextKey: string } | null> {
    const existing = await platformRepository.platformApiKey.findUnique({ where: { id } });
    if (!existing || existing.revokedAt) {
      return null;
    }
    await this.revokeApiKey(id);
    const { plaintextKey } = await this.createApiKey(
      existing.accountId,
      `${existing.name} (rotated)`,
      existing.scopes as string[],
      existing.expiresAt ?? undefined,
    );
    return { plaintextKey };
  }

  public async revokeApiKey(id: string): Promise<boolean> {
    const result = await platformRepository.platformApiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    if (result) {
      this.logger.info(`API key revoked: ${id}`);
    }
    return !!result;
  }

  /**
   * Bind an API key to a specific instance.
   * After binding, the key can only be used for operations on that instance.
   */
  public async bindInstance(apiKeyId: string, instanceId: string): Promise<void> {
    await platformRepository.platformApiKeyInstance.create({
      data: { apiKeyId, instanceId },
    });
  }

  public async listApiKeys(accountId: string) {
    const keys = await platformRepository.platformApiKey.findMany({
      where: { accountId },
      select: {
        id: true,
        publicId: true,
        name: true,
        scopes: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    return keys;
  }

  private hashKey(plaintextKey: string): string {
    return crypto.createHash('sha256').update(plaintextKey).digest('hex');
  }
}
