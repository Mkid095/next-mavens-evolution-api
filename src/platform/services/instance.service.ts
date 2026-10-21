import { prismaRepository } from '@api/server.module';
import { Integration } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';
import crypto from 'crypto';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { platformRepository } from '../repository/platform.repository';

/**
 * Public API DTO for a PlatformInstance.
 * Exposes inst_xxx public IDs only — no internal CUIDs.
 */
export interface InstancePublicDTO {
  id: string; // inst_xxx
  name: string;
  status: string;
  phoneNumber: string | null;
  capabilities: Record<string, unknown>;
  connectedAt: string | null; // ISO8601
  createdAt: string; // ISO8601
}

/**
 * Domain object — raw PlatformInstance from the database.
 */
interface PlatformInstanceDomain {
  id: string;
  publicId: string;
  accountId: string;
  name: string;
  status: string;
  phoneNumber: string | null;
  capabilities: unknown;
  lastConnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class InstanceService {
  private readonly logger = new Logger('InstanceService');

  // ──────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────

  /**
   * Create a new PlatformInstance AND pre-allocate the underlying
   * Evolution Instance row.
   *
   * Doing both at create time means:
   *  - Connect flow always has a real Evolution instanceId to bind to
   *  - The first /connect call doesn't have to do a fragile
   *    "find-or-create" against the engine that used a broken
   *    waMonitor.prismaRepository reference
   *  - The Evolution row exists before any SSE / Baileys startup, so
   *    events find a target channel immediately
   *
   * If the Evolution row already exists (very rare), we reuse it.
   *
   * `projectId` is the internal PlatformProject id (cuid) the instance
   * is scoped to — the `projectId` column is NOT NULL in the database.
   */
  async create(accountId: string, projectId: string, name: string): Promise<PlatformInstanceDomain> {
    const publicId = `inst_${crypto.randomBytes(8).toString('hex')}`;

    // 1) Pre-create the Evolution Instance row (in the engine's DB)
    let evolutionInstance = await prismaRepository.instance.findFirst({
      where: { name },
    });
    if (!evolutionInstance) {
      evolutionInstance = await prismaRepository.instance.create({
        data: {
          name,
          integration: Integration.WHATSAPP_BAILEYS,
          connectionStatus: 'close',
          // Links the engine row to its owning account. The webhook route
          // checks this column to prove the caller owns the instance.
          platformAccountId: accountId,
        },
      });
      this.logger.log(`Created Evolution Instance id=${evolutionInstance.id} name=${name}`);
    } else if (!evolutionInstance.platformAccountId) {
      // Reusing a row created before this column was populated — claim it
      // for the account creating the canonical row.
      evolutionInstance = await prismaRepository.instance.update({
        where: { id: evolutionInstance.id },
        data: { platformAccountId: accountId },
      });
      this.logger.log(
        `Claimed existing Evolution Instance id=${evolutionInstance.id} name=${name} for account ${accountId}`,
      );
    } else {
      this.logger.log(`Reusing existing Evolution Instance id=${evolutionInstance.id} name=${name}`);
    }

    // 2) Create the canonical PlatformInstance row
    const instance = await platformRepository.platformInstance.create({
      data: {
        publicId,
        accountId,
        projectId,
        name,
        status: 'CREATED',
        capabilities: [],
      },
    });

    this.logger.log(
      `Created PlatformInstance ${publicId} (Evolution id=${evolutionInstance.id}) for account ${accountId} project ${projectId}`,
    );
    return instance;
  }

  /**
   * Initiate a WhatsApp connection for an existing PlatformInstance.
   *
   * Calls the WhatsApp adapter. If the adapter returns a qrCode, the QR code
   * is emitted as a QR_CODE lifecycle event via the adapter's event system.
   */
  async connect(instanceId: string): Promise<{ qrCode?: string }> {
    const instance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!instance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const result = await evolutionAdapter.connectInstance(instanceId);

    if (result.qrCode) {
      // Emit QR code as a lifecycle event through the adapter
      await this.emitLifecycleEvent(instance.publicId, 'QR_CODE', {
        qrCode: result.qrCode,
      });
    }

    return result;
  }

  /**
   * Terminate the active WhatsApp connection for a PlatformInstance.
   */
  async disconnect(instanceId: string): Promise<void> {
    const instance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!instance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    await evolutionAdapter.disconnectInstance(instanceId);
    this.logger.log(`Disconnected PlatformInstance ${instance.publicId}`);
  }

  /**
   * Restart: disconnect then reconnect.
   */
  async restart(instanceId: string): Promise<void> {
    await this.disconnect(instanceId);
    await this.connect(instanceId);
  }

  /**
   * Retrieve a single PlatformInstance by ID.
   *
   * Enforces tenant isolation — only returns the instance if the supplied
   * accountId matches the record's accountId. When `projectId` is given the
   * instance must belong to that project as well.
   * Returns null if not found or if the caller does not own the instance.
   */
  async get(instanceId: string, accountId: string, projectId?: string): Promise<PlatformInstanceDomain | null> {
    const instance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!instance || instance.accountId !== accountId) {
      return null;
    }

    if (projectId && instance.projectId !== projectId) {
      return null;
    }

    return instance;
  }

