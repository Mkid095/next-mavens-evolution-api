/**
 * IWhatsAppAdapter — engine-neutral WhatsApp adapter interface.
 *
 * Canonical services (InstanceService, MessageService, ContactService, GroupService)
 * use this interface exclusively. This interface contains NO JIDs, NO engine refs,
 * and NO engine-specific types.
 *
 * Implementation: EvolutionAdapter (src/platform/adapters/evolution.adapter.ts)
 */

/**
 * A message on its way out.
 *
 * `type` decides which engine call is used:
 *
 *   text          → `textMessage`
 *   image         → `mediaMessage` with mediatype 'image'
 *   video         → `mediaMessage` with mediatype 'video'
 *   document      → `mediaMessage` with mediatype 'document'
 *   audio         → `mediaMessage` with mediatype 'audio'
 *
 * The rest are named in the type union because the platform accepted
 * them for a while and stored them without ever transmitting one. They
 * are rejected at the API now rather than quietly accepted.
 */
export type OutgoingMessageType = 'text' | 'image' | 'video' | 'document' | 'audio';

/** The message types the platform transmits. */
export const OUTGOING_MESSAGE_TYPES: OutgoingMessageType[] = ['text', 'image', 'video', 'document', 'audio'];

/**
 * The media types, and the `mediatype` the engine wants for each.
 *
 * `image`, `video`, `document` and `audio` are the four the engine's
 * `mediaMessage` handles. `ptv` exists on the engine but is a WhatsApp
 * status reel, not something a broadcast wants.
 */
export const MEDIA_TYPES: Record<string, string> = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
};

export interface OutgoingMessage {
  to: string; // E.164 phone number
  type: OutgoingMessageType;
  content: Record<string, unknown>;
}

export interface CanonicalContact {
  id: string; // public cnt_xxx
  phoneNumber: string; // E.164
  displayName: string | null;
  profilePhotoUrl: string | null;
  /**
   * The contact's WhatsApp address (`5511999999999@s.whatsapp.net`).
   * This is the identifier to use when addressing the contact.
   */
  jid: string | null;
  /**
   * The contact's LID (`123456789012345@lid`) — WhatsApp's privacy
   * preserving identifier for the same person. Null when the contact
   * has no known LID.
   */
  lid: string | null;
}

export interface CanonicalGroup {
  id: string; // public grp_xxx
  name: string;
  participantCount: number;
}

/**
 * Internal type for group sync — includes engine-specific JID used for
 * upsert matching in PlatformGroupEngineRef. NEVER exposed through
 * IWhatsAppAdapter — consumed only by adapter-private sync logic.
 */
export interface EngineGroup {
  id: string; // public grp_xxx
  engineJid: string;
  name: string;
  participantCount: number;
}

export interface CanonicalInstanceState {
  publicId: string; // inst_xxx
  status: InstanceStatus;
  phoneNumber: string | null; // E.164
  capabilities: string[];
  connectedAt: string | null; // ISO8601
}

export type InstanceStatus = 'CREATED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'SUSPENDED';

export interface LifecycleEvent {
  eventId: string; // evt_xxx — stable public event ID
  eventType: LifecycleEventType;
  instancePublicId: string; // inst_xxx
  payload: Record<string, unknown>;
  timestamp: string; // ISO8601
}

export type LifecycleEventType =
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_SENT'
  | 'MESSAGE_DELIVERED'
  | 'MESSAGE_READ'
  | 'CONNECTION_STATE'
  | 'INSTANCE_CREATED'
  | 'INSTANCE_DELETED'
  | 'QR_CODE'
  | 'LABEL_UPDATE';

/**
 * Engine-neutral WhatsApp adapter.
 *
 * Canonical services use this exclusively.
 * NO JIDs, NO engine refs in this interface.
 * InstanceService owns canonical PlatformInstance creation — createInstance() is NOT here.
 */
export interface IWhatsAppAdapter {
  /**
   * Initiate engine connection for an existing PlatformInstance.
   * InstanceService.createInstance() creates the canonical record;
   * connectInstance() provisions the engine side.
   *
   * @returns qrCode if pairing is required (user must scan)
   */
  connectInstance(instanceId: string): Promise<{ qrCode?: string }>;

  /**
   * Terminate active engine connection.
   */
  disconnectInstance(instanceId: string): Promise<void>;

  /**
   * Remove the engine-side session for an instance.
   *
   * Disconnecting leaves the engine's own record of the session behind —
   * the Baileys credentials and the socket's row. Deleting the platform
   * instance has to take that with it, or every instance that is ever
   * deleted leaves a stale session behind forever.
   */
  removeInstance(instanceId: string): Promise<void>;

  /**
   * Disconnect and reconnect (logout + connect).
   */
  restartInstance(instanceId: string): Promise<void>;

  /**
   * Get current canonical instance state.
   */
  getInstanceState(instanceId: string): Promise<CanonicalInstanceState>;

  /**
   * Send a WhatsApp message.
   * @returns messageId — canonical public ID (msg_xxx)
   * @returns engineRef — engine-specific message key (internal only, not exposed in API)
   */
  sendMessage(instanceId: string, message: OutgoingMessage): Promise<{ messageId: string; engineRef: string | null }>;

  /**
   * Which of these numbers are on WhatsApp.
   *
   * WhatsApp does not refuse a message to a number that has no account —
   * it accepts it and never delivers it. So "not on WhatsApp" cannot be
   * read off a failed send; it has to be asked for. The engine checks its
   * own cache first and only calls WhatsApp for what it does not know.
   */
  checkNumbersOnWhatsapp(
    instanceId: string,
    numbers: string[],
  ): Promise<{ number: string; onWhatsapp: boolean; name?: string }[]>;

  /**
   * Fetch canonical contacts from engine.
   */
  fetchContacts(instanceId: string): Promise<CanonicalContact[]>;

  /**
   * Fetch canonical groups from engine.
   * Returns only engine-neutral data — no engine JIDs.
   */
  fetchGroups(instanceId: string): Promise<CanonicalGroup[]>;

  /**
   * Fetch groups with engine-specific JIDs for internal sync operations.
   * Adapter-private — consumed only by the group sync logic.
   * @internal
   */
  fetchGroupsForSync(instanceId: string): Promise<EngineGroup[]>;

  /**
   * Register a handler for lifecycle events (MESSAGE_RECEIVED, CONNECTION_STATE, etc.).
   * @returns unsubscribe function
   */
  onLifecycleEvent(handler: (event: LifecycleEvent) => void): () => void;
}
