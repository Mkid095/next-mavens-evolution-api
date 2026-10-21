import { Logger } from '@config/logger.config';
import { InputJsonValue } from '@prisma/client/runtime/library';

import { platformRepository } from '../repository/platform.repository';

/**
 * The categories the project logs endpoint can filter on.
 *
 *  - `api`     — REST calls handled by the platform
 *  - `mcp`     — MCP tool invocations
 *  - `auth`    — logins and other authentication events
 *  - `message` — WhatsApp messages sent (from PlatformMessageCommand)
 */
export type AuditCategory = 'api' | 'mcp' | 'auth' | 'message';

/**
 * Derive the category of an audit action.
 *
 * The action prefix is the contract: `MCP_*` is an MCP invocation,
 * `AUTH_*` is an authentication event, `MESSAGE_*` is a message and
 * everything else was driven by a REST call.
 */
export function categorizeAction(action: string): AuditCategory {
  const upper = (action ?? '').toUpperCase();
  if (upper.startsWith('MCP_')) return 'mcp';
  if (upper.startsWith('AUTH_') || upper.startsWith('LOGIN')) return 'auth';
  if (upper.startsWith('MESSAGE_')) return 'message';
  return 'api';
}

/**
 * Options accepted by `AuditService.record`.
 */
export interface AuditRecordOptions {
  /** The project the event belongs to. `null` for account-level events. */
  projectId?: string | null;
  /** Overrides the category derived from the action. */
  category?: AuditCategory;
}

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
   * @param options - Project scope and category
   */
  public async record(
    accountId: string,
    action: string,
    resource: { type: string; id: string },
    metadata?: Record<string, unknown>,
    options?: AuditRecordOptions,
  ): Promise<void> {
    const safeMetadata = this.sanitizeMetadata(metadata);
    const category = options?.category ?? categorizeAction(action);
    safeMetadata.category = category;

    const row = await platformRepository.platformAuditLog.create({
      data: {
        accountId,
        projectId: options?.projectId ?? null,
        action,
        resource: resource.type,
        resourceId: resource.id,
        ipAddress: safeMetadata.ipAddress as string | undefined,
        userAgent: safeMetadata.userAgent as string | undefined,
        metadata: safeMetadata as InputJsonValue,
        createdAt: new Date(),
      },
    });

    this.logger.info(`Audit: ${accountId} ${action} ${resource.type}/${resource.id}`);

    // Fire-and-forget SSE publish so the dashboard activity feed
    // shows the event in real time. Imported lazily to avoid a
    // circular import (activity-publisher.ts already imports logger).
    void import('./activity-publisher.service').then(({ publishAccountEvent }) => {
      const humanAction = action
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/^./, (c) => c.toUpperCase());
      publishAccountEvent(accountId, {
        id: row.id,
        kind: 'audit',
        action,
        category,
        resourceType: resource.type,
        resourceId: resource.id,
        projectId: options?.projectId ?? undefined,
        instancePublicId:
          typeof safeMetadata.instancePublicId === 'string'
            ? safeMetadata.instancePublicId
            : resource.type === 'instance'
              ? resource.id
              : undefined,
        message: `${humanAction}: ${resource.id}`,
        metadata: safeMetadata,
        ts: row.createdAt.getTime(),
      });
    });
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
      if (forbiddenKeys.some((f) => lowerKey.includes(f))) {
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
