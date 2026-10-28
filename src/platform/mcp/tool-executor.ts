import { configService } from '@config/env.config';
import { Request } from 'express';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { docsService } from '../services/docs.service';
import { InstanceService } from '../services/instance.service';
import { PlatformAuthService } from '../services/platform-auth.service';
import { ProjectScope } from '../services/project-scope.service';
import { resolveRequestProject } from '../services/request-project';
import { SubscriptionService } from '../services/subscription.service';
import { UsageService } from '../services/usage.service';
import { WebhookService } from '../services/webhook.service';
import { PlatformTenant } from '../types/platform-tenant';
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
} from './jsonrpc';

// ─── Error codes (kept identical to the legacy /invoke envelope) ──────────────

export { JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS, JSONRPC_INVALID_REQUEST, JSONRPC_METHOD_NOT_FOUND };

// ─── Types ────────────────────────────────────────────────────────────────────

/** A tool failure — carries the same code the legacy envelope used. */
export interface ToolError {
  code: number;
  message: string;
  data?: unknown;
}

/** The outcome of a tool invocation. */
export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: ToolError };

/** Everything a tool needs to run. */
export interface ToolContext {
  /** The resolved tenant (account) the call runs as. */
  tenant: PlatformTenant;
  /** The incoming request — used to forward the caller's credentials. */
  req: Request;
}

/** Thrown by helpers that fail with a specific, user-facing error code. */
export class ToolExecutionError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

/**
 * Type guard for a failed tool outcome.
 *
 * The project compiles with `strictNullChecks: false`, which disables
 * TypeScript's built-in narrowing of discriminated unions — a plain
 * `if (!outcome.ok)` would not narrow. This guard restores it.
 */
export function isToolError(outcome: ToolOutcome): outcome is { ok: false; error: ToolError } {
  return outcome.ok === false;
}

// ─── Service singletons ───────────────────────────────────────────────────────

const instanceService = new InstanceService();
export const auditService = new AuditService();
let webhookService: WebhookService;
let authService: PlatformAuthService;
let usageService: UsageService;
let subscriptionService: SubscriptionService;

function getWebhookService(): WebhookService {
  if (!webhookService) webhookService = new WebhookService();
  return webhookService;
}
function getAuthService(): PlatformAuthService {
  if (!authService) authService = new PlatformAuthService();
  return authService;
}
function getUsageService(): UsageService {
  if (!usageService) usageService = new UsageService();
  return usageService;
}
function getSubscriptionService(): SubscriptionService {
  if (!subscriptionService) subscriptionService = new SubscriptionService();
  return subscriptionService;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(code: number, message: string, data?: unknown): ToolOutcome {
  return { ok: false, error: { code, message, data } };
}

/**
 * Find an instance by its public id, scoped to a project.
 *
 * The API key that authenticated the call names the project, so an
 * agent can only ever reach the instances of the project it holds a
 * key for.
 */
async function resolveInstance(instanceId: string, projectId: string) {
  const instance = await platformRepository.platformInstance.findFirst({
    where: { publicId: instanceId, projectId },
  });

  // Reconcile the stored status with the live socket before the caller
  // reads it. A device that was paired while the platform was not
  // looking would otherwise be reported as never connected, and every
  // tool that checks the status would refuse to use it.
  if (instance) {
    try {
      await evolutionAdapter.syncInstanceStatus(instance.id);
    } catch {
      // A failed sync must not stop the tool from running — the row is
      // still the best answer available.
    }
  }

  return platformRepository.platformInstance.findFirst({
    where: { publicId: instanceId, projectId },
  });
}

/** Read the dashboard session id off the request cookie, if there is one. */
function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  return header.match(/(?:^|;\s*)sessionId=([^;]+)/)?.[1];
}

/**
 * Send a message through the canonical public route.
 *
 * `POST /api/v1/messages/send` is the route the dashboard uses: it resolves
 * the instance from its public id, applies the entitlement + rate limit
 * checks and enqueues a durable PlatformMessageCommand. Calling it (instead
 * of writing to the queue directly) is what keeps MCP messages paced exactly
 * like REST messages.
 *
 * The caller's credentials are forwarded, so the internal call is
 * authenticated as the same account — an API key is forwarded as
 * `X-API-Key`, a dashboard session as the `sessionId` cookie.
 */
