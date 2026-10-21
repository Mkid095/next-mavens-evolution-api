import { Logger } from '@config/logger.config';
import { Request, Response, Router } from 'express';

import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { WebhookService } from '../services/webhook.service';
import { PlatformTenant } from '../types/platform-tenant';

const router: Router = Router();
const webhookService = new WebhookService();
const auditService = new AuditService();
const logger = new Logger('WebhookRoutes');

/**
 * List webhooks for the authenticated account.
 * GET /webhooks
 * Returns public IDs only — `instanceId` is the public instance id (inst_xxx).
 */
router.get(
  '/',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      const webhooks = await webhookService.listWebhooks(platformTenant!.accountId);

      // The stored `instanceId` is the internal PlatformInstance id. Translate
      // it to the public id (inst_xxx) so the list matches what the create
      // endpoint returns. Rows created before that switch stored the engine
      // Instance cuid — resolve those through the instance name.
      const instanceIds = [...new Set(webhooks.map((w) => w.instanceId))];
      const platformInstances = await platformRepository.platformInstance.findMany({
        where: { id: { in: instanceIds } },
        select: { id: true, publicId: true, name: true },
      });
      const publicIdById = new Map(platformInstances.map((i) => [i.id, i.publicId]));

      const legacyIds = instanceIds.filter((id) => !publicIdById.has(id));
      if (legacyIds.length > 0) {
        const engineInstances = await platformRepository.instance.findMany({
          where: { id: { in: legacyIds } },
          select: { id: true, name: true },
        });
        const legacyPlatformInstances = await platformRepository.platformInstance.findMany({
          where: { name: { in: engineInstances.map((e) => e.name) }, accountId: platformTenant!.accountId },
          select: { name: true, publicId: true },
        });
        const publicIdByName = new Map(legacyPlatformInstances.map((i) => [i.name, i.publicId]));
        for (const engine of engineInstances) {
          const publicId = publicIdByName.get(engine.name);
          if (publicId) publicIdById.set(engine.id, publicId);
        }
      }

      res.json(
        webhooks.map((w) => ({
          ...w,
          instanceId: publicIdById.get(w.instanceId) ?? w.instanceId,
        })),
      );
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create a webhook for a specific instance.
 * POST /webhooks
 *
 * Body: { instanceId, url, events }
 *   `instanceId` is the PUBLIC instance id (`inst_xxx`) — the same identifier
 *   every other platform route uses. The internal engine CUID is still
 *   accepted for backwards compatibility, but the public id is the contract.
 *
 * Response: { webhook: { publicId, url, events, instanceId, secret } }
 *   `secret` is the PLAINTEXT signing secret and is shown ONLY here, at
 *   creation time — it is stored encrypted (AES-256-GCM) and can never be
 *   read back. `POST /webhooks/:webhookId/rotate` issues a new one.
 */
router.post(
  '/',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      const { instanceId, url, events } = req.body ?? {};

      if (!instanceId || !url) {
        res.status(400).json({ error: 'MISSING_FIELDS' });
        return;
      }

      // Resolve the public instance id (inst_xxx) → PlatformInstance →
      // the engine Instance row it owns. The engine CUID is accepted as a
      // fallback so callers written against the old contract keep working.
      let platformInstance = await platformRepository.platformInstance.findFirst({
        where: { publicId: instanceId, accountId: platformTenant!.accountId },
      });

      let engineInstance = platformInstance
        ? await platformRepository.instance.findFirst({ where: { name: platformInstance.name } })
        : null;

      if (!platformInstance) {
        const byEngineId = await platformRepository.instance.findUnique({ where: { id: instanceId } });
        if (byEngineId) {
          engineInstance = byEngineId;
          platformInstance = await platformRepository.platformInstance.findFirst({
            where: { name: byEngineId.name, accountId: platformTenant!.accountId },
          });
        }
      }

      // Validate the instance exists and belongs to this account. Ownership is
      // proven by the PlatformInstance lookup above (it is scoped to the
      // caller's account); the engine row's `platformAccountId` is a second,
      // optional confirmation — it is null on instances provisioned before
      // that column was populated, and a mismatch means the two rows are
      // out of sync.
      const engineOwnedByOther =
        engineInstance?.platformAccountId != null && engineInstance.platformAccountId !== platformTenant!.accountId;

      if (!platformInstance || !engineInstance || engineOwnedByOther) {
        res
          .status(400)
          .json({ error: 'INVALID_INSTANCE', message: 'Instance not found or does not belong to this account' });
        return;
      }

      // `platformInstance.id` is the id the webhook delivery worker matches on
      // (the lifecycle event log is keyed by PlatformInstance.id) — the same
      // value the MCP `create_webhook` tool stores.
      const webhook = await webhookService.createWebhook(
        platformTenant!.accountId,
        platformInstance.id,
        url,
        events || [],
        platformTenant!.defaultApp.id,
      );

      await auditService.record(platformTenant!.accountId, 'WEBHOOK_CREATE', {
        type: 'webhook',
        id: webhook.publicId,
      });

      const responseBody = {
        webhook: {
          publicId: webhook.publicId,
          url: webhook.url,
          events: webhook.events,
          instanceId: platformInstance.publicId,
          // Plaintext secret — shown ONLY at creation. It is stored encrypted
          // and is never returned again; rotate to issue a new one.
          secret: webhook.secret,
        },
      };

      idempotencyMiddleware.complete(req, res, responseBody, webhook.publicId);

      // Return only the public contract
      res.status(201).json(responseBody);
    } catch (error) {
      logger.error(`Webhook create failed: ${error}`);
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * Update a webhook (must belong to authenticated account).
 * PATCH /webhooks/:webhookId
 * :webhookId must be the publicId (wh_xxx), never an internal CUID.
 */
router.patch(
  '/:webhookId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      const { url, events, enabled } = req.body;

      // Resolve publicId → internal ID
      const webhook = await platformRepository.platformWebhook.findUnique({
        where: { publicId: req.params.webhookId },
      });

      if (!webhook || webhook.accountId !== platformTenant!.accountId) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await webhookService.updateWebhook(webhook.id, { url, events, enabled });

      await auditService.record(platformTenant!.accountId, 'WEBHOOK_UPDATE', {
        type: 'webhook',
        id: req.params.webhookId, // public ID in audit
      });

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'UPDATE_ERROR' });
    }
  },
);

