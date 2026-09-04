import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

/**
 * Audit Service
 * Records all mutating operations on the platform.
 * Secrets, passwords, message content, and API keys are never stored in audit records.
 */
export class AuditService {
  private readonly logger = new Logger('AuditService');

  /**
   * Record an audit event.
   * @param accountId - The account performing the action
   * @param action - The action identifier (e.g., "ACCOUNT_ONBOARD", "USER_CREATE")
   * @param resource - The resource affected { type, id }
   * @param metadata - Optional metadata (passwords, tokens, secrets are redacted)
   */
  public async record(
    accountId: string,
    action: string,
    resource: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const safeMetadata = this.sanitizeMetadata(metadata);

    await platformRepository.platformAuditLog.create({
      data: {
        accountId,
        action,
        resource: resource.type,
        resourceId: resource.id,
        ipAddress: safeMetadata.ipAddress as string | undefined,
        userAgent: safeMetadata.userAgent as string | undefined,
        metadata: safeMetadata,
        createdAt: new Date(),
      },
    });

    this.logger.info(`Audit: ${accountId} ${action} ${resource.type}/${resource.id}`);
  }

  /**
   * Get audit history for a specific resource.
   */
  public async getResourceHistory(resourceType: string, resourceId: string, limit = 50) {
    return platformRepository.platformAuditLog.findMany({
      where: { resource: resourceType, resourceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get audit history for an entire account.
   */
  public async getAccountHistory(accountId: string, limit = 100) {
    return platformRepository.platformAuditLog.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Remove sensitive fields from metadata before storing.
   */
  private sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
    if (!metadata) return {};

    const forbiddenKeys = [
      'password',
      'token',
      'apiKey',
      'secret',
      'authorization',
      'message',
      'content',
      'body',
      'headers',
      'phoneNumber',
      'email',
    ];

    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(metadata)) {
      const lowerKey = key.toLowerCase();
      if (forbiddenKeys.some(f => lowerKey.includes(f))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeMetadata(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}
