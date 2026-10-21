import { Logger } from '@config/logger.config';
import crypto from 'crypto';

import { platformRepository } from '../repository/platform.repository';

export class PlatformAuthService {
  private readonly logger = new Logger('PlatformAuthService');

  /**
   * Create an API key for a project.
   *
   * `projectId` is the internal PlatformProject id (cuid) the key is
   * scoped to — the `projectId` column is NOT NULL in the database.
   */
  public async createApiKey(
    accountId: string,
    projectId: string,
    name: string,
    scopes: string[],
    expiresAt: Date | undefined,
  ): Promise<{ id: string; publicId: string; plaintextKey: string; keyPrefix: string }> {
    const publicId = `key_${crypto.randomBytes(12).toString('hex')}`;
    const plaintextKey = `fidscript_sk_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = this.hashKey(plaintextKey);
    const keyPrefix = plaintextKey.substring(0, 16);

    const created = await platformRepository.platformApiKey.create({
      data: {
        publicId,
        accountId,
        projectId,
        name,
        keyHash,
        keyPrefix,
        scopes,
        expiresAt,
        createdAt: new Date(),
      },
      select: { id: true },
    });

    this.logger.info(`API key created: ${publicId} for account ${accountId} project ${projectId}`);
    return { id: created.id, publicId, plaintextKey, keyPrefix };
  }

  /**
   * Validate a plaintext API key.
   * Returns the key record's internal id, publicId, accountId, projectId,
   * scopes, and expiry.
   * Returns null if the key is invalid, revoked, or expired.
   */
  public async validateApiKey(plaintextKey: string): Promise<{
    id: string;
    publicId: string;
    accountId: string;
    projectId: string;
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
      projectId: record.projectId,
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
      existing.projectId,
      `${existing.name} (rotated)`,
      existing.scopes as string[],
      existing.expiresAt ?? undefined,
    );
    return { plaintextKey };
  }

  public async revokeApiKey(publicId: string, accountId?: string, projectId?: string): Promise<boolean> {
    // publicId is the key_xxx id; the platformApiKey.id is the internal CUID.
    // We look up by publicId to keep the URL stable.
    const existing = await platformRepository.platformApiKey.findFirst({
      where: { publicId, ...(accountId ? { accountId } : {}), ...(projectId ? { projectId } : {}) },
      select: { id: true, revokedAt: true },
    });
    if (!existing || existing.revokedAt) {
      return false;
    }
    await platformRepository.platformApiKey.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    this.logger.info(`API key revoked: ${publicId} (accountId=${accountId ?? 'n/a'})`);
    return true;
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

  /**
   * List the API keys of an account. When `projectId` is supplied only
   * that project's keys are returned.
   */
  public async listApiKeys(accountId: string, projectId?: string) {
    const keys = await platformRepository.platformApiKey.findMany({
      where: { accountId, ...(projectId ? { projectId } : {}) },
      select: {
        id: true,
        publicId: true,
        projectId: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return keys;
  }

  private hashKey(plaintextKey: string): string {
    return crypto.createHash('sha256').update(plaintextKey).digest('hex');
  }
}