/**
 * Delete a webhook (must belong to authenticated account).
 * DELETE /webhooks/:webhookId
 * :webhookId must be the publicId (wh_xxx).
 */
router.delete(
  '/:webhookId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;

      // Resolve publicId → internal ID
      const webhook = await platformRepository.platformWebhook.findUnique({
        where: { publicId: req.params.webhookId },
      });

      if (!webhook || webhook.accountId !== platformTenant!.accountId) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await webhookService.deleteWebhook(webhook.id);

      await auditService.record(platformTenant!.accountId, 'WEBHOOK_DELETE', {
        type: 'webhook',
        id: req.params.webhookId, // public ID in audit
      });

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'DELETE_ERROR' });
    }
  },
);

/**
 * Rotate webhook secret (must belong to authenticated account).
 * POST /webhooks/:webhookId/rotate
 * :webhookId must be the publicId (wh_xxx).
 * Plaintext secret is returned ONLY at rotation time.
 */
router.post(
  '/:webhookId/rotate',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;

      // Resolve publicId → internal ID
      const webhook = await platformRepository.platformWebhook.findUnique({
        where: { publicId: req.params.webhookId },
      });

      if (!webhook || webhook.accountId !== platformTenant!.accountId) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      const result = await webhookService.rotateSecret(webhook.id);

      await auditService.record(platformTenant!.accountId, 'WEBHOOK_ROTATE_SECRET', {
        type: 'webhook',
        id: req.params.webhookId, // public ID in audit
      });

      // Plaintext secret returned only at rotation — caller must save it
      res.json({ secret: result.secret });
    } catch {
      res.status(500).json({ error: 'ROTATE_ERROR' });
    }
  },
);

export { router as webhookRoutes };