async function sendViaPublicApi(
  req: Request,
  body: {
    instancePublicId: string;
    number: string;
    text?: string;
    type: string;
    media?: string;
    caption?: string;
    fileName?: string;
    mimeType?: string;
  },
): Promise<string> {
  const base = (configService.get('PLATFORM').PUBLIC_API_BASE || '').replace(/\/+$/, '');
  if (!base) {
    throw new ToolExecutionError(-32006, 'PUBLIC_API_BASE is not configured — cannot enqueue a message');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Forward whichever credential the caller used. The platform accepts
  // either header, and a client that sent `Authorization: Bearer` would
  // get a 401 from this internal call if only `X-API-Key` were copied.
  const apiKeyHeader = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (apiKey) headers['X-API-Key'] = apiKey;

  const authorizationHeader = req.headers.authorization;
  const authorization = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (authorization) headers.Authorization = authorization;

  const sessionId = readSessionCookie(req);
  if (sessionId) headers.Cookie = `sessionId=${sessionId}`;

  let response;
  try {
    response = await fetch(`${base}/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolExecutionError(-32006, `Could not reach the platform message API: ${reason}`);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    messageId?: string;
    error?: string;
    message?: string;
  };

  if (!response.ok) {
    throw new ToolExecutionError(-32006, payload.message || payload.error || 'Send failed', {
      statusCode: response.status,
    });
  }
  if (!payload.messageId) {
    throw new ToolExecutionError(-32006, 'The platform message API did not return a message id', {
      statusCode: response.status,
    });
  }
  return payload.messageId;
}

// ─── Tool executor ────────────────────────────────────────────────────────────

/**
 * Execute an MCP tool.
 *
 * This is the single implementation shared by the legacy
 * `POST /api/v1/platform/mcp/invoke` endpoint and the standard MCP
 * transport (`POST /api/v1/platform/mcp`) — the two differ only in how the
 * outcome is serialised.
 */
export async function executeTool(
  tool: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const tenant = ctx.tenant;
  const req = ctx.req;

  // The project the call is scoped to. An API key names its own
  // project; a dashboard session falls back to the account's default
  // project. Resolved lazily — the account-level tools (plans, usage,
  // documentation) do not need it.
  let projectPromise: Promise<ProjectScope | null> | null = null;
  const getProject = (): Promise<ProjectScope | null> => {
    if (!projectPromise) {
      projectPromise = resolveRequestProject(req, tenant.accountId);
    }
    return projectPromise;
  };

  try {
    switch (tool) {
      // ══════════════════════════════════════════════════════
      // INSTANCES
      // ══════════════════════════════════════════════════════

      case 'list_instances': {
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instances = await platformRepository.platformInstance.findMany({
          where: { projectId: project.id },
          select: {
            publicId: true,
            name: true,
            status: true,
            phoneNumber: true,
            capabilities: true,
            lastConnectedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        });
        return {
          ok: true,
          data: {
            instances: instances.map((i) => ({
              id: i.publicId,
              name: i.name,
              status: i.status,
              phoneNumber: i.phoneNumber,
              capabilities: i.capabilities ?? {},
              connectedAt: i.lastConnectedAt?.toISOString() ?? null,
              createdAt: i.createdAt.toISOString(),
            })),
            total: instances.length,
          },
        };
      }

      case 'get_instance': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        return {
          ok: true,
          data: {
            id: instance.publicId,
            name: instance.name,
            status: instance.status,
            phoneNumber: instance.phoneNumber,
            capabilities: instance.capabilities ?? {},
            connectedAt: instance.lastConnectedAt?.toISOString() ?? null,
            createdAt: instance.createdAt.toISOString(),
          },
        };
      }

      case 'instance_status': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        return {
          ok: true,
          data: {
            id: instance.publicId,
            name: instance.name,
            status: instance.status,
            phoneNumber: instance.phoneNumber,
          },
        };
      }

      case 'list_instances_summary': {
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instances = await platformRepository.platformInstance.findMany({
          where: { projectId: project.id },
          select: { status: true },
        });
        const summary = {
          CONNECTED: 0,
          CONNECTING: 0,
          CREATED: 0,
          DISCONNECTED: 0,
          SUSPENDED: 0,
          total: instances.length,
        };
        for (const inst of instances) {
          const s = inst.status as keyof typeof summary;
          if (s in summary) (summary as Record<string, number>)[s]++;
        }
        return { ok: true, data: summary };
      }

      case 'create_instance': {
        const { name } = params as { name?: string };
        if (!name) return fail(JSONRPC_INVALID_PARAMS, 'name is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const existing = await platformRepository.platformInstance.findFirst({
          where: { accountId: tenant.accountId, name },
        });
        if (existing) return fail(-32002, 'Instance with this name already exists', { name });
        const domain = await instanceService.create(tenant.accountId, project.id, name);
        await auditService.record(
          tenant.accountId,
          'INSTANCE_CREATED',
          { type: 'instance', id: domain.publicId },
          { instancePublicId: domain.publicId },
          { projectId: project.id },
        );
        return {
          ok: true,
          data: {
            id: domain.publicId,
            name: domain.name,
            status: domain.status,
            createdAt: domain.createdAt.toISOString(),
          },
        };
      }

      case 'delete_instance': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return { ok: true, data: { deleted: false, reason: 'not_found' } }; // Idempotent
        await instanceService.delete(instance.id, tenant.accountId);
        await auditService.record(
          tenant.accountId,
          'INSTANCE_DELETED',
          { type: 'instance', id: instanceId },
          { instancePublicId: instance.publicId },
          { projectId: project.id },
        );
        return { ok: true, data: { deleted: true } };
      }

      case 'whatsapp_connect': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        if (instance.status === 'CONNECTED') {
          return { ok: true, data: { status: 'CONNECTED', message: 'Instance already connected' } };
        }
        await instanceService.connect(instance.id);
        await auditService.record(
          tenant.accountId,
          'INSTANCE_CONNECT_INITIATED',
          { type: 'instance', id: instanceId },
          { instancePublicId: instance.publicId },
          { projectId: project.id },
        );
        return {
          ok: true,
          data: {
            status: 'CONNECTING',
            message: 'Connection initiated. Subscribe to SSE stream for QR code and status updates.',
            instanceId,
          },
        };
      }

      case 'whatsapp_disconnect': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        await instanceService.disconnect(instance.id);
        await auditService.record(
          tenant.accountId,
          'INSTANCE_DISCONNECTED',
          { type: 'instance', id: instanceId },
          { instancePublicId: instance.publicId },
          { projectId: project.id },
        );
        return { ok: true, data: { status: 'DISCONNECTED', instanceId } };
      }

      case 'whatsapp_restart': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        await instanceService.restart(instance.id);
        await auditService.record(
          tenant.accountId,
          'INSTANCE_RESTARTED',
          { type: 'instance', id: instanceId },
          { instancePublicId: instance.publicId },
          { projectId: project.id },
        );
        return { ok: true, data: { status: 'CONNECTING', instanceId, message: 'Restart initiated' } };
      }

      // ══════════════════════════════════════════════════════
      // MESSAGES
      // ══════════════════════════════════════════════════════

      case 'send_message': {
        const { instanceId, recipient, text } = params as {
          instanceId?: string;
          recipient?: string;
          text?: string;
        };
        if (!instanceId || !recipient || !text) {
          return fail(JSONRPC_INVALID_PARAMS, 'instanceId, recipient, and text are required');
        }
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        if (instance.status !== 'CONNECTED') {
          return fail(-32009, 'Instance not connected', { instanceId, status: instance.status });
        }

        // Goes through the canonical public route, so the message is queued
        // (and paced) exactly like a REST message.
        const messageId = await sendViaPublicApi(req, {
          instancePublicId: instance.publicId,
          number: recipient,
          text,
          type: 'text',
        });

        await auditService.record(
          tenant.accountId,
          'MESSAGE_SENT',
          { type: 'message', id: messageId },
          { instancePublicId: instance.publicId },
          { projectId: project.id },
        );
        return { ok: true, data: { messageId, status: 'queued' } };
      }

      case 'send_media': {
        const { instanceId, recipient, type, url, caption } = params as {
          instanceId?: string;
          recipient?: string;
          type?: string;
          url?: string;
          caption?: string;
        };
        if (!instanceId || !recipient || !type || !url) {
          return fail(JSONRPC_INVALID_PARAMS, 'instanceId, recipient, type, and url are required');
        }
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        if (instance.status !== 'CONNECTED') {
          return fail(-32009, 'Instance not connected', { instanceId, status: instance.status });
        }

        // The media is sent AS media. It used to be carried in the body of
        // a text message — the URL, with the caption above it — so what
        // the recipient got was a link, not the picture. The platform
        // transmits image, video, document and audio now, so the tool
        // does too.
        const messageId = await sendViaPublicApi(req, {
          instancePublicId: instance.publicId,
          number: recipient,
          type,
          media: url,
          ...(caption ? { caption } : {}),
        });

        await auditService.record(
          tenant.accountId,
          'MESSAGE_SENT',
          { type: 'message', id: messageId },
          { instancePublicId: instance.publicId },
          { projectId: project.id },
        );
        return {
          ok: true,
          data: {
            messageId,
            status: 'queued',
            mediaType: type,
            mediaUrl: url,
            caption: caption ?? null,
          },
        };
      }

      case 'get_message_status': {
        const { instanceId, messageId, state, limit } = params as {
          instanceId?: string;
          messageId?: string;
          state?: string;
          limit?: number;
        };
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');

        const { messageStatusService } = await import('../services/message-status.service');
        const accountId = project.accountId;

        // One message.
        if (messageId) {
          const message = await messageStatusService.get(accountId, messageId);
          if (!message) {
            return fail(-32004, `Unknown message: ${messageId}`);
          }
          return { ok: true, data: message };
        }

        // The whole picture.
        const instancePublicId = instanceId;
        if (instancePublicId) {
          const instance = await resolveInstance(instancePublicId, project.id);
          if (!instance) {
            return fail(-32004, 'Instance not found', { instanceId });
          }
        }

        const summary = await messageStatusService.summary(accountId, {
          instancePublicId,
          since: undefined,
        });
        const page = await messageStatusService.list(accountId, {
          instancePublicId,
          state: state as never,
          limit: typeof limit === 'number' ? limit : undefined,
        });

        return { ok: true, data: { summary, messages: page.messages, nextCursor: page.nextCursor } };
      }

      case 'check_numbers_on_whatsapp': {
        const { instanceId, numbers } = params as { instanceId?: string; numbers?: string[] };
        if (!instanceId || !Array.isArray(numbers) || numbers.length === 0) {
          return fail(JSONRPC_INVALID_PARAMS, 'instanceId and a non-empty numbers array are required');
        }
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) {
          return fail(-32004, 'Instance not found', { instanceId });
        }

        const { evolutionAdapter } = await import('../adapters/evolution.adapter');
        try {
          const results = await evolutionAdapter.checkNumbersOnWhatsapp(
            instance.id,
            numbers.map((n) => String(n)),
          );
          return {
            ok: true,
            data: {
              total: results.length,
              onWhatsapp: results.filter((r) => r.onWhatsapp).length,
              notOnWhatsapp: results.filter((r) => !r.onWhatsapp).length,
              results,
            },
          };
        } catch (error) {
          return fail(-32006, `Could not check the numbers: ${String(error)}`);
        }
      }

      // ══════════════════════════════════════════════════════
      // WEBHOOKS
      // ══════════════════════════════════════════════════════

      case 'list_webhooks': {
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const ws = getWebhookService();
        const webhooks = await ws.listWebhooks(project.id);
        const instanceIds = [...new Set(webhooks.map((w: any) => w.instanceId))];
        const instances = await platformRepository.platformInstance.findMany({
          where: { id: { in: instanceIds } },
          select: { id: true, publicId: true },
        });
        const instanceMap: Record<string, string> = {};
        for (const inst of instances) instanceMap[inst.id] = inst.publicId;
        return {
          ok: true,
          data: {
            webhooks: webhooks.map((w: any) => ({
              id: w.publicId,
              instanceId: instanceMap[w.instanceId] ?? w.instanceId,
              url: w.url,
              events: w.events,
              enabled: w.enabled,
              createdAt: w.createdAt.toISOString(),
            })),
          },
        };
      }

      case 'get_webhook': {
        const { webhookId } = params as { webhookId?: string };
        if (!webhookId) return fail(JSONRPC_INVALID_PARAMS, 'webhookId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const webhook = await platformRepository.platformWebhook.findFirst({
          where: { publicId: webhookId, projectId: project.id },
        });
        if (!webhook) return fail(-32004, 'Webhook not found', { webhookId });
        return {
          ok: true,
          data: {
            id: webhook.publicId,
            instanceId: webhook.instanceId,
            url: webhook.url,
            events: webhook.events,
            enabled: webhook.enabled,
            createdAt: webhook.createdAt.toISOString(),
          },
        };
      }

      case 'create_webhook': {
        const { instanceId, url, events } = params as { instanceId?: string; url?: string; events?: string[] };
        if (!instanceId || !url || !events) {
          return fail(JSONRPC_INVALID_PARAMS, 'instanceId, url, and events are required');
        }
        if (!Array.isArray(events) || events.length === 0) {
          return fail(JSONRPC_INVALID_PARAMS, 'events must be a non-empty array');
        }
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        const ws = getWebhookService();
        const result = await ws.createWebhook(tenant.accountId, project.id, instance.id, url, events);
        await auditService.record(
          tenant.accountId,
          'WEBHOOK_CREATED',
          { type: 'webhook', id: result.publicId },
          undefined,
          { projectId: project.id },
        );
        return {
          ok: true,
          data: {
            id: result.publicId,
            secret: result.secret,
            url: result.url,
            events: result.events,
            instanceId,
          },
        };
      }

      case 'update_webhook': {
        const { webhookId, url, events, enabled } = params as {
          webhookId?: string;
          url?: string;
          events?: string[];
          enabled?: boolean;
        };
        if (!webhookId) return fail(JSONRPC_INVALID_PARAMS, 'webhookId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const webhook = await platformRepository.platformWebhook.findFirst({
          where: { publicId: webhookId, projectId: project.id },
        });
        if (!webhook) return fail(-32004, 'Webhook not found', { webhookId });
        const updateData: { url?: string; events?: string[]; enabled?: boolean } = {};
        if (url !== undefined) updateData.url = url;
        if (events !== undefined) updateData.events = events;
        if (enabled !== undefined) updateData.enabled = enabled;
        const ws = getWebhookService();
        await ws.updateWebhook(webhook.id, updateData);
        await auditService.record(tenant.accountId, 'WEBHOOK_UPDATED', { type: 'webhook', id: webhookId });
        return { ok: true, data: { updated: true, webhookId } };
      }

      case 'delete_webhook': {
        const { webhookId } = params as { webhookId?: string };
        if (!webhookId) return fail(JSONRPC_INVALID_PARAMS, 'webhookId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const webhook = await platformRepository.platformWebhook.findFirst({
          where: { publicId: webhookId, projectId: project.id },
        });
        if (!webhook) return { ok: true, data: { deleted: false, reason: 'not_found' } }; // Idempotent
        const ws = getWebhookService();
        await ws.deleteWebhook(webhook.id);
        await auditService.record(tenant.accountId, 'WEBHOOK_DELETED', { type: 'webhook', id: webhookId });
        return { ok: true, data: { deleted: true } };
      }

      case 'test_webhook': {
        const { webhookId } = params as { webhookId?: string };
        if (!webhookId) return fail(JSONRPC_INVALID_PARAMS, 'webhookId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const webhook = await platformRepository.platformWebhook.findFirst({
          where: { publicId: webhookId, projectId: project.id },
        });
        if (!webhook) return fail(-32004, 'Webhook not found', { webhookId });
        const ws = getWebhookService();
        const testPayload = {
          event: 'test',
          timestamp: new Date().toISOString(),
          data: { message: 'Test payload from Viventure MCP' },
        };
        const timestamp = Math.floor(Date.now() / 1000);
        const plaintextSecret = ws.decrypt(webhook.secret);
        const signature = ws.signPayload(JSON.stringify(testPayload), timestamp, plaintextSecret);
        try {
          const response = await fetch(webhook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Viventure-Timestamp': String(timestamp),
              'X-Viventure-Signature': signature,
            },
            body: JSON.stringify(testPayload),
            signal: AbortSignal.timeout(10000),
          });
          return { ok: true, data: { delivered: response.ok, statusCode: response.status, webhookId } };
        } catch (err) {
          return { ok: true, data: { delivered: false, error: String(err), webhookId } };
        }
      }

      case 'rotate_webhook_secret': {
        const { webhookId } = params as { webhookId?: string };
        if (!webhookId) return fail(JSONRPC_INVALID_PARAMS, 'webhookId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const webhook = await platformRepository.platformWebhook.findFirst({
          where: { publicId: webhookId, projectId: project.id },
        });
        if (!webhook) return fail(-32004, 'Webhook not found', { webhookId });
        const ws = getWebhookService();
        const { secret } = await ws.rotateSecret(webhook.id);
        await auditService.record(tenant.accountId, 'WEBHOOK_SECRET_ROTATED', { type: 'webhook', id: webhookId });
        return { ok: true, data: { webhookId, secret } };
      }

      // ══════════════════════════════════════════════════════
      // API KEYS
      // ══════════════════════════════════════════════════════

      case 'list_api_keys': {
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const as = getAuthService();
        const keys = await as.listApiKeys(tenant.accountId, project.id);
        return {
          ok: true,
          data: {
            apiKeys: keys.map((k: any) => ({
              id: k.publicId,
              name: k.name,
              scopes: k.scopes ?? [],
              keyPrefix: k.keyPrefix ?? null,
              createdAt: k.createdAt.toISOString(),
              expiresAt: k.expiresAt?.toISOString() ?? null,
              lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
            })),
          },
        };
      }

      case 'create_api_key': {
        const { name, scopes, expiresAt } = params as { name?: string; scopes?: string[]; expiresAt?: string };
        if (!name) return fail(JSONRPC_INVALID_PARAMS, 'name is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const as = getAuthService();
        const { plaintextKey, publicId } = await as.createApiKey(
          tenant.accountId,
          project.id,
          name,
          scopes ?? ['*'],
          expiresAt ? new Date(expiresAt) : undefined,
        );
        await auditService.record(tenant.accountId, 'API_KEY_CREATED', { type: 'api_key', id: publicId }, undefined, {
          projectId: project.id,
        });
        return {
          ok: true,
          data: {
            id: publicId,
            name,
            key: plaintextKey,
            scopes: scopes ?? ['*'],
            expiresAt: expiresAt ?? null,
            message: 'Store this key securely — it will not be shown again.',
          },
        };
      }

      case 'revoke_api_key': {
        const { keyId } = params as { keyId?: string };
        if (!keyId) return fail(JSONRPC_INVALID_PARAMS, 'keyId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const as = getAuthService();
        const revoked = await as.revokeApiKey(keyId, tenant.accountId, project.id);
        if (!revoked) return fail(-32004, 'API key not found', { keyId });
        await auditService.record(tenant.accountId, 'API_KEY_REVOKED', { type: 'api_key', id: keyId }, undefined, {
          projectId: project.id,
        });
        return { ok: true, data: { revoked: true, keyId } };
      }

      case 'bind_api_key_instance': {
        const { keyId, instanceId } = params as { keyId?: string; instanceId?: string };
        if (!keyId || !instanceId) return fail(JSONRPC_INVALID_PARAMS, 'keyId and instanceId are required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        const as = getAuthService();
        await as.bindInstance(keyId, instance.id);
        await auditService.record(
          tenant.accountId,
          'API_KEY_INSTANCE_BINDING',
          { type: 'api_key', id: keyId },
          undefined,
          { projectId: project.id },
        );
        return { ok: true, data: { bound: true, keyId, instanceId } };
      }

      // ══════════════════════════════════════════════════════
      // ACCOUNT
      // ══════════════════════════════════════════════════════

      case 'get_account': {
        const account = await platformRepository.platformAccount.findUnique({ where: { id: tenant.accountId } });
        if (!account) return fail(-32001, 'Account not found');
        const subService = getSubscriptionService();
        const subscription = await subService.getActiveSubscription(tenant.accountId);
        return {
          ok: true,
          data: {
            id: account.publicId,
            name: account.name,
            status: account.status,
            plan: subscription?.plan?.name ?? 'unknown',
            subscriptionStatus: subscription?.status ?? 'unknown',
            trialEndsAt: subscription?.endsAt?.toISOString() ?? null,
            createdAt: account.createdAt.toISOString(),
          },
        };
      }

      case 'get_usage': {
        const usage = getUsageService();
        const breakdown = await usage.getUsageBreakdown(tenant.accountId);
        return {
          ok: true,
          data: {
            period: {
              start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
              end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
            },
            usage: breakdown,
          },
        };
      }

      case 'get_plans': {
        const subService = getSubscriptionService();
        const plans = await subService.listPlans();
        return { ok: true, data: { plans } };
      }

      case 'list_subscriptions': {
        const subscriptions = await platformRepository.platformSubscription.findMany({
          where: { accountId: tenant.accountId },
          include: { plan: true },
          orderBy: { startedAt: 'desc' },
        });
        return {
          ok: true,
          data: {
            subscriptions: subscriptions.map((s: any) => ({
              id: s.publicId,
              planId: s.plan?.publicId,
              planName: s.plan?.name,
              status: s.status,
              startedAt: s.startedAt.toISOString(),
              endsAt: s.endsAt?.toISOString() ?? null,
            })),
          },
        };
      }

      // ══════════════════════════════════════════════════════
      // HEALTH
      // ══════════════════════════════════════════════════════

      case 'health_check': {
        try {
          await platformRepository.$queryRaw`SELECT 1`;
          return {
            ok: true,
            data: { status: 'healthy', database: 'connected', timestamp: new Date().toISOString() },
          };
        } catch {
          return fail(-32003, 'Service degraded', { database: 'disconnected' });
        }
      }

      case 'get_instance_logs': {
        const { instanceId, limit } = params as { instanceId?: string; limit?: number };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        const logs = await platformRepository.instanceEventLog.findMany({
          where: { instanceId: instance.id },
          orderBy: { createdAt: 'desc' },
          take: Math.min(limit ?? 50, 200),
          select: { publicId: true, eventType: true, payload: true, createdAt: true },
        });
        return {
          ok: true,
          data: {
            logs: logs.map((l) => ({
              id: l.publicId,
              eventType: l.eventType,
              payload: l.payload,
              timestamp: l.createdAt.toISOString(),
            })),
            total: logs.length,
          },
        };
      }

      // ══════════════════════════════════════════════════════
      // CONTACTS
      // ══════════════════════════════════════════════════════

      case 'list_contacts': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        if (instance.status !== 'CONNECTED') {
          return fail(-32009, 'Instance not connected', { instanceId, status: instance.status });
        }
        const contacts = await evolutionAdapter.fetchContacts(instance.id);
        return { ok: true, data: { contacts, total: contacts.length } };
      }

      case 'list_groups': {
        const { instanceId } = params as { instanceId?: string };
        if (!instanceId) return fail(JSONRPC_INVALID_PARAMS, 'instanceId is required');
        const project = await getProject();
        if (!project) return fail(-32001, 'No project is available for this credential');
        const instance = await resolveInstance(instanceId, project.id);
        if (!instance) return fail(-32004, 'Instance not found', { instanceId });
        if (instance.status !== 'CONNECTED') {
          return fail(-32009, 'Instance not connected', { instanceId, status: instance.status });
        }
        const groups = await evolutionAdapter.fetchGroups(instance.id);
        return { ok: true, data: { groups, total: groups.length } };
      }

      // ══════════════════════════════════════════════════════
      // DOCUMENTATION
      // ══════════════════════════════════════════════════════

      case 'get_documentation': {
        const { page, query } = params as { page?: string; query?: string };
        const pageId = page?.trim();
        const term = query?.trim();

        if (pageId) {
          const found = await docsService.getPage(pageId);
          if (!found) {
            return fail(-32004, `Unknown documentation page: ${pageId}`, {
              available: docsService.listPages().sections.flatMap((s) => s.pages.map((p) => p.id)),
            });
          }
          return { ok: true, data: found };
        }

        if (term) {
          const hits = docsService.search(term);
          if (!hits.length) {
            return fail(-32004, `No documentation page matches "${term}"`, {
              available: docsService.listPages().sections.flatMap((s) => s.pages.map((p) => p.id)),
            });
          }
          // The best hit carries the full body so the agent does not have to
          // make a second round trip.
          const best = await docsService.getPage(hits[0].id);
          return {
            ok: true,
            data: {
              query: term,
              total: hits.length,
              matches: hits,
              page: best,
            },
          };
        }

        // No page and no query — hand back the whole index.
        return {
          ok: true,
          data: {
            docsBaseUrl: docsService.getDocsBaseUrl(),
            ...docsService.listPages(),
          },
        };
      }

      // No default — unknown tools are caught by the pre-check above
      default:
        return fail(JSONRPC_METHOD_NOT_FOUND, `Unknown tool: ${tool}`);
    }
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return { ok: false, error: { code: error.code, message: error.message, data: error.data } };
    }
    throw error;
  }
}
