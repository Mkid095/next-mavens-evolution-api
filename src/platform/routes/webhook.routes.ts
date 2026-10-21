import { Logger } from '@config/logger.config';
import { Request, Response, Router } from 'express';

import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { WebhookService } from '../services/webhook.service';
import { getSessionService } from './auth.routes';
import { requireProjectContext } from './project-scope';

const router: Router = Router();
const webhookService = new WebhookService();
const auditService = new AuditService();
const logger = new Logger('WebhookRoutes');

/**
 * Load a webhook by its public id and check that it belongs to the project.
 */
async function findProjectWebhook(publicId: string, projectId: string) {
  return platformRepository.platformWebhook.findFirst({
    where: { publicId, projectId },
  });
}

/**
 * List the webhooks of a project.
 * GET /accounts/:accountId/projects/:projectPublicId/webhooks
 *
 * Returns public IDs only — `instanceId` is the public instance id
 * (inst_xxx).
 */
router.get(
  '/:accountId/projects/:projectPublicId/webhooks',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const webhooks = await webhookService.listWebhooks(context.project.id);

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
          where: { name: { in: engineInstances.map((e) => e.name) }, projectId: context.project.id },
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
 * POST /accounts/:accountId/projects/:projectPublicId/webhooks
 *
 * Body: { instanceId, url, events }
 *   `instanceId` is the PUBLIC instance id (`inst_xxx`) — the same identifier
 *   every other platform route uses. The internal engine CUID is still
 *   accepted for backwards compatibility, but the public id is the contract.
 *
 * Response: { webhook: { publicId, url, events, instanceId, secret } }
 *   `secret` is the PLAINTEXT signing secret and is shown ONLY here, at
 *   creation time — it is stored encrypted (AES-256-GCM) and can never be
 *   read back. `POST .../webhooks/:webhookId/rotate` issues a new one.
 */
router.post(
  '/:accountId/projects/:projectPublicId/webhooks',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const { instanceId, url, events } = req.body ?? {};

      if (!instanceId || !url) {
        res.status(400).json({ error: 'MISSING_FIELDS' });
        return;
      }

      // Resolve the public instance id (inst_xxx) → PlatformInstance →
      // the engine Instance row it owns. The engine CUID is accepted as a
      // fallback so callers written against the old contract keep working.
      let platformInstance = await platformRepository.platformInstance.findFirst({
        where: { publicId: instanceId, projectId: context.project.id },
      });

      let engineInstance = platformInstance
        ? await platformRepository.instance.findFirst({ where: { name: platformInstance.name } })
        : null;

      if (!platformInstance) {
        const byEngineId = await platformRepository.instance.findUnique({ where: { id: instanceId } });
        if (byEngineId) {
          engineInstance = byEngineId;
          platformInstance = await platformRepository.platformInstance.findFirst({
            where: { name: byEngineId.name, projectId: context.project.id },
          });
        }
      }

      // Validate the instance exists and belongs to this project. Ownership is
      // proven by the PlatformInstance lookup above (it is scoped to the
      // project's instances); the engine row's `platformAccountId` is a second,
      // optional confirmation — it is null on instances provisioned before
      // that column was populated, and a mismatch means the two rows are
      // out of sync.
      const engineOwnedByOther =
        engineInstance?.platformAccountId != null && engineInstance.platformAccountId !== context.tenant.accountId;

      if (!platformInstance || !engineInstance || engineOwnedByOther) {
        res
          .status(400)
          .json({ error: 'INVALID_INSTANCE', message: 'Instance not found or does not belong to this project' });
        return;
      }

      // `platformInstance.id` is the id the webhook delivery worker matches on
      // (the lifecycle event log is keyed by PlatformInstance.id) — the same
      // value the MCP `create_webhook` tool stores.
      const webhook = await webhookService.createWebhook(
        context.tenant.accountId,
        context.project.id,
        platformInstance.id,
        url,
        events || [],
      );

      await auditService.record(
        context.tenant.accountId,
        'WEBHOOK_CREATE',
        { type: 'webhook', id: webhook.publicId },
        undefined,
        { projectId: context.project.id },
      );

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
 * Update a webhook (must belong to the project).
 * PATCH /accounts/:accountId/projects/:projectPublicId/webhooks/:webhookId
 * :webhookId must be the publicId (wh_xxx), never an internal CUID.
 */
router.patch(
  '/:accountId/projects/:projectPublicId/webhooks/:webhookId',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const { url, events, enabled } = req.body ?? {};

      const webhook = await findProjectWebhook(req.params.webhookId, context.project.id);
      if (!webhook) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await webhookService.updateWebhook(webhook.id, { url, events, enabled });

      await auditService.record(
        context.tenant.accountId,
        'WEBHOOK_UPDATE',
        { type: 'webhook', id: req.params.webhookId }, // public ID in audit
        undefined,
        { projectId: context.project.id },
      );

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'UPDATE_ERROR' });
    }
  },
);

/**
 * Delete a webhook (must belong to the project).
 * DELETE /accounts/:accountId/projects/:projectPublicId/webhooks/:webhookId
 * :webhookId must be the publicId (wh_xxx).
 */
router.delete(
  '/:accountId/projects/:projectPublicId/webhooks/:webhookId',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const webhook = await findProjectWebhook(req.params.webhookId, context.project.id);
      if (!webhook) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await webhookService.deleteWebhook(webhook.id);

      await auditService.record(
        context.tenant.accountId,
        'WEBHOOK_DELETE',
        { type: 'webhook', id: req.params.webhookId }, // public ID in audit
        undefined,
        { projectId: context.project.id },
      );

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'DELETE_ERROR' });
    }
  },
);

/**
 * Rotate webhook secret (must belong to the project).
 * POST /accounts/:accountId/projects/:projectPublicId/webhooks/:webhookId/rotate
 * :webhookId must be the publicId (wh_xxx).
 * Plaintext secret is returned ONLY at rotation time.
 */
router.post(
  '/:accountId/projects/:projectPublicId/webhooks/:webhookId/rotate',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const webhook = await findProjectWebhook(req.params.webhookId, context.project.id);
      if (!webhook) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      const result = await webhookService.rotateSecret(webhook.id);

      await auditService.record(
        context.tenant.accountId,
        'WEBHOOK_ROTATE_SECRET',
        { type: 'webhook', id: req.params.webhookId }, // public ID in audit
        undefined,
        { projectId: context.project.id },
      );

      // Plaintext secret returned only at rotation — caller must save it
      res.json({ secret: result.secret });
    } catch {
      res.status(500).json({ error: 'ROTATE_ERROR' });
    }
  },
);

export { router as webhookRoutes };
