/**
 * IWhatsAppAdapter — engine-neutral WhatsApp adapter interface.
 *
 * Canonical services (InstanceService, MessageService, ContactService, GroupService)
 * use this interface exclusively. This interface contains NO JIDs, NO engine refs,
 * and NO engine-specific types.
 *
 * Implementation: EvolutionAdapter (src/platform/adapters/evolution.adapter.ts)
 */

export interface OutgoingMessage {
  to: string; // E.164 phone number
  type: 'text' | 'media' | 'audio' | 'button' | 'interactive' | 'template';
  content: Record<string, unknown>;
}

export interface CanonicalContact {
  id: string; // public cnt_xxx
  phoneNumber: string; // E.164
  displayName: string | null;
  profilePhotoUrl: string | null;
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
