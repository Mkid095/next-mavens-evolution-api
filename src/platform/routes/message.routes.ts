import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';

interface PlatformTenant {
  accountId: string;
  publicId: string;
  status: string;
  plan: { planId: string; name: string; monthlyMessageLimit: number | null };
}

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

    // Verify instance exists and belongs to this tenant
    const instance = await platformRepository.instance.findUnique({
      where: { id: instanceId },
    });

    if (!instance || instance.platformAccountId !== platformTenant.accountId) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
      return;
    }

    // Generate public messageId (msg_xxx)
    const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;

    // Idempotency key from header (required for POST)
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    try {
      const command = await platformRepository.platformMessageCommand.create({
        data: {
          idempotencyKey: idempotencyKey ?? `inline_${messageId}`,
          accountId: platformTenant.accountId,
          instanceId,
          apiKeyId: (req as Request & { platformKey?: { apiKeyId: string } }).platformKey?.apiKeyId ?? '',
          messageId,
          type: type ?? 'text',
          recipient: number,
          content: { text },
          status: 'queued',
          attempts: 0,
        },
      });

      await auditService.record(platformTenant.accountId, 'MESSAGE_SEND', {
        type: 'message',
        id: messageId,
      });

      // Complete the idempotency record
      idempotencyMiddleware.complete(req, res, { messageId }, messageId);

      res.status(202).json({ messageId });
    } catch (error) {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

export { router as messageRoutes };