  /**
   * List the PlatformInstances of a project.
   */
  async list(projectId: string): Promise<PlatformInstanceDomain[]> {
    return platformRepository.platformInstance.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Delete a PlatformInstance.
   *
   * Calls disconnectInstance on the adapter first to clean up the engine-side
   * connection, then deletes the PlatformInstance record.
   * Enforces tenant isolation — delete is only performed if the caller owns
   * the instance.
   */
  async delete(instanceId: string, accountId: string): Promise<void> {
    const instance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!instance || instance.accountId !== accountId) {
      // Silently succeed for non-existent or unauthorized instances
      // (idempotent delete)
      return;
    }

    // Clean up engine-side connection first
    try {
      await evolutionAdapter.disconnectInstance(instanceId);
    } catch (err) {
      this.logger.warn(`Error disconnecting instance ${instance.publicId} during delete: ${err}`);
    }

    await platformRepository.platformInstance.delete({
      where: { id: instanceId },
    });

    this.logger.log(`Deleted PlatformInstance ${instance.publicId}`);
  }

  /**
   * Bind an API key to an instance by creating a PlatformApiKeyInstance record.
   *
   * The API key must belong to the same account as the instance.
   * A unique constraint on [apiKeyId, instanceId] prevents duplicate bindings.
   */
  async bindApiKey(apiKeyId: string, instanceId: string): Promise<void> {
    const instance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!instance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    // Verify the API key belongs to the same account
    const apiKey = await platformRepository.platformApiKey.findUnique({
      where: { id: apiKeyId },
    });

    if (!apiKey || apiKey.accountId !== instance.accountId) {
      throw new Error(`PlatformApiKey ${apiKeyId} not found or does not belong to the same account`);
    }

    await platformRepository.platformApiKeyInstance.upsert({
      where: {
        apiKeyId_instanceId: { apiKeyId, instanceId },
      },
      create: { apiKeyId, instanceId },
      update: {}, // Already exists — no-op
    });

    this.logger.log(`Bound API key ${apiKey.publicId} to instance ${instance.publicId}`);
  }

  // ──────────────────────────────────────────────
  // DTO projection
  // ──────────────────────────────────────────────

  /**
   * Convert a PlatformInstance domain object to the public API DTO.
   * Strips internal CUID ids and replaces them with the public inst_xxx id.
   */
  toPublicDTO(instance: PlatformInstanceDomain): InstancePublicDTO {
    return {
      id: instance.publicId,
      name: instance.name,
      status: instance.status,
      phoneNumber: instance.phoneNumber,
      capabilities: (instance.capabilities as Record<string, unknown>) ?? {},
      connectedAt: instance.lastConnectedAt?.toISOString() ?? null,
      createdAt: instance.createdAt.toISOString(),
    };
  }

  // ──────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────

  private async emitLifecycleEvent(
    instancePublicId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;

    // Persist to InstanceEventLog for durability
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { publicId: instancePublicId },
    });

    if (platformInstance) {
      await platformRepository.instanceEventLog.create({
        data: {
          publicId: eventId,
          instanceId: platformInstance.id,
          eventType,
          payload: payload as unknown as object,
        },
      });
    }

    // Note: the event is persisted to InstanceEventLog above. Callers who want
    // live delivery should subscribe via evolutionAdapter.onLifecycleEvent() directly.
  }
}
