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
 * - prismaRepository — module-level singleton for Evolution Instance table
 * - createJid (src/utils/createJid.ts) — JID formatting (adapter-private)
 * - platformRepository — PlatformInstance, InstanceEventLog, etc.
 */

import { InstanceDto } from '@api/dto/instance.dto';
import { prismaRepository, waMonitor } from '@api/server.module';
import { Integration } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';
import { getOnWhatsappCache } from '@utils/onWhatsappCache';
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

interface CachedQr {
  base64: string | null;
  pairingCode: string | null;
  capturedAt: number;
}

export class EvolutionAdapter implements IWhatsAppAdapter {
  private readonly logger = new Logger('EvolutionAdapter');
  private eventHandlers: Set<(event: LifecycleEvent) => void> = new Set();
  // In-memory cache of the latest QR per instance name. The SSE handler
  // also subscribes to Redis, but this cache is used by the polling
  // fallback in GET /instances/:id so the QR is available even if SSE
  // delivery is delayed.
  private qrCache: Map<string, CachedQr> = new Map();

  // ──────────────────────────────────────────────────────────────────────
  //  Connect
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Initiate a Baileys connection for an existing PlatformInstance.
   *
   * Steps (in order):
   *  1. Look up the PlatformInstance and its associated Evolution row
   *  2. Close any stale in-memory socket
   *  3. Hand the Evolution row ID to waMonitor.initializeInstance, which
   *     calls BaileysStartupService.create() + connectToWhatsapp() — that
   *     last call is what actually generates the QR
   *  4. Update PlatformInstance.status to CONNECTING
   *  5. Return immediately; the QR arrives via SSE / polling
   */
  async connectInstance(instanceId: string): Promise<{ qrCode?: string }> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const instanceName = platformInstance.name;

