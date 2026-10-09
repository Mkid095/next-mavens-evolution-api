/**
 * EvolutionAdapter — Baileys/Evolution implementation of IWhatsAppAdapter.
 *
 * This is the ONLY component that knows about:
 * - Baileys WASocket, JIDs, and protocol specifics
 * - Evolution engine integration
 *
 * Canonical services NEVER import from this file.
 *
 * IMPORTS:
 * - waMonitor (WAMonitoringService) — accesses waInstances[instanceName]
 * - createJid (src/utils/createJid.ts) — JID formatting (adapter-private)
 * - platformRepository — PlatformInstance, InstanceEventLog, etc.
 */

import { InstanceDto } from '@api/dto/instance.dto';
import { prismaRepository, waMonitor } from '@api/server.module';
import { Integration } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';
import crypto from 'crypto';

import { platformRepository } from '../repository/platform.repository';
import {
  CanonicalContact,
  CanonicalGroup,
  CanonicalInstanceState,
  EngineGroup,
  InstanceStatus,
  IWhatsAppAdapter,
  LifecycleEvent,
  OutgoingMessage,
} from './whatsapp.adapter';

function jidToPhone(jid: string): string {
  // Strip @s.whatsapp.net, @g.us, @lid, :\d+ suffix
  return jid.replace(/@.+$/, '').replace(/:\d+$/, '');
}

