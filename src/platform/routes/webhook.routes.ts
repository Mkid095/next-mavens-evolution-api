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
 * Returns public IDs only.
 */
router.get(
  '/',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      const webhooks = await webhookService.listWebhooks(platformTenant!.accountId);
      res.json(webhooks);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create a webhook for a specific instance.
 * POST /webhooks
 * instanceId must be the internal CUID of an existing Instance belonging to the account.
 * The response returns only the publicId (wh_xxx), never the internal CUID.
 */
router.post(
  '/',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      const { instanceId, url, events } = req.body;

      if (!instanceId || !url) {
        res.status(400).json({ error: 'MISSING_FIELDS' });
        return;
      }

      // Validate instance exists and belongs to this account
      const instance = await platformRepository.instance.findUnique({
        where: { id: instanceId },
      });

      if (!instance || instance.platformAccountId !== platformTenant!.accountId) {
        res
          .status(400)
          .json({ error: 'INVALID_INSTANCE', message: 'Instance not found or does not belong to this account' });
        return;
      }

      const webhook = await webhookService.createWebhook(
        platformTenant!.accountId,
        instanceId,
        url,
        events || [],
        platformTenant!.defaultApp.id,
      );

      await auditService.record(platformTenant!.accountId, 'WEBHOOK_CREATE', {
        type: 'webhook',
        id: webhook.publicId,
      });

      idempotencyMiddleware.complete(
        req,
        res,
        {
          webhook: {
            publicId: webhook.publicId,
            url: webhook.url,
            events: webhook.events,
            instanceId: webhook.instanceId,
          },
        },
        webhook.publicId,
      );

      // Return only the public contract
      res.status(201).json({ webhook });
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