    // Already connected? Reuse the socket and return no QR needed.
    const existing = waMonitor.waInstances[instanceName];
    if (existing?.stateConnection?.state === 'open') {
      this.logger.log(`Instance ${instanceName} already connected, reusing socket`);
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

    // Find the Evolution row (created at instance-creation time by
    // InstanceService). If for some reason it's missing, create it now.
    let evolutionRow = await prismaRepository.instance.findFirst({
      where: { name: instanceName },
    });
    if (!evolutionRow) {
      this.logger.warn(`Evolution row missing for ${instanceName}; creating on the fly`);
      evolutionRow = await prismaRepository.instance.create({
        data: {
          name: instanceName,
          integration: Integration.WHATSAPP_BAILEYS,
          connectionStatus: 'close',
        },
      });
    }

    // Clear any cached QR from a previous connect attempt
    this.qrCache.delete(instanceName);

    // Initialize the Baileys service. This calls connectToWhatsapp() in
    // turn, which is what kicks off QR generation.
    const instanceData: InstanceDto = {
      instanceName,
      instanceId: evolutionRow.id,
      integration: Integration.WHATSAPP_BAILEYS,
      connectionStatus: 'connecting',
    };

    const service = await waMonitor.initializeInstance(instanceData);
    if (!service) {
      throw new Error(`Failed to initialize Baileys for ${instanceName}`);
    }

    // Update PlatformInstance status
    await platformRepository.platformInstance.update({
      where: { id: instanceId },
      data: { status: 'CONNECTING' },
    });

    // Hook a one-time event listener on the new Baileys service so we
    // can capture the first QR into our cache for the polling fallback.
    this.attachQrCacheListener(instanceName);

    this.logger.log(`Connect started for ${instanceName} (Evolution id=${evolutionRow.id})`);

    return {};
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Disconnect
  // ──────────────────────────────────────────────────────────────────────

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
      } catch (err) {
        this.logger.warn(`Logout error for ${instanceName}: ${err}`);
      }
    }

    // Clear any cached QR
    this.qrCache.delete(instanceName);

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

  // ──────────────────────────────────────────────────────────────────────
  //  Remove
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Delete the engine-side session row for an instance.
   *
   * The engine's `Instance` row is what the Baileys manager keys its
   * socket on, and the `Session` row hanging off it holds the WhatsApp
   * credentials. Both have to go when the platform instance goes,
   * otherwise a deleted number keeps a credential and a session row
   * forever.
   */
  async removeInstance(instanceId: string): Promise<void> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, name: true },
    });

    if (!platformInstance) return;

    // The socket goes first — deleting the row out from under a live
    // Baileys connection leaves it running with no record of itself.
    const existing = waMonitor.waInstances[platformInstance.name];
    if (existing) {
      try {
        await (existing as any).logoutInstance();
      } catch (err) {
        this.logger.warn(`Logout error for ${platformInstance.name} during removal: ${err}`);
      }
    }
    this.qrCache.delete(platformInstance.name);
    delete waMonitor.waInstances[platformInstance.name];

    // The engine's Session row cascades from here.
    await platformRepository.instance.deleteMany({
      where: { name: platformInstance.name },
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Restart
  // ──────────────────────────────────────────────────────────────────────

  async restartInstance(instanceId: string): Promise<void> {
    await this.disconnectInstance(instanceId);
    await this.connectInstance(instanceId);
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Read state
  // ──────────────────────────────────────────────────────────────────────

  async getInstanceState(instanceId: string): Promise<CanonicalInstanceState> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    // Reconcile the stored row with the live socket before answering.
    // The engine owns the truth about whether a device is connected; the
    // platform row is a copy of it, and a copy that is never refreshed
    // is a copy that lies.
    const status = await this.syncInstanceStatus(instanceId);
    const synced = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
      select: { phoneNumber: true, lastConnectedAt: true, capabilities: true },
    });

    return {
      publicId: platformInstance.publicId,
      status,
      phoneNumber: synced?.phoneNumber ?? platformInstance.phoneNumber,
      capabilities: (synced?.capabilities as string[]) ?? (platformInstance.capabilities as string[]) ?? [],
      connectedAt: synced?.lastConnectedAt?.toISOString() ?? platformInstance.lastConnectedAt?.toISOString() ?? null,
    };
  }

  /**
   * Reconcile the platform's instance row with the live engine state.
   *
   * The engine updates its own `Instance` row when the Baileys socket
   * opens or closes, but nothing told the platform. So a device that
   * had been paired and was sending messages perfectly well still read
   * `CONNECTING` in the platform row — the dashboard showed it as
   * never connected, and every tool that checks the stored status
   * refused to use it.
   *
   * This reads the live socket and the engine's row, and writes the
   * truth back onto the platform row.
   */
  async syncInstanceStatus(instanceId: string): Promise<InstanceStatus> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
      select: {
        id: true,
        name: true,
        status: true,
        phoneNumber: true,
        lastConnectedAt: true,
      },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const live = waMonitor.waInstances[platformInstance.name];
    const liveState = live?.stateConnection?.state;

    const engine = await platformRepository.instance.findFirst({
      where: { name: platformInstance.name },
      select: { number: true, ownerJid: true, connectionStatus: true },
    });

    /*
     * The live socket is the truth about whether the device is connected
     * RIGHT NOW. The engine's row records what was true when the process
     * last wrote it, which after a restart is simply stale — the row says
     * `open` while no socket exists at all.
     */
    let status: InstanceStatus = platformInstance.status as InstanceStatus;
    if (liveState === 'open') status = 'CONNECTED';
    else if (liveState === 'connecting') status = 'CONNECTING';
    else status = 'DISCONNECTED';

    // The number the session belongs to. The engine knows it two ways:
    // a dedicated `number` column, and the owner JID of the session
    // (`254…@s.whatsapp.net`). The JID is the one that is always
    // there — a device paired by QR code never has `number` set.
    const ownerJid = engine?.ownerJid ?? null;
    const phoneNumber = engine?.number ?? (ownerJid ? jidToPhone(ownerJid) : null) ?? platformInstance.phoneNumber;

    const statusChanged = status !== platformInstance.status;
    const phoneChanged = phoneNumber !== null && phoneNumber !== platformInstance.phoneNumber;
    const needsTimestamp = status === 'CONNECTED' && !platformInstance.lastConnectedAt;

    if (statusChanged || phoneChanged || needsTimestamp) {
      await platformRepository.platformInstance.update({
        where: { id: instanceId },
        data: {
          status,
          ...(phoneChanged ? { phoneNumber } : {}),
          ...(needsTimestamp ? { lastConnectedAt: new Date() } : {}),
        },
      });
      this.logger.log(
        `Instance ${platformInstance.name} is ${status}${phoneChanged && phoneNumber ? ` (${phoneNumber})` : ''}`,
      );
    }

    return status;
  }

  /**
   * The instance's own WhatsApp profile picture.
   *
   * Two sources, in order:
   *
   *   1. the live socket — WhatsApp hands out a fresh, signed URL every
   *      time it is asked, and the one stored on the engine row expires
   *      (the `oe=` parameter in it is an expiry stamp, about ten days
   *      out). A picture served from the stored URL silently stops
   *      rendering once it does.
   *   2. the engine row — what was last seen, used when the socket is
   *      not up.
   */
  async getProfilePicture(instanceId: string): Promise<{ url: string | null; name: string | null }> {
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, name: true, phoneNumber: true },
    });

    if (!platformInstance) {
      throw new Error(`PlatformInstance ${instanceId} not found`);
    }

    const engine = await platformRepository.instance.findFirst({
      where: { name: platformInstance.name },
      select: { profilePicUrl: true, profileName: true, ownerJid: true },
    });

    const live = waMonitor.waInstances[platformInstance.name];
    const number = platformInstance.phoneNumber ?? engine?.ownerJid ?? null;

    // The live socket can be asked for a fresh URL.
    if (live && number) {
      try {
        const fresh = await (live as any).profilePicture(number);
        if (fresh?.profilePictureUrl) {
          return { url: fresh.profilePictureUrl, name: engine?.profileName ?? null };
        }
      } catch (error) {
        this.logger.warn(`Could not fetch a fresh profile picture for ${platformInstance.name}: ${error}`);
      }
    }

    return { url: engine?.profilePicUrl ?? null, name: engine?.profileName ?? null };
  }

  /**
   * Reconcile every instance that has an engine row.
   *
   * A device can be paired while nobody is looking at the dashboard, and
   * the socket can drop while the API is restarting. A periodic sweep
   * means the platform's view of the world is never more than a few
   * seconds behind the engine's.
   */
  async syncAllInstanceStatuses(): Promise<void> {
    const instances = await platformRepository.platformInstance.findMany({
      select: { id: true },
    });
    for (const instance of instances) {
      try {
        await this.syncInstanceStatus(instance.id);
      } catch (error) {
        this.logger.warn(`Could not sync the status of instance ${instance.id}: ${error}`);
      }
    }
  }

  /**
   * Get the most recent QR for an instance, if available.
   * Reads from the in-memory cache (populated by SSE / direct event
   * capture). Returns null if no QR has been emitted yet.
   */
  getCachedQr(instanceName: string): CachedQr | null {
    return this.qrCache.get(instanceName) ?? null;
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Send / fetch
  // ──────────────────────────────────────────────────────────────────────

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

    // Resolve the LID for each contact. WhatsApp addresses a person by
    // a JID (the phone number) and, increasingly, by a LID (a privacy
    // preserving alias for the same person). The engine's contact
    // table only holds the JID, so the LID comes from the on-WhatsApp
    // cache, which records both identifiers for a contact.
    const remoteJids = contacts
      .map((contact: any) => contact.remoteJid)
      .filter((jid: unknown): jid is string => typeof jid === 'string' && jid.length > 0);
    const lidByJid = new Map<string, string>();
    try {
      const cached = await getOnWhatsappCache(remoteJids);
      for (const entry of cached) {
        const lidOption = entry.jidOptions?.find((option) => option.endsWith('@lid'));
        const lid = lidOption ?? (entry.lid ? entry.remoteJid : null);
        if (lid) lidByJid.set(entry.remoteJid, lid);
      }
    } catch {
      // The cache is a best-effort enrichment; a contact without a LID
      // is still a usable contact.
    }

    return contacts.map((contact: any) => {
      const jid = typeof contact.remoteJid === 'string' ? contact.remoteJid : null;
      const phone = jid ? jidToPhone(jid) : '';
      return {
        id: generatePublicId('cnt'),
        phoneNumber: phone,
        displayName: contact.pushName ?? null,
        profilePhotoUrl: contact.profilePicUrl ?? null,
        jid,
        lid: jid ? (lidByJid.get(jid) ?? null) : null,
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

  // ──────────────────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to QRCODE_UPDATED events on the running Baileys service
   * and cache the latest QR. Even if the SSE pipeline (which depends
   * on Redis pub/sub) drops a message, the polling fallback in the GET
   * handler can still read the cached QR.
   */
  private attachQrCacheListener(instanceName: string): void {
    const service = waMonitor.waInstances[instanceName];
    if (!service) {
      // Service not in waInstances yet; try again on a short delay
      setTimeout(() => this.attachQrCacheListener(instanceName), 200);
      return;
    }

    try {
      const data = (service as any).qrCode;
      if (data?.base64) {
        this.qrCache.set(instanceName, {
          base64: data.base64 ?? null,
          pairingCode: data.pairingCode ?? null,
          capturedAt: Date.now(),
        });
      }
    } catch {
      /* engine not yet initialized with QR — Redis event will fill it */
    }
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
