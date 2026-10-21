import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { PlatformTenant } from '../types/platform-tenant';
import { keyIsScopedElsewhere } from './project-scope';

const router: Router = Router();
const auditService = new AuditService();

/**
 * Send a message command (Phase 1 — durable queue only, no Evolution call).
 * POST /instances/:id/messages/send
 *
 * :id is the internal CUID of the Instance.
 * Creates a PlatformMessageCommand with status='queued' and returns a public msg_ ID.
 *
 * Phase 1 lifecycle: queued → processing → deferred (never sent/completed/failed).
 */
router.post(
  '/:id/messages/send',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const { number, text, type } = req.body;
    if (!number || !text) {
      res.status(400).json({ error: 'MISSING_FIELDS' });
      return;
    }

    const instanceId = req.params.id;

    // Verify the PlatformInstance exists and belongs to this tenant.
    // The :id in this route is the internal PlatformInstance CUID.
    const platformInstance = await platformRepository.platformInstance.findUnique({
      where: { id: instanceId },
    });

    if (!platformInstance || platformInstance.accountId !== platformTenant.accountId) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
      return;
    }

    // A project-scoped key may only send through instances of its own
    // project. An account-level personal access token may use any
    // instance of the account.
    if (keyIsScopedElsewhere(req, platformInstance.projectId)) {
      res.status(403).json({
        error: 'PROJECT_ACCESS_DENIED',
        message: 'This API key is scoped to a different project',
      });
      return;
    }

    // Resolve the engine Instance by name (PlatformInstance.name = Instance.name = waMonitor key).
    const instance = await platformRepository.instance.findFirst({
      where: { name: platformInstance.name },
    });

    if (!instance) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Engine instance not provisioned' });
      return;
    }

    // Generate public messageId (msg_xxx)
    const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;

    // Idempotency key from header (required for POST)
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    try {
      await platformRepository.platformMessageCommand.create({
        data: {
          idempotencyKey: idempotencyKey ?? `inline_${messageId}`,
          accountId: platformTenant.accountId,
          projectId: platformInstance.projectId,
          instanceId: platformInstance.id,
          apiKeyId: (req as Request & { platformKey?: { apiKeyId: string } }).platformKey?.apiKeyId ?? '',
          messageId,
          type: type ?? 'text',
          recipient: number,
          content: { text },
          status: 'queued',
          attempts: 0,
        },
      });

      await auditService.record(
        platformTenant.accountId,
        'MESSAGE_SEND',
        {
          type: 'message',
          id: messageId,
        },
        { instancePublicId: platformInstance.publicId },
        { projectId: platformInstance.projectId },
      );

      // Complete the idempotency record
      idempotencyMiddleware.complete(req, res, { messageId }, messageId);

      res.status(202).json({ messageId });
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

export { router as messageRoutes };