function generatePublicId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export class EvolutionAdapter implements IWhatsAppAdapter {
  private readonly logger = new Logger('EvolutionAdapter');
  private eventHandlers: Set<(event: LifecycleEvent) => void> = new Set();

  async connectInstance(instanceId: string): Promise<{ qrCode?: string }> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
      include: { account: true },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;

    // Check if already connected — reuse existing socket
    const existing = waMonitor.waInstances[instanceName];
    if (existing?.stateConnection?.state === 'open') {
      this.logger.log(`Instance ${instanceName} already connected, reusing socket`);
      // Update PlatformInstance status
      await platformRepository.platformInstance.update({
        where: { id: instanceId },
        data: {
          status: 'CONNECTED',
          phoneNumber: (existing as any).phoneNumber ?? null,
          lastConnectedAt: new Date(),
        },
      });
      return {};
    }

    // Close stale socket if exists
    if (existing) {
      try {
        await (existing as any).logoutInstance();
      } catch {
        // ignore close errors on stale entries
      }
    }

    // Load or create the Evolution Instance record via the module-level
    // prismaRepository singleton (not waMonitor.prismaRepository which
    // is private).
    let dbInstance = await prismaRepository.instance.findFirst({
      where: { name: instanceName },
    });

    if (!dbInstance) {
      // Create the Evolution Instance if it doesn't exist
      dbInstance = await prismaRepository.instance.create({
        data: {
          name: instanceName,
          integration: Integration.WHATSAPP_BAILEYS,
          connectionStatus: 'close',
        },
      });
    }

    // Initialize via waMonitor
    const instanceData: InstanceDto = {
      instanceName,
      instanceId: dbInstance.id,
      integration: Integration.WHATSAPP_BAILEYS,
      connectionStatus: 'connecting',
    };

    await waMonitor.initializeInstance(instanceData);

    // Update PlatformInstance status
    await platformRepository.platformInstance.update({
      where: { id: instanceId },
      data: { status: 'CONNECTING' },
    });

    // Listen for connection events to emit lifecycle events
    this.setupConnectionEventListener(instanceName);

    // Return empty — QR code will be emitted via lifecycle event if needed
    return {};
  }

  async disconnectInstance(instanceId: string): Promise<void> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;
    const existing = waMonitor.waInstances[instanceName];

    if (existing) {
      try {
        await (existing as any).logoutInstance();
      } catch {
        // ignore
      }
    }

    await platformRepository.platformInstance.update({
      where: { id: instanceId },
      data: { status: 'DISCONNECTED', phoneNumber: null },
    });

    await this.emitEvent({
      eventId: generatePublicId('evt'),
      eventType: 'CONNECTION_STATE',
      instancePublicId: platformInstance.publicId,
      payload: { status: 'DISCONNECTED' },
      timestamp: new Date().toISOString(),
    });
  }

  async restartInstance(instanceId: string): Promise<void> {
    await this.disconnectInstance(instanceId);
    await this.connectInstance(instanceId);
  }

  async getInstanceState(instanceId: string): Promise<CanonicalInstanceState> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;
    const existing = waMonitor.waInstances[instanceName];
    const isConnected = existing?.stateConnection?.state === 'open';

    let status: InstanceStatus = platformInstance.status as InstanceStatus;
    if (isConnected && status === 'CONNECTING') {
      status = 'CONNECTED';
    } else if (isConnected && status !== 'DISCONNECTED' && status !== 'SUSPENDED') {
      status = 'CONNECTED';
    }

    return {
      publicId: platformInstance.publicId,
      status,
      phoneNumber: platformInstance.phoneNumber,
      capabilities: (platformInstance.capabilities as string[]) ?? [],
      connectedAt: platformInstance.lastConnectedAt?.toISOString() ?? null,
    };
  }

  async sendMessage(
    instanceId: string,
    message: OutgoingMessage,
  ): Promise<{ messageId: string; engineRef: string | null }> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;
    const service = waMonitor.waInstances[instanceName];

    if (!service) {
      throw new Error(`Instance ${instanceName} not connected`);
    }

    // Convert E.164 → JID
    const recipientJid = this.phoneToJid(message.to);

    // Call Baileys textMessage
    const result = await (service as any).textMessage(
      { number: recipientJid, text: (message.content as any).text ?? '' },
      true, // isIntegration
    );

    // Extract engine message key ID — this is internal only, never exposed in API
    const engineRef = result?.key?.id ?? null;

    // Generate canonical public message ID — this is what the API consumer sees
    const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;

    return { messageId, engineRef };
  }

  async fetchContacts(instanceId: string): Promise<CanonicalContact[]> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;
    const service = waMonitor.waInstances[instanceName];

    if (!service) {
      return [];
    }

    // Fetch from Baileys via the service
    const contacts = (await (service as any).fetchContacts?.()) ?? [];

    return contacts.map((contact: any) => {
      const phone = jidToPhone(contact.remoteJid ?? '');
      return {
        id: generatePublicId('cnt'),
        phoneNumber: phone,
        displayName: contact.pushName ?? null,
        profilePhotoUrl: contact.profilePicUrl ?? null,
      };
    });
  }

  async fetchGroups(instanceId: string): Promise<CanonicalGroup[]> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;
    const service = waMonitor.waInstances[instanceName];

    if (!service) {
      return [];
    }

    // Fetch groups from Baileys via the service
    const groups = (await (service as any).fetchGroups?.()) ?? [];

    return groups.map((group: any) => ({
      id: generatePublicId('grp'),
      name: group.subject ?? group.name ?? 'Unknown',
      participantCount: group.participants?.length ?? 0,
    }));
  }

  /**
   * Fetch groups with engine JIDs for internal sync use only.
   * @internal
   */
  async fetchGroupsForSync(instanceId: string): Promise<EngineGroup[]> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;
    const service = waMonitor.waInstances[instanceName];

    if (!service) {
      return [];
    }

    const groups = (await (service as any).fetchGroups?.()) ?? [];

    return groups.map((group: any) => ({
      id: generatePublicId('grp'),
      engineJid: group.id ?? '',
      name: group.subject ?? group.name ?? 'Unknown',
      participantCount: group.participants?.length ?? 0,
    }));
  }

  onLifecycleEvent(handler: (event: LifecycleEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  // ────────────────────────────────────────────────
  // Private helper methods
  // ────────────────────────────────────────────────

  private setupConnectionEventListener(instanceName: string): void {
    const service = waMonitor.waInstances[instanceName];
    if (!service) return;

    // The lifecycle events are written to InstanceEventLog and forwarded
    // The Baileys service emits via eventHandler on waMonitor
  }

  private async emitEvent(event: LifecycleEvent): Promise<void> {
    // Write to InstanceEventLog for durability
    await platformRepository.instanceEventLog.create({
      data: {
        publicId: event.eventId,
        instanceId:
          (
            await platformRepository.platformInstance.findFirst({
              where: { publicId: event.instancePublicId },
            })
          )?.id ?? '',
        eventType: event.eventType,
        payload: event.payload as any,
      },
    });

    // Emit to all registered handlers
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error(`Event handler error: ${err}`);
      }
    }
  }

  private phoneToJid(phone: string): string {
    // Import createJid dynamically to keep this adapter-private
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createJid } = require('@utils/createJid');
    return createJid(phone);
  }
}

// Singleton instance
export const evolutionAdapter = new EvolutionAdapter();
